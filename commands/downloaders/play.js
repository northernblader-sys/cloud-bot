const { createRequire } = require("module");
const { spawnSync } = require("child_process");
const { existsSync } = require("fs");
const { readFile, rm, mkdir, stat } = require("fs/promises");
const { randomUUID } = require("crypto");
const { join } = require("path");

const require2 = createRequire(__filename);
const ffmpeg = require2("fluent-ffmpeg");
const ffmpegBinary = require2("ffmpeg-static");

const { searchYoutube } = require("../../utils/y2mate/search");
const { fetchAudioToFile, cleanupFile, TEMP_DIR } = require("../../utils/youtube/innertube");
const { fetchAudioFromApis, isLikelyAudio } = require("../../utils/youtube/audioApis");
const { fetchAudioWithYtdlp, hasYtdlp } = require("../../utils/youtube/ytdlp");
const { downloadY2mateAudioToFile } = require("../../utils/y2mate/audio");

// WhatsApp tops out around 16 MB for playable audio; stay a bit under it.
const WHATSAPP_AUDIO_LIMIT = 15.5 * 1024 * 1024;
const MAX_SOURCE_BYTES = 300 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 5 * 60 * 1000;

// ── ffmpeg setup ───────────────────────────────────────────────────
// Prefer the bundled static binary, but fall back to whatever ffmpeg is on
// PATH (some hosts ship one), and keep working even if neither exists — an
// m4a/opus file is still a valid WhatsApp audio message.
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
  else console.warn("[play] ffmpeg not found — sending the original audio stream as-is");
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

const MIME_BY_EXTENSION = {
  mp3: "audio/mpeg",
  webm: "audio/webm",
  m4a: "audio/mp4",
};

function extensionForMime(mimeType) {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  if (mime.includes("webm") || mime.includes("opus")) return "webm";
  if (mime.includes("mp4") || mime.includes("m4a") || mime.includes("aac")) return "m4a";
  return "m4a";
}

function isMp3Buffer(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length > 3 &&
    (buffer.subarray(0, 3).toString() === "ID3" ||
      (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))
  );
}

function hasDuration(durationSec) {
  return Number.isFinite(Number(durationSec)) && Number(durationSec) > 0;
}

async function fileSize(path) {
  return stat(path)
    .then((s) => s.size)
    .catch(() => 0);
}

// Baileys' audio message proto has no thumbnail field (jpegThumbnail is only
// on image/video/document messages), so the cover art is sent as its own
// image with a caption first — that is what actually shows up as a visible
// thumbnail in every client.
async function fetchThumbnailBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Source order, best first:
//   1. YouTube InnerTube  — highest quality, one request, most likely to work
//   2. public APIs        — Piped / Invidious / cobalt / a custom endpoint
//   3. y2mate             — HTML scraper, last resort
// Each stage only wins if it actually produced audio bytes, and each failure
// is collected so the error we surface says which stage died and why.
async function downloadAudioSource(videoId, filePath) {
  const stages = [];

  // Reasons worth surfacing verbatim: they say what to configure.
  const reasonsOf = (error) =>
    (error.failures || [])
      .map((failure) => failure.error || failure.message || String(failure))
      .filter(Boolean);

  // yt-dlp first when it's already installed: it follows YouTube's anti-bot
  // changes (PO tokens, nsig challenges) faster than any library can, and it
  // is the approach proven by desktop downloaders. Autodownloading it is
  // handled inside (YTDLP_AUTODOWNLOAD=0 disables the ~30 MB fetch).
  //
  // Two yt-dlp passes: the plain desktop-app recipe, then Arroxy's retry
  // ladder (PO token if configured → clients that don't demand one → yt-dlp's
  // own defaults), which is what rescues videos the first pass can't reach.
  if (hasYtdlp() || process.env.YTDLP_AUTODOWNLOAD !== "0") {
    const strategies = [
      { strategy: "basic", label: "yt-dlp" },
      { strategy: "arroxy", label: "yt-dlp (arroxy)" },
    ];

    for (const { strategy, label } of strategies) {
      try {
        return await fetchAudioWithYtdlp(videoId, filePath, {
          maxBytes: MAX_SOURCE_BYTES,
          strategy,
        });
      } catch (error) {
        stages.push({ stage: label, error, reasons: reasonsOf(error) });
        console.warn(`[play] ${label} failed: ${error.message}`);
        // A rate limit or a removed video won't be fixed by another source.
        if (error.kind === "rateLimit") {
          const error2 = new Error(error.message);
          error2.kind = error.kind;
          error2.stages = stages;
          error2.code = "DOWNLOAD_FAILED";
          throw error2;
        }
      }
    }
  }

  try {
    return await fetchAudioToFile(videoId, filePath, { maxBytes: MAX_SOURCE_BYTES });
  } catch (error) {
    stages.push({ stage: "YouTube", error, reasons: reasonsOf(error) });
    console.warn("[play] InnerTube failed, trying public audio APIs");
  }

  try {
    return await fetchAudioFromApis(videoId, filePath, { maxBytes: MAX_SOURCE_BYTES });
  } catch (error) {
    stages.push({ stage: "public APIs", error, reasons: reasonsOf(error) });
    console.warn("[play] public audio APIs failed, trying y2mate");
  }

  try {
    return await downloadY2mateAudioToFile(videoId, filePath);
  } catch (error) {
    stages.push({ stage: "y2mate", error, reasons: reasonsOf(error) });
  }

  const combined = new Error(
    "every audio source refused this track:\n" +
      stages
        .map((entry) => {
          const detail = entry.reasons[0] || entry.error.message || "unknown error";
          return `• ${entry.stage}: ${detail}`;
        })
        .join("\n")
  );
  combined.code = "DOWNLOAD_FAILED";
  combined.stages = stages;
  throw combined;
}

