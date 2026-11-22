"use strict";

/**
 * songfetch — the download *approach* from lucashanak/music-seeker's
 * `songfetch.py`, ported to Node for the `.play` command.
 *
 * This is not the web app. It's the ~150 lines worth copying, with
 * FastAPI, Navidrome, the job queue and the BPM analyser removed.
 * It only needs the standalone yt-dlp binary in `bin/` (fetched by
 * `scripts/install-ytdlp.js`) and `ffmpeg-static` — no Python, no
 * system packages, so it works on Render's Node-only image.
 *
 * Where each piece came from (songfetch.py):
 *   rank/search/_fold/_DEMOTE   ->  app/services/ytpick.py
 *   _run/_sanitize/_clear_partials/two-phase download
 *                                 ->  app/services/downloader.py
 *
 * The three ideas that make it work:
 *
 * 1. **Search once, cheaply.** `yt-dlp --flat-playlist` lists the top
 *    N results as text in ~1s with no per-video extraction. You need
 *    those titles to choose between them.
 * 2. **Try candidates in order, not just the first.** YouTube's top
 *    hit is regularly region- or label-blocked, or behind the
 *    "Sign in to confirm you're not a bot" wall on datacenter IPs.
 *    Success is tested by the file existing on disk, not by the
 *    exit code.
 * 3. **Clear the .part files between attempts.** All candidates write
 *    to the same output path, so a killed attempt leaves a `.part`
 *    that the next candidate will happily *resume* — one file, two
 *    different videos' bytes.
 *
 * Plus the bot-check mitigations from `utils/ytdlp.js`
 * (`ytdlpBaseFlags()`): android/ios player client, retries, and an
 * optional cookies file. When every candidate still fails with a
 * bot-check error, `isBotCheckError()` lets the caller tell the
 * user to drop a `cookies.txt` in the repo root.
 *
 * Usage (from commands/music.js or anywhere else):
 *   const { downloadTrack, search, rank } = require("../utils/songfetch");
 *   const path = await downloadTrack({ artist: "Daft Punk", title: "One More Time", album: "Discovery", fmt: "mp3", outRoot: "/music" });
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { ytdlp, ytdlpBaseFlags } = require("./ytdlp");

const YT_SEARCH_TIMEOUT_MS = Number(process.env.YTDLP_SEARCH_TIMEOUT_MS) || 20 * 1000;
const TRACK_DL_TIMEOUT_MS = Number(process.env.YTDLP_TRACK_TIMEOUT_MS) || 600 * 1000;
const TAG_TIMEOUT_MS = Number(process.env.YTDLP_TAG_TIMEOUT_MS) || 120 * 1000;

const YT_WATCH = "https://www.youtube.com/watch?v=";

// ── 1. choosing which YouTube result to use ────────────────────────────────
// Word-boundary patterns matched against a folded title. Deliberately
// short: every addition is a chance to demote the correct result.
const DEMOTE = {
  live: /\blive\b|\bkoncert\w*\b|\ben\s+vivo\b|\ben\s+directo\b/,
  karaoke: /\bkaraoke\w*\b|\bbacking\s+track\b|\bplayback\b/,
  cover: /\bcover(ed)?\b|\bcovers\b/,
};

/** Lowercase and strip diacritics so matching survives 'Kóncert' / 'LIVE'. */
function fold(text) {
  return String(text || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * The penalties that still apply once the query's own wording is excluded.
 * 'Live and Let Die' contains 'live', and so does a deliberate search for
 * an unplugged session — so any keyword already in the query is dropped,
 * otherwise we would penalise every single result equally.
 */
function activeTerms(query) {
  const folded = fold(query);
  return Object.values(DEMOTE).filter((p) => !p.test(folded));
}

/**
 * Preferred results first, demoted ones after, original order within each.
 * Demote, never drop: a live take is a worse substitute for the studio
 * version but a far better one than silence, and for some tracks it is
 * the only upload.
 */
function rank(candidates, query) {
  const terms = activeTerms(query);
  const preferred = [];
  const demoted = [];
  for (const cand of candidates || []) {
    const folded = fold(cand && cand.title);
    (terms.some((p) => p.test(folded)) ? demoted : preferred).push(cand);
  }
  return preferred.concat(demoted);
}

/** Split "Artist - Title" the same way songfetch.py's CLI does. */
function parseArtistTitle(query) {
  const q = String(query || "").trim();
  const idx = q.indexOf(" - ");
  if (idx !== -1) {
    return { artist: q.slice(0, idx).trim(), title: q.slice(idx + 3).trim() };
  }
  return { artist: "", title: q };
}

/**
 * Top `limit` matches as [{id, title, url, duration}] in relevance order.
 * Uses `--flat-playlist` so no video is downloaded yet — just titles.
 * Returns [] when the search itself fails (caller falls back to a
 * one-shot ytsearch download); rethrows only when the binary is missing.
 */
async function search(query, opts = {}) {
  const limit = opts.limit || 5;
  const timeoutMs = opts.timeoutMs || YT_SEARCH_TIMEOUT_MS;
  const runner = opts.ytdlpImpl || ytdlp;

  let out;
  try {
    out = await runner(
      `ytsearch${limit}:${query}`,
      {
        flatPlaylist: true,
        noWarnings: true,
        print: "%(id)s\t%(title)s\t%(duration)s",
        ...ytdlpBaseFlags(),
      },
      { timeoutMs }
    );
  } catch (err) {
    if (/binary not found/i.test(String((err && err.message) || err))) throw err;
    return [];
  }

  const text = typeof out === "string" ? out : JSON.stringify(out || "");
  const results = [];
  for (const line of text.split("\n")) {
    const [videoId, title, durationRaw] = line.trim().split("\t");
    if (videoId && videoId !== "NA") {
      const duration = durationRaw && durationRaw !== "NA" ? Number(durationRaw) : null;
      results.push({
        id: videoId,
        title: title || "",
        url: YT_WATCH + videoId,
        duration: Number.isFinite(duration) ? duration : null,
      });
    }
  }
  return results;
}

// ── 2. running external tools safely ─────────────────────────────────────

function sanitize(name) {
  return String(name || "")
    .replace(/[/\\:*?"<>|]/g, "_")
    .trim()
    .replace(/\.+$/, "");
}

/** Drop scratch files left by an abandoned attempt (see header). */
function clearPartials(outDir, safeTitle) {
  let entries;
  try {
    entries = fs.readdirSync(outDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(safeTitle + ".")) continue;
    if (entry.endsWith(".part") || entry.endsWith(".ytdl") || entry.endsWith(".temp")) {
      try {
        fs.unlinkSync(path.join(outDir, entry));
      } catch {
        // best effort — a locked file shouldn't block the next attempt
      }
    }
  }
}

function unlinkQuiet(filePath) {
  try {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

/** Download album art to a temp file. Returns true on success. */
async function fetchCover(imageUrl, destPath, fetchImpl = globalThis.fetch) {
  if (!imageUrl || typeof fetchImpl !== "function") return false;
  try {
    const res = await fetchImpl(imageUrl, {
      headers: { "User-Agent": "songfetch/1.0" },
      redirect: "follow",
    });
    if (!res.ok) return false;
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length) return false;
    await fs.promises.writeFile(destPath, body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Free Deezer API lookup for a cover image URL. Best effort — returns ""
 * on any failure so a missing cover never blocks the download.
 */
async function fetchDeezerCover(artist, title, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return "";
  const q = [artist, title].filter(Boolean).join(" ").trim();
  if (!q) return "";
  try {
    const res = await fetchImpl(`https://api.deezer.com/search?q=${encodeURIComponent(q)}`, {
      headers: { "User-Agent": "songfetch/1.0" },
    });
    if (!res.ok) return "";
    const data = await res.json();
    const first = data && data.data && data.data[0];
    const album = first && first.album;
    return (album && (album.cover_big || album.cover_xl || album.cover)) || "";
  } catch {
    return "";
  }
}

function ffmpegBinary() {
  try {
    return require("ffmpeg-static");
  } catch {
    return "ffmpeg";
  }
}

/** Run ffmpeg to completion, killing it past `timeoutMs`. Returns exit code or null. */
function runFfmpeg(args, timeoutMs, ffmpegPath) {
  const bin = ffmpegPath || ffmpegBinary();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      return resolve(null);
    }
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(code);
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              // ignore
            }
            settle(null);
          }, timeoutMs)
        : null;
    child.on("error", () => settle(null));
    child.on("close", (code) => settle(code));
  });
}

// ── 3. the download itself ───────────────────────────────────────────────

/**
 * Download one track and tag it. Returns the final path, or null on failure.
 * Output layout: <outRoot>/<Artist>/<Album>/<Title>.<fmt>
 *
 * @param {object} opts
 * @param {string} opts.artist
 * @param {string} opts.title        required
 * @param {string} [opts.album]
 * @param {string} [opts.fmt]        default "mp3"
 * @param {string} [opts.outRoot]    default "."
 * @param {string} [opts.imageUrl]   cover URL (Deezer is tried when empty)
 * @param {Function} [opts.progress] called with "trying: ..." messages
 * @param {number} [opts.searchLimit] default 5
 * @param {number} [opts.searchTimeoutMs]
 * @param {number} [opts.trackTimeoutMs] per-candidate ceiling
 * @param {number} [opts.tagTimeoutMs]
 * @param {Function} [opts.ytdlpImpl]  injection point for tests
 * @param {Function} [opts.searchImpl] injection point for tests
 * @param {Function} [opts.fetchImpl]  injection point for tests
 * @param {Function} [opts.ffmpegImpl] injection point for tests
 */
async function downloadTrack(opts = {}) {
  const {
    artist = "",
    title,
    album = "",
    fmt = "mp3",
    outRoot = ".",
    imageUrl = "",
    progress = null,
    searchLimit = 5,
    searchTimeoutMs = YT_SEARCH_TIMEOUT_MS,
    trackTimeoutMs = TRACK_DL_TIMEOUT_MS,
    tagTimeoutMs = TAG_TIMEOUT_MS,
    ytdlpImpl = ytdlp,
    searchImpl = search,
    fetchImpl = globalThis.fetch,
    ffmpegImpl = runFfmpeg,
  } = opts;

  if (!title) throw new Error("title is required");

  const safeArtist = sanitize(artist) || "Unknown Artist";
  const safeAlbum = sanitize(album) || "Unknown Album";
  const safeTitle = sanitize(title) || "Unknown";

  const outDir = path.join(outRoot, safeArtist, safeAlbum);
  await fs.promises.mkdir(outDir, { recursive: true });
  const outTemplate = path.join(outDir, `${safeTitle}.%(ext)s`);
  const finalFile = path.join(outDir, `${safeTitle}.${fmt}`);

  const query = artist ? `${artist} ${title}` : title;

  async function attempt(target, timeoutMs, skipUnavailable) {
    const flags = {
      extractAudio: true,
      audioFormat: fmt,
      audioQuality: "0", // best available (string: dargs would drop numeric 0)
      noEmbedMetadata: true, // we tag it ourselves below
      noPlaylist: true,
      output: outTemplate,
      ffmpegLocation: ffmpegBinary(),
      ...ytdlpBaseFlags(),
    };
    if (skipUnavailable) {
      // `-i` skips entries it cannot extract and `--max-downloads 1`
      // stops at the first that works — that exits 101 ("max downloads
      // reached"), so the exit code cannot be the success test. The file is.
      flags.ignoreErrors = true;
      flags.maxDownloads = 1;
    }
    clearPartials(outDir, safeTitle);
    try {
      await ytdlpImpl(target, flags, { timeoutMs });
    } catch {
      // Fall through: success is "does the file exist", not exit code.
    }
    return fs.existsSync(finalFile);
  }

  // Phase 1: search, rank, try each candidate in turn.
  const deadline = Date.now() + trackTimeoutMs * 2;
  let ok = false;
  const candidates = await searchImpl(query, { limit: searchLimit, timeoutMs: searchTimeoutMs, ytdlpImpl });
  for (const cand of rank(candidates, query)) {
    const left = deadline - Date.now();
    if (left <= 1000) break;
    if (progress) progress(`trying: ${String(cand.title || "").slice(0, 60)}`);
    if (await attempt(cand.url, Math.min(trackTimeoutMs, left), false)) {
      ok = true;
      break;
    }
  }
  if (!ok && (!candidates || candidates.length === 0)) {
    // The search itself failed — let yt-dlp search and fetch in one go.
    ok = await attempt(`ytsearch${searchLimit}:${query}`, trackTimeoutMs, true);
  }
  if (!ok) return null;

  // Phase 2: overwrite YouTube's metadata with the real catalogue metadata.
  // One ffmpeg pass, stream-copied (no re-encode) + embedded cover.
  let coverUrl = imageUrl;
  if (!coverUrl && artist) {
    coverUrl = await fetchDeezerCover(artist, title, fetchImpl);
  }
  const cover = `${finalFile}.cover.jpg`;
  const hasCover = Boolean(coverUrl) && (await fetchCover(coverUrl, cover, fetchImpl));
  const tmpOut = `${finalFile}.tmp.${fmt}`;
  const cmd = ["-y", "-i", finalFile];
  if (hasCover) {
    cmd.push(
      "-i", cover,
      "-map", "0:a", "-map", "1:0",
      "-c:v", "mjpeg", "-id3v2_version", "3",
      "-metadata:s:v", "title=Album cover",
      "-metadata:s:v", "comment=Cover (front)"
    );
  } else {
    cmd.push("-map", "0:a");
  }
  cmd.push("-c:a", "copy");
  if (artist) cmd.push("-metadata", `artist=${artist}`);
  cmd.push("-metadata", `title=${title}`);
  if (album) cmd.push("-metadata", `album=${album}`);
  cmd.push(tmpOut);

  const rc = await ffmpegImpl(cmd, tagTimeoutMs);
  if (rc === 0 && fs.existsSync(tmpOut)) {
    await fs.promises.rename(tmpOut, finalFile);
  } else {
    unlinkQuiet(tmpOut);
  }
  unlinkQuiet(cover);

  return finalFile;
}

module.exports = {
  fold,
  sanitize,
  rank,
  activeTerms,
  parseArtistTitle,
  search,
  clearPartials,
  fetchCover,
  fetchDeezerCover,
  downloadTrack,
  DEMOTE,
  YT_SEARCH_TIMEOUT_MS,
  TRACK_DL_TIMEOUT_MS,
  TAG_TIMEOUT_MS,
};
