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
 * How it works — audio mode runs a five-stage fallback chain:
 *
 *     cache hit?  ->  send
 *        | no
 *     Prexzy ytmp3 (candidate 1 -> 2 -> ...)  <- FIRST: YouTube -> .m4a
 *        | fail                                (googlevideo link — EXPIRES,
 *        |                                      download immediately, never store)
 *     Knight API (candidate 1 -> ...)          YouTube -> MP3 on savetube.vip
 *        | fail                                CDN (no IP lock, no expiry)
 *     SoundCloud (candidate 1 -> ...)          no bot check, no proxy needed;
 *        | fail                                reached lazily, own search
 *     yt-dlp (songfetch method)                last resort only; the 300s YouTube
 *                                              IP cooldown gates ONLY this stage
 *
 * Same-API-next-candidate before switching APIs: one dead upload is not a
 * dead API. The YouTube flat search runs up front (both YouTube APIs take
 * watch URLs). Pasted soundcloud.com / snd.sc links bypass the YouTube
 * flow entirely (resolve -> card from SC metadata -> download). Whichever
 * stage wins, the file is sent DIRECTLY (mp3/m4a are natively playable
 * WhatsApp audio formats — no transcode, no "Converting..." wait; the
 * Opus/OGG path remains only as a send-failure fallback). The metadata
 * card is sent before the download.
 *
 * Video mode (.play -v) still uses yt-dlp directly (songfetch search ->
 * rank -> try-each-candidate loop on MP4 downloads).
 *
 * No player-client overrides, no cookies, no retries/extractor-args
 * tricks anywhere — the download flags are exactly songfetch.py's.
 */

