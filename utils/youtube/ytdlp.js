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
const session = require("./session");
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

// ── client ladder ──────────────────────────────────────────────────
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
//
// What we add on top: YouTube blocks *clients*, not just IPs, so after a
// "Sign in to confirm you're not a bot" the useful move is to change client,
// not to repeat the same request. Each entry below is one client group yt-dlp
// knows; the ladder walks them until one is let through.
const ARROXY_FALLBACK_CLIENTS = "youtube:player_client=default,-web,-web_safari";

// Without cookies these are the clients that historically answer first from
// datacenter IPs. tv/tv_simply are plain URLs, android_vr/ios need no PO token
// for most videos, and mweb is the least-hammered web surface.
const CLIENT_LADDER = [
  "youtube:player_client=tv_simply,tv",
  "youtube:player_client=android_vr",
  "youtube:player_client=ios",
  "youtube:player_client=mweb,web_safari",
  ARROXY_FALLBACK_CLIENTS,
];

// With cookies the session is the thing YouTube wants, and the web clients are
// the ones that actually use it — so lead with those.
const COOKIE_CLIENT_LADDER = [
  null, // yt-dlp's own defaults, which already include tv + web_safari
  "youtube:player_client=web_safari,web,mweb",
  "youtube:player_client=tv_simply,tv",
];

function clientLadder(hasCookies) {
  return hasCookies ? COOKIE_CLIENT_LADDER : CLIENT_LADDER;
}

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

/** The --extractor-args value of an attempt, or "default" when it has none. */
function extractorArgsOf(args) {
  const index = args.indexOf("--extractor-args");
  return index >= 0 && args[index + 1] ? args[index + 1] : "default";
}

function shortLabel(extractorArgs) {
  if (!extractorArgs || extractorArgs === "default") return "yt-dlp defaults";
  return String(extractorArgs).replace(/^youtube:player_client=/, "").replace(/;.*$/, "");
}

// YouTube's block is per-IP, so once a client group has been refused in the
// last few minutes there is no point asking it again — the second strategy in
// one `.play` would otherwise repeat every attempt the first one just made.
const BLOCK_MEMO_MS = 10 * 60 * 1000;
const blockedAttempts = new Map(); // `${cookies}|${extractorArgs}` -> timestamp

function memoKey(extractorArgs, cookieState) {
  return `${cookieState}|${extractorArgs}`;
}

function knownBlock(extractorArgs, cookieState) {
  const entry = blockedAttempts.get(memoKey(extractorArgs, cookieState));
  if (!entry) return null;
  if (Date.now() - entry.at > BLOCK_MEMO_MS) {
    blockedAttempts.delete(memoKey(extractorArgs, cookieState));
    return null;
  }
  return entry;
}

function rememberBlocked(extractorArgs, cookieState, message) {
  // Keep the original stderr: later attempts are skipped, and the user still
  // deserves the real reason rather than "skipped".
  blockedAttempts.set(memoKey(extractorArgs, cookieState), { at: Date.now(), message });
}

