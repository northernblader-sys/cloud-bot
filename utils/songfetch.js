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
 *   rank/search/_fold/_DEMOTE   ->  app/services/ytpick.py (copied almost verbatim)
 *   _run/_sanitize/_clear_partials/two-phase download
 *                                 ->  app/services/downloader.py (_download_track_ytdlp)
 *
 * The three ideas that make it work:
 *
 * 1. **Search once, cheaply.** `--flat-playlist` lists the top N
 *    results as text in ~1s with no per-video extraction. You need
 *    those titles to choose between them.
 * 2. **Try candidates in order, not just the first.** YouTube's top
 *    hit is regularly region- or label-blocked. Success is tested by
 *    the file existing on disk, not by the exit code.
 * 3. **Clear the .part files between attempts.** All candidates write
 *    to the same output path, so a killed attempt leaves a `.part`
 *    that the next candidate will happily *resume* — one file, two
 *    different videos' bytes.
 * 4. **When YouTube says no, read the real cause.** "Use --cookies" is
 *    a static remedy suffix yt-dlp appends to failures — never a prompt.
 *    The line before it names the actual problem: "Sign in to confirm
 *    you're not a bot" / HTTP 429 means the server's *IP* is flagged
 *    (cookies rarely help; hammering retries extends the block),
 *    age-restricted means an account is needed, private/unavailable
 *    means the upload is gone. Following music-seeker's player.py
 *    (which chose NOT to use cookies), a bot check or 429 starts a
 *    300 s cooldown (`YT_COOLDOWN_MS`) during which every download
 *    fails fast, candidate attempts are spaced 5 s apart, and the
 *    yt-dlp binary is refreshed once it is older than 24 h (see
 *    utils/ytdlp.js).
 *
 * Node adaptations (behaviour identical to songfetch.py):
 *   - yt-dlp binary is `bin/yt-dlp` (standalone, no Python) instead of
 *     PATH `yt-dlp`; ffmpeg is `ffmpeg-static` instead of PATH `ffmpeg`,
 *     passed via `--ffmpeg-location` so yt-dlp finds it on Render.
 *   - `fetch()` instead of urllib for cover downloads.
 *   - FLAC tagging uses ffmpeg (metaflac is not available on Render);
 *     the MP3 path is exactly as in songfetch.py.
 *
 * Usage:
 *   const { downloadTrack, search, rank } = require("../utils/songfetch");
 *   const path = await downloadTrack({ artist: "Daft Punk", title: "One More Time", album: "Discovery", fmt: "mp3", outRoot: "/music" });
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const { ytdlp } = require("./ytdlp");

const YT_SEARCH_TIMEOUT_MS = 20 * 1000;
const TRACK_DL_TIMEOUT_MS = 600 * 1000;
const TAG_TIMEOUT_MS = 120 * 1000;
const YT_WATCH = "https://www.youtube.com/watch?v=";

// music-seeker's player.py mitigation for YouTube's IP wall:
//   YT_COOLDOWN = 300.0  — after a bot check / 429, every download fails
//                          fast for 5 minutes instead of hammering
//                          YouTube (which only extends the block)
//   requests spaced apart — "50 in a row from one IP is what earns the
//                          bot check" (5 s between candidate attempts)

// ── 1. choosing which YouTube result to use (from app/services/ytpick.py) ──
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

/**
 * Split "Artist - Title" the same way songfetch.py's CLI does, including
 * the `--artist X "X Title"` case (should not search for "X X Title").
 * Returns {artist, title} — caller handles exact-URL queries separately.
 */
function parseArtistTitle(query, artist = "") {
  const q = String(query || "").trim();
  let a = String(artist || "").trim();
  let t = "";
  if (q.includes(" - ")) {
    const idx = q.indexOf(" - ");
    a = q.slice(0, idx).trim();
    t = q.slice(idx + 3).trim();
  } else if (a && q.toLowerCase().startsWith(a.toLowerCase())) {
    t = q.slice(a.length).trim().replace(/^-+/, "").trim();
  } else {
    t = q;
  }
  return { artist: a, title: t };
}

// ── 1b. when YouTube says no (from music-seeker's app/services/player.py) ──
// yt-dlp never asks for cookies interactively: "use --cookies" is a static
// remedy suffix it glues onto failures (extractor/common.py:595). The line
// before it names the real cause:
//
//   "Sign in to confirm you're not a bot"  -> IP reputation (datacenter/VPN)
//   HTTP Error 429                          -> rate limited; slow down
//   age-restricted / inappropriate           -> needs an account (cookies WOULD help)
//   private video / video unavailable        -> gone; nothing helps
//
// player.py:31-40 measured that once YouTube flags the address, EVERY track
// fails until it cools down. Their mitigation, mirrored here: a 300 s
// cooldown after a bot check/429, requests spaced apart, and nightly yt-dlp
// updates (see utils/ytdlp.js). No cookies — the same call the source repo
// made: they bind downloads to a personal Google account (ban risk), expire
// in weeks, and are a patch on an IP problem, not a fix.

