// y2mate-based audio downloader — now a *fallback* only.
//
// The primary path is YouTube's own InnerTube API (utils/youtube/innertube.js).
// This file is kept because it can still rescue a video when YouTube refuses
// every InnerTube client (and because it also handles the odd geo-restricted
// case). The old code here looked for an option whose quality was exactly
// "MP3"; y2mate no longer labels its buttons that way, which is what produced
// the "No audio format was available for that video" reply for every song.
// We now accept anything that looks audio-ish, and prefer a real MP3 button
// when the site happens to expose one.

const { mkdir, writeFile } = require("fs/promises");
const { dirname } = require("path");

const Y2MATE_BASE = (process.env.Y2MATE_BASE || "https://yt1d.io").replace(/\/+$/, "");
const Y2MATE_AJAX = `${Y2MATE_BASE}/wp-admin/admin-ajax.php`;
const Y2MATE_RENDER_HOST = "https://fpa-balancer.flashydl.space/get-server";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const YOUTUBE_ID_RE = /(?:v=|\/embed\/|\/shorts\/|youtu\.be\/|\/v\/)([-_0-9A-Za-z]{11})/;

const y2mateCache = new Map();

function extractVideoId(input) {
  const value = String(input || "").trim();
  if (/^[-_0-9A-Za-z]{11}$/.test(value)) return value;
  return value.match(YOUTUBE_ID_RE)?.[1] || value;
}

function safeFilename(value, fallback = "track") {
  return (
    String(value || fallback)
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100) || fallback
  );
}

async function getY2mateNonces() {
  const response = await fetch(`${Y2MATE_BASE}/`, {
    headers: { "User-Agent": BROWSER_UA, Accept: "text/html" },
  });
  const html = await response.text();
  return {
    path: new URL(response.url).pathname,
    nonce: html.match(/name="yt1_nonce" value="([^"]+)"/)?.[1],
    mergeNonce: html.match(/"merge_nonce":"([^"]+)"/)?.[1],
  };
}

function attrFrom(tag, name) {
  return tag.match(new RegExp(`data-${name}="([^"]*)"`))?.[1];
}

function looksLikeAudio(option) {
  if (option.hasAudio) return true;
  const label = `${option.quality} ${option.mime} ${option.ext}`.toLowerCase();
  if (/mp3|m4a|webm|opus|audio/.test(label)) return true;
  // y2mate labels audio renders as "128kbps", "320kbps", ... 
  return /\d+\s*kbps/.test(label);
}

async function fetchY2mateOptions(videoId) {
  const { path, nonce, mergeNonce } = await getY2mateNonces();
  if (!nonce) throw new Error("y2mate did not return a nonce");

  const response = await fetch(`${Y2MATE_BASE}/results/`, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      "content-type": "application/x-www-form-urlencoded",
      Origin: Y2MATE_BASE,
      Referer: `${Y2MATE_BASE}${path}`,
    },
    body: new URLSearchParams({
      yt1_nonce: nonce,
      _wp_http_referer: path,
      yt_video_url: `https://www.youtube.com/watch?v=${videoId}`,
    }),
  });

  const html = await response.text();

  return [...html.matchAll(/<[^>]*data-token="[^"]*"[^>]*>/g)]
    .map(([tag]) => ({
      token: attrFrom(tag, "token"),
      quality: attrFrom(tag, "quality") || "",
      mime: attrFrom(tag, "mime") || attrFrom(tag, "type") || "",
      ext: attrFrom(tag, "ext") || "",
      hasAudio: attrFrom(tag, "has-audio") === "1" || attrFrom(tag, "audio") === "1",
      size: Number.parseInt(attrFrom(tag, "filesize"), 10) || 0,
      title: attrFrom(tag, "title"),
      mergeId: attrFrom(tag, "merge-id"),
      mergeNonce: attrFrom(tag, "merge-nonce") || mergeNonce,
    }))
    .filter((option) => option.token);
}

// Rank audio candidates. y2mate's labels are inconsistent ("MP3", "128kbps",
// "H.264", sometimes with data-has-audio on video rows too), and a naive
// parseInt would happily read "1080p" as bitrate 1080 — hence real scoring.
function audioScore(option) {
  const label = `${option.quality} ${option.mime} ${option.ext}`.toLowerCase();
  const kbps = Number.parseInt((label.match(/(\d+)\s*kbps/) || [])[1], 10) || 0;

  let score = 0;
  if (/mp3/.test(label)) score += 1000;
  if (/kbps/.test(label)) score += 200;
  if (/audio|m4a|opus|webm/.test(label)) score += 100;
  if (/^\s*\d{3,4}p\s*$/i.test(option.quality || "")) score -= 500;
  if (/video/.test(label)) score -= 300;

  return { score, kbps };
}

