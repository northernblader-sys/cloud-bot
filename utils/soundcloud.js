"use strict";
/**
 * SoundCloud support for cloud-bot.
 *
 * Works out of a link like:
 *   https://soundcloud.com/blogger-2/eminem-mockingbird-lyrics?si=10558d09...
 *
 * Chain:
 *   1. prexzyapis.com /search/soundcloud      -> find a track by name
 *   2. prexzyapis.com /download/soundcloud    -> full metadata + links
 *   3. downloadUrl                            -> real audio bytes (m4a/aac)
 *   4. streams.hq (HLS .m3u8) via ffmpeg      -> fallback if 3 breaks
 *
 * No API key. Links carry an `expires=` stamp, so never cache them.
 */

const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");

const { fold, rank } = require("./songfetch");

const API = (process.env.PREXZY_API_URL || "https://prexzyapis.com").replace(/\/+$/, "");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

const MAX_BYTES = 40 * 1024 * 1024; // WhatsApp audio ceiling we care about
const API_TIMEOUT_MS = 45_000;
const HLS_TIMEOUT_MS = 120_000;

const SC_LINK_RE = /https?:\/\/(?:www\.|m\.)?(?:soundcloud\.com|snd\.sc)\/[^\s<>"']+/i;
const SC_HOST_RE = /^(?:www\.|m\.)?(?:soundcloud\.com|snd\.sc)$/i;

// SoundCloud-specific junk patterns for ranking (the YouTube rank() in
// songfetch.js already covers live/karaoke/cover). "push sped up, slowed,
// cover, remix to the back, same rule as your YouTube ranking" — and the
// same exception: a keyword the user searched for is not a penalty.
const SC_DEMOTE = {
  sped: /\bsped(\s*up)?\b|\bnightcore\b|\b8d(\s*audio)?\b/,
  slowed: /\bslowed(\s*(down|\+?\s*and\s*|\+?\s*n\s*)?(\s*reverb)?)?\b|\breverb\b/,
  remix: /\bremix(es)?\b|\bbootleg\b|\bedit\b/,
};

/** Stable two-tier ranking: SC junk to the back, then songfetch.rank order. */
function rankSoundCloud(candidates, query) {
  const foldedQuery = fold(query);
  const active = Object.entries(SC_DEMOTE)
    .filter(([, re]) => !re.test(foldedQuery))
    .map(([, re]) => re);
  const marked = (candidates || []).map((c) => ({
    ...c,
    _scJunk: active.some((re) => re.test(fold(c && c.title))),
  }));
  return rank(marked.filter((c) => !c._scJunk), query).concat(
    rank(marked.filter((c) => c._scJunk), query)
  );
}

/* ------------------------------------------------------------------ */
/* URL helpers                                                         */
/* ------------------------------------------------------------------ */

/** Pull a SoundCloud link out of any message text (or return null). */
function extractSoundCloudUrl(text) {
  const match = String(text || "").match(SC_LINK_RE);
  return match ? stripTracking(match[0]) : null;
}

function isSoundCloudUrl(text) {
  return Boolean(extractSoundCloudUrl(text));
}

/** Drop ?si=..., utm_* and other share junk — the API only needs the path. */
function stripTracking(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!SC_HOST_RE.test(url.hostname)) return rawUrl;
    return `${url.protocol}//${url.hostname}${url.pathname}`;
  } catch {
    return rawUrl;
  }
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function getJson(pathname, params = {}, timeout = API_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const url = new URL(API + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  const res = await fetchImpl(url, {
    headers: { Accept: "application/json", "User-Agent": UA },
    signal: AbortSignal.timeout(timeout),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`SoundCloud API returned non-JSON (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }
  if (!res.ok || data.status === false) {
    throw new Error(data.error || data.message || `SoundCloud API HTTP ${res.status}`);
  }
  return data;
}

/** Read a URL into a Buffer, refusing anything bigger than MAX_BYTES. */
async function fetchAudioBuffer(url, timeout = HLS_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(url, {
    headers: { "User-Agent": UA, Accept: "audio/*,*/*" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`audio fetch HTTP ${res.status}`);

  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > MAX_BYTES) throw new Error(`audio is too large (${Math.round(declared / 1048576)} MB)`);

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 20_000) {
    // A JSON error body served with 200 is the classic trap here.
    throw new Error(`audio too small (${buf.length} bytes) — probably an error page`);
  }
  if (buf.length > MAX_BYTES) throw new Error("audio exceeded size limit");
  // Step 6 sanity check: a real AAC-in-MP4 starts with an ftyp box
  // (bytes 4..8). Anything else (HTML, JSON) is an error page — throw it
  // away, never send it to WhatsApp.
  if (buf.subarray(4, 8).toString("latin1") !== "ftyp") {
    throw new Error("downloaded bytes are not an MP4/AAC file (missing ftyp box)");
  }
  return buf;
}

/* ------------------------------------------------------------------ */
/* 1. search                                                           */
/* ------------------------------------------------------------------ */

/**
 * Search SoundCloud by name.
 * @returns {Promise<Array<{id,title,url,duration,thumbnail,author}>>}
 */
async function searchSoundCloud(query, limit = 8, fetchImpl = globalThis.fetch) {
  const data = await getJson("/search/soundcloud", { q: String(query || "").trim() }, API_TIMEOUT_MS, fetchImpl);
  const list = Array.isArray(data.data) ? data.data : data.data ? [data.data] : [];
  return list
    .filter((t) => t && t.url && /soundcloud\.com\//i.test(t.url))
    .slice(0, limit)
    .map((t) => ({
      id: t.id,
      title: t.title || "Unknown",
      url: stripTracking(t.url),
      duration: t.duration || "",
      thumbnail: t.thumbnail || t.artwork || "",
      author: t.author?.username || t.user?.username || "",
    }));
}

/* ------------------------------------------------------------------ */
/* 2. resolve: link (or name) -> metadata + playable links             */
/* ------------------------------------------------------------------ */

/**
 * Turn a SoundCloud link (or a song name) into everything we need.
 * @returns {Promise<{title,author,duration,durationMs,artwork,url,id,
 *                    downloadUrl,streamUrl,streamUrlLq,stats}>}
 */
async function resolveSoundCloud(input, fetchImpl = globalThis.fetch) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("nothing to resolve");

  let target = stripTracking(raw);
  if (!SC_LINK_RE.test(raw)) {
    // Not a link -> treat it as a search query and take the first hit.
    const hits = await searchSoundCloud(raw, 5, fetchImpl);
    if (!hits.length) throw new Error(`no SoundCloud result for "${raw}"`);
    target = hits[0].url;
  }

  const data = await getJson("/download/soundcloud", { url: target }, API_TIMEOUT_MS, fetchImpl);
  const d = data.data || {};

  const streamUrl = d.streams?.hq || d.streams?.lq || "";
  const downloadUrl = d.downloadUrl || (d.id
    ? `${API}/download/soundcloud?id=${d.id}&mode=audio&quality=hq`
    : "");

  if (!downloadUrl && !streamUrl) throw new Error("SoundCloud returned no playable link");

  return {
    id: d.id,
    title: d.title || "Unknown",
    author: d.author?.username || "",
    duration: d.duration || "",
    durationMs: d.durationMs || 0,
    artwork: d.artwork || d.thumbnail || "",
    url: stripTracking(d.url || target),
    genre: d.genre || "",
    stats: d.stats || {},
    downloadUrl,
    streamUrl,
    streamUrlLq: d.streams?.lq || "",
  };
}

/* ------------------------------------------------------------------ */
/* 3. download bytes                                                   */
/* ------------------------------------------------------------------ */

async function hlsToBuffer(m3u8Url, timeout = HLS_TIMEOUT_MS, opts = {}) {
  // opts.ffmpegPath overrides the binary — tests point it at a fake
  // executable that writes a file to args[last] and exits 0.
  let ffmpegPath = opts.ffmpegPath;
  if (!ffmpegPath) {
    ffmpegPath = "ffmpeg";
    try {
      ffmpegPath = require("ffmpeg-static") || ffmpegPath;
    } catch {
      /* fall back to PATH */
    }
  }

  const tmpOut = path.join(os.tmpdir(), `sc-${Date.now()}-${Math.random().toString(36).slice(2)}.m4a`);

  await new Promise((resolve, reject) => {
    const args = [
      "-y", "-v", "error",
      "-user_agent", UA,
      "-i", m3u8Url,
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      tmpOut,
    ];
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg HLS failed (${code}): ${stderr.slice(-160)}`));
    });
  });

  const buf = await fsp.readFile(tmpOut);
  await fsp.unlink(tmpOut).catch(() => {});
  if (buf.length < 20_000) throw new Error("HLS produced an empty file");
  return buf;
}

