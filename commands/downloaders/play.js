// `.play` — search YouTube, then fetch the audio through public downloader
// APIs. Same approach as Knightbot-MD: the bot never talks to YouTube's
// media servers itself, so a datacenter IP can't trigger YouTube's bot check.
//
//   1. search   yt-search (a plain search-results lookup, no login needed)
//   2. download EliteProTech (the only source, no backups)
//   3. send     converted to MP3 with ffmpeg when available
//
// None of these APIs need a key or credentials.

const { createRequire } = require("module");
const { spawnSync } = require("child_process");
const { existsSync, createWriteStream } = require("fs");
const { readFile, rm, mkdir, stat, open } = require("fs/promises");
const { pipeline } = require("stream/promises");
const { randomUUID } = require("crypto");
const { join } = require("path");
const { tmpdir } = require("os");

const axios = require("axios");
const yts = require("yt-search");

const require2 = createRequire(__filename);
const ffmpeg = require2("fluent-ffmpeg");
const ffmpegBinary = require2("ffmpeg-static");

// WhatsApp tops out around 16 MB for playable audio; stay a bit under it.
const WHATSAPP_AUDIO_LIMIT = 15.5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 100 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 5 * 60 * 1000;
const API_TIMEOUT_MS = 60 * 1000;
const FILE_TIMEOUT_MS = 90 * 1000;
const TEMP_DIR = join(tmpdir(), "astral-cloud-music");

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const API_HEADERS = { "User-Agent": BROWSER_UA, Accept: "application/json, text/plain, */*" };

// ── download sources ───────────────────────────────────────────────
// Each source takes a YouTube URL and resolves to { download, title?, thumbnail? }.
// There is only one source now; no backup sources are configured.
async function getJson(url) {
  const res = await axios.get(url, { timeout: API_TIMEOUT_MS, headers: API_HEADERS });
  return res.data;
}

const SOURCES = [
  {
    name: "EliteProTech",
    async resolve(youtubeUrl) {
      const data = await getJson(
        `https://eliteprotech-apis.zone.id/download/ytmp3?url=${encodeURIComponent(youtubeUrl)}`
      );
      if (data?.status && data?.download?.downloadUrl) {
        return {
          download: data.download.downloadUrl,
          title: data.download.title,
          thumbnail: data.download.thumbnail,
        };
      }
      throw new Error("returned no download link");
    },
  },
];

// ── audio sniffing ─────────────────────────────────────────────────
function isLikelyAudio(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return false;

  const head = buffer.subarray(0, 16);
  const ascii = head.toString("latin1");

  if (ascii.startsWith("ID3")) return true; // MP3 with ID3 tag
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  if (ascii.slice(4, 8) === "ftyp") return true; // MP4/M4A/AAC container
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return true; // WebM
  if (ascii.startsWith("OggS")) return true; // Ogg/Opus
  if (ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WAVE") return true; // WAV
  if (ascii.startsWith("fLaC")) return true; // FLAC

  return false;
}

function isMp3Buffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > 3 &&
    (buffer.subarray(0, 3).toString() === "ID3" ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))
  );
}

function extensionForHead(head) {
  const ascii = head.toString("latin1");
  if (isMp3Buffer(head)) return "mp3";
  if (ascii.slice(4, 8) === "ftyp") return "m4a";
  if (ascii.startsWith("OggS")) return "ogg";
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
  if (ascii.startsWith("RIFF")) return "wav";
  if (ascii.startsWith("fLaC")) return "flac";
  return "m4a";
}

const MIME_BY_EXTENSION = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  ogg: "audio/ogg; codecs=opus",
  webm: "audio/webm",
  wav: "audio/wav",
  flac: "audio/flac",
};

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

async function fileSize(path) {
  return stat(path)
    .then((s) => s.size)
    .catch(() => 0);
}

async function cleanupFile(path) {
  await rm(path, { force: true }).catch(() => {});
}

// ── ffmpeg ─────────────────────────────────────────────────────────
// Prefer the bundled static binary, fall back to ffmpeg on PATH, and keep
// working without either: an m4a/ogg file is still a valid WhatsApp audio.
let ffmpegPath = null;
let ffmpegChecked = false;