// One short line per source, each with the most useful reason we have.
function describeFailure(error) {
  const stages = error.stages || [];
  if (!stages.length) return String(error.message || "unknown error").slice(0, 300);

  const lines = stages.map((entry) => {
    const detail = (entry.reasons[0] || entry.error.message || "failed")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 90);
    return `• ${entry.stage}: ${detail}`;
  });

  // If YouTube is asking for a logged-in session, point at the knobs.
  const youtube = stages.find((entry) => entry.stage === "YouTube");
  const youtubeText = [youtube?.error?.message, ...(youtube?.reasons || [])].filter(Boolean).join(" ");
  const youtubeBlocked = /LOGIN_REQUIRED|confirm you.{0,3}re not a bot|bot/i.test(youtubeText);
  if (youtubeBlocked) {
    lines.push(
      "\n_YouTube is asking for a logged-in/PO-token session from this IP. " +
        "Set YT_COOKIE (or YT_PO_TOKEN), or point PIPED_INSTANCES at an instance that works._"
    );
  }

  return lines.join("\n");
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

async function playSong(sock, msg, query) {
  const from = msg.key.remoteJid;

  if (!query || !query.trim()) {
    return { text: "⚠️ Usage: .play <song name or YouTube link>" };
  }

  await sock.sendMessage(from, { text: `🔍 Searching for *${query}*...` }, { quoted: msg });

  let video;
  try {
    video = await searchYoutube(query);
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
      source = await downloadAudioSource(video.id, sourcePath);
    } catch (err) {
      console.error("[play] download failed:", err.message);

      return {
        text:
          "⚠️ Couldn't get audio for that one — every source refused.\n\n" +
          describeFailure(err),
      };
    }

    const sourceSize = await fileSize(sourcePath);
    if (!sourceSize) {
      return { text: "⚠️ The downloaded audio was empty. Try another song." };
    }

    const title = (source.title || video.title || "audio")
      .replace(/[\\/:*?"<>|]/g, "_")
      .slice(0, 100);
    const durationSec = source.durationSec || video.durationSec || 0;

    let audioPath = sourcePath;
    let extension = extensionForMime(source.mimeType);
    let mimetype = MIME_BY_EXTENSION[extension] || "audio/mpeg";

    // y2mate already renders MP3. InnerTube hands us m4a/opus, which WhatsApp
    // plays only sometimes, so convert whenever ffmpeg is available.
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

    let buffer = await readFile(audioPath);
    if (!buffer.length) {
      return { text: "⚠️ The downloaded audio was empty. Try another song." };
    }

    // Guard against a source that returned an HTML/JSON error page with a 200:
    // sending that as a voice note looks like "it replied but no audio plays".
    if (!isLikelyAudio(buffer.subarray(0, 64)) && !isMp3Buffer(buffer)) {
      return {
        text:
          "⚠️ The download didn't come back as real audio (the source probably " +
          "returned an error page). Try again or send a different song.",
      };
    }

    // Some sources already deliver MP3 under a different mimetype label.
    if (isMp3Buffer(buffer)) {
      mimetype = "audio/mpeg";
      extension = "mp3";
    }

    // Passing `seconds` also stops Baileys from shelling out to ffmpeg to
    // measure the track itself.
    const seconds = hasDuration(durationSec) ? { seconds: Math.round(durationSec) } : {};

    if (buffer.length <= WHATSAPP_AUDIO_LIMIT) {
      return { audio: buffer, mimetype, ptt: false, ...seconds };
    }

    // Too large to stream inline: try harder, then fall back to a document
    // instead of letting WhatsApp reject the upload.
    if (resolveFfmpeg()) {
      const squeezed = await recompressUnderLimit(sourcePath, mp3Path).catch(() => null);
      if (squeezed) {
        return { audio: squeezed, mimetype: "audio/mpeg", ptt: false, ...seconds };
      }
    }

    // Only documents carry a filename/thumbnail in WhatsApp.
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

module.exports = { playSong };
