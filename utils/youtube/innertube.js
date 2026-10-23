// Primary YouTube audio source: YouTube's own InnerTube API via youtubei.js.
//
// The old `.play` path sent every video through the y2mate scraper, and when
// y2mate stopped exposing a plain MP3 button the bot answered every request
// with "No audio format was available for that video". YouTube itself is a
// far more stable source, so this module pulls the audio-only stream straight
// from InnerTube and streams it to a temp file.
//
// The catch: YouTube hands different clients different playback URLs, and some
// of them (WEB, ANDROID, iOS, ANDROID_VR...) now demand a PO token before the
// media URL works. So we walk a list of clients, TV first — that is the one
// that still serves audio without a token — and keep whichever client actually
// returns bytes. The winning client is remembered for the rest of the session.
//
// Optional env vars (only needed if YouTube starts blocking the host's IP):
//   YT_PO_TOKEN      a Proof-of-Origin token for the client being used
//   YT_VISITOR_DATA  a persistent visitor_data string
//   YT_COOKIE        a YouTube cookie header (for age-restricted videos)
//   YT_CLIENTS       comma separated client list to override the order below

const { mkdir, open, rm, stat } = require("fs/promises");
const session = require("./session");
const { Readable } = require("stream");
const { dirname, join } = require("path");
const { tmpdir } = require("os");

const TEMP_DIR = join(tmpdir(), "astral-cloud-music");

// Client names must match youtubei.js' Constants.CLIENTS[].NAME exactly,
// otherwise the library silently falls back to WEB (which needs a PO token).
// TV/TVHTML5 first: no PO token needed and it exposes adaptive audio formats.
const DEFAULT_CLIENT_ORDER = [
  "TVHTML5",
  "TVHTML5_SIMPLY",
  "VISIONOS",
  "ANDROID_VR",
  "iOS",
  "ANDROID_MUSIC",
  "WEB_EMBEDDED_PLAYER",
  "MWEB",
  "WEB",
];

const CLIENT_INFO_TIMEOUT_MS = 25000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const CLIENT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_BYTES = 300 * 1024 * 1024;

let youtubeModulePromise;
const clientPromises = new Map();
let preferredClient = null;
let moduleOverride = null; // test seam: lets specs inject a fake youtubei.js

function loadYoutube() {
  if (moduleOverride) return Promise.resolve(moduleOverride);
  if (!youtubeModulePromise) {
    // youtubei.js ships as ESM only; this bot is CommonJS.
    youtubeModulePromise = import("youtubei.js").catch((err) => {
      youtubeModulePromise = null;
      throw err;
    });
  }
  return youtubeModulePromise;
}

function envValue(name) {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

// ...but cookies only help the *web* clients. When a session is configured,
// ask those first instead of walking the whole list.
const COOKIE_CLIENT_ORDER = [
  "WEB",
  "MWEB",
  "WEB_EMBEDDED_PLAYER",
  "TVHTML5",
  "TVHTML5_SIMPLY",
  "ANDROID_VR",
  "iOS",
  "ANDROID_MUSIC",
];

function clientOrder() {
  const override = envValue("YT_CLIENTS");
  if (!override) return session.header() ? COOKIE_CLIENT_ORDER : DEFAULT_CLIENT_ORDER;
  const list = override
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return list.length ? list : DEFAULT_CLIENT_ORDER;
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

async function createClient(clientName) {
  const yt = await loadYoutube();
  const options = {
    client_type: clientName,
    generate_session_locally: true,
    cache: new yt.UniversalCache(false),
    lang: "en",
    location: "US",
  };

  const poToken = envValue("YT_PO_TOKEN");
  const visitorData = envValue("YT_VISITOR_DATA");
  // Any of the cookie sources (env, saved from chat) work here.
  const cookie = session.header();
  if (poToken) options.po_token = poToken;
  if (visitorData) options.visitor_data = visitorData;
  if (cookie) options.cookie = cookie;

  return yt.Innertube.create(options);
}

function getClient(clientName) {
  const cached = clientPromises.get(clientName);
  if (cached && Date.now() - cached.createdAt < CLIENT_TTL_MS) return cached.promise;

  const entry = { createdAt: Date.now() };
  entry.promise = createClient(clientName).catch((err) => {
    // Don't cache a broken session — the next attempt should retry.
    clientPromises.delete(clientName);
    throw err;
  });
  clientPromises.set(clientName, entry);
  return entry.promise;
}

function formatRank(format) {
  const mime = String(format.mime_type || "");
  // Prefer mp4/AAC — it converts to MP3 cleanly and plays everywhere.
  if (mime.includes("mp4a")) return 3;
  if (mime.includes("mp3")) return 3;
  if (mime.includes("opus") || mime.includes("webm")) return 2;
  return 1;
}

function pickAudioFormat(streamingData) {
  if (!streamingData) return null;

  const formats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptive_formats || []),
  ];

  const audioOnly = formats.filter(
    (format) =>
      format &&
      format.has_audio &&
      !format.has_video &&
      !format.has_text &&
      !format.is_type_otf
  );

  const pool = audioOnly.length ? audioOnly : formats.filter((f) => f && f.has_audio);

  return (
    pool
      .slice()
      .sort(
        (a, b) => formatRank(b) - formatRank(a) || (b.bitrate || 0) - (a.bitrate || 0)
      )[0] || null
  );
}