const fs = require("fs");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const { buildTrackCard } = require("../utils/trackCard");
const { ytdlp, rotatingProxiesActive } = require("../utils/ytdlp");
const { downloadViaApis } = require("../utils/songApis");
const {
  isSoundCloudUrl,
  extractSoundCloudUrl,
  resolveSoundCloud,
  searchSoundCloud,
  rankSoundCloud,
  downloadSoundCloudCandidates,
} = require("../utils/soundcloud");
const {
  search,
  rank,
  clearPartials,
  sanitize,
  parseArtistTitle,
  downloadTrack,
  lookupTrackInfo,
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
  if (kind === "botcheck" || kind === "ratelimit" || kind === "forbidden") {
    const label =
      kind === "ratelimit" ? " (HTTP 429)" : kind === "forbidden" ? " (HTTP 403)" : " (bot check)";
    if (rotatingProxiesActive()) {
      return (
        `🚫 YouTube flagged one of the proxy IPs while fetching *${what}*${label}.\n` +
        "That IP is benched for 10 min and the next ones get tried automatically.\n" +
        "If this keeps failing, refresh the proxy list (YT_DLP_PROXY_LIST) — free datacenter proxies are often already flagged."
      );
    }
    const mins = Math.max(1, Math.ceil(cooldownRemainingMs() / 60000));
    return (
      `🚫 YouTube is rate-limiting this server's IP${label}.\n` +
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

/** Download an image URL into a Buffer (null on any failure or tiny body). */
async function fetchImageBuffer(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 1000 ? buf : null; // <1 KB is an error page, not art
  } catch {
    return null;
  }
}

/**
 * Convert any audio input (yt-dlp MP3 or API .m4a — fluent-ffmpeg reads
 * the content, not the extension) to WhatsApp's inline-play format:
 * mono 48 kHz Opus in OGG.
 */
function mp3ToWhatsAppOgg(inputPath, oggPath) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("audio conversion timed out")), 120 * 1000);
    ffmpeg(inputPath)
      .noVideo() // ignore embedded cover streams — the card already showed them
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(48000)
      .audioBitrate("64k")
      // ffmpeg's libopus default is compression_level 10 — maximum CPU
      // complexity, which on Render's small vCPU meant 30-90 s per song
      // ("the conversion takes too long"). Level 3 is roughly 5-10x
      // faster; at 64 kbps mono the audible difference is nil, and
      // WhatsApp re-encodes audio itself for playback anyway.
      .outputOptions(["-compression_level", "3", "-application", "audio"])
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
    // The bot-check client ladder may only offer pre-merged mp4 above
    // 480p, so fall back to DASH (video+audio merged by ffmpeg-static)
    // before giving up on the height cap.
    format: "best[height<=480][ext=mp4]/bv[height<=480]+ba/b[height<=480]/best",
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

  // ── Audio mode ──
  // Chain order (per the user: Prexzy first, then Knight, then SoundCloud):
  //   cache → Prexzy ytmp3 → Knight → SoundCloud (Prexzy SC endpoints) → yt-dlp.
  // The YouTube IP cooldown gates ONLY the yt-dlp stage.

  // A pasted SoundCloud link (soundcloud.com/... or snd.sc/...) bypasses
  // the YouTube flow entirely: resolve it, card from SC metadata, done.
  const scLink = extractSoundCloudUrl(query);
  if (scLink) return playSoundCloudLink(sock, from, query, scLink, say);

  // songfetch.py's CLI split: "Artist - Title" or `--artist X "X Title"`.
  const { artist, title } = parseArtistTitle(query);

  // Cache path, same layout downloadTrack() writes:
  // <root>/<Artist>/<Album>/<Title>.mp3 (+ .ogg for the WhatsApp copy)
  const safeArtist = sanitize(artist) || "Unknown Artist";
  const safeAlbum = sanitize("") || "Unknown Album";
  const safeTitle = sanitize(title) || "Unknown";
  const albumDir = path.join(CACHE_ROOT, safeArtist, safeAlbum);
  fs.mkdirSync(albumDir, { recursive: true }); // card/ogg writes need it on first play
  const mp3Path = path.join(albumDir, `${safeTitle}.mp3`);
  const m4aPath = path.join(albumDir, `${safeTitle}.m4a`);
  const oggPath = path.join(albumDir, `${safeTitle}.ogg`);
  const outBase = path.join(albumDir, safeTitle);

  const cardPath = path.join(albumDir, `${safeTitle}.card.png`);
  let trackInfo = null; // iTunes match — card fallback + yt-dlp tag art
  const wasCached = Boolean(fs.existsSync(mp3Path) || fs.existsSync(m4aPath));
  // What actually produced the master file: { source, title?, author?,
  // thumbnail?/artwork? } — its thumbnail is the artwork of the exact
  // upload the user is getting, so it beats any catalogue guess.
  let served = null;

  if (wasCached) {
    served = { source: "cache" };
    await say(`♻️ Cached: *${title}*`);
  } else {
    // ── Stages 1+2: Prexzy ytmp3, then Knight — the YouTube-based APIs,
    // first in the chain. The flat search runs up front: both take
    // watch URLs, so the video-ID list is needed immediately.
    let candidates = [];
    let searchError = null;
    try {
      candidates = rank(await search(query, { limit: 5 }), query);
    } catch (err) {
      searchError = err;
    }

    // The same API is retried with the NEXT candidate video before
    // switching APIs: one dead upload is not a dead API. Each attempt
    // edits the status message so ~7s-per-attempt doesn't look frozen.
    let apiResult = null;
    if (candidates.length > 0) {
      apiResult = await downloadViaApis({
        candidates,
        outBase,
        onAttempt: (label) => say(`${label}...`),
      });
    }

    if (apiResult) {
      served = apiResult;
      await say(`✅ Downloaded via ${apiResult.source} API`);
    } else {
      // ── Stage 3: SoundCloud — its own search, reached lazily only after
      // both YouTube APIs failed. No bot check, no proxy needed.
      try {
        const scRows = await searchSoundCloud(query, 8);
        const rankedSc = rankSoundCloud(scRows, query);
        if (rankedSc.length > 0) {
          const scResult = await downloadSoundCloudCandidates({
            candidates: rankedSc,
            outBase,
            onAttempt: (label) => say(`☁️ ${label}...`),
          });
          if (scResult) {
            served = scResult;
            await say(
              `✅ Downloaded from SoundCloud${scResult.author ? ` — ${scResult.author}` : ""}`
            );
          }
        }
      } catch (scErr) {
        console.error(
          "soundcloud stage failed (falling through):",
          (scErr && scErr.message) || scErr
        );
      }

      // ── Stage 4: yt-dlp last resort (skipped when SoundCloud already
      // wrote the file). The YouTube IP cooldown gates ONLY this path —
      // every API stage ran first.
      if (!served) {
        if (
          searchError &&
          /binary not found/i.test(String((searchError && searchError.message) || searchError))
        ) {
          return say("⚠️ yt-dlp binary not found — run `npm install` to download it.");
        }
        if (cooldownRemainingMs() > 0) {
          return say(failureMessage(title));
        }
        await say("🌀 Trying yt-dlp fallback...");
        const imageUrl = trackInfo ? trackInfo.artworkUrl : await lookupCover(artist, title);
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
        served = { source: "yt-dlp" };
      }
    }
  }

  // The metadata card, built AFTER the download so it can use the serving
  // stage's own thumbnail — the artwork of the exact upload the user is
  // getting (Prexzy/Knight return one, SoundCloud's artwork, else the
  // iTunes exact-artist match; the dark ♪ fallback card is the last
  // resort and is NOT cached, so a later play can still pick up real art).
  // Skipped silently on errors — the audio never depends on the card.
  try {
    if (!fs.existsSync(cardPath)) {
      let coverBuf = null;
      let cardTitle = title;
      let cardArtist = artist;
      let cardAlbum = "";
      let cardDurationMs = 0;

      const apiArt = served && (served.thumbnail || served.artwork);
      if (apiArt) {
        coverBuf = await fetchImageBuffer(apiArt);
        cardTitle = served.title || title;
        cardArtist = served.author || artist;
      }
      if (!coverBuf) {
        trackInfo = trackInfo || (await lookupTrackInfo(artist, title));
        if (trackInfo) {
          coverBuf = await fetchImageBuffer(trackInfo.artworkUrl);
          cardTitle = trackInfo.trackName;
          cardArtist = trackInfo.artistName;
          cardAlbum = trackInfo.collectionName;
          cardDurationMs = trackInfo.durationMs;
        }
      }

      const png = await buildTrackCard({
        title: cardTitle,
        artist: cardArtist,
        album: cardAlbum,
        durationMs: cardDurationMs,
        cover: coverBuf,
      });
      if (coverBuf) fs.writeFileSync(cardPath, png);
      await sock.sendMessage(from, { image: png });
    } else {
      await sock.sendMessage(from, { image: fs.readFileSync(cardPath) });
    }
  } catch (cardErr) {
    console.error("track card failed (continuing):", (cardErr && cardErr.message) || cardErr);
  }

  // Send (shared tail — see sendAudioFile).
  const master = fs.existsSync(mp3Path) ? mp3Path : fs.existsSync(m4aPath) ? m4aPath : null;
  if (!master) {
    return say(failureMessage(title));
  }
  await sendAudioFile(sock, from, master, safeTitle, say);
}