function resolveFfmpeg() {
  if (ffmpegChecked) return ffmpegPath;
  ffmpegChecked = true;

  if (ffmpegBinary && existsSync(ffmpegBinary)) {
    ffmpegPath = ffmpegBinary;
  } else {
    const probe = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" });
    if (!probe.error && probe.status === 0) ffmpegPath = "ffmpeg";
  }

  if (ffmpegPath) ffmpeg.setFfmpegPath(ffmpegPath);
  else console.warn("[play] ffmpeg not found — sending the original audio as-is");
  return ffmpegPath;
}

function convertToMp3(input, output, bitrate) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg(input)
      .noVideo()
      .audioCodec("libmp3lame")
      .audioBitrate(bitrate)
      .audioFrequency(44100)
      .format("mp3");

    const timer = setTimeout(() => {
      command.kill("SIGKILL");
      reject(new Error("FFmpeg timed out"));
    }, CONVERT_TIMEOUT_MS);

    command
      .on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`FFmpeg error: ${err.message}`));
      })
      .on("end", () => {
        clearTimeout(timer);
        resolve();
      })
      .save(output);
  });
}

// Keep the MP3 under WhatsApp's media limit by lowering the bitrate on long
// tracks instead of blindly encoding everything at 192 kbps.
function pickBitrate(durationSec) {
  const seconds = Number(durationSec) || 0;
  if (!seconds) return 192;
  const kbps = Math.floor((WHATSAPP_AUDIO_LIMIT * 8) / seconds / 1000) - 8;
  return Math.min(192, Math.max(48, kbps));
}

async function recompressUnderLimit(sourcePath, outputPath) {
  for (const bitrate of [48, 32, 24]) {
    await convertToMp3(sourcePath, outputPath, bitrate);
    const size = await fileSize(outputPath);
    if (size && size <= WHATSAPP_AUDIO_LIMIT) return readFile(outputPath);
    await rm(outputPath, { force: true }).catch(() => {});
  }
  return null;
}

// ── search ─────────────────────────────────────────────────────────
function extractVideoId(input) {
  const match = String(input || "").match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/|music\.youtube\.com\/watch\?(?:.*&)?v=)([A-Za-z0-9_-]{11})/
  );
  return match ? match[1] : null;
}

function normalizeVideo(video) {
  return {
    id: video.videoId || extractVideoId(video.url),
    url: video.url,
    title: video.title || "audio",
    author: video.author?.name || "",
    durationSec: Number(video.seconds) || 0,
    thumbnail: video.thumbnail || video.image || null,
  };
}

async function findVideo(query) {
  const videoId = extractVideoId(query);

  if (videoId) {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    try {
      const found = await yts({ videoId });
      if (found?.title) return normalizeVideo({ ...found, url });
    } catch {
      // metadata lookup is optional when we already have the link
    }
    return { id: videoId, url, title: "audio", author: "", durationSec: 0, thumbnail: null };
  }

  const { videos } = await yts(String(query).trim());
  if (!videos || !videos.length) throw new Error("No results found for that search.");
  return normalizeVideo(videos[0]);
}

async function fetchThumbnailBuffer(url) {
  if (!url) return null;
  try {
    const res = await axios.get(url, { responseType: "arraybuffer", timeout: 15000 });
    return Buffer.from(res.data);
  } catch {
    return null;
  }
}

// ── download ───────────────────────────────────────────────────────
// Stream a source's file URL to disk and make sure it is really audio. An
// HTML or JSON error page served with a 200 must never reach WhatsApp.
async function downloadToFile(url, filePath, maxBytes) {
  const response = await axios.get(url, {
    responseType: "stream",
    timeout: FILE_TIMEOUT_MS,
    maxRedirects: 5,
    headers: { "User-Agent": BROWSER_UA, Accept: "*/*", "Accept-Encoding": "identity" },
  });

  let received = 0;
  response.data.on("data", (chunk) => {
    received += chunk.length;
    if (received > maxBytes) response.data.destroy(new Error("file is too large"));
  });

  await pipeline(response.data, createWriteStream(filePath));

  if (!received) throw new Error("file was empty");
  const head = await readHead(filePath);
  if (!isLikelyAudio(head)) throw new Error("returned a page instead of audio");
  return { extension: extensionForHead(head) };
}

function describeError(error) {
  const status = error?.response?.status;
  if (status) return `HTTP ${status}`;
  return String(error?.message || "failed").replace(/\s+/g, " ").trim().slice(0, 90);
}

