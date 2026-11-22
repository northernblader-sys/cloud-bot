/**
 * commands/music.js
 * WhatsApp music plugin for the astral-cloud bot (Baileys).
 *
 * Commands:
 *   .play <song name>        Search YouTube and send the audio as a
 *                            WhatsApp audio message (plays inline).
 *   .play -v <song name>     Same, but sends the video instead of audio.
 *   .play                    Show usage help.
 *
 * Dependencies (all npm — zero system packages needed, works on Render):
 *   - yt-dlp standalone binary -> fetched into bin/ by the root postinstall
 *     script (scripts/install-ytdlp.js); no Python, no system packages
 *   - ffmpeg-static / fluent-ffmpeg -> already in package.json
 *
 * How it works — the songfetch.py method, followed exactly (ported in
 * utils/songfetch.js, which this file only drives):
 *
 *   Audio mode calls downloadTrack() from utils/songfetch.js, which does
 *   the whole method:
 *     1. Search cheap, once. `yt-dlp --flat-playlist --no-warnings
 *        --print "%(id)s\t%(title)s" ytsearch5:<query>` returns the top
 *        5 titles as text in ~1s, no video downloaded.
 *     2. Rank them. Titles containing live/karaoke/cover are pushed to
 *        the back (never deleted), so the studio version is tried first.
 *     3. Try each one until a file appears. Success is "does the file
 *        exist", not exit code. Leftover .part files are deleted before
 *        each retry, otherwise attempt #2 would resume attempt #1's
 *        half-file and you'd get one song made of two different videos.
 *     4. Tag it yourself: one stream-copy ffmpeg pass writes real
 *        artist/title/album metadata plus the cover art (no re-encode).
 *     5. Cover art comes from the iTunes Search API (no key) with an
 *        exact-artist match — never from YouTube, and "" rather than a
 *        wrong karaoke-tribute image.
 *   The tagged MP3 is then re-muxed into mono 48 kHz Opus in an OGG
 *   container — the exact format WhatsApp inline-plays as an audio
 *   message (anything else shows up as a tap-to-open document).
 *
 *   Video mode (.play -v) applies the same search → rank → try-each-
 *   candidate loop to MP4 downloads; there is no tagging step for video.
 *
 * No player-client overrides, no cookies, no retries/extractor-args
 * tricks anywhere — the download flags are exactly songfetch.py's.
 */

const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { ytdlp } = require("../utils/ytdlp");
const {
  search,
  rank,
  clearPartials,
  sanitize,
  parseArtistTitle,
  downloadTrack,
  lookupCover,
  classifyError,
  noteFailure,
  cooldownRemainingMs,
  lastFailureInfo,
} = require("../utils/songfetch");

// Where downloaded songs are cached so a repeat .play is instant.
// Layout matches songfetch.py: <root>/<Artist>/<Album>/<Title>.<ext>
const CACHE_ROOT = path.join(__dirname, "..", "cache", "music");
const VIDEO_DIR = path.join(CACHE_ROOT, "video");
fs.mkdirSync(CACHE_ROOT, { recursive: true });
fs.mkdirSync(VIDEO_DIR, { recursive: true });

// Tell fluent-ffmpeg where the bundled ffmpeg binary lives.
ffmpeg.setFfmpegPath(ffmpegPath);

/**
 * The honest failure message, per the diagnosis table in README ("When
 * YouTube says no"): "use --cookies" is a static remedy suffix yt-dlp
 * appends to failures, not a prompt — the real cause is the line before
 * it. The bot never suggests cookies for an IP flag, because they rarely
 * help there (it's the IP, not a login) and the source repo chose not to
 * use them.
 */
