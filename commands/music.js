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
 *   - fluent-ffmpeg      ->  already in your package.json
 *   - yt-search          ->  fallback search only (see below)
 *
 * How it works (ported from songfetch.py — see utils/songfetch.js):
 *   1. Search cheap, once. `yt-dlp --flat-playlist ytsearch5:<query>`
 *      returns the top 5 titles as text in ~1s, no video downloaded.
 *   2. Rank them. Titles containing live/karaoke/cover are pushed to
 *      the back (never deleted), so the studio version is tried first.
 *   3. Try each one until a file appears. The first hit is often
 *      blocked, so success is "does the file exist", not exit code.
 *      Leftover .part files are deleted before each retry, otherwise
 *      attempt #2 would resume attempt #1's half-file.
 *   4. Re-mux the audio with ffmpeg-static into mono 48 kHz Opus in
 *      an OGG container — the exact format WhatsApp inline-plays.
 *
 * Bot check ("Sign in to confirm you're not a bot"): YouTube flags
 * datacenter IPs. Every download carries an android/ios player client
 * plus retries (see `ytdlpBaseFlags()` in utils/ytdlp.js). If that
 * still fails, drop a `cookies.txt` (Netscape format, exported from
 * a browser signed into YouTube) in the repo root, or set
 * YT_DLP_COOKIES to its path. The error message in chat explains this.
 */

const fs = require("fs");
const path = require("path");
const yts = require("yt-search");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { ytdlp, ytdlpBaseFlags, isBotCheckError } = require("../utils/ytdlp");
const { search, rank, clearPartials } = require("../utils/songfetch");

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

function formatDuration(seconds) {
  if (!seconds || !Number.isFinite(seconds)) return "?";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function botCheckHelp() {
  return (
    "⚠️ YouTube is asking for cookies (\"Sign in to confirm you're not a bot\").\n" +
    "This happens on cloud servers — YouTube flags datacenter IPs.\n\n" +
    "Fix: export your YouTube cookies as `cookies.txt` (Netscape format)\n" +
    "from a browser signed into YouTube, drop it in the bot's root folder,\n" +
    "or set `YT_DLP_COOKIES=/path/to/cookies.txt`. Then retry `.play`.\n" +
    "Tip: re-export fresh cookies if it stops working — they expire."
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

  // 1. Search cheap, once (songfetch step 1) + rank (step 2).
  let candidates;
  try {
    candidates = await search(query, { limit: 5 });
  } catch (err) {
    console.error("songfetch search error:", err);
    if (/binary not found/i.test(String((err && err.message) || err))) {
      return sock.sendMessage(from, {
        text: "⚠️ yt-dlp binary not found — run `npm install` to download it.",
        edit: status.key,
      });
    }
    candidates = [];
  }

  let ranked = rank(candidates, query);

  // Fallback: if the flat search came back empty, try yt-search for
  // at least one URL to attempt (same spirit as songfetch Phase 2).
  if (ranked.length === 0) {
    try {
      const result = await yts(query);
      const video = result.videos && result.videos[0];
      if (video) {
        ranked = [
          {
            id: "",
            title: video.title || query,
            url: video.url,
            duration:
              video.duration && typeof video.duration.seconds === "number"
                ? video.duration.seconds
                : null,
          },
        ];
      }
    } catch (err) {
      console.error("yt-search fallback error:", err);
    }
  }

  if (ranked.length === 0) {
    return sock.sendMessage(from, {
      text: `❌ No results for "${query}".`,
      edit: status.key,
    });
  }

  // Reject overly long videos up front (keep at least the shortest
  // candidate if every result is over the cap, so we can still tell
  // the user which one was too long instead of a bare "no results").
  const short = ranked.filter(
    (c) => c.duration == null || c.duration <= MAX_DURATION_SECONDS
  );
  if (short.length === 0) {
    const top = ranked[0];
    return sock.sendMessage(from, {
      text:
        `⚠️ "${top.title}" is ${Math.round((top.duration || 0) / 60)} min long.\n` +
        `Max is ${MAX_DURATION_SECONDS / 60} min. Try a shorter clip.`,
      edit: status.key,
    });
  }
  ranked = short;

  const top = ranked[0];
  await sock.sendMessage(from, {
    text:
      `🎬 Found: *${top.title}*\n` +
      `⏱️ ${formatDuration(top.duration)}` +
      (ranked.length > 1 ? ` • ${ranked.length} candidates, trying in order` : "") +
      `\n${wantVideo ? "📥 Downloading video..." : "📥 Downloading audio..."}`,
    edit: status.key,
  });

  // 2. Download + convert (cached by query so repeats are instant).
  // Try each ranked candidate until a file appears (songfetch step 3).
  const safeKey = query.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60);
  const ext = wantVideo ? "mp4" : "ogg";
  const outFile = path.join(CACHE_DIR, `${safeKey}.${ext}`);

  let chosen = top;
  let lastError = null;

  if (!fs.existsSync(outFile)) {
    for (let i = 0; i < ranked.length; i++) {
      const cand = ranked[i];
      if (i > 0) {
        await sock.sendMessage(from, {
          text: `🔁 Trying ${i + 1}/${ranked.length}: *${cand.title}*...`,
          edit: status.key,
        });
      }
      // Delete leftover .part files before each retry, otherwise the
      // next attempt resumes the previous one's half-file.
      clearPartials(CACHE_DIR, safeKey);
      try {
        if (wantVideo) {
          await downloadVideo(cand.url, outFile);
        } else {
          await downloadAudio(cand.url, outFile);
        }
        chosen = cand;
        lastError = null;
        break;
      } catch (err) {
        console.error(`download attempt ${i + 1} failed:`, err.message || err);
        lastError = err;
        // Clean up any half-written output so the next attempt (or a
        // later .play) starts fresh.
        if (fs.existsSync(outFile)) {
          try {
            fs.unlinkSync(outFile);
          } catch {
            // ignore
          }
        }
      }
    }

    if (!fs.existsSync(outFile)) {
      if (isBotCheckError(lastError)) {
        return sock.sendMessage(from, { text: botCheckHelp(), edit: status.key });
      }
      return sock.sendMessage(from, {
        text:
          `⚠️ Download failed for "${top.title}".\n` +
          `_Error: ${String((lastError && lastError.message) || lastError || "unknown").slice(0, 200)}_`,
        edit: status.key,
      });
    }
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
      caption: `🎬 ${chosen.title}`,
    });
  } else {
    // WhatsApp plays audio inline ONLY when it's Opus in an OGG container,
    // mono, ~48kHz. fluent-ffmpeg above produced exactly that.
    await sock.sendMessage(from, {
      audio: buffer,
      mimetype: "audio/ogg; codecs=opus",
      ptt: false, // false = audio message; true = voice-note style
      fileName: `${chosen.title}.ogg`,
    });
  }
}

