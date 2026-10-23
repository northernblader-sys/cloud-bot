// Secondary audio sources: public YouTube frontends/APIs (Piped, Invidious,
// cobalt) plus a fully custom endpoint.
//
// Why this exists: YouTube's own InnerTube API (utils/youtube/innertube.js) is
// the best source, but it is the same API everyone else hammers, so from a
// datacenter IP it can start answering "Sign in to confirm you're not a bot"
// for every client. Piped/Invidious/cobalt are open-source proxies that do
// that work from their own IPs and hand back a plain media URL we can stream —
// so when InnerTube and y2mate both refuse, one of these usually still has it.
//
// Configure with env vars (all optional):
//   YT_AUDIO_APIS       ordered list of providers, e.g. "piped,cobalt" or a
//                       bare template URL "https://api.example/dl?id={id}&x=1"
//   PIPED_INSTANCES     comma separated Piped API base URLs
//   INVIDIOUS_INSTANCES comma separated Invidious base URLs
//   COBALT_API_URL      a cobalt instance (https://github.com/imputnet/cobalt)

const { open, rm } = require("fs/promises");
const { downloadUrlToFile } = require("./innertube");

const DEFAULT_PIPED = [
  "https://pipedapi.kavin.rocks",
  "https://pipedapi.adminforge.de",
  "https://api.piped.private.coffee",
];

const DEFAULT_INVIDIOUS = [
  "https://inv.nadeko.net",
  "https://invidious.nerdvpn.de",
];

const REQUEST_TIMEOUT_MS = 15000;
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;

function envList(name) {
  const value = process.env[name];
  if (!value || !value.trim()) return null;
  const list = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return list.length ? list : null;
}

/**
 * Does this buffer actually look like audio? Frontends sometimes answer with
 * an HTML error page or a JSON blob, and shipping that as a voice note is
 * exactly the "it sent something but no audio plays" failure.
 */
function isLikelyAudio(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;

  const head = buffer.subarray(0, 16);
  const ascii = head.toString("latin1");

  if (ascii.startsWith("ID3")) return true; // MP3 with ID3 tag
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  if (ascii.slice(4, 8) === "ftyp") return true; // MP4/M4A/AAC container
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // EBML/WebM
  if (ascii.startsWith("OggS")) return true; // Ogg/Opus
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return true; // WAV
  if (ascii.startsWith("fLaC")) return true; // FLAC

  return false;
}

// First 64 bytes are enough for every magic-number check below.
async function readHead(filePath, length = 64) {
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => {});
  }
}

async function getJson(url, options = {}) {
  const { method = "GET", body, headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers: {
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        accept: "application/json",
        ...headers,
      },
      body,
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("response was not JSON");
    }
  } finally {
    clearTimeout(timer);
  }
}

function absoluteUrl(url, base) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("/") && base) return `${base.replace(/\/+$/, "")}${url}`;
  return null;
}

function pickBestAudio(list, getUrl, getMime, getBitrate, base) {
  const candidates = (list || [])
    .map((item) => ({
      url: absoluteUrl(getUrl(item), base),
      mime: String(getMime(item) || ""),
      bitrate: Number(getBitrate(item)) || 0,
    }))
    .filter((item) => item.url);

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.bitrate - a.bitrate);
  return candidates[0];
}

// ── Piped ──────────────────────────────────────────────────────────
// GET /streams/{id} -> { title, uploader, duration, audioStreams: [{url, mimeType, bitrate}] }
async function fromPiped(videoId, instance) {
  const base = instance.replace(/\/+$/, "");
  const data = await getJson(`${base}/streams/${videoId}`);

  if (data?.error) throw new Error(data.error.message || data.error);
  const best = pickBestAudio(
    data?.audioStreams,
    (item) => item.url,
    (item) => item.mimeType,
    (item) => item.bitrate,
    base
  );
  if (!best) throw new Error("no audio streams returned");

  return {
    provider: `piped:${new URL(base).host}`,
    url: best.url,
    mimeType: best.mime,
    title: data.title || "",
    author: data.uploader || "",
    durationSec: Math.round(Number(data.duration) || 0),
  };
}

