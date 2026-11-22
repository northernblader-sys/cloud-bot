#!/usr/bin/env node
"use strict";

/**
 * Root postinstall: fetch the standalone yt-dlp binary into bin/.
 * See utils/ytdlp.js for why this replaces youtube-dl-exec.
 *
 * Skips when a fresh-enough binary is already there; re-downloads one
 * older than YT_DLP_MAX_AGE_HOURS (default 24 h — music-seeker refreshes
 * yt-dlp nightly at container start, because YouTube breaks old
 * extractors). `index.js` runs the same check at every bot start.
 *
 * Fails the install (exit 1) on purpose when there is no usable binary
 * afterwards — a loud build-time error beats a broken .play command
 * discovered later. A failed *refresh* keeps the existing binary instead.
 */

const { installYtDlp } = require("../utils/ytdlp");

installYtDlp()
  .then(({ dest, skipped, bytes, reason }) => {
    if (skipped) {
      console.log(`[ytdlp] binary already present${reason ? ` (${reason})` : ""}: ${dest}`);
    } else {
      console.log(`[ytdlp] installed (${(bytes / 1048576).toFixed(1)} MB): ${dest}`);
    }
  })
  .catch((err) => {
    console.error(`[ytdlp] install failed: ${err.message}`);
    console.error(
      "[ytdlp] the .play command needs this binary — re-run `npm install`, " +
        "or download it manually to bin/yt-dlp"
    );
    process.exit(1);
  });