/**
 * Download + convert a YouTube URL to Opus/OGG (WhatsApp audio format).
 * Uses the standalone yt-dlp binary in bin/ (fetched by the root
 * postinstall script) — no Python, no system yt-dlp needed.
 * Success is "does the file exist", not exit code (songfetch rule).
 */
async function downloadAudio(url, outFile) {
  // Step A: yt-dlp pulls the raw bestaudio stream to a temp opus file.
  const tmpRaw = outFile.replace(/\.ogg$/, ".raw.opus");
  let ytdlpError = null;
  try {
    await ytdlp(url, {
      extractAudio: true,
      audioFormat: "opus",
      audioQuality: 5,
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      output: tmpRaw,
      // Point yt-dlp at the bundled ffmpeg so it doesn't need a system one.
      ffmpegLocation: ffmpegPath,
      ...ytdlpBaseFlags(),
    });
  } catch (err) {
    ytdlpError = err;
  }
  if (!fs.existsSync(tmpRaw)) {
    throw ytdlpError || new Error("yt-dlp produced no audio file");
  }

  // Step B: re-mux/transcode to mono 48kHz Opus in an OGG container,
  // which is exactly what WhatsApp needs for inline playback.
  try {
    await new Promise((resolve, reject) => {
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
  } finally {
    if (fs.existsSync(tmpRaw)) fs.unlinkSync(tmpRaw);
  }
}

/**
 * Download a YouTube URL as an MP4 video (H.264 + AAC), 480p max for speed.
 * Uses the standalone yt-dlp binary in bin/ (fetched by the root postinstall).
 * Success is "does the file exist", not exit code (songfetch rule).
 */
async function downloadVideo(url, outFile) {
  let ytdlpError = null;
  try {
    await ytdlp(url, {
      format: "best[height<=480][ext=mp4]/best[height<=480]/best",
      mergeOutputFormat: "mp4",
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      output: outFile,
      ffmpegLocation: ffmpegPath,
      ...ytdlpBaseFlags(),
    });
  } catch (err) {
    ytdlpError = err;
  }
  if (!fs.existsSync(outFile)) {
    throw ytdlpError || new Error("yt-dlp produced no video file");
  }
}

module.exports = { play, downloadAudio, downloadVideo };
