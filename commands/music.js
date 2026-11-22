/**
 * commands/music.js
 * WhatsApp music plugin for the astral-cloud bot (Baileys).
 *
 * Commands:
 *   .play <song name>        Search YouTube and send the audio as a
 *                            WhatsApp audio message (plays inline).
 *   .play -v <song name>    Same, but sends the video instead of audio.
 *   .play                    Show usage help.
 *
 * Dependencies (all npm — zero system packages needed, works on Render):
 *   - yt-dlp standalone binary -> fetched into bin/ by the root postinstall
 *     script (scripts/install-ytdlp.js); no Python, no system packages
 *   - ffmpeg-static      ->  already in your package.json (bundles ffmpeg)
 *   - yt-search          ->  already in your package.json
 *   - fluent-ffmpeg      ->  already in your package.json
 *
 * Drop this file into commands/, wire it into handlers/router.js, restart
 * the bot. That's it.
 */

const fs = require("fs");
const path = require("path");
const yts = require("yt-search");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { ytdlp } = require("../utils/ytdlp");

// Where to cache downloaded songs so a repeat .play is instant.
const CACHE_DIR = path.join(__dirname, "..", "cache", "music");
fs.mkdirSync(CACHE_DIR, { recursive: true });

// Hard cap so a user can't request a 3-hour mix and hang the bot.
const MAX_DURATION_SECONDS = 10 * 60; // 10 minutes

// Tell fluent-ffmpeg where the bundled ffmpeg binary lives.
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * Show usage when no query is given.
 */
function playUsage() {
  return (
    "🎵 *Music Player*\n\n" +
    "Usage:\n" +
    "`.play <song name>` — search and send as audio\n" +
    "`.play -v <song name>` — send as video\n\n" +
    "Examples:\n" +
    "`.play love in the dark`\n" +
    "`.play adele hello`\n" +
    "`.play -v coldplay yellow`\n\n" +
    "_Tip: songs are cached, so the second `.play` of the same name is instant._"
  );
}

/**
 * Main entry. Called from handlers/router.js with the Baileys socket so
 * we can stream progress messages and send the audio file directly.
 *
 * @param {object} sock   Baileys socket
 * @param {string} from   remoteJid (chat id)
 * @param {object} msg    original Baileys message (for replies/reactions)
 * @param {string} argText everything after the command
 */
async function play(sock, from, msg, argText) {
  if (!argText || !argText.trim()) {
    return sock.sendMessage(from, { text: playUsage() });
  }

  // Parse flags: .play -v <query>  ->  video mode
  let wantVideo = false;
  let query = argText.trim();
  if (query.startsWith("-v ")) {
    wantVideo = true;
    query = query.slice(3).trim();
  } else if (query === "-v") {
    return sock.sendMessage(from, { text: "⚠️ Usage: .play -v <song name>" });
  }

  const status = await sock.sendMessage(from, {
    text: `🔎 Searching YouTube for "${query}"...`,
  });

  // 1. Search YouTube
  let video;
  try {
    const result = await yts(query);
    video = result.videos[0];
  } catch (err) {
    console.error("yt-search error:", err);
    return sock.sendMessage(from, {
      text: "⚠️ Search failed. Try again in a moment.",
      edit: status.key,
    });
  }

  if (!video) {
    return sock.sendMessage(from, {
      text: `❌ No results for "${query}".`,
      edit: status.key,
    });
  }

  // Reject overly long videos up front.
  if (video.duration && video.duration.seconds > MAX_DURATION_SECONDS) {
    return sock.sendMessage(from, {
      text:
        `⚠️ "${video.title}" is ${Math.round(video.duration.seconds / 60)} min long.\n` +
        `Max is ${MAX_DURATION_SECONDS / 60} min. Try a shorter clip.`,
      edit: status.key,
    });
  }

  await sock.sendMessage(from, {
    text:
      `🎬 Found: *${video.title}*\n` +
      `⏱️ ${video.timestamp || video.durationString || "?"} • 👁 ${video.views || "?"} views\n` +
      `${wantVideo ? "📥 Downloading video..." : "📥 Downloading audio..."}`,
    edit: status.key,
  });

  // 2. Download + convert (cached by query so repeats are instant)
  const safeKey = query.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
  const ext = wantVideo ? "mp4" : "ogg";
  const outFile = path.join(CACHE_DIR, `${safeKey}.${ext}`);

  try {
    if (!fs.existsSync(outFile)) {
      if (wantVideo) {
        await downloadVideo(video.url, outFile);
      } else {
        await downloadAudio(video.url, outFile);
      }
    }
  } catch (err) {
    console.error("download error:", err);
    return sock.sendMessage(from, {
      text:
        `⚠️ Download failed for "${video.title}".\n` +
        `_Error: ${String(err.message || err).slice(0, 200)}_`,
      edit: status.key,
    });
  }

  // 3. Send to WhatsApp in the correct format
  await sock.sendMessage(from, {
    text: `✅ Sending as ${wantVideo ? "video" : "audio"}...`,
    edit: status.key,
  });

  const buffer = fs.readFileSync(outFile);

  if (wantVideo) {
    await sock.sendMessage(from, {
      video: buffer,
      mimetype: "video/mp4",
      caption: `🎬 ${video.title}`,
    });
  } else {
    // WhatsApp plays audio inline ONLY when it's Opus in an OGG container,
    // mono, ~48kHz. fluent-ffmpeg above produced exactly that.
    await sock.sendMessage(from, {
      audio: buffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: false, // false = audio message; true = voice-note style
      fileName: `${video.title}.ogg`,
    });
  }
}

/**
 * Download + convert a YouTube URL to Opus/OGG (WhatsApp audio format).
 * Uses the standalone yt-dlp binary in bin/ (fetched by the root
 * postinstall script) — no Python, no system yt-dlp needed.
 */
function downloadAudio(url, outFile) {
  // Step A: yt-dlp pulls the raw bestaudio stream to a temp opus file.
  const tmpRaw = outFile.replace(/\.ogg$/, ".raw.opus");
  return ytdlp(url, {
    extractAudio: true,
    audioFormat: "opus",
    audioQuality: 5,
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    output: tmpRaw,
    // Point yt-dlp at the bundled ffmpeg so it doesn't need a system one.
    ffmpegLocation: ffmpegPath,
  })
    .then(() => {
      // Step B: re-mux/transcode to mono 48kHz Opus in an OGG container,
      // which is exactly what WhatsApp needs for inline playback.
      return new Promise((resolve, reject) => {
        ffmpeg(tmpRaw)
          .audioCodec("libopus")
          .audioChannels(1)
          .audioFrequency(48000)
          .audioBitrate("64k")
          .format("ogg")
          .on("error", reject)
          .on("end", resolve)
          .save(outFile);
      });
    })
    .finally(() => {
      if (fs.existsSync(tmpRaw)) fs.unlinkSync(tmpRaw);
    });
}

/**
 * Download a YouTube URL as an MP4 video (H.264 + AAC), 480p max for speed.
 * Uses the standalone yt-dlp binary in bin/ (fetched by the root postinstall).
 */
function downloadVideo(url, outFile) {
  return ytdlp(url, {
    format: "best[height<=480][ext=mp4]/best[height<=480]/best",
    mergeOutputFormat: "mp4",
    noPlaylist: true,
    noWarnings: true,
    quiet: true,
    output: outFile,
    ffmpegLocation: ffmpegPath,
  });
}

module.exports = { play };
