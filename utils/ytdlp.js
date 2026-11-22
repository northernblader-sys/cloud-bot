"use strict";

/**
 * yt-dlp runner for the `.play` command (commands/music.js).
 *
 * Why not `youtube-dl-exec`? Its install scripts require a system Python
 * 3.11+ — Render's default Node image doesn't ship one, so `npm install`
 * failed the Render build. Skipping that check wouldn't help either: the
 * asset it downloads by default (`yt-dlp`) is a Python zipapp that needs
 * that interpreter at runtime too.
 *
 * The official standalone releases (`yt-dlp_linux`, `yt-dlp_macos`,
 * `yt-dlp.exe`, ...) embed their own interpreter, so we fetch those
 * instead: zero system packages, zero Python, plain `npm install` works
 * on Render. `scripts/install-ytdlp.js` (root postinstall) downloads the
 * binary to `bin/`; this module spawns it using the same dargs flag
 * conversion youtube-dl-exec used, so call sites behave identically.
 *
 * The `.play` download method itself lives in `utils/songfetch.js`
 * (search-rank-retry, ported from songfetch.py). This module is just
 * the binary installer + process runner.
 *
 * The installer also *refreshes*: YouTube breaks old extractors between
 * releases, and music-seeker's answer ("nightly yt-dlp updates at every
 * container start") clears a lot of "bot checks" on its own. A binary
 * older than `YT_DLP_MAX_AGE_HOURS` (default 24) is re-downloaded on
 * the next `npm install` or bot start; if the refresh fails, the
 * existing binary is kept — an outdated yt-dlp beats no yt-dlp.
 */

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const dargs = require("dargs");

const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const BIN_DIR = path.join(__dirname, "..", "bin");
// Anything smaller than 1 MB is not yt-dlp (the real binaries are 22-40 MB);
// it's an HTML/JSON error page or a truncated download.
const MIN_BINARY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
// music-seeker refreshes yt-dlp nightly at every container start; YouTube
// breaks old extractors between releases. Default: refresh after 24 h.
const DEFAULT_MAX_AGE_HOURS = 24;

/** Max age (ms) a fetched binary may have before it gets re-downloaded. */
function maxAgeMsFromEnv() {
  const hours = Number(process.env.YT_DLP_MAX_AGE_HOURS);
  const value = Number.isFinite(hours) ? hours : DEFAULT_MAX_AGE_HOURS;
  return value * 60 * 60 * 1000; // 0 = always refresh, negative = never
}

/** Where the yt-dlp binary lives. YT_DLP_PATH overrides for custom setups. */
function binPath(platform = process.platform) {
  return process.env.YT_DLP_PATH || path.join(BIN_DIR, platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
}

/** Official release asset name for a platform/arch pair. */
function assetFor(platform, arch) {
  if (platform === "linux") {
    if (arch === "x64") return "yt-dlp_linux";
    if (arch === "arm64") return "yt-dlp_linux_aarch64";
    throw new Error(
      `unsupported linux arch "${arch}" — download yt-dlp_linux_armv7l.zip ` +
        `from GitHub manually and set YT_DLP_PATH`
    );
  }
  if (platform === "darwin") return "yt-dlp_macos";
  if (platform === "win32") {
    if (arch === "x64") return "yt-dlp.exe";
    if (arch === "arm64") return "yt-dlp_arm64.exe";
    if (arch === "ia32") return "yt-dlp_x86.exe";
    throw new Error(`unsupported windows arch "${arch}"`);
  }
  throw new Error(`unsupported platform "${platform}" — set YT_DLP_PATH to a yt-dlp binary`);
}

/** camelCase flags -> yt-dlp CLI args (same dargs conversion youtube-dl-exec used). */
function toArgs(flags = {}) {
  return dargs(flags, { useEquals: false }).filter(Boolean);
}

async function isSizedFile(filePath, minBytes) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.isFile() && stat.size >= minBytes;
  } catch {
    return false;
  }
}

async function makeExecutable(filePath, platform) {
  if (platform === "win32") return;
  await fs.promises.chmod(filePath, 0o755);
}

/**
 * Download the standalone yt-dlp binary into `dir` (default: bin/).
 * Idempotent: skips when a valid-sized, fresh-enough binary is already
 * there, so repeated `npm install` runs are free. A binary older than
 * `maxAgeMs` is re-downloaded (music-seeker refreshes yt-dlp nightly at
 * every container start — YouTube breaks old extractors, and a current
 * binary alone clears a lot of bot checks). When the refresh fails but
 * a valid binary exists, the old one is kept: an outdated yt-dlp beats
 * no yt-dlp. Throws only when there is no usable binary afterwards —
 * we want a loud build-time error, not a silent .play failure later.
 *
 * @param {object} [opts]
 * @param {string} [opts.dir] target directory (default bin/)
 * @param {string} [opts.url] direct download URL (tests inject a local one)
 * @param {string} [opts.platform] defaults to process.platform
 * @param {string} [opts.arch] defaults to process.arch
 * @param {number} [opts.minBytes] sanity floor (default 1 MB)
 * @param {number} [opts.maxAgeMs] refresh threshold (default 24 h;
 *   0 = always refresh, negative = never; falls back to
 *   $YT_DLP_MAX_AGE_HOURS when omitted)
 * @param {Function} [opts.fetchImpl] fetch override for tests
 */