/**
 * Shared send tail: sends the master file DIRECTLY as a WhatsApp audio
 * message. MP3 and M4A are natively playable audio formats in WhatsApp
 * (same music bubble as when a phone sends an .m4a) — the mandatory Opus/
 * OGG transcode only applies to voice-note mode (ptt: true), which we
 * don't use. Skipping the conversion removes the whole "Converting for
 * WhatsApp..." wait, and for SoundCloud HQ (AAC 160 kbps stereo) it is
 * also a quality UPGRADE over the old 64 kbps mono Opus re-encode.
 *
 * The Opus/OGG path (mp3ToWhatsAppOgg) is kept only as a fallback for
 * the rare case the direct send itself errors out.
 */
async function sendAudioFile(sock, from, masterPath, safeTitle, say) {
  const ext = path.extname(masterPath).toLowerCase();
  const mimetype = ext === ".m4a" ? "audio/mp4" : "audio/mpeg";

  // The audio upload can take several seconds — show it as Sending, not
  // stuck on a conversion that already finished.
  await say("✅ Sending...");

  try {
    await sock.sendMessage(from, {
      audio: fs.readFileSync(masterPath),
      mimetype,
      ptt: false, // false = music message; true = voice-note style
      fileName: path.basename(masterPath),
    });
  } catch (sendErr) {
    console.error("direct audio send failed, falling back to Opus/OGG:", (sendErr && sendErr.message) || sendErr);
    const oggPath = masterPath.replace(/\.(mp3|m4a)$/i, ".ogg");
    await say("🎧 Optimizing for WhatsApp...");
    await mp3ToWhatsAppOgg(masterPath, oggPath);
    await sock.sendMessage(from, {
      audio: fs.readFileSync(oggPath),
      mimetype: "audio/ogg; codecs=opus",
      ptt: false,
      fileName: `${safeTitle}.ogg`,
    });
  }
}

