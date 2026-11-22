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
 *
 * YouTube bot checks: YouTube walls datacenter IPs (Render's) behind
 * "Sign in to confirm you're not a bot" on its default clients. Cookies
 * are off the table for this bot, so instead every video download
 * requests a ladder of client impersonations via --extractor-args (see
 * YOUTUBE_LADDER) and, if yt-dlp still reports the wall on stderr,
 * climbs two more rungs: --force-ipv4 + a webpage-free fetch, then an
 * alternate client ladder (see buildAttempts). The optional `deno` npm
 * package supplies the JS runtime that most ladder clients need to
 * decode their streams; when it's installed its binary path is passed
 * via --js-runtimes (android_vr, the ladder's bot-check bypass, works
 * without any runtime). Flat `ytsearch:` calls skip all of it — no
 * player API is involved there, so search stays single-attempt.
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

// --- Cookie-free YouTube bot-check workaround -------------------------------
// YouTube's "Sign in to confirm you're not a bot" wall (playabilityStatus
// reason + login hint) hits datacenter IPs on the default client set.
// We never pass cookies, so instead we ask for a ladder of clients in ONE
// yt-dlp run: the extractor tries each in order, warns-and-continues on
// per-client failures, and merges whatever formats come back.
//   android_vr     — JS-free, community-proven bot-check bypass (the carrier)
//   tv_downgraded/tv/web_embedded/mweb — JS-dependent alternates; without a
//     JS runtime their unsolvable sig/n formats are skipped non-fatally,
//     with deno installed they contribute full format lists.
const YOUTUBE_LADDER =
  "youtube:player_client=android_vr,tv_downgraded,tv,web_embedded,mweb";
// Second ladder for the retry pass (Grabora-style): different client mix
// in case the first ladder is itself walled. ios is deliberately absent —
// its GVS PO-token policy is required=True and we run no PO-token plugin.
const YOUTUBE_LADDER_RETRY =
  "youtube:player_client=web_creator,web,android_vr,tv_downgraded";
// yt-dlp surfaces the wall on stderr as its error message (the playability
// reason, echoed by raise_no_formats). Match the phrases YouTube uses.
const BOT_CHECK_RE = /not a bot|sign in to confirm|login required/i;
// The cookie how-to yt-dlp appends after the reason (_youtube_login_hint).
// Cookies are rejected for this bot, so strip the advice from errors we
// surface in chat — "Sign in to confirm you're not a bot." alone is clearer.
const COOKIE_HINT_RE = /\s*Use --cookies[\s\S]*$/i;

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
const PROXY_REPUTATION_RE =
  /sign in to confirm|not a bot|http error 429|too many requests|http error 403|unable to download video data|access denied|forbidden/i;

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
 * Locate the deno binary installed by the optional `deno` npm package.
 * Returns an absolute path, or null when the package isn't installed —
 * callers then simply omit --js-runtimes and the ladder's JS-free clients
 * (android_vr) carry the download on their own.
 */
function resolveDenoPath() {
  const name = process.platform === "win32" ? "deno.exe" : "deno";
  const p = path.join(__dirname, "..", "node_modules", "deno", name);
  return fs.existsSync(p) ? p : null;
}

/**
 * Build the flag sets for a bot-check-hardened run: three rungs, each a
 * full yt-dlp invocation. Rung 1 is the plain client ladder; rungs 2-3
 * add --force-ipv4 (the wall can be IP-family-specific) and skip the
 * /watch webpage fetch (another wall surface), rung 3 switching to an
 * alternate client mix. Every rung carries deno's path via --js-runtimes
 * when available.
 *
 * @param {object} [flags] caller flags (youtube-dl-exec style)
 * @param {object} [opts]
 * @param {string|null} [opts.denoPath] undefined=auto-detect, null=disable
 * @returns {object[]} flag objects, one per attempt, in order
 */
function buildAttempts(flags = {}, opts = {}) {
  const deno = opts.denoPath !== undefined ? opts.denoPath : resolveDenoPath();
  const rung = (extractorArgs, extra = {}) => {
    const f = { ...flags, ...extra, extractorArgs };
    // Auto-wire deno unless the caller pinned their own runtime.
    if (deno && f.jsRuntimes === undefined) f.jsRuntimes = `deno:${deno}`;
    return f;
  };
  return [
    rung(YOUTUBE_LADDER),
    rung(`${YOUTUBE_LADDER};player_skip=webpage`, { forceIpv4: true }),
    rung(`${YOUTUBE_LADDER_RETRY};player_skip=webpage`, { forceIpv4: true }),
  ];
}

/**
 * One yt-dlp spawn. Resolves with stdout (JSON-parsed when it looks like
 * JSON), rejects with an Error carrying yt-dlp's stderr on failure.
 * `proxy` is the outbound proxy used for this attempt ("" = direct) —
 * recorded on failure so a bad IP gets benched by the pool.
 */
function runOnce(bin, args, timeoutMs, proxy) {
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

/**
 * Run yt-dlp against a URL with youtube-dl-exec-compatible flags.
 * Resolves with stdout (JSON-parsed when it looks like JSON), rejects with
 * an Error carrying yt-dlp's stderr on failure.
 *
 * Bot-check handling (cookie-free): video URLs get buildAttempts()' three
 * rungs (client ladder, then force-ipv4 + no-webpage, then an alternate
 * ladder). A new rung starts ONLY when yt-dlp's stderr matches YouTube's
 * wall; any other failure (404s, timeouts, network) surfaces after the
 * first spawn. Flat `ytsearch:` calls skip the ladder entirely — no
 * player API is involved, so search keeps main's single-attempt,
 * fail-fast-into-cooldown behavior. The final error has yt-dlp's cookie
 * advice stripped (cookies are rejected for this bot).
 *
 * Each rung resolves its own proxy: with a rotating pool a walled IP
 * gets benched (penalizeProxy in runOnce) and the next rung rides the
 * next proxy.
 *
 * @param {string} url
 * @param {object} [flags] camelCase yt-dlp flags, e.g. { extractAudio: true, audioFormat: "opus" }
 * @param {object} [opts]
 * @param {string} [opts.bin] binary path override (tests use this)
 * @param {number} [opts.timeoutMs] per-attempt kill timer (default 15 min; 0 disables)
 * @param {string} [opts.proxy] per-call proxy override ("" disables; tests use this)
 * @param {string|null} [opts.denoPath] JS-runtime binary override; null disables
 *   --js-runtimes (default: auto-detect node_modules/deno)
 */
async function ytdlp(url, flags = {}, opts = {}) {
  const bin = opts.bin || binPath();
  if (!fs.existsSync(bin)) {
    throw new Error(
      `yt-dlp binary not found at ${bin} — run \`npm install\` to download it ` +
        `(or set YT_DLP_PATH)`
    );
  }

  const timeoutMs =
    opts.timeoutMs !== undefined
      ? opts.timeoutMs
      : process.env.YTDLP_TIMEOUT_MS
        ? Number(process.env.YTDLP_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

  // Flat search never touches the player API — the ladder would only add
  // pointless flags and triple the wall-failure latency, so keep the
  // single plain attempt there.
  const isFlatSearch = /^ytsearch\d*:/i.test(String(url));
  const attempts = isFlatSearch ? [flags] : buildAttempts(flags, opts);

  let lastErr;
  for (let i = 0; i < attempts.length; i++) {
    // One proxy per rung: a walled IP is benched and the next rung (or
    // the next call) rides the next proxy in the pool.
    const proxy = proxyArg(opts);
    const args = [...toArgs(attempts[i])];
    if (proxy) args.push("--proxy", proxy);
    args.push("--", url);
    try {
      return await runOnce(bin, args, timeoutMs, proxy);
    } catch (err) {
      lastErr = err;
      // Only YouTube's wall earns another rung; every other failure
      // (404s, timeouts, network) is final after the first attempt.
      const isLast = i === attempts.length - 1;
      if (isLast || !BOT_CHECK_RE.test(String((err && err.message) || ""))) {
        throw stripCookieHint(err);
      }
    }
  }
  /* istanbul ignore next — loop always returns or throws */
  throw stripCookieHint(lastErr);
}

/** Drop yt-dlp's cookie how-to from a surfaced error (we never pass cookies). */
function stripCookieHint(err) {
  const msg = String((err && err.message) || "");
  const cleaned = msg.replace(COOKIE_HINT_RE, "").trim();
  if (!cleaned || cleaned === msg) return err;
  const wrapped = new Error(cleaned);
  wrapped.cause = err;
  return wrapped;
}

module.exports = {
  ytdlp,
  toArgs,
  binPath,
  assetFor,
  installYtDlp,
  resolveDenoPath,
  buildAttempts,
  YOUTUBE_LADDER,
  YOUTUBE_LADDER_RETRY,
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
