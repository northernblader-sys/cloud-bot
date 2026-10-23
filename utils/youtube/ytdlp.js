// yt-dlp source — the approach proven by desktop downloaders.
//
// This is the most battle-tested way to get audio off YouTube: yt-dlp tracks
// YouTube's anti-bot changes within days (PO tokens, nsig/sig challenges, new
// player clients), which is exactly the class of problem that broke the
// lighter-weight paths. Two things make it work where naive requests fail:
//
//   * a JS runtime (`--js-runtimes node`, using the Node that already runs
//     this bot) so yt-dlp can solve YouTube's player JS challenges, and
//   * explicit player clients (`youtube:player_client=default,web_safari`).
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
      reject(new Error(`yt-dlp exited ${code}${reason ? `: ${reason}` : ""}`));
    });
  });
}

function looksLikeUnsupportedOption(stderr) {
  return /unrecognized arguments|no such option|unknown option|invalid choice/i.test(stderr || "");
}

/**
 * Download the audio for `videoId` into `filePath`.
 *
 * Tries a few flag combinations, newest first, because the flags that solve
 * YouTube's challenges differ between yt-dlp releases. The first that exits 0
 * AND produced audio wins.
 */
async function fetchAudioWithYtdlp(videoId, filePath, options = {}) {
  const { maxBytes = 300 * 1024 * 1024 } = options;
  const binary = await resolveYtdlp();

  await mkdir(TEMP_DIR, { recursive: true });
  const workId = randomUUID();
  const template = join(TEMP_DIR, `ytdlp-${workId}.%(ext)s`);
  const url = `https://www.youtube.com/watch?v=${videoId}`;

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

  // `--js-runtimes` accepts RUNTIME[:PATH]; pinning the bot's own Node binary
  // means yt-dlp can solve the player JS challenges even when node isn't on
  // PATH (containers often don't have it there). Older yt-dlp builds don't
  // know the flag at all, hence the progressively simpler fallbacks.
  const attempts = [
    [...base, "--js-runtimes", `node:${process.execPath}`, "--extractor-args", EXTRACTOR_ARGS],
    [...base, "--js-runtimes", "node", "--extractor-args", EXTRACTOR_ARGS],
    [...base, "--js-runtimes", "node"],
    base,
  ];

  const failures = [];
  let produced = null;

  try {
    for (const args of attempts) {
      try {
        await runYtdlp(binary, args);
        produced = await findOutput(workId);
        if (produced) break;
        failures.push("yt-dlp finished but wrote no audio file");
      } catch (err) {
        failures.push(err.message);
        // Only retry with fewer flags when the failure looks like a flag issue;
        // otherwise the next attempt would fail identically.
        const last = failures[failures.length - 1];
        if (!looksLikeUnsupportedOption(last)) break;
      }
    }

    if (!produced) {
      throw new Error(failures[failures.length - 1] || "yt-dlp produced no output");
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
      source: "yt-dlp",
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
  resolveYtdlp,
  hasYtdlp,
  BIN_DIR,
  EXTRACTOR_ARGS,
  _reset: () => {
    cachedBinary = null;
    resolvePromise = null;
  },
};
