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
 *
 * Outbound proxy: when `YT_DLP_PROXY` (single) or `YT_DLP_PROXY_LIST`
 * (several, comma/newline-separated) is set, yt-dlp traffic goes through
 * it and WhatsApp traffic stays direct. With several proxies the pool
 * *rotates per call* — each search/candidate attempt rides the next IP —
 * and a proxy that fails (dead endpoint, or YouTube flagged its IP) is
 * benched for 10 minutes (`YT_DLP_PROXY_BENCH_MS`) so the rest keep
 * working. See README "If the IP stays blocked" for endpoint options.
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
 * Outbound proxy support for yt-dlp traffic only.
 *
 * Sources: `YT_DLP_PROXY_LIST` (comma/newline/semicolon-separated
 * Webshare-style URLs, e.g. `http://user:pass@host:port`) or the older
 * single `YT_DLP_PROXY` (which now also accepts a list). Per-call
 * `opts.proxy` overrides both ("" disables), which is what tests use.
 *
 * With 2+ proxies configured the pool rotates per yt-dlp call: each
 * search and each candidate download gets the next IP, spreading the
 * request rate across the pool. A proxy whose call fails at the
 * transport level (connection refused/auth/tunnel/timeout) or whose IP
 * YouTube flags (bot check / 429) is *benched* for
 * `YT_DLP_PROXY_BENCH_MS` (default 10 min) — the rotation skips it and
 * the rest keep working. While rotation is active, the 300 s global
 * YouTube cooldown does NOT apply (each call uses a different IP, so
 * one flagged proxy shouldn't stall the others); with a single proxy
 * or a direct connection it does, exactly as before.
 */

const PROXY_BENCH_MS_DEFAULT = 10 * 60 * 1000;

let proxyCursor = 0;
const benchedProxies = new Map(); // proxy URL -> bench-until timestamp (ms)

/** Split a raw env value into a deduped proxy URL list. */
function parseProxyList(raw) {
  const parts = String(raw || "")
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(parts)];
}

/** The configured pool: YT_DLP_PROXY_LIST, falling back to YT_DLP_PROXY. */
function proxyPool() {
  let pool = parseProxyList(process.env.YT_DLP_PROXY_LIST);
  if (pool.length === 0) pool = parseProxyList(process.env.YT_DLP_PROXY);
  return pool;
}

function benchMs() {
  const n = Number(process.env.YT_DLP_PROXY_BENCH_MS);
  return Number.isFinite(n) && n >= 0 ? n : PROXY_BENCH_MS_DEFAULT;
}

/**
 * Transport-level (dead/wrong endpoint) and IP-reputation (bot check /
 * 429) failures are the proxy's fault; content failures ("private
 * video", age-restricted, format) are not — benching for those would
 * eventually bench every healthy proxy for nothing.
 */
const PROXY_FAULT_RE =
  /econnrefused|econnreset|etimedout|eproto|enotfound|getaddrinfo|socket hang up|unable to connect to (proxy|host)|proxy (connect|authentication|error)|tunnel|http error 407|timed out after/i;
const PROXY_REPUTATION_RE = /sign in to confirm|not a bot|http error 429|too many requests/i;

function isProxyFault(err) {
  const msg = String((err && err.message) || err || "");
  return PROXY_FAULT_RE.test(msg) || PROXY_REPUTATION_RE.test(msg);
}

/** Bench a proxy after one of its calls failed. Returns true if benched. */
function penalizeProxy(proxy, err) {
  if (!proxy || !isProxyFault(err)) return false;
  benchedProxies.set(proxy, Date.now() + benchMs());
  return true;
}

/** Milliseconds this proxy is still benched for (0 = usable). */
function proxyBenchRemaining(proxy) {
  return Math.max(0, (benchedProxies.get(proxy) || 0) - Date.now());
}

/** Next proxy in the pool, skipping benched ones (round-robin per call). */
function nextProxy() {
  const pool = proxyPool();
  if (pool.length === 0) return "";
  for (let i = 0; i < pool.length; i++) {
    const cand = pool[(proxyCursor + i) % pool.length];
    if (proxyBenchRemaining(cand) === 0) {
      proxyCursor = (proxyCursor + i + 1) % pool.length;
      return cand;
    }
  }
  // Every proxy is benched — rotate anyway: bench windows expire, and
  // a possibly-recovered proxy beats a dead bot.
  const cand = pool[proxyCursor % pool.length];
  proxyCursor = (proxyCursor + 1) % pool.length;
  return cand;
}

/** True when 2+ proxies are configured (rotation + no global cooldown). */
function rotatingProxiesActive() {
  return proxyPool().length > 1;
}

/** Forget benches and the cursor (admin escape hatch; used by tests). */
function resetProxyPool() {
  proxyCursor = 0;
  benchedProxies.clear();
}

/**
 * The proxy for one yt-dlp call. Resolution order: per-call `opts.proxy`
 * (tests / callers; "" disables), then the configured pool. Returns ""
 * when nothing is configured — yt-dlp connects directly.
 */
function proxyArg(opts = {}) {
  if (opts.proxy !== undefined) return String(opts.proxy || "");
  const pool = proxyPool();
  if (pool.length === 0) return "";
  if (pool.length === 1) return pool[0];
  return nextProxy();
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

  const args = [...toArgs(flags)];
  const proxy = proxyArg(opts);
  if (proxy) {
    args.push("--proxy", proxy);
  }
  args.push("--", url);  const timeoutMs =
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
            const err = new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`);
            penalizeProxy(proxy, err); // a hang is usually a dead/slow proxy
            settle(err);
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
        const err = new Error(stderr.trim() || `yt-dlp exited with code ${code}`);
        penalizeProxy(proxy, err);
        settle(err);
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
  parseProxyList,
  proxyPool,
  proxyArg,
  nextProxy,
  penalizeProxy,
  proxyBenchRemaining,
  rotatingProxiesActive,
  resetProxyPool,
  isProxyFault,
  BIN_DIR,
  RELEASE_BASE,
  MIN_BINARY_BYTES,
  DEFAULT_MAX_AGE_HOURS,
  PROXY_BENCH_MS_DEFAULT,
};