/**
 * Pasted-SoundCloud-link path: resolve → metadata card from SC fields →
 * download (direct byte link, HLS fallback) → shared convert+send tail.
 * No YouTube, no iTunes, no proxies involved anywhere.
 */
async function playSoundCloudLink(sock, from, query, scLink, say) {
  await say("☁️ Resolving SoundCloud track...");
  let track = null;
  try {
    track = await resolveSoundCloud(scLink);
  } catch (err) {
    console.error("soundcloud resolve failed:", (err && err.message) || err);
    return say(
      `❌ Couldn't resolve that SoundCloud link — the track may be private, deleted, or geo-blocked.`
    );
  }

  const safeArtist = sanitize(track.author) || "Unknown Artist";
  const safeTitle = sanitize(track.title) || "Unknown";
  const albumDir = path.join(CACHE_ROOT, safeArtist, "Unknown Album");
  fs.mkdirSync(albumDir, { recursive: true });
  const cardPath = path.join(albumDir, `${safeTitle}.card.png`);

  // Metadata card from the SC response itself (artwork is often present
  // here, unlike the search rows). Not cached without artwork — a later
  // play can still pick up real art.
  try {
    if (!fs.existsSync(cardPath)) {
      const coverBuf = await fetchImageBuffer(track.artwork);
      const png = await buildTrackCard({
        title: track.title,
        artist: track.author,
        album: "",
        durationMs: track.durationMs || 0,
        cover: coverBuf,
      });
      if (coverBuf) fs.writeFileSync(cardPath, png);
      await sock.sendMessage(from, { image: png });
    } else {
      await sock.sendMessage(from, { image: fs.readFileSync(cardPath) });
    }
  } catch (cardErr) {
    console.error("track card failed (continuing):", (cardErr && cardErr.message) || cardErr);
  }

  const existing = fs.existsSync(path.join(albumDir, `${safeTitle}.mp3`))
    ? path.join(albumDir, `${safeTitle}.mp3`)
    : fs.existsSync(path.join(albumDir, `${safeTitle}.m4a`))
      ? path.join(albumDir, `${safeTitle}.m4a`)
      : null;

  if (existing) {
    await say(`♻️ Cached: *${track.title}*`);
  } else {
    const got = await downloadSoundCloudCandidates({
      candidates: [{ id: track.id, title: track.title, url: scLink }],
      outBase: path.join(albumDir, safeTitle),
      onAttempt: (label) => say(`☁️ ${label}...`),
    });
    if (!got) {
      return say(
        `❌ Couldn't download *${track.title}* from SoundCloud — try again, or use the track name instead of the link.`
      );
    }
    await say("✅ Downloaded from SoundCloud");
  }

  const master = fs.existsSync(path.join(albumDir, `${safeTitle}.mp3`))
    ? path.join(albumDir, `${safeTitle}.mp3`)
    : fs.existsSync(path.join(albumDir, `${safeTitle}.m4a`))
      ? path.join(albumDir, `${safeTitle}.m4a`)
      : null;
  if (!master) {
    return say(failureMessage(track.title));
  }
  await sendAudioFile(sock, from, master, safeTitle, say);
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
        // A bot check / 429 means the current IP is flagged: stop the
        // loop (the cooldown will fail fast the next .play) — unless a
        // rotating proxy pool is active, where the next candidate uses a
        // different IP and is worth trying.
        const kind = classifyError(err);
        if ((kind === "botcheck" || kind === "ratelimit") && !rotatingProxiesActive()) break;
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