// ── Invidious ──────────────────────────────────────────────────────
// GET /api/v1/videos/{id} -> { title, author, lengthSeconds, adaptiveFormats: [...] }
async function fromInvidious(videoId, instance) {
  const base = instance.replace(/\/+$/, "");
  const data = await getJson(`${base}/api/v1/videos/${videoId}`);

  if (data?.error) throw new Error(data.error);
  const formats = (data?.adaptiveFormats || []).filter((format) =>
    /audio\//i.test(String(format.type || "")) && !/video/i.test(String(format.type || ""))
  );

  const best = pickBestAudio(
    formats.length ? formats : data?.adaptiveFormats,
    (item) => item.url || item.signatureCipher,
    (item) => item.type,
    (item) => item.bitrate,
    base
  );

  // Some instances only expose the combined (video+audio) stream.
  const fallback = !best
    ? pickBestAudio(
        data?.formatStreams,
        (item) => item.url,
        (item) => item.type,
        (item) => item.bitrate,
        base
      )
    : best;

  if (!fallback) throw new Error("no audio formats returned");

  return {
    provider: `invidious:${new URL(base).host}`,
    url: fallback.url,
    mimeType: fallback.mime,
    title: data.title || "",
    author: data.author || "",
    durationSec: Math.round(Number(data.lengthSeconds) || 0),
  };
}

// ── cobalt ─────────────────────────────────────────────────────────
// POST /  { url, downloadMode: "audio" }  ->  { status, url }
async function fromCobalt(videoId, instance) {
  const base = instance.replace(/\/+$/, "");
  const data = await getJson(base, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      downloadMode: "audio",
      audioFormat: "mp3",
      videoQuality: "360",
    }),
  });

  if (data?.status === "error" || data?.error) {
    throw new Error(data?.error?.code || data?.text || "cobalt returned an error");
  }
  if (!data?.url) throw new Error(`cobalt returned status "${data?.status || "unknown"}"`);

  return {
    provider: `cobalt:${new URL(base).host}`,
    url: data.url,
    mimeType: data.url.includes(".mp3") ? "audio/mpeg" : "",
    title: data.filename || "",
    author: "",
    durationSec: 0,
  };
}

// ── custom template ────────────────────────────────────────────────
// "https://api.example/dl?id={id}" -> the response is JSON (or plain text)
// containing a media URL. Real APIs return these with or without a file
// extension (googlevideo URLs have none at all), so we collect every URL we
// can find, rank the audio-looking ones first, and let the download + magic
// number check throw out anything that isn't actually audio.
const NON_AUDIO_RE = /\.(jpe?g|png|gif|webp|svg|ico|css|js|html?|json|xml)(\?|$)/i;
const AUDIO_HINT_RE = /\.(mp3|m4a|mp4|webm|opus|ogg|aac|flac)(\?|$)/i;

