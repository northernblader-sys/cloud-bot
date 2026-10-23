// yt-dlp source — the approach proven by desktop downloaders.
//
// This is the most battle-tested way to get audio off YouTube: yt-dlp tracks
// YouTube's anti-bot changes within days (PO tokens, nsig/sig challenges, new
// player clients), which is exactly the class of problem that broke the
// lighter-weight paths.
//
// Two strategies are implemented, both by the same binary:
//
//   "basic"   — the Refloow desktop app's recipe: `-f bestaudio`,
//               `--js-runtimes node:<ours>` and
//               `youtube:player_client=default,web_safari;player_js_version=actual`.
//   "arroxy"  — Arroxy's retry ladder (see arroxyLadder() below), which is
//               smarter about PO tokens and about which clients demand one.
//
// The binary is resolved in this order:
//   1. YTDLP_PATH env var
//   2. a previously downloaded copy in <DATA_DIR>/media/bin/
//   3. `yt-dlp` on PATH
//   4. downloaded once from the official GitHub releases (set
//      YTDLP_AUTODOWNLOAD=0 to disable that last step)
//
// Everything is spawned as a child process; audio lands in a temp file and is
// magic-number checked before anyone can send it.

const { spawn } = require("child_process");
const { createWriteStream, existsSync } = require("fs");
const { chmod, mkdir, readdir, readFile, rename, rm, stat } = require("fs/promises");
const { join } = require("path");
const { randomUUID } = require("crypto");
const { tmpdir } = require("os");

const { isLikelyAudio } = require("./audioApis");
const { BASE_DIR } = require("../dataDir");

const BIN_DIR = join(BASE_DIR, "media", "bin");
const TEMP_DIR = join(tmpdir(), "astral-cloud-music");
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const RELEASE_BASE = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

// Same client hints the working desktop app passes.
const EXTRACTOR_ARGS = "youtube:player_client=default,web_safari;player_js_version=actual";

let cachedBinary = null;
let resolvePromise = null;

function envFlag(name, fallback = true) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(value.trim());
}

function binaryName() {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function releaseAsset() {
  if (process.platform === "win32") return "yt-dlp.exe";
  if (process.platform === "darwin") return "yt-dlp_macos";
  if (process.arch === "arm64") return "yt-dlp_linux_aarch64";
  return "yt-dlp_linux";
}

function whichSync(command) {
  const { spawnSync } = require("child_process");
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
    stdio: "ignore",
  });
  return !probe.error && probe.status === 0 ? command : null;
}

async function downloadBinary(target) {
  await mkdir(BIN_DIR, { recursive: true });
  const url = `${RELEASE_BASE}/${releaseAsset()}`;
  console.log(`[play] downloading yt-dlp (${url})`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  const partial = `${target}.part`;

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`yt-dlp download failed with HTTP ${response.status}`);
    }

    await new Promise(async (resolve, reject) => {
      const sink = createWriteStream(partial);
      sink.on("error", reject);
      sink.on("finish", resolve);
      try {
        for await (const chunk of response.body) sink.write(chunk);
        sink.end();
      } catch (err) {
        sink.destroy();
        reject(err);
      }
    });

    const size = await stat(partial).then((s) => s.size);
    if (size < 1024 * 1024) throw new Error("downloaded yt-dlp looks truncated");

    await chmod(partial, 0o755).catch(() => {});
    await rename(partial, target);
    console.log(`[play] yt-dlp ready at ${target} (${(size / 1048576).toFixed(1)} MB)`);
    return target;
  } finally {
    clearTimeout(timer);
    await rm(partial, { force: true }).catch(() => {});
  }
}

/** Resolve (and if allowed, fetch) a usable yt-dlp binary. Memoised. */
function resolveYtdlp() {
  if (resolvePromise) return resolvePromise;

  resolvePromise = (async () => {
    if (cachedBinary) return cachedBinary;

    const explicit = process.env.YTDLP_PATH;
    if (explicit && existsSync(explicit)) {
      cachedBinary = explicit;
      return cachedBinary;
    }

    const bundled = join(BIN_DIR, binaryName());
    if (existsSync(bundled)) {
      cachedBinary = bundled;
      return cachedBinary;
    }

    const onPath = whichSync("yt-dlp");
    if (onPath) {
      cachedBinary = onPath;
      return cachedBinary;
    }

    if (!envFlag("YTDLP_AUTODOWNLOAD", true)) {
      throw new Error("yt-dlp is not installed (YTDLP_AUTODOWNLOAD=0)");
    }

    try {
      cachedBinary = await downloadBinary(bundled);
      return cachedBinary;
    } catch (err) {
      resolvePromise = null; // allow a retry later
      throw new Error(`could not install yt-dlp: ${err.message}`);
    }
  })();

  return resolvePromise;
}