// YouTube media servers are happy with sequential byte ranges, and pulling
// them ourselves (instead of youtubei.js' own chunked helper) means we never
// stop early when a format arrives without a content_length.
const CHUNK_BYTES = 2 * 1024 * 1024;
const CHUNK_STALL_MS = 60000;

// Some clients hand back URLs with a baked-in `range`/`rn` query that caps the
// response; strip them so our own Range header is what decides the byte window.
function cleanMediaUrl(url) {
  try {
    const parsed = new URL(url);
    for (const key of ["range", "rn", "rbuf"]) parsed.searchParams.delete(key);
    return parsed.toString();
  } catch {
    return url;
  }
}

async function downloadStreamUrl(mediaUrl, filePath, { timeoutMs, maxBytes }) {
  if (!mediaUrl) throw new Error("YouTube gave no playable audio URL");
  const url = cleanMediaUrl(mediaUrl);

  const started = Date.now();
  const handle = await open(filePath, "w");

  try {
    let offset = 0;
    let total = null;

    for (;;) {
      if (Date.now() - started > timeoutMs) throw new Error("audio download timed out");

      const stall = new AbortController();
      const stallTimer = setTimeout(() => stall.abort(), CHUNK_STALL_MS);

      let response;
      try {
        response = await fetch(url, {
          signal: stall.signal,
          headers: {
            accept: "*/*",
            origin: "https://www.youtube.com",
            referer: "https://www.youtube.com",
            "accept-encoding": "identity",
            range: `bytes=${offset}-${offset + CHUNK_BYTES - 1}`,
          },
        });
      } catch (err) {
        throw new Error(`audio fetch failed: ${err.message}`);
      } finally {
        clearTimeout(stallTimer);
      }

      if (response.status !== 200 && response.status !== 206) {
        throw new Error(`YouTube media returned HTTP ${response.status}`);
      }

      const contentRange = response.headers.get("content-range");
      if (contentRange) {
        const parsedTotal = Number(contentRange.split("/")[1]);
        if (Number.isFinite(parsedTotal) && parsedTotal > 0) total = parsedTotal;
      }

      if (!response.body) break;

      let written = 0;
      for await (const chunk of Readable.fromWeb(response.body)) {
        if (maxBytes && offset + chunk.length > maxBytes) {
          const error = new Error(
            `audio is over the ${Math.round(maxBytes / 1048576)} MB limit`
          );
          error.code = "TOO_LARGE";
          throw error;
        }
        await handle.write(chunk, 0, chunk.length, offset);
        offset += chunk.length;
        written += chunk.length;
      }

      // 200 means the server ignored Range and just sent the whole file.
      if (response.status === 200) break;
      if (total !== null && offset >= total) break;
      if (total === null && written < CHUNK_BYTES) break;
      if (!written) break;
    }

    return offset;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Turn a format into a downloadable URL, whether or not it is ciphered.
 * Plain URLs (TV/iOS) need no session player at all.
 */
async function resolveMediaUrl(format, client, clientName) {
  // Plain (unciphered) URLs — TV, iOS and some others — need nothing else.
  if (typeof format.url === "string" && format.url) return format.url;

  const player = client?.session?.player;
  if (!player) {
    throw new Error(
      `[${clientName}] YouTube sent no player response (the session was ` +
        `refused or limited), so the audio URL can't be deciphered`
    );
  }

  try {
    return await format.decipher(player);
  } catch (err) {
    const message = String(err?.message || err);
    if (/reading 'as'|Cannot read propert|null/i.test(message)) {
      throw new Error(
        `[${clientName}] YouTube's player data was incomplete ` +
          `(this client is being throttled)`
      );
    }
    throw new Error(`[${clientName}] ${message}`);
  }
}

function describePlayability(info) {
  const status = info?.playability_status;
  if (!status) return null;
  if (status.status === "OK") return null;
  const reason = status.reason || status.error_screen?.subreason?.text;
  return `${status.status}${reason ? `: ${reason}` : ""}`;
}

async function tryClient(clientName, videoId, filePath, maxBytes) {
  const client = await getClient(clientName);
  const info = await withTimeout(
    client.getInfo(videoId),
    CLIENT_INFO_TIMEOUT_MS,
    `[${clientName}] video info`
  );

  const playability = describePlayability(info);
  if (playability) throw new Error(playability);

  const format = pickAudioFormat(info.streaming_data);
  if (!format) throw new Error("YouTube sent no audio format");

  if (format.content_length && format.content_length > maxBytes) {
    const error = new Error(
      `audio track is ${(format.content_length / 1048576).toFixed(1)} MB, over the ` +
        `${Math.round(maxBytes / 1048576)} MB limit`
    );
    error.code = "TOO_LARGE";
    throw error;
  }

  // Decipher the media URL for the format we just verified, then pull it in
  // byte ranges. This works for TV/iOS (plain URLs) and WEB (nsig ciphers).
  //
  // `client.session.player` is null whenever YouTube answered with something
  // other than a player response (a consent page, a bot check, a region block).
  // Deciphering through it then throws a bare "Cannot read properties of null
  // (reading 'as')", which tells nobody anything — so say what actually
  // happened and let the next client try.
  const url = await resolveMediaUrl(format, client, clientName);
  if (!url) throw new Error("YouTube gave no playable audio URL");

  await downloadStreamUrl(url, filePath, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    maxBytes,
  });

  const { size } = await stat(filePath);
  if (!size) throw new Error("downloaded audio file was empty");
  if (format.content_length && size < format.content_length) {
    throw new Error(
      `truncated download (${size} of ${format.content_length} bytes)`
    );
  }

  const basic = info.basic_info || {};
  return {
    client: clientName,
    itag: format.itag,
    mimeType: format.mime_type || "audio/mp4",
    bitrate: format.bitrate || 0,
    bytes: size,
    title: basic.title || "",
    author: basic.author || "",
    durationSec: Math.round(Number(basic.duration) || 0),
    thumbnail:
      basic.thumbnail?.[0]?.url ||
      `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
  };
}

/**
 * Download a video's audio-only stream to `filePath`.
 *
 * Tries every client in order until one returns real bytes, then remembers it.
 * Resolves with metadata about the downloaded track.
 */
async function fetchAudioToFile(videoId, filePath, options = {}) {
  const { maxBytes = DEFAULT_MAX_BYTES, onAttempt } = options;

  if (!videoId) throw new Error("Missing YouTube video id");

  await mkdir(dirname(filePath), { recursive: true });
  await mkdir(TEMP_DIR, { recursive: true });

  const order = clientOrder();
  const attempts = preferredClient
    ? [preferredClient, ...order.filter((name) => name !== preferredClient)]
    : order;

  const failures = [];

  for (const clientName of attempts) {
    try {
      const result = await tryClient(clientName, videoId, filePath, maxBytes);
      preferredClient = clientName;
      return result;
    } catch (err) {
      await rm(filePath, { force: true }).catch(() => {});
      failures.push({ client: clientName, error: err.message });
      console.warn(`[play] YouTube client ${clientName} failed: ${err.message}`);
      if (typeof onAttempt === "function") {
        try {
          onAttempt(clientName, err, failures.length);
        } catch {
          /* status updates are best-effort */
        }
      }

      // Size limits won't change by asking another client.
      if (err.code === "TOO_LARGE") throw err;
    }
  }

  const error = new Error(
    "Couldn't get audio from YouTube:\n" +
      failures.map((f) => `• ${f.client}: ${f.error}`).join("\n")
  );
  error.code = "ALL_CLIENTS_FAILED";
  error.failures = failures;
  throw error;
}

/** Remove a temp file without ever throwing. */
async function cleanupFile(filePath) {
  if (!filePath) return;
  await rm(filePath, { force: true }).catch(() => {});
}

module.exports = {
  TEMP_DIR,
  fetchAudioToFile,
  cleanupFile,
  pickAudioFormat,
  DEFAULT_CLIENT_ORDER,
  // Reused by utils/youtube/audioApis.js and any other provider that hands us
  // a plain media URL: ranged, size-capped download straight to a file.
  downloadUrlToFile: downloadStreamUrl,
  _downloadStreamUrl: downloadStreamUrl,
  // Internals used by the offline test suite (see test/play.test.js).
  _setYoutubeModule: (mod) => {
    moduleOverride = mod;
    clientPromises.clear();
    preferredClient = null;
  },
  _getPreferredClient: () => preferredClient,
};
