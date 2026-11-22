"use strict";

/**
 * songApis — YouTube-to-audio HTTP APIs used BEFORE the yt-dlp fallback.
 *
 * The bot's own server IP never touches YouTube through these: both APIs
 * return a download URL for a file sitting on someone else's CDN, so a
 * flagged datacenter IP (Render) or dead proxy doesn't matter for them.
 *
 *   1. Knight  — GET {KNIGHT_API_URL}/api/download/ytaudio
 *                ?format=128kbps&apikey=knight&url=<watch url>
 *                -> { success, result: { title, id, download } }
 *                `download` is an MP3 on savetube.vip's CDN: no IP lock,
 *                no expiry. apikey=knight is the free shared key from
 *                KnightBot's public repo — not a secret.
 *   2. Prexzy  — GET {PREXZY_API_URL}/download/ytmp3?url=<watch url>
 *                -> { status, info: {...}, download_url }
 *                `download_url` is a raw googlevideo.com link (.m4a) that
 *                EXPIRES within hours — download it immediately and never
 *                store the URL. Response body is ~10 KB; never log it whole.
 *
 * Chat labels are generic on purpose — the user asked to never show the
 * API service names: stages appear as "API 1", "API 2", ... following the
 * chain order (API 1 = Knight, API 2 = Prexzy). The mapping lives in the
 * README only. The caller can reorder via downloadViaApis()'s `order`
 * option; the numbering follows whatever order is active.
 *
 * The same API is retried with the NEXT candidate video before switching
 * APIs — one dead upload is not a dead API (measured: the official Adele
 * upload failed on both while 5 of 6 other uploads worked instantly).
 *
 * Both are unofficial scrapers: they can change or vanish without notice,
 * which is why the base URLs live in env vars (KNIGHT_API_URL /
 * PREXZY_API_URL) and can be swapped without touching code.
 */

const fs = require("fs");

const DEFAULT_KNIGHT_URL = "https://knightbotapi.stream";
const DEFAULT_PREXZY_URL = "https://prexzyapis.com";
const UA = "Mozilla/5.0 (X11; Linux x86_64) songfetch/1.0";

// Per-request ceiling and sanity floors for saved audio.
const MAX_BYTES_DEFAULT = 40 * 1024 * 1024; // 40 MB — way above any song
const MIN_BYTES = 64 * 1024; // shorter than 8s @64kbps = broken
const PROBE_BYTES = 200 * 1024; // ranged probe per the method write-up

/** fetch with a hard timeout (AbortController). */
async function fetchWithTimeout(url, opts = {}, timeoutMs = 25000, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== "function") throw new Error("fetch unavailable");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...opts, signal: ctrl.signal });
  } catch (err) {
    const name = String((err && err.name) || "");
    const msg = String((err && err.message) || err || "");
    if (name === "AbortError" || /abort/i.test(msg)) {
      throw new Error(`request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function knightBaseUrl() {
  return (process.env.KNIGHT_API_URL || DEFAULT_KNIGHT_URL).replace(/\/+$/, "");
}

function prexzyBaseUrl() {
  return (process.env.PREXZY_API_URL || DEFAULT_PREXZY_URL).replace(/\/+$/, "");
}

/**
 * Knight API: ask for the 128kbps audio of one video.
 * Checks, in the write-up's order: HTTP ok -> success === true ->
 * result.download starts with http. Returns { title, id, download }.
 */
async function fetchKnight(videoUrl, opts = {}) {
  const {
    baseUrl = knightBaseUrl(),
    apiKey = process.env.KNIGHT_API_KEY || "knight",
    fetchImpl = globalThis.fetch,
    timeoutMs = 25000,
  } = opts;
  const endpoint =
    `${baseUrl}/api/download/ytaudio?format=128kbps` +
    `&apikey=${encodeURIComponent(apiKey)}&url=${encodeURIComponent(videoUrl)}`;
  const res = await fetchWithTimeout(
    endpoint,
    { headers: { "User-Agent": UA, Accept: "application/json" }, redirect: "follow" },
    timeoutMs,
    fetchImpl
  );
  if (!res.ok) throw new Error(`Knight API HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Knight API returned non-JSON response");
  }
  if (!data || data.success !== true) {
    const why = data && (data.message || data.error || data.result && data.result.message);
    throw new Error(`Knight API: success=false${why ? ` (${String(why).slice(0, 120)})` : ""}`);
  }
  const download = data.result && data.result.download;
  if (typeof download !== "string" || !/^https?:\/\//i.test(download)) {
    throw new Error("Knight API: no download URL in response");
  }
  return {
    title: (data.result && data.result.title) || "",
    id: (data.result && data.result.id) || "",
    download,
    thumbnail: (data.result && data.result.thumbnail) || "",
  };
}

/**
 * Prexzy API: .m4a (AAC) fallback. Checks: status === true ->
 * download_url is a non-empty http URL. Returns { title, id, download, ext }.
 * The download_url expires within hours — the caller downloads immediately.
 */
async function fetchPrexzy(videoUrl, opts = {}) {
  const {
    baseUrl = prexzyBaseUrl(),
    fetchImpl = globalThis.fetch,
    timeoutMs = 25000,
  } = opts;
  const endpoint = `${baseUrl}/download/ytmp3?url=${encodeURIComponent(videoUrl)}`;
  const res = await fetchWithTimeout(
    endpoint,
    { headers: { "User-Agent": UA, Accept: "application/json" }, redirect: "follow" },
    timeoutMs,
    fetchImpl
  );
  if (!res.ok) throw new Error(`Prexzy API HTTP ${res.status}`);
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error("Prexzy API returned non-JSON response");
  }
  if (!data || data.status !== true) {
    const why = data && (data.message || data.error || data.info && data.info.error);
    throw new Error(`Prexzy API: status=false${why ? ` (${String(why).slice(0, 120)})` : ""}`);
  }
  const download = data.download_url;
  if (typeof download !== "string" || !/^https?:\/\//i.test(download)) {
    throw new Error("Prexzy API: no download_url in response");
  }
  return {
    title: (data.info && data.info.title) || "",
    id: (data.info && data.info.id) || "",
    download,
    ext: data.ext || "m4a",
    thumbnail: (data.info && data.info.thumbnail) || "",
    uploader: (data.info && (data.info.uploader || data.info.channel)) || "",
  };
}