/**
 * Get the actual audio for a link or name.
 * @returns {Promise<{buffer,ext,mime,title,author,duration,artwork,url,via}>}
 */
async function downloadSoundCloud(input, { onProgress, fetchImpl, ffmpegPath } = {}) {
  const track = await resolveSoundCloud(input, fetchImpl);
  const meta = {
    title: track.title,
    author: track.author,
    duration: track.duration,
    durationMs: track.durationMs,
    artwork: track.artwork,
    url: track.url,
    id: track.id,
  };

  if (track.downloadUrl) {
    try {
      onProgress?.("downloading");
      const buffer = await fetchAudioBuffer(track.downloadUrl, HLS_TIMEOUT_MS, fetchImpl);
      return { ...meta, buffer, ext: "m4a", mime: "audio/mp4", via: "prexzy-direct" };
    } catch (err) {
      if (!track.streamUrl) throw err;
      onProgress?.("fallback-hls");
    }
  }

  const buffer = await hlsToBuffer(track.streamUrl, HLS_TIMEOUT_MS, { ffmpegPath });
  return { ...meta, buffer, ext: "m4a", mime: "audio/mp4", via: "hls" };
}

/**
 * Chain-level helper used by commands/music.js: try every ranked
 * candidate ("try data[1] from search" on failure), writing the winner
 * to `<outBase>.m4a` — the same cache layout the YouTube chain uses.
 * The byte/HLS links carry expires= stamps, so nothing but the file is
 * ever stored.
 *
 * @param {object} opts
 * @param {Array<{id,title,url}>} opts.candidates  ranked SC search rows
 * @param {string} opts.outBase        output path WITHOUT extension
 * @param {Function} [opts.onAttempt]  per-attempt label for chat edits
 * @param {Function} [opts.fetchImpl]  fetch injection for tests
 * @param {string} [opts.ffmpegPath]   binary override for the HLS fallback
 * @returns {Promise<{path,source,title,author,url}|null>} null when every candidate failed
 */