async function installYtDlp({
  dir = BIN_DIR,
  url,
  platform = process.platform,
  arch = process.arch,
  minBytes = MIN_BINARY_BYTES,
  maxAgeMs,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (process.env.YT_DLP_PATH) {
    return { dest: process.env.YT_DLP_PATH, skipped: true, reason: "YT_DLP_PATH is set" };
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("global fetch is unavailable — Node 18+ is required to install yt-dlp");
  }
  const maxAge = maxAgeMs === undefined ? maxAgeMsFromEnv() : maxAgeMs;

  const dest = path.join(dir, platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  const downloadUrl = url || `${RELEASE_BASE}/${assetFor(platform, arch)}`;

  const download = async () => {
    const res = await fetchImpl(downloadUrl, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`yt-dlp download failed: HTTP ${res.status} ${downloadUrl}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length < minBytes) {
      throw new Error(
        `yt-dlp download looks corrupt: ${body.length} bytes (< ${minBytes}) from ${downloadUrl}`
      );
    }
    // Write to a temp name, then rename, so an interrupted install never
    // leaves a truncated binary that would pass the exists-check next time.
    await fs.promises.mkdir(dir, { recursive: true });
    const tmp = `${dest}.part`;
    await fs.promises.writeFile(tmp, body);
    await fs.promises.rename(tmp, dest);
    await makeExecutable(dest, platform);
    return { dest, skipped: false, bytes: body.length };
  };

  if (await isSizedFile(dest, minBytes)) {
    await makeExecutable(dest, platform);
    let ageMs = 0;
    try {
      ageMs = Date.now() - (await fs.promises.stat(dest)).mtimeMs;
    } catch {
      ageMs = 0;
    }
    const fresh = maxAge > 0 && ageMs < maxAge;
    if (maxAge < 0 || fresh) {
      // maxAge < 0 = refresh disabled; otherwise still inside the window.
      return { dest, skipped: true };
    }
    // Stale (or YT_DLP_MAX_AGE_HOURS=0): refresh. On failure keep the old
    // binary and say why — an outdated yt-dlp beats no yt-dlp.
    try {
      return await download();
    } catch (err) {
      return {
        dest,
        skipped: true,
        reason: `kept existing binary (age ${Math.round(ageMs / 3600000)}h) — refresh failed: ${err.message}`,
      };
    }
  }

  return download();
}

/**
 * Run yt-dlp against a URL with youtube-dl-exec-compatible flags.
 * Resolves with stdout (JSON-parsed when it looks like JSON), rejects with
 * an Error carrying yt-dlp's stderr on failure.
 *
 * @param {string} url
 * @param {object} [flags] camelCase yt-dlp flags, e.g. { extractAudio: true, audioFormat: "opus" }
 * @param {object} [opts]
 * @param {string} [opts.bin] binary path override (tests use this)
 * @param {number} [opts.timeoutMs] kill after this long (default 15 min; 0 disables)
 */
function ytdlp(url, flags = {}, opts = {}) {
  const bin = opts.bin || binPath();
  if (!fs.existsSync(bin)) {
    return Promise.reject(
      new Error(
        `yt-dlp binary not found at ${bin} — run \`npm install\` to download it ` +
          `(or set YT_DLP_PATH)`
      )
    );
  }

  const args = [...toArgs(flags), "--", url];
  const timeoutMs =
    opts.timeoutMs !== undefined
      ? opts.timeoutMs
      : process.env.YTDLP_TIMEOUT_MS
        ? Number(process.env.YTDLP_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            settle(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`));
          }, timeoutMs)
        : null;

    function settle(err, value) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => settle(err));
    child.on("close", (code) => {
      if (code !== 0) {
        settle(new Error(stderr.trim() || `yt-dlp exited with code ${code}`));
        return;
      }
      const out = stdout.trim();
      if (out.startsWith("{")) {
        try {
          settle(null, JSON.parse(out));
          return;
        } catch {
          // not valid JSON after all — fall through and return raw stdout
        }
      }
      settle(null, out);
    });
  });
}

module.exports = {
  ytdlp,
  toArgs,
  binPath,
  assetFor,
  installYtDlp,
  BIN_DIR,
  RELEASE_BASE,
  MIN_BINARY_BYTES,
  DEFAULT_MAX_AGE_HOURS,
};