function pickAudioOption(options) {
  const audio = options.filter(looksLikeAudio);
  if (!audio.length) return null;

  return (
    audio
      .slice()
      .sort((a, b) => {
        const left = audioScore(a);
        const right = audioScore(b);
        return right.score - left.score || right.kbps - left.kbps;
      })[0] || audio[0]
  );
}

async function getY2mateInfo(idOrUrl) {
  const cacheKey = String(idOrUrl);
  if (y2mateCache.has(cacheKey)) return y2mateCache.get(cacheKey);

  const videoId = extractVideoId(idOrUrl);
  const options = await fetchY2mateOptions(videoId);
  if (!options.length) return null;

  const best = pickAudioOption(options);
  const audio = {};
  if (best) audio[best.quality || "audio"] = best;

  const info = {
    id: videoId,
    title: options[0].title || videoId,
    thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    audio,
  };
  y2mateCache.set(cacheKey, info);
  return info;
}

async function resolveY2mateStreams(option) {
  const body = new URLSearchParams();
  body.append("action", "yt1_resolve_streams");
  body.append("nonce", option.mergeNonce);
  body.append("token", option.token);
  body.append("quality", option.quality);

  const response = await fetch(Y2MATE_AJAX, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: `${Y2MATE_BASE}/results/`,
    },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!json.success || !json.data) throw new Error("y2mate stream resolution failed");

  return {
    audioUrl: json.data.audio_url || json.data.url || "",
  };
}

async function startY2mateRender(request, nonce) {
  const body = new URLSearchParams();
  body.append("action", "process_video_merge");
  body.append("nonce", nonce);
  body.append("request_data", JSON.stringify(request));

  const response = await fetch(Y2MATE_AJAX, {
    method: "POST",
    headers: {
      "User-Agent": BROWSER_UA,
      Referer: `${Y2MATE_BASE}/results/`,
    },
    body,
  });
  const json = await response.json().catch(() => ({}));
  if (!json.success) {
    throw new Error(
      `y2mate render start failed: ${JSON.stringify(json.data || json).slice(0, 160)}`
    );
  }
}

async function waitForY2mateResult(jobId, timeoutMs = 120000) {
  const WebSocket = require("ws");

  const hostResponse = await fetch(Y2MATE_RENDER_HOST, {
    headers: { "User-Agent": BROWSER_UA },
  });
  const host = (await hostResponse.text()).trim();
  if (!host) throw new Error("y2mate did not return a render host");

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://${host}/pub/render/status_ws/${jobId}`, {
      headers: { "User-Agent": BROWSER_UA },
    });

    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("y2mate render timed out"));
    }, timeoutMs);

    socket.on("message", (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (data.status === "done" && data.output?.url) {
        clearTimeout(timer);
        socket.close();
        resolve(data.output.url);
      } else if (data.error) {
        clearTimeout(timer);
        socket.close();
        reject(new Error(JSON.stringify(data.error)));
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function downloadAudioUrl(idOrUrl) {
  const info = y2mateCache.get(String(idOrUrl)) || (await getY2mateInfo(idOrUrl));
  if (!info) throw new Error("y2mate returned no download options");

  const option = Object.values(info.audio)[0];
  if (!option) throw new Error("y2mate exposed no audio option");

  const streams = await resolveY2mateStreams(option);
  if (!streams.audioUrl) throw new Error("y2mate returned no audio stream");

  const isWebm = /webm|opus/i.test(`${option.mime} ${option.ext}`);
  const request = {
    id: `${option.mergeId}_${option.quality}`,
    ttl: 3600000,
    chunk: { size: 209715200, concurrency: 3 },
    inputs: [{ url: streams.audioUrl, ext: isWebm ? "webm" : "m4a" }],
    output: {
      ext: "mp3",
      downloadName: `${safeFilename(option.title)}_MP3.mp3`,
      chunkUpload: { size: 209715200, concurrency: 3 },
    },
    operation: { type: "no_process" },
  };

  await startY2mateRender(request, option.mergeNonce);
  const url = await waitForY2mateResult(request.id);
  return { url, title: option.title || info.title };
}

async function downloadUrlToBuffer(url, timeout = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Download failed with status ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (!buffer.length) throw new Error("The media response was empty");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fallback entry point: fetch a track through y2mate and write it to `filePath`.
 * y2mate's render already outputs MP3, so the file is sent as-is.
 */
async function downloadY2mateAudioToFile(videoId, filePath) {
  const { url, title } = await downloadAudioUrl(videoId);
  const buffer = await downloadUrlToBuffer(url);

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, buffer);

  const info = y2mateCache.get(String(videoId));
  return {
    source: "y2mate",
    mimeType: "audio/mpeg",
    bytes: buffer.length,
    title: title || info?.title || "",
    author: "",
    durationSec: 0,
    thumbnail: info?.thumbnail || null,
  };
}

module.exports = {
  extractVideoId,
  getY2mateInfo,
  downloadAudioUrl,
  downloadUrlToBuffer,
  downloadY2mateAudioToFile,
  safeFilename,
  pickAudioOption,
};