async function downloadSoundCloudCandidates({
  candidates,
  outBase,
  onAttempt = null,
  fetchImpl = globalThis.fetch,
  ffmpegPath,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const dest = `${outBase}.m4a`;
  const failures = [];

  for (const cand of list) {
    const link = cand && (cand.url || cand.pageUrl);
    if (!link) continue;
    // Generic label — the caller prefixes the chain position ("API 3").
    if (onAttempt) onAttempt(String(cand.title || link).slice(0, 48));
    try {
      const got = await downloadSoundCloud(link, { fetchImpl, ffmpegPath });
      await fsp.writeFile(dest, got.buffer);
      return {
        path: dest,
        source: "soundcloud",
        title: got.title || cand.title || "",
        author: got.author || "",
        artwork: got.artwork || "",
        url: got.url || link,
      };
    } catch (err) {
      failures.push(`${cand.id || link}: ${String((err && err.message) || err).slice(0, 160)}`);
      // Never leave a half-written/JSON-page file for the next attempt.
      await fsp.unlink(dest).catch(() => {});
    }
  }

  if (failures.length > 0) {
    console.error("[soundcloud] all candidates failed:\n  " + failures.join("\n  "));
  }
  return null;
}

/** Convenience: name -> playable SoundCloud link (no download). */
async function findSoundCloudLink(query) {
  const track = await resolveSoundCloud(query);
  return {
    title: track.title,
    author: track.author,
    duration: track.duration,
    pageUrl: track.url,
    audioUrl: track.downloadUrl || track.streamUrl,
  };
}

module.exports = {
  extractSoundCloudUrl,
  isSoundCloudUrl,
  stripTracking,
  searchSoundCloud,
  resolveSoundCloud,
  downloadSoundCloud,
  downloadSoundCloudCandidates,
  rankSoundCloud,
  findSoundCloudLink,
  SC_DEMOTE,
};