function scoreMediaUrl(url) {
  if (!/^https?:\/\//i.test(url)) return 0;
  if (NON_AUDIO_RE.test(url)) return 0;
  if (AUDIO_HINT_RE.test(url)) return 3;
  if (/googlevideo|\/audio|audio%2F|mime=audio/i.test(url)) return 2;
  return 1;
}

function collectMediaUrls(value, found = [], depth = 0) {
  if (depth > 6 || value == null) return found;

  if (typeof value === "string") {
    for (const match of value.match(/https?:\/\/[^\s"'<>\\]+/gi) || []) {
      const score = scoreMediaUrl(match);
      if (score) found.push({ url: match, score });
    }
    return found;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectMediaUrls(item, found, depth + 1);
    return found;
  }

  if (typeof value === "object") {
    // Keys that conventionally hold the download link score higher.
    for (const [key, item] of Object.entries(value)) {
      const bonus = /url|link|download|audio|mp3|stream/i.test(key) ? 1 : 0;
      const before = found.length;
      collectMediaUrls(item, found, depth + 1);
      if (bonus) {
        for (let i = before; i < found.length; i += 1) found[i].score += bonus;
      }
    }
  }

  return found;
}

function findUrlInJson(value) {
  const best = collectMediaUrls(value).sort((a, b) => b.score - a.score)[0];
  return best ? best.url : null;
}

async function fromTemplate(videoId, template) {
  const url = template.replace(/\{id\}/g, encodeURIComponent(videoId));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0", accept: "application/json, text/plain, */*" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const text = await response.text();
    let mediaUrl = null;

    if (/^https?:\/\/\S+$/i.test(text.trim()) && scoreMediaUrl(text.trim())) {
      mediaUrl = text.trim();
    } else {
      try {
        mediaUrl = findUrlInJson(JSON.parse(text));
      } catch {
        // Not JSON: still let the URL scan look at the raw body.
        mediaUrl = findUrlInJson(text);
      }
    }

    if (!mediaUrl) throw new Error("no media URL in response");

    return {
      provider: "custom-api",
      url: mediaUrl,
      mimeType: "",
      title: "",
      author: "",
      durationSec: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildProviders() {
  const overrides = envList("YT_AUDIO_APIS");
  const piped = envList("PIPED_INSTANCES") || DEFAULT_PIPED;
  const invidious = envList("INVIDIOUS_INSTANCES") || DEFAULT_INVIDIOUS;
  const cobalt = envList("COBALT_INSTANCES") || (process.env.COBALT_API_URL ? [process.env.COBALT_API_URL] : []);

  const named = {
    piped: () => piped.map((instance) => () => ({ kind: "piped", instance })),
    invidious: () => invidious.map((instance) => () => ({ kind: "invidious", instance })),
    cobalt: () => cobalt.map((instance) => () => ({ kind: "cobalt", instance })),
  };

  const requested = overrides || ["piped", "invidious", "cobalt"];
  const providers = [];

  for (const entry of requested) {
    if (entry.includes("{id}")) {
      providers.push(() => ({ kind: "template", template: entry }));
      continue;
    }

    const name = entry.toLowerCase();
    if (named[name]) providers.push(...named[name]());
    else if (/^https?:\/\//i.test(entry)) providers.push(() => ({ kind: "template", template: entry }));
    else console.warn(`[play] unknown YT_AUDIO_APIS entry "${entry}" ignored`);
  }

  return providers;
}

async function resolveWithProvider(candidate, videoId) {
  if (candidate.kind === "piped") return fromPiped(videoId, candidate.instance);
  if (candidate.kind === "invidious") return fromInvidious(videoId, candidate.instance);
  if (candidate.kind === "cobalt") return fromCobalt(videoId, candidate.instance);
  return fromTemplate(videoId, candidate.template);
}

/**
 * Try every configured public API until one yields a real audio file at
 * `filePath`. Returns metadata about the track.
 */
async function fetchAudioFromApis(videoId, filePath, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, onAttempt } = options;
  const providers = buildProviders();
  const failures = [];

  for (const makeCandidate of providers) {
    const candidate = makeCandidate();
    const label =
      candidate.kind === "template"
        ? `custom(${new URL(candidate.template.replace(/\{id\}/g, videoId)).host})`
        : `${candidate.kind}:${(() => {
            try {
              return new URL(candidate.instance).host;
            } catch {
              return candidate.instance;
            }
          })()}`;

    try {
      const resolved = await resolveWithProvider(candidate, videoId);
      const bytes = await downloadUrlToFile(resolved.url, filePath, { maxBytes });

      if (!bytes) throw new Error("downloaded file was empty");

      const head = await readHead(filePath);
      if (!isLikelyAudio(head)) {
        await rm(filePath, { force: true }).catch(() => {});
        throw new Error("response was not audio (probably an error page)");
      }

      return {
        source: resolved.provider || label,
        mimeType: resolved.mimeType || "",
        bytes,
        title: resolved.title || "",
        author: resolved.author || "",
        durationSec: resolved.durationSec || 0,
        thumbnail: null,
      };
    } catch (err) {
      failures.push({ provider: label, error: err.message });
      console.warn(`[play] ${label} failed: ${err.message}`);
      if (typeof onAttempt === "function") {
        try {
          onAttempt(label, err, failures.length);
        } catch {
          /* status updates are best-effort */
        }
      }
    }
  }

  const error = new Error(
    "no public audio API had this track:\n" +
      failures.map((failure) => `• ${failure.provider}: ${failure.error}`).join("\n")
  );
  error.code = "ALL_APIS_FAILED";
  error.failures = failures;
  throw error;
}

module.exports = {
  fetchAudioFromApis,
  isLikelyAudio,
  buildProviders,
  findUrlInJson,
  collectMediaUrls,
};