function runYtdlp(binary, args, timeoutMs = RUN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 20000) stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      // keep the tail — that's where the useful error is
      stderr = (stderr + chunk.toString()).slice(-4000);
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`could not run yt-dlp: ${err.message}`));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr });
      const reason = stderr
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("[debug]"))
        .slice(-3)
        .join(" | ");
      const error = new Error(`yt-dlp exited ${code}${reason ? `: ${reason}` : ""}`);
      error.exitCode = code;
      error.stderr = stderr;
      error.stdout = stdout;
      reject(error);
    });
  });
}

// ── error classification (mirrors Arroxy's ytdlp-errors kinds) ─────
// Knowing *why* yt-dlp failed lets the ladder decide whether another attempt
// can plausibly succeed, and lets the reply tell the user what to change.
const ERROR_PATTERNS = [
  {
    kind: "rateLimit",
    retryable: false,
    fix: "YouTube is rate-limiting this IP — wait a while before trying again.",
    test: /HTTP Error 429|Too Many Requests|unusual traffic|google\.com\/sorry|rate.?limit/i,
  },
  {
    kind: "botBlock",
    retryable: true,
    fix: "Set YT_COOKIE (or YT_PO_TOKEN + YT_VISITOR_DATA), or use a working PIPED_INSTANCES entry.",
    test: /Sign in to confirm|not a bot|confirm you.{0,3}re not a bot|Use --cookies/i,
  },
  {
    kind: "loginRequired",
    retryable: true,
    fix: "This video needs an account — set YT_COOKIE to a signed-in cookie header.",
    test: /login required|Private video|members-only|Join this channel|Sign in if you/i,
  },
  {
    kind: "ageRestricted",
    retryable: true,
    fix: "Age-restricted video — set YT_COOKIE to a signed-in cookie header.",
    test: /age.?restricted|inappropriate for some users|confirm your age/i,
  },
  {
    kind: "unavailable",
    retryable: false,
    fix: "The video itself is unavailable (removed, private or region-locked).",
    test: /Video unavailable|This video is not available|has been removed|does not exist|not made this video available/i,
  },
  {
    kind: "jsRuntime",
    retryable: true,
    fix: "yt-dlp needs a JS runtime — this build passes the bot's own node binary.",
    test: /js.?runtime|nsig|n ?sig|signature extraction|Some formats may be missing|no suitable javascript/i,
  },
  {
    kind: "missingDependency",
    retryable: false,
    fix: "Install the missing binary (ffmpeg/ffprobe) or set its path.",
    test: /ffmpeg not found|ffprobe|atomicparsley which is not installed|Impersonate target|curl_cffi/i,
  },
  {
    kind: "network",
    retryable: true,
    fix: "Network hiccup or blocked host — retry shortly.",
    test: /timed out|Connection refused|Temporary failure|getaddrinfo|SSL|urlopen error/i,
  },
];

/** Classify a yt-dlp stderr blob into {kind, retryable, fix}. */
function classifyYtdlpError(text) {
  const value = String(text || "");
  for (const entry of ERROR_PATTERNS) {
    if (entry.test.test(value)) {
      return { kind: entry.kind, retryable: entry.retryable, fix: entry.fix };
    }
  }
  return { kind: "other", retryable: true, fix: null };
}

// ── Arroxy's ladder ────────────────────────────────────────────────
// Arroxy (github.com/antonio-orionus/Arroxy) runs a 3-attempt ladder:
//
//   0. PO token + visitor data, player_client=default   (token-bound clients)
//   1. re-mint the token, retry                          (needs their provider)
//   2. player_client=default,-web,-web_safari            (VidBee's trick:
//      drop the clients that *demand* a PO token, so the non-PoT path works)
//
// and finally a run with no --extractor-args at all. We can't mint tokens
// without BotGuard (Arroxy drives a hidden Electron window), but we honour
// YT_PO_TOKEN + YT_VISITOR_DATA if given — and yt-dlp drops a GVS token that
// arrives without visitor data, which is why we scrape it.
const ARROXY_FALLBACK_CLIENTS = "youtube:player_client=default,-web,-web_safari";

function looksLikeUnsupportedOption(stderr) {
  return /unrecognized arguments|no such option|unknown option|invalid choice/i.test(stderr || "");
}

function jsRuntimeArgs() {
  // `--no-js-runtimes` clears yt-dlp's implicit deno default, then we hand it
  // the node that is already running this bot, so no runtime install is needed.
  return ["--no-js-runtimes", "--js-runtimes", `node:${process.execPath}`];
}

function poTokenArgs(poToken, visitorData) {
  // yt-dlp keeps only the LAST --extractor-args block per extractor, so the
  // token, visitor data and client list must live in one block (Arroxy does
  // the same merge for exactly this reason).
  if (!poToken || !visitorData) return null;
  return `youtube:player_client=default;po_token=web.gvs+${poToken};visitor_data=${visitorData}`;
}