const SHARED_ARGS = (url, template) => [
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

function cookieArgs(cookiePath) {
  return cookiePath ? ["--cookies", cookiePath] : [];
}

/**
 * Build the ordered attempt list for the Arroxy strategy.
 * Exported for tests; each entry is {label, args}.
 */
function arroxyLadder({ url, template, poToken, visitorData, cookiePath }) {
  const base = [...SHARED_ARGS(url, template), ...cookieArgs(cookiePath)];
  const js = jsRuntimeArgs();
  const attempts = [];

  // 0. A PO token only helps when paired with the visitor data it is bound to.
  //    It is pointless alongside cookies, and yt-dlp refuses that combination.
  const withToken = cookiePath ? null : poTokenArgs(poToken, visitorData);
  if (withToken) {
    attempts.push({ label: "po-token", args: [...base, ...js, "--extractor-args", withToken] });
  }

  // 1. Walk the client ladder.
  for (const extractorArgs of clientLadder(Boolean(cookiePath))) {
    attempts.push({
      label: shortLabel(extractorArgs),
      args: extractorArgs ? [...base, ...js, "--extractor-args", extractorArgs] : [...base, ...js],
    });
  }

  // 2. If even that fails, try without the node runtime hint: an old build may
  //    reject --js-runtimes outright.
  if (!cookiePath) {
    attempts.push({ label: "no-extractor-args", args: [...base] });
  }

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
 * strategy "basic"  — the desktop-app recipe first (Refloow), then the client
 *                      ladder, so a bot-blocked client doesn't end the run.
 * strategy "arroxy" — Arroxy's ladder: PO token (if configured) → client
 *                      ladder → yt-dlp defaults, stopping early on rate
 *                      limits or unavailable videos.
 *
 * Cookies come from utils/youtube/session.js when configured and are passed as
 * `--cookies`, which is what actually gets past "Sign in to confirm you're not
 * a bot" on a datacenter IP.
 */
async function fetchAudioWithYtdlp(videoId, filePath, options = {}) {
  const { maxBytes = 300 * 1024 * 1024, strategy = "basic" } = options;
  const binary = await resolveYtdlp();

  await mkdir(TEMP_DIR, { recursive: true });
  const workId = randomUUID();
  const template = join(TEMP_DIR, `ytdlp-${workId}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Writing the cookie file is cheap and idempotent; null when none are set.
  // Include the active cookie header in cookieState so replacing cookies via
  // `.play cookie` immediately invalidates any memoised bot-block from older cookies.
  const cookiePath = session.cookieFile();
  const cookieState = cookiePath
    ? `${session.source() || "file"}:${session.header() || ""}`
    : "none";

  let attempts;
  if (strategy === "arroxy") {
    // A GVS token is only usable together with the visitor data it is bound
    // to, so scrape that first when a token is configured.
    const poToken = process.env.YT_PO_TOKEN;
    const visitorData = poToken ? await getVisitorData() : null;
    attempts = arroxyLadder({ url, template, poToken, visitorData, cookiePath }).map((entry) => ({
      ...entry,
      // Arroxy ends the ladder at a rate limit: another request now only meets
      // the same limit. An unavailable video won't change either.
      stopKinds: ["rateLimit", "unavailable", "missingDependency"],
    }));
  } else {
    // `--js-runtimes` accepts RUNTIME[:PATH]; pinning the bot's own Node binary
    // means yt-dlp can solve the player JS challenges even when node isn't on
    // PATH. Older yt-dlp builds don't know the flag at all, hence the final
    // attempt without it.
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
      ...cookieArgs(cookiePath),
    ];

    const js = ["--js-runtimes", `node:${process.execPath}`];

    // Refloow's recipe first (EXTRACTOR_ARGS), then the first ladder client. A
    // "Sign in to confirm you're not a bot" is the normal failure here, so the
    // run has to be able to change client rather than give up, while leaving
    // the full ladder walk to the "arroxy" pass.
    const ladder = clientLadder(Boolean(cookiePath));
    const variants = [EXTRACTOR_ARGS, ladder[0]];

    attempts = variants.map((extractorArgs, index) => ({
      label: `basic-${index + 1} (${shortLabel(extractorArgs)})`,
      args: extractorArgs
        ? [...base, ...js, "--extractor-args", extractorArgs]
        : [...base, ...js],
      stopKinds: ["rateLimit", "unavailable", "missingDependency"],
    }));

    // Last resort for older binaries: no JS runtime flags at all.
    attempts.push({ label: "basic-plain", args: [...base], stopKinds: ["rateLimit"] });
  }

  const failures = [];
  let produced = null;
  let botBlockCount = 0;

  try {
    for (const attempt of attempts) {
      const extractorArgs = extractorArgsOf(attempt.args);

      // Skip a client group already refused minutes ago from this IP.
      const blocked = knownBlock(extractorArgs, cookieState);
      if (blocked) {
        failures.push({
          label: attempt.label,
          message: blocked.message || "blocked a moment ago",
          kind: "botBlock",
          skipped: true,
        });
        continue;
      }

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

        if (classification.kind === "botBlock") {
          botBlockCount += 1;
          rememberBlocked(extractorArgs, cookieState, err.message);
          // Once two distinct client groups are bot-blocked on this IP,
          // YouTube is refusing the IP/session across clients — memoise the
          // rest of this pass and move on to non-YouTube fallbacks.
          if (botBlockCount >= 2) {
            for (const rest of attempts) {
              rememberBlocked(extractorArgsOf(rest.args), cookieState, err.message);
            }
            break;
          }
        }

        if (attempt.stopKinds?.includes(classification.kind)) break;
        // A non-retryable kind (a removed video, a 429) fails identically on
        // every client, so stop instead of burning minutes.
        if (!classification.retryable) break;
      }
    }

    if (!produced) {
      // Prefer a real failure over "skipped because it was blocked a moment
      // ago" — that message means nothing on its own.
      const lastFailure =
        [...failures].reverse().find((entry) => !entry.skipped) || failures[failures.length - 1];
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
  const infoFiles = files.filter((file) => /\.info\.json$/i.test(file));
  for (const infoFile of infoFiles) {
    try {
      const info = JSON.parse(await readFile(infoFile, "utf8"));
      if (info && info._type !== "playlist" && (info.title || info.duration)) {
        return {
          title: info.title || "",
          author: info.uploader || info.channel || info.artist || "",
          durationSec: Math.round(Number(info.duration) || 0),
        };
      }
    } catch {
      // try next
    }
  }
  return {};
}

/**
 * Build clean search queries for non-YouTube audio sources (e.g. SoundCloud)
 * from a YouTube search result `{ title, author, query }`.
 */
function cleanSearchQuery(meta = {}) {
  const queries = [];
  const rawTitle = String(meta.title || "").trim();
  const rawAuthor = String(meta.author || "").trim();
  const rawQuery = String(meta.query || "").trim();

  const isBareId = (s) => /^[-_0-9A-Za-z]{11}$/.test(s);
  const isUrl = (s) => /^https?:\/\/|(?:youtube\.com|youtu\.be)\//i.test(s);

  const cleanTitle = rawTitle
    .replace(
      /\s*[\(\[](?:official\s*(?:music\s*)?(?:video|audio|lyric\s*video|visualizer|hd|4k)|lyrics?|lyric\s*video|audio|video\s*oficial|visualizer|hd|4k|hq|full\s*audio|m\/v|mv|explicit|clean)[\)\]]/gi,
      ""
    )
    .replace(/\s*\|\s*.*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  const cleanAuthor = rawAuthor
    .replace(/\s*-\s*Topic$/i, "")
    .replace(/VEVO$/i, "")
    .replace(/\s*Official$/i, "")
    .trim();

  if (cleanTitle && !isBareId(cleanTitle) && !isUrl(cleanTitle)) {
    if (
      cleanAuthor &&
      !cleanTitle.toLowerCase().includes(cleanAuthor.toLowerCase())
    ) {
      queries.push(`${cleanAuthor} - ${cleanTitle}`);
    }
    queries.push(cleanTitle);
  }

  if (rawQuery && !isBareId(rawQuery) && !isUrl(rawQuery)) {
    if (!queries.some((q) => q.toLowerCase() === rawQuery.toLowerCase())) {
      queries.push(rawQuery);
    }
  }

  return queries;
}

/**
 * Download audio for a track by searching SoundCloud via yt-dlp (`scsearch5:`).
 *
 * SoundCloud does not block datacenter IPs with BotGuard or require cookies,
 * so when YouTube refuses every client on a cloud host, this still delivers
 * the song in a few seconds.
 */
async function fetchAudioWithYtdlpSearch(meta, filePath, options = {}) {
  const { maxBytes = 300 * 1024 * 1024 } = options;
  const queries =
    typeof meta === "string" ? cleanSearchQuery({ query: meta }) : cleanSearchQuery(meta);
  if (!queries.length) {
    throw new Error("no search query available for SoundCloud fallback");
  }

  const binary = await resolveYtdlp();
  await mkdir(TEMP_DIR, { recursive: true });
  const workId = randomUUID();
  const template = join(TEMP_DIR, `ytdlp-sc-${workId}.%(ext)s`);

  const targetDuration = Number(meta?.durationSec) || 0;
  // Skip 30-second SoundCloud Go+ preview snippets unless the track itself is short.
  const minDuration = targetDuration > 0 && targetDuration <= 45 ? 5 : 40;
  const maxDuration = targetDuration > 0 ? Math.max(900, targetDuration * 2) : 900;

  const attempts = [];
  for (const q of queries.slice(0, 2)) {
    attempts.push({
      label: `scsearch5:${q}`,
      args: [
        `scsearch5:${q}`,
        "-f",
        "bestaudio/best",
        "-o",
        template,
        "--ignore-config",
        "--no-warnings",
        "--no-progress",
        "--no-part",
        "--write-info-json",
        "--match-filter",
        `duration >= ${minDuration} & duration <= ${maxDuration}`,
        "--max-downloads",
        "1",
        "--socket-timeout",
        "20",
        "--retries",
        "3",
      ],
    });
  }

  // Fallback without duration filter in case the track is <40s or metadata omits duration.
  attempts.push({
    label: `scsearch1:${queries[0]}`,
    args: [
      `scsearch1:${queries[0]}`,
      "-f",
      "bestaudio/best",
      "-o",
      template,
      "--ignore-config",
      "--no-warnings",
      "--no-progress",
      "--no-part",
      "--write-info-json",
      "--socket-timeout",
      "20",
      "--retries",
      "3",
    ],
  });

  let produced = null;
  let lastError = null;

  try {
    for (const attempt of attempts) {
      for (const leftover of await listWorkFiles(workId)) {
        await rm(leftover, { force: true }).catch(() => {});
      }

      try {
        await runYtdlp(binary, attempt.args);
      } catch (err) {
        // Exit code 101 is yt-dlp's normal status when --max-downloads 1 is reached
        // right after downloading the first matching track.
        if (err.exitCode !== 101) {
          lastError = err;
        }
      }

      produced = await findOutput(workId);
      if (produced) {
        const size = await stat(produced).then((s) => s.size).catch(() => 0);
        const head = size ? (await readFile(produced)).subarray(0, 64) : Buffer.alloc(0);
        if (size && isLikelyAudio(head)) break;
        produced = null;
      }
    }

    if (!produced) {
      throw lastError || new Error("SoundCloud search produced no matching audio");
    }

    const size = await stat(produced).then((s) => s.size);
    if (size > maxBytes) {
      const error = new Error(
        `audio is ${(size / 1048576).toFixed(1)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`
      );
      error.code = "TOO_LARGE";
      throw error;
    }

    await rm(filePath, { force: true }).catch(() => {});
    await rename(produced, filePath);

    const scMeta = await readInfoJson(workId);
    return {
      source: "yt-dlp (soundcloud)",
      mimeType: mimeForExtension(produced),
      bytes: size,
      title: meta?.title || scMeta.title || "",
      author: meta?.author || scMeta.author || "",
      durationSec: scMeta.durationSec || targetDuration || 0,
    };
  } finally {
    for (const leftover of await listWorkFiles(workId)) {
      await rm(leftover, { force: true }).catch(() => {});
    }
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
  fetchAudioWithYtdlpSearch,
  cleanSearchQuery,
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
    blockedAttempts.clear();
  },
};