/**
 * Save one download URL to disk. Ranged GET probe first (confirms bytes
 * without pulling the whole file), then the full download with a size
 * cap and a floor: anything under 64 KB is a broken/truncated response.
 */
async function downloadTo(
  url,
  destPath,
  { fetchImpl = globalThis.fetch, timeoutMs = 60000, maxBytes = MAX_BYTES_DEFAULT } = {}
) {
  // 1. Probe: a ranged GET of the first 200 KB is enough to confirm bytes.
  const probe = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": UA, Range: `bytes=0-${PROBE_BYTES - 1}` }, redirect: "follow" },
    timeoutMs,
    fetchImpl
  );
  if (!probe.ok) throw new Error(`download probe HTTP ${probe.status}`);

  // 2. Full download.
  const res = await fetchWithTimeout(
    url,
    { headers: { "User-Agent": UA }, redirect: "follow" },
    timeoutMs,
    fetchImpl
  );
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > maxBytes) throw new Error(`file too large (${declared} bytes)`);
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > maxBytes) throw new Error(`file too large (${body.length} bytes)`);
  if (body.length < MIN_BYTES) {
    throw new Error(`download looks truncated/broken (${body.length} bytes)`);
  }
  await fs.promises.writeFile(destPath, body);
  return { bytes: body.length };
}

/**
 * The API phase of the fallback chain: every candidate through the FIRST
 * API (same API, next video ID), then every candidate through the second,
 * then give up (caller falls back further). `opts.order` picks which API
 * goes first — default ["knight", "prexzy"] (Knight first, per the user).
 * Chat labels are generic: "API 1", "API 2" — never the service names.
 *
 * @param {object} opts
 * @param {Array<{id,title,url}>} opts.candidates  ranked search results
 * @param {string} opts.outBase        output path WITHOUT extension;
 *                                     writes `<outBase>.mp3` (Knight) or
 *                                     `<outBase>.m4a` (Prexzy)
 * @param {Array<"knight"|"prexzy">} [opts.order] API priority
 * @param {Function} [opts.onAttempt]  called with a short label before
 *                                     each attempt (chat status edits)
 * @param {Function} [opts.fetchImpl]  injection point for tests
 * @param {number} [opts.apiTimeoutMs] per API request (default 25 s —
 *                                     Knight takes ~7 s even to fail)
 * @param {number} [opts.downloadTimeoutMs] per file download (default 120 s)
 * @returns {Promise<{path, source, apiNo, title, thumbnail, author}|null>}
 *   null when every attempt failed; apiNo is the 1-based chain position
 *   for the generic chat labels.
 */
async function downloadViaApis({
  candidates,
  outBase,
  order = ["knight", "prexzy"],
  onAttempt = null,
  fetchImpl = globalThis.fetch,
  apiTimeoutMs = 25000,
  downloadTimeoutMs = 120 * 1000,
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const apis = Array.isArray(order) ? order.filter((a) => a === "knight" || a === "prexzy") : [];
  if (apis.length === 0) apis.push("knight", "prexzy");
  const failures = [];

  for (let i = 0; i < apis.length; i++) {
    const api = apis[i];
    const apiNo = i + 1;
    for (const cand of list) {
      const watchUrl = cand && cand.url;
      if (!watchUrl) continue;
      if (onAttempt) {
        onAttempt(`🌐 API ${apiNo}: ${String(cand.title || cand.id || "").slice(0, 48)}`);
      }
      try {
        let info;
        let dest;
        if (api === "knight") {
          info = await fetchKnight(watchUrl, { fetchImpl, timeoutMs: apiTimeoutMs });
          dest = `${outBase}.mp3`;
        } else {
          info = await fetchPrexzy(watchUrl, { fetchImpl, timeoutMs: apiTimeoutMs });
          dest = `${outBase}.${info.ext === "mp3" ? "mp3" : "m4a"}`;
        }
        await downloadTo(info.download, dest, { fetchImpl, timeoutMs: downloadTimeoutMs });
        return {
          path: dest,
          source: api,
          apiNo,
          title: info.title || cand.title || "",
          thumbnail: info.thumbnail || "",
          author: info.uploader || "",
        };
      } catch (err) {
        failures.push(`${api}#${cand.id}: ${String((err && err.message) || err).slice(0, 160)}`);
        // Clean a half-written file so the next attempt starts fresh.
        await fs.promises.unlink(`${outBase}.mp3`).catch(() => {});
        await fs.promises.unlink(`${outBase}.m4a`).catch(() => {});
      }
    }
  }

  if (failures.length > 0) {
    // Only the compact per-attempt lines — never a full API body (~10 KB).
    console.error("[songapis] all API attempts failed:\n  " + failures.join("\n  "));
  }
  return null;
}

module.exports = {
  fetchKnight,
  fetchPrexzy,
  downloadTo,
  downloadViaApis,
  fetchWithTimeout,
  DEFAULT_KNIGHT_URL,
  DEFAULT_PREXZY_URL,
  MAX_BYTES_DEFAULT,
  MIN_BYTES,
  PROBE_BYTES,
};