/**
 * Build the ordered attempt list for the Arroxy strategy.
 * Exported for tests; each entry is {label, args}.
 */
function arroxyLadder({ url, template, poToken, visitorData }) {
  const base = [
    url,
    "-f",
    "bestaudio/best",
    "-o",
    template,
    "--ignore-config",
    "--no-playlist",
    "--no-part",
    "--continue",
    "--newline",
    "--no-warnings",
    "--write-info-json",
    // Arroxy's download hardening: chunked HTTP, bounded retries, no silent
    // half-files, and a socket timeout so a stalled read can't hang the job.
    "--http-chunk-size",
    "10M",
    "--retries",
    "5",
    "--fragment-retries",
    "5",
    "--retry-sleep",
    "1:3",
    "--socket-timeout",
    "20",
    "--abort-on-unavailable-fragments",
  ];

  const js = jsRuntimeArgs();
  const attempts = [];

  // 0. A PO token only helps when paired with the visitor data it is bound to.
  const withToken = poTokenArgs(poToken, visitorData);
  if (withToken) {
    attempts.push({ label: "po-token", args: [...base, ...js, "--extractor-args", withToken] });
  }

  // 1. VidBee's trick: drop the clients that demand a PO token.
  attempts.push({
    label: "no-pot-clients",
    args: [...base, ...js, "--extractor-args", ARROXY_FALLBACK_CLIENTS],
  });

  // 2. Let yt-dlp pick its own clients.
  attempts.push({ label: "no-extractor-args", args: [...base, ...js] });

  return attempts;
}

// A GVS token is bound to visitor data, and yt-dlp drops a token that arrives
// without it ("Missing required Visitor Data"). Scrape it once and cache —
// this is the cheap part of what Arroxy's Electron token provider does.
let visitorDataCache = { value: null, at: 0 };
const VISITOR_DATA_TTL_MS = 5 * 60 * 60 * 1000;