function failureMessage(what) {
  const info = lastFailureInfo();
  const kind = info && info.kind;
  if (kind === "botcheck" || kind === "ratelimit") {
    const mins = Math.max(1, Math.ceil(cooldownRemainingMs() / 60000));
    return (
      `🚫 YouTube is rate-limiting this server's IP${kind === "ratelimit" ? " (HTTP 429)" : " (bot check)"}.\n` +
      "It's the IP, not a login — cookies rarely help here, and retrying nonstop makes it worse.\n" +
      "Tip: set YT_DLP_PROXY to route yt-dlp through a different IP (README: \"If the IP stays blocked\").\n" +
      `Cooling down for ~${mins} min; try *${what}* again after that.`
    );
  }
  if (kind === "age") {
    return (
      `🔒 *${what}* is age-restricted — it needs a signed-in account, ` +
      "which the bot deliberately doesn't use (ban risk, expiring cookies)."
    );
  }
  if (kind === "unavailable") {
    return `🗑️ The uploads of *${what}* on YouTube are private or removed — nothing can fetch them.`;
  }
  const detail = info && info.detail ? `\n_${info.detail.slice(0, 160)}_` : "";
  return `❌ Couldn't download *${what}* — every candidate failed.${detail}`;
}

/** Show usage when no query is given. */
function playUsage() {
  return (
    "🎵 *Music Player*\n\n" +
    "Usage:\n" +
    "`.play <song name>` — search and send as audio\n" +
    "`.play -v <song name>` — send as video\n\n" +
    "Examples:\n" +
    "`.play love in the dark`\n" +
    "`.play daft punk - one more time`\n" +
    "`.play -v coldplay yellow`\n\n" +
    "_Tip: songs are cached, so the second `.play` of the same song is instant._"
  );
}

/** Convert the tagged MP3 to WhatsApp's inline-play format: mono 48 kHz Opus in OGG. */
function mp3ToWhatsAppOgg(mp3Path, oggPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("audio conversion timed out")), 120 * 1000);
    ffmpeg(mp3Path)
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(48000)
      .audioBitrate("64k")
      .format("ogg")
      .on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      })
      .on("end", () => {
        clearTimeout(timer);
        resolve(oggPath);
      })
      .save(oggPath);
  });
}

/**
 * Download one YouTube URL as an MP4 video (H.264 + AAC), 480p max.
 * Success is "does the file exist", not exit code (songfetch rule).
 */
async function downloadVideo(url, outFile, skipUnavailable = false) {
  const flags = {
    format: "best[height<=480][ext=mp4]/best[height<=480]/best",
    mergeOutputFormat: "mp4",
    noPlaylist: true,
    output: outFile,
    ffmpegLocation: ffmpegPath,
  };
  if (skipUnavailable) {
    // `-i` skips entries it cannot extract and `--max-downloads 1`
    // stops at the first that works — that exits 101 ("max downloads
    // reached"), so the exit code cannot be the success test. The file is.
    flags.ignoreErrors = true;
    flags.maxDownloads = 1;
  }
  let ytdlpError = null;
  try {
    await ytdlp(url, flags);
  } catch (err) {
    ytdlpError = err;
  }
  if (!fs.existsSync(outFile)) {
    throw ytdlpError || new Error("yt-dlp produced no video file");
  }
}

/**
 * Main entry. Called from handlers/router.js with the Baileys socket.
 *
 * @param {object} sock    Baileys socket
 * @param {string} from    remoteJid (chat id)
 * @param {object} msg     original Baileys message (for replies)
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
  const say = (text) =>
    sock.sendMessage(from, { text, edit: status.key }).catch(() => {});

  if (wantVideo) return playVideo(sock, from, query, say);

  // ── Audio mode: the songfetch.py method via utils/songfetch.js ──

  // songfetch.py's CLI split: "Artist - Title" or `--artist X "X Title"`.
  const { artist, title } = parseArtistTitle(query);

  // Cache path, same layout downloadTrack() writes:
  // <root>/<Artist>/<Album>/<Title>.mp3 (+ .ogg for the WhatsApp copy)
  const safeArtist = sanitize(artist) || "Unknown Artist";
  const safeAlbum = sanitize("") || "Unknown Album";
  const safeTitle = sanitize(title) || "Unknown";
  const albumDir = path.join(CACHE_ROOT, safeArtist, safeAlbum);
  const mp3Path = path.join(albumDir, `${safeTitle}.mp3`);
  const oggPath = path.join(albumDir, `${safeTitle}.ogg`);

  if (!fs.existsSync(mp3Path)) {
    // player.py rule: while the IP cooldown is active, fail fast with the
    // remaining time instead of re-flagging the address.
    if (cooldownRemainingMs() > 0) {
      return say(failureMessage(title));
    }
    // Step 5 of the method: cover art from iTunes (no key), exact artist
    // match, "" rather than a wrong image.
    const imageUrl = await lookupCover(artist, title);
    await say(`📥 Downloading *${title}*...`);

    // Steps 1-4: search once, rank, try each candidate until the file
    // exists, clear .part files between attempts, tag it yourself.
    const got = await downloadTrack({
      artist,
      title,
      album: "",
      fmt: "mp3",
      outRoot: CACHE_ROOT,
      imageUrl,
      progress: (m) => say(`⏳ ${m}`),
    });

    if (!got || !fs.existsSync(mp3Path)) {
      return say(failureMessage(title));
    }
  } else {
    await say(`♻️ Cached: *${title}*`);
  }

  // WhatsApp inline-play format (Opus in OGG), cached next to the MP3.
  if (!fs.existsSync(oggPath)) {
    await say("🎧 Converting for WhatsApp...");
    await mp3ToWhatsAppOgg(mp3Path, oggPath);
  }

  await say("✅ Sending...");
  await sock.sendMessage(from, {
    audio: fs.readFileSync(oggPath),
    mimetype: "audio/ogg; codecs=opus",
    ptt: false, // false = music message; true = voice-note style
    fileName: `${safeTitle}.ogg`,
  });
}

/**
 * Video mode: the same search → rank → try-each-candidate method,
 * applied to MP4 downloads. Success = the file exists; .part files are
 * cleared between attempts; one-shot ytsearch fallback when the flat
 * search comes back empty.
 */