async function downloadAudioSource(youtubeUrl, filePath, sources = SOURCES) {
  const stages = [];

  for (const source of sources) {
    try {
      const resolved = await source.resolve(youtubeUrl);
      const { extension } = await downloadToFile(resolved.download, filePath, MAX_SOURCE_BYTES);
      return { ...resolved, extension, source: source.name };
    } catch (error) {
      stages.push({ stage: source.name, error: describeError(error) });
      console.warn(`[play] ${source.name} failed: ${describeError(error)}`);
      await cleanupFile(filePath);
    }
  }

  const failure = new Error(
    "the audio source refused this track:\n" +
      stages.map((entry) => `• ${entry.stage}: ${entry.error}`).join("\n")
  );
  failure.code = "DOWNLOAD_FAILED";
  failure.stages = stages;
  throw failure;
}

// ── command ────────────────────────────────────────────────────────
async function playSong(sock, msg, query) {
  const from = msg.key.remoteJid;

  if (!query || !query.trim()) {
    return { text: "⚠️ Usage: .play <song name or YouTube link>" };
  }

  await sock.sendMessage(from, { text: `🔍 Searching for *${query}*...` }, { quoted: msg });

  let video;
  try {
    video = await findVideo(query);
  } catch (err) {
    return { text: `⚠️ Couldn't find that song. ${err.message}` };
  }

  // Fetch the cover art once, reuse it for the "found" message and for the
  // document fallback (only documents can carry a thumbnail).
  const thumbBuffer = await fetchThumbnailBuffer(video.thumbnail);

  const foundLine = `⬇️ Found *${video.title}*${
    video.author ? ` — ${video.author}` : ""
  }\ndownloading audio...`;

  if (thumbBuffer) {
    await sock.sendMessage(from, { image: thumbBuffer, caption: foundLine }, { quoted: msg });
  } else {
    await sock.sendMessage(from, { text: foundLine }, { quoted: msg });
  }

  await mkdir(TEMP_DIR, { recursive: true });
  const id = randomUUID();
  const sourcePath = join(TEMP_DIR, `${id}.source`);
  const mp3Path = join(TEMP_DIR, `${id}.mp3`);
  const tempPaths = [sourcePath, mp3Path];

  try {
    let source;
    try {
      source = await downloadAudioSource(video.url, sourcePath);
    } catch (err) {
      console.error("[play] download failed:", err.message);
      return { text: `⚠️ Couldn't get audio for that one.\n\n${err.message}` };
    }

    const title = (source.title || video.title || "audio")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 100);
    const durationSec = video.durationSec || 0;

    let audioPath = sourcePath;
    let extension = source.extension;
    let mimetype = MIME_BY_EXTENSION[extension] || "audio/mpeg";

    // WhatsApp plays m4a/ogg/webm only sometimes, so convert to MP3 whenever
    // ffmpeg is available.
    if (extension !== "mp3" && resolveFfmpeg()) {
      try {
        await convertToMp3(sourcePath, mp3Path, pickBitrate(durationSec));
        audioPath = mp3Path;
        mimetype = "audio/mpeg";
        extension = "mp3";
      } catch (err) {
        console.warn(`[play] MP3 conversion failed, sending original audio: ${err.message}`);
      }
    }

    const buffer = await readFile(audioPath);
    if (!buffer.length) {
      return { text: "⚠️ The downloaded audio was empty. Try another song." };
    }

    // Passing `seconds` also stops Baileys from shelling out to ffmpeg to
    // measure the track itself.
    const seconds = durationSec > 0 ? { seconds: Math.round(durationSec) } : {};

    if (buffer.length <= WHATSAPP_AUDIO_LIMIT) {
      return { audio: buffer, mimetype, ptt: false, ...seconds };
    }

    // Too large to send inline: squeeze it, then fall back to a document
    // instead of letting WhatsApp reject the upload.
    if (resolveFfmpeg()) {
      const squeezed = await recompressUnderLimit(sourcePath, mp3Path).catch(() => null);
      if (squeezed) {
        return { audio: squeezed, mimetype: "audio/mpeg", ptt: false, ...seconds };
      }
    }

    return {
      document: buffer,
      mimetype,
      fileName: `${title}.${extension}`,
      ...(thumbBuffer ? { jpegThumbnail: thumbBuffer } : {}),
      ...seconds,
    };
  } catch (err) {
    return { text: `⚠️ Download failed: ${err.message}` };
  } finally {
    await Promise.all(tempPaths.map((path) => cleanupFile(path)));
  }
}

module.exports = {
  playSong,
  // exported for tests
  _internals: { downloadAudioSource, extractVideoId, isLikelyAudio, SOURCES, TEMP_DIR },
};