const YT_COOLDOWN_MS = 300 * 1000; // player.py: YT_COOLDOWN = 300.0
const ATTEMPT_GAP_MS = 5 * 1000; // "space requests 5-10s apart"

const FAILURE_PATTERNS = [
  ["botcheck", /sign in to confirm|not a bot/i],
  ["ratelimit", /http error 429|\b429\b|too many requests/i],
  ["age", /\bage[- ]?restrict|\binappropriate\b/i],
  [
    "unavailable",
    /private video|video unavailable|has been removed|content is not available|no longer available|does not exist/i,
  ],
  ["format", /requested format is not available/i],
];

/** Map a yt-dlp failure to its real cause (see the table above). */
function classifyError(err) {
  const msg = String((err && err.message) || err || "");
  for (const [kind, re] of FAILURE_PATTERNS) {
    if (re.test(msg)) return kind;
  }
  return "other";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let cooldownUntil = 0;
let lastFailure = null; // { kind, detail, at } — the most recent attempt's cause

/** Record a failure's cause; starts the 300 s cooldown on bot check / 429. */
function noteFailure(err) {
  const kind = classifyError(err);
  const detail = String((err && err.message) || err || "")
    .split("\n")
    .find((line) => line.trim()) || "";
  lastFailure = { kind, detail: detail.trim().slice(0, 200), at: Date.now() };
  if (kind === "botcheck" || kind === "ratelimit") {
    cooldownUntil = Date.now() + YT_COOLDOWN_MS;
  }
  return lastFailure;
}

/** Milliseconds left in the IP cooldown (0 = clear). */
function cooldownRemainingMs() {
  return Math.max(0, cooldownUntil - Date.now());
}

/** Forget the cooldown (admin escape hatch; also used by tests). */
function clearCooldown() {
  cooldownUntil = 0;
  lastFailure = null;
}

/** The cause of the most recent failed attempt, or null. */
function lastFailureInfo() {
  return lastFailure;
}

/**
 * Top `limit` matches as [{id, title, url}] in relevance order.
 * Exactly as songfetch.py: `--flat-playlist --no-warnings
 * --print "%(id)s\t%(title)s" ytsearch<limit>:<query>`, 20s timeout,
 * [] on timeout. Rethrows only when the binary is missing.
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
        print: "%(id)s\t%(title)s",
      },
      { timeoutMs }
    );
  } catch (err) {
    if (/binary not found/i.test(String((err && err.message) || err))) throw err;
    noteFailure(err); // a 429/bot check here starts the cooldown too
    return [];
  }

  const text = typeof out === "string" ? out : JSON.stringify(out || "");
  const results = [];
  for (const line of text.split("\n")) {
    const [videoId, title] = line.trim().split("\t");
    if (videoId && videoId !== "NA") {
      results.push({ id: videoId, title: title || "", url: YT_WATCH + videoId });
    }
  }
  return results;
}

// ── 2. running external tools safely (from downloader.py) ──────────────────

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
 * iTunes Search API track lookup (no API key), with exact artist match.
 * Returns the full metadata for the .play card, or null — never a wrong
 * match. This is the fix for the Deezer bug where the top hit was a
 * karaoke tribute ("Delayed Karma | Love in the Dark (Originally
 * Performed by Adele)").
 */
async function lookupTrackInfo(artist, title, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") return null;
  const q = [artist, title].filter(Boolean).join(" ").trim();
  if (!q) return null;
  try {
    const res = await fetchImpl(
      `https://itunes.apple.com/search?term=${encodeURIComponent(q)}&entity=song&limit=25`,
      { headers: { "User-Agent": "songfetch/1.0" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const rows = (data && data.results) || [];
    const wantArtist = fold(artist);
    const wantTitle = fold(title);
    for (const row of rows) {
      if (wantArtist && fold(row.artistName) !== wantArtist) continue;
      if (wantTitle && !fold(row.trackName).includes(wantTitle)) continue;
      const art = row.artworkUrl100 || "";
      return {
        artworkUrl: art ? art.replace("100x100bb.jpg", "600x600bb.jpg") : "",
        artistName: row.artistName || "",
        trackName: row.trackName || "",
        collectionName: row.collectionName || "",
        durationMs: Number(row.trackTimeMillis) || 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Cover URL only — thin wrapper over lookupTrackInfo(). Returns a 600x600
 * artwork URL or "" — never a wrong image. Caller passes the result as
 * `imageUrl` to downloadTrack().
 */
async function lookupCover(artist, title, fetchImpl = globalThis.fetch) {
  const info = await lookupTrackInfo(artist, title, fetchImpl);
  return info ? info.artworkUrl : "";
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

// ── 3. the download itself (from downloader.py: _download_track_ytdlp) ──────

/**
 * Download one track and tag it. Returns the final path, or null on failure.
 * Output layout matches the app: <outRoot>/<Artist>/<Album>/<Title>.<fmt>
 *
 * @param {object} opts
 * @param {string} opts.artist
 * @param {string} opts.title        required
 * @param {string} [opts.album]
 * @param {string} [opts.fmt]        default "mp3"
 * @param {string} [opts.outRoot]    default "."
 * @param {string} [opts.imageUrl]   cover URL (use lookupCover() to get one)
 * @param {Function} [opts.progress] called with "trying: ..." messages
 * @param {number} [opts.searchLimit] default 5
 * @param {number} [opts.searchTimeoutMs]
 * @param {number} [opts.trackTimeoutMs] per-candidate ceiling (600s)
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
    attemptGapMs = ATTEMPT_GAP_MS,
    ytdlpImpl = ytdlp,
    searchImpl = search,
    fetchImpl = globalThis.fetch,
    ffmpegImpl = runFfmpeg,
  } = opts;

  if (!title) throw new Error("title is required");

  // player.py rule: once YouTube flags the address, EVERY track fails
  // until the IP cools down — so fail fast instead of re-flagging it.
  if (cooldownRemainingMs() > 0) return null;

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
      audioQuality: "0", // best available
      noEmbedMetadata: true, // we tag it ourselves below
      noPlaylist: true,
      output: outTemplate,
      ffmpegLocation: ffmpegBinary(),
    };
    if (skipUnavailable) {
      // `-i` skips entries it cannot extract and `--max-downloads 1`
      // stops at the first that works — that exits 101 ("max downloads
      // reached"), so the exit code cannot be the success test. The file is.
      flags.ignoreErrors = true;
      flags.maxDownloads = 1;
    }
    clearPartials(outDir, safeTitle);
    let blocked = false;
    try {
      await ytdlpImpl(target, flags, { timeoutMs });
    } catch (err) {
      noteFailure(err);
      const kind = classifyError(err);
      // A bot check / 429 means the server's IP is flagged: further
      // candidates only extend the block, so tell the caller to stop.
      blocked = kind === "botcheck" || kind === "ratelimit";
      // Fall through: success is "does the file exist", not exit code.
    }
    if (fs.existsSync(finalFile)) return { ok: true, blocked: false };
    return { ok: false, blocked };
  }

  // Phase 1: search, rank, try each candidate in turn.
  const deadline = Date.now() + trackTimeoutMs * 2;
  let ok = false;
  let blocked = false;
  const candidates = await searchImpl(query, { limit: searchLimit, timeoutMs: searchTimeoutMs, ytdlpImpl });
  let first = true;
  for (const cand of rank(candidates, query)) {
    const left = deadline - Date.now();
    if (left <= 1000) break;
    if (!first && attemptGapMs > 0) await sleep(attemptGapMs);
    first = false;
    if (progress) progress(`trying: ${String(cand.title || "").slice(0, 60)}`);
    const res = await attempt(cand.url, Math.min(trackTimeoutMs, left), false);
    if (res.ok) {
      ok = true;
      break;
    }
    if (res.blocked) {
      blocked = true;
      break;
    }
  }
  if (!ok && !blocked && (!candidates || candidates.length === 0)) {
    // The search itself failed — let yt-dlp search and fetch in one go.
    // But if the search failure was a bot check / 429 (it just started
    // the cooldown), don't fallback-hammer: fail fast like player.py.
    if (cooldownRemainingMs() > 0) return null;
    ok = (await attempt(`ytsearch${searchLimit}:${query}`, trackTimeoutMs, true)).ok;
  }
  if (!ok) return null;

  // Phase 2: overwrite YouTube's metadata with the real catalogue metadata.
  // One ffmpeg pass, stream-copied (no re-encode) + embedded cover.
  // (songfetch.py uses metaflac for FLAC; metaflac is not available on
  // Render, so ffmpeg is used for all formats here.)
  const cover = `${finalFile}.cover.jpg`;
  const hasCover = Boolean(imageUrl) && (await fetchCover(imageUrl, cover, fetchImpl));
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
  cmd.push(
    "-c:a", "copy",
    "-metadata", `artist=${artist}`,
    "-metadata", `title=${title}`,
    "-metadata", `album=${album}`,
    tmpOut
  );

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
  lookupCover,
  lookupTrackInfo,
  downloadTrack,
  classifyError,
  noteFailure,
  cooldownRemainingMs,
  clearCooldown,
  lastFailureInfo,
  DEMOTE,
  YT_SEARCH_TIMEOUT_MS,
  TRACK_DL_TIMEOUT_MS,
  TAG_TIMEOUT_MS,
  YT_COOLDOWN_MS,
  ATTEMPT_GAP_MS,
};