async function playVideo(sock, from, query, say) {
  const safeKey =
    sanitize(query.toLowerCase()).replace(/\s+/g, "_").slice(0, 60) || "video";
  const outFile = path.join(VIDEO_DIR, `${safeKey}.mp4`);

  if (fs.existsSync(outFile)) {
    await say(`♻️ Cached: *${query}*`);
  } else {
    // player.py rule: while the IP cooldown is active, fail fast.
    if (cooldownRemainingMs() > 0) {
      return say(failureMessage(query));
    }
    // Steps 1-2: search cheap, once, and rank (songfetch step 1-2).
    let candidates = [];
    try {
      candidates = await search(query, { limit: 5 });
    } catch (err) {
      if (/binary not found/i.test(String((err && err.message) || err))) {
        return say("⚠️ yt-dlp binary not found — run `npm install` to download it.");
      }
      candidates = []; // search failed → fall through to the one-shot fallback
    }
    const ranked = rank(candidates, query);

    if (ranked.length > 0) {
      await say(`🎬 Found: *${ranked[0].title}* — trying in order...`);
    } else if (cooldownRemainingMs() > 0) {
      // The search itself hit the bot check / 429 — don't fallback-hammer.
      return say(failureMessage(query));
    }

    // Step 3: try each candidate until the file exists.
    const targets =
      ranked.length > 0
        ? ranked.map((c) => ({ url: c.url, title: c.title, skipUnavailable: false }))
        : [{ url: `ytsearch5:${query}`, title: query, skipUnavailable: true }];

    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      if (i > 0) await say(`🔁 Trying ${i + 1}/${targets.length}: *${target.title}*...`);
      // Delete leftover .part files before each retry, otherwise the next
      // attempt resumes the previous one's half-file.
      clearPartials(VIDEO_DIR, safeKey);
      try {
        await downloadVideo(target.url, outFile, target.skipUnavailable);
        break;
      } catch (err) {
        console.error(`video attempt ${i + 1} failed:`, (err && err.message) || err);
        noteFailure(err);
        if (fs.existsSync(outFile)) {
          try {
            fs.unlinkSync(outFile);
          } catch {
            // ignore
          }
        }
        // A bot check / 429 means the IP is flagged: stop the loop, the
        // cooldown will make the next .play fail fast with a clear message.
        const kind = classifyError(err);
        if (kind === "botcheck" || kind === "ratelimit") break;
      }
    }

    if (!fs.existsSync(outFile)) {
      return say(failureMessage(query));
    }
  }

  await say("✅ Sending...");
  await sock.sendMessage(from, {
    video: fs.readFileSync(outFile),
    mimetype: "video/mp4",
    caption: `🎬 ${query}`,
  });
}

module.exports = { play, downloadVideo, mp3ToWhatsAppOgg };
