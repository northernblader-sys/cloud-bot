#!/usr/bin/env node
"use strict";

/**
 * Root postinstall: fetch the standalone yt-dlp binary into bin/.
 * See utils/ytdlp.js for why this replaces youtube-dl-exec.
 *
 * Fails the install (exit 1) on purpose when the download fails — a loud
 * build-time error beats a broken .play command discovered later.
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