async function getVisitorData() {
  if (process.env.YT_VISITOR_DATA) return process.env.YT_VISITOR_DATA;
  if (visitorDataCache.value && Date.now() - visitorDataCache.at < VISITOR_DATA_TTL_MS) {
    return visitorDataCache.value;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch("https://www.youtube.com/watch?v=dQw4w9WgXcQ", {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });
    const html = await response.text();
    const value =
      html.match(/"visitorData"\s*:\s*"([^"]+)"/)?.[1] ||
      html.match(/VISITOR_DATA"\s*:\s*"([^"]+)"/)?.[1] ||
      null;
    if (value) visitorDataCache = { value, at: Date.now() };
    return value;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Download the audio for `videoId` into `filePath`.
 *
 * strategy "basic"  — the desktop-app recipe (single attempt plus flag
 *                      downgrades for older yt-dlp builds).
 * strategy "arroxy" — Arroxy's ladder: PO token (if configured) →
 *                      non-PoT clients → yt-dlp defaults, stopping early on
 *                      rate limits or unavailable videos.
 */
async function fetchAudioWithYtdlp(videoId, filePath, options = {}) {
  const { maxBytes = 300 * 1024 * 1024, strategy = "basic" } = options;
  const binary = await resolveYtdlp();

  await mkdir(TEMP_DIR, { recursive: true });
  const workId = randomUUID();
  const template = join(TEMP_DIR, `ytdlp-${workId}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  let attempts;
  if (strategy === "arroxy") {
    // A GVS token is only usable together with the visitor data it is bound
    // to, so scrape that first when a token is configured.
    const poToken = process.env.YT_PO_TOKEN;
    const visitorData = poToken ? await getVisitorData() : null;
    attempts = arroxyLadder({ url, template, poToken, visitorData }).map((entry) => ({
      ...entry,
      // Arroxy ends the ladder at a rate limit: another request now only meets
      // the same limit. An unavailable video won't change either.
      stopKinds: ["rateLimit", "unavailable", "missingDependency"],
    }));
  } else {
    // `--js-runtimes` accepts RUNTIME[:PATH]; pinning the bot's own Node binary
    // means yt-dlp can solve the player JS challenges even when node isn't on
    // PATH. Older yt-dlp builds don't know the flag at all, hence the
    // progressively simpler fallbacks.
    const base = [
      url,
      "-f",
      "bestaudio/best",
      "-o",
      template,
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--no-part",
      "--write-info-json",
      "--socket-timeout",
      "20",
      "--retries",
      "3",
    ];

    attempts = [
      [...base, "--js-runtimes", `node:${process.execPath}`, "--extractor-args", EXTRACTOR_ARGS],
      [...base, "--js-runtimes", "node", "--extractor-args", EXTRACTOR_ARGS],
      [...base, "--js-runtimes", "node"],
      base,
    ].map((args, index) => ({
      label: `basic-${index + 1}`,
      args,
      stopKinds: ["rateLimit"],
      // Only retry with fewer flags when the failure looks like a flag issue;
      // otherwise the next attempt would fail identically.
      flagSensitive: true,
    }));
  }

  const failures = [];
  let produced = null;

  try {
    for (const attempt of attempts) {
      try {
        await runYtdlp(binary, attempt.args);
        produced = await findOutput(workId);
        if (produced) break;
        failures.push({
          label: attempt.label,
          message: "yt-dlp finished but wrote no audio file",
          kind: "other",
        });
      } catch (err) {
        const classification = classifyYtdlpError(err.stderr || err.message);
        failures.push({
          label: attempt.label,
          message: err.message,
          kind: classification.kind,
          fix: classification.fix,
        });

        if (attempt.stopKinds?.includes(classification.kind)) break;
        if (attempt.flagSensitive && !looksLikeUnsupportedOption(err.stderr || err.message)) break;
      }
    }

    if (!produced) {
      const lastFailure = failures[failures.length - 1];
      const error = new Error(lastFailure ? lastFailure.message : "yt-dlp produced no output");
      error.kind = lastFailure?.kind || "other";
      error.fix = lastFailure?.fix || null;
      error.attempts = failures;
      throw error;
    }

    const size = await stat(produced).then((s) => s.size);
    if (!size) throw new Error("yt-dlp wrote an empty file");
    if (size > maxBytes) {
      const error = new Error(
        `audio is ${(size / 1048576).toFixed(1)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`
      );
      error.code = "TOO_LARGE";
      throw error;
    }

    const head = (await readFile(produced)).subarray(0, 64);
    if (!isLikelyAudio(head)) throw new Error("yt-dlp output was not audio");

    await rm(filePath, { force: true }).catch(() => {});
    await rename(produced, filePath);

    const meta = await readInfoJson(workId);
    return {
      source: strategy === "arroxy" ? "yt-dlp (arroxy ladder)" : "yt-dlp",
      mimeType: mimeForExtension(produced),
      bytes: size,
      title: meta.title || "",
      author: meta.author || "",
      durationSec: meta.durationSec || 0,
    };
  } finally {
    for (const leftover of await listWorkFiles(workId)) {
      await rm(leftover, { force: true }).catch(() => {});
    }
  }
}

function mimeForExtension(filePath) {
  if (/\.mp3$/i.test(filePath)) return "audio/mpeg";
  if (/\.m4a$|\.mp4$/i.test(filePath)) return "audio/mp4";
  if (/\.webm$|\.opus$/i.test(filePath)) return "audio/webm";
  if (/\.ogg$/i.test(filePath)) return "audio/ogg";
  return "audio/mpeg";
}

async function listWorkFiles(workId) {
  try {
    const entries = await readdir(TEMP_DIR);
    return entries
      .filter((name) => name.includes(workId))
      .map((name) => join(TEMP_DIR, name));
  } catch {
    return [];
  }
}

async function findOutput(workId) {
  const files = await listWorkFiles(workId);
  // Skip sidecars: .info.json, .part, .ytdl, thumbnails.
  const audio = files.filter((file) => !/\.(info\.json|json|part|ytdl|jpg|jpeg|png|webp|vtt|srt)$/i.test(file));
  return audio.sort()[0] || files.find((file) => isLikelyAudioPath(file)) || null;
}

function isLikelyAudioPath(file) {
  return /\.(m4a|mp3|webm|opus|ogg|aac|flac|wav|mp4)$/i.test(file);
}

async function readInfoJson(workId) {
  const files = await listWorkFiles(workId);
  const infoFile = files.find((file) => /\.info\.json$/i.test(file));
  if (!infoFile) return {};
  try {
    const info = JSON.parse(await readFile(infoFile, "utf8"));
    return {
      title: info.title || "",
      author: info.uploader || info.channel || "",
      durationSec: Math.round(Number(info.duration) || 0),
    };
  } catch {
    return {};
  }
}

/** Is a yt-dlp binary available without downloading anything? */
function hasYtdlp() {
  if (cachedBinary) return true;
  if (process.env.YTDLP_PATH && existsSync(process.env.YTDLP_PATH)) return true;
  if (existsSync(join(BIN_DIR, binaryName()))) return true;
  return Boolean(whichSync("yt-dlp"));
}

module.exports = {
  fetchAudioWithYtdlp,
  arroxyLadder,
  classifyYtdlpError,
  getVisitorData,
  ARROXY_FALLBACK_CLIENTS,
  resolveYtdlp,
  hasYtdlp,
  BIN_DIR,
  EXTRACTOR_ARGS,
  _reset: () => {
    cachedBinary = null;
    resolvePromise = null;
  },
};
