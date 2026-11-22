// Offline tests for utils/ytdlp.js — the yt-dlp installer/runner that
// replaced youtube-dl-exec (which needed a system Python 3.11+ and broke
// the Render build). A local HTTP server stands in for GitHub releases,
// so nothing here touches the network.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { mkdtemp, chmod, stat, rm } = require("node:fs/promises");

const {
  ytdlp,
  toArgs,
  assetFor,
  binPath,
  installYtDlp,
  buildAttempts,
  resolveDenoPath,
  YOUTUBE_LADDER,
  YOUTUBE_LADDER_RETRY,
} = require(path.join(__dirname, "..", "utils", "ytdlp.js"));

/** Restore an env var a test borrowed (undefined = delete). */
function restoreEnv(key, prev) {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

/**
 * Fake yt-dlp driven by FAKE_YTDLP_MODE, logging every spawn's argv to
 * FAKE_YTDLP_LOG (one JSON array per line) so tests can count attempts
 * and inspect each rung's flags.
 *   bot-once  — rung 1 dies with YouTube's wall, later rungs succeed
 *   bot-always— every rung dies with the wall
 *   http-always— every rung dies with a non-bot-check failure
 */
function fakeYtDlpScript() {
  return (
    "#!/usr/bin/env node\n" +
    "const fs = require('fs');\n" +
    "const args = process.argv.slice(2);\n" +
    "fs.appendFileSync(process.env.FAKE_YTDLP_LOG, JSON.stringify(args) + '\\n');\n" +
    "const n = fs.readFileSync(process.env.FAKE_YTDLP_LOG, 'utf8').trim().split('\\n').length;\n" +
    "const mode = process.env.FAKE_YTDLP_MODE || '';\n" +
    "if (mode === 'http-always') { console.error('ERROR: unable to download video data: HTTP Error 402: Payment Required'); process.exit(1); }\n" +
    "const wall = \"ERROR: [youtube] oytOOA9sOiE: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication. See https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies for how to manually pass cookies.\";\n" +
    "if (mode === 'bot-always' || (mode === 'bot-once' && n === 1)) { console.error(wall); process.exit(1); }\n" +
    "console.log(JSON.stringify({ args }));\n"
  );
}

/** Spawn log written by fakeYtDlpScript: array of argv arrays, in order. */
function readSpawns(log) {
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

test("toArgs converts flags exactly like youtube-dl-exec did", () => {
  assert.deepEqual(
    toArgs({
      extractAudio: true,
      audioFormat: "opus",
      audioQuality: 5,
      noPlaylist: true,
      noWarnings: true,
      quiet: true,
      output: "/tmp/song.raw.opus",
      ffmpegLocation: "/opt/ffmpeg",
    }),
    [
      "--extract-audio",
      "--audio-format",
      "opus",
      "--audio-quality",
      "5",
      "--no-playlist",
      "--no-warnings",
      "--quiet",
      "--output",
      "/tmp/song.raw.opus",
      "--ffmpeg-location",
      "/opt/ffmpeg",
    ]
  );

  assert.deepEqual(
    toArgs({ format: "best[height<=480][ext=mp4]/best", mergeOutputFormat: "mp4" }),
    ["--format", "best[height<=480][ext=mp4]/best", "--merge-output-format", "mp4"]
  );
});

test("assetFor picks the standalone (no-Python) asset per platform", () => {
  assert.equal(assetFor("linux", "x64"), "yt-dlp_linux");
  assert.equal(assetFor("linux", "arm64"), "yt-dlp_linux_aarch64");
  assert.equal(assetFor("darwin", "x64"), "yt-dlp_macos");
  assert.equal(assetFor("darwin", "arm64"), "yt-dlp_macos");
  assert.equal(assetFor("win32", "x64"), "yt-dlp.exe");
  assert.equal(assetFor("win32", "arm64"), "yt-dlp_arm64.exe");
  assert.throws(() => assetFor("linux", "arm"), /unsupported linux arch/);
  assert.throws(() => assetFor("sunos", "x64"), /unsupported platform/);
});

test("binPath honors YT_DLP_PATH and otherwise targets bin/", () => {
  const before = process.env.YT_DLP_PATH;
  try {
    delete process.env.YT_DLP_PATH;
    const expected = path.join(
      path.dirname(binPath()),
      process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
    );
    assert.equal(binPath(), expected);

    process.env.YT_DLP_PATH = "/custom/yt-dlp";
    assert.equal(binPath(), "/custom/yt-dlp");
  } finally {
    if (before === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = before;
  }
});

function startServer() {
  const PAYLOAD = Buffer.alloc(2 * 1024 * 1024, 7); // 2 MB — passes the 1 MB floor
  const server = http.createServer((req, res) => {
    if (req.url === "/good") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      return res.end(PAYLOAD);
    }
    if (req.url === "/tiny") {
      // A "successful" response that is far too small to be yt-dlp.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html>rate limited</html>");
    }
    res.writeHead(404);
    res.end("nope");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

test("installYtDlp downloads the binary, makes it executable, and is idempotent", async () => {
  const { server, base } = await startServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  try {
    const first = await installYtDlp({ dir, url: `${base}/good` });
    assert.equal(first.skipped, false);
    assert.equal(first.bytes, 2 * 1024 * 1024);

    const dest = path.join(dir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    assert.ok(existsSync(dest), "binary exists at the expected path");
    assert.ok(!existsSync(`${dest}.part`), "no temp file left behind");
    const size = (await stat(dest)).size;
    assert.equal(size, 2 * 1024 * 1024);
    if (process.platform !== "win32") {
      const mode = (await stat(dest)).mode & 0o111;
      assert.ok(mode !== 0, "binary is executable");
    }

    // Second run must skip (no re-download) and still leave a valid file.
    const second = await installYtDlp({ dir, url: `${base}/good` });
    assert.equal(second.skipped, true);
    assert.equal((await stat(dest)).size, 2 * 1024 * 1024);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("installYtDlp rejects HTTP errors and too-small responses", async () => {
  const { server, base } = await startServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  try {
    await assert.rejects(
      () => installYtDlp({ dir, url: `${base}/missing` }),
      /HTTP 404/
    );
    await assert.rejects(
      () => installYtDlp({ dir, url: `${base}/tiny` }),
      /looks corrupt/
    );
    // Neither failure may leave a binary behind.
    assert.equal(existsSync(path.join(dir, "yt-dlp")), false);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("installYtDlp skips entirely when YT_DLP_PATH is set", async () => {
  const before = process.env.YT_DLP_PATH;
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  try {
    process.env.YT_DLP_PATH = "/custom/yt-dlp";
    const result = await installYtDlp({ dir, url: "http://127.0.0.1:1/never" });
    assert.equal(result.skipped, true);
    assert.equal(result.dest, "/custom/yt-dlp");
    assert.match(result.reason, /YT_DLP_PATH/);
  } finally {
    if (before === undefined) delete process.env.YT_DLP_PATH;
    else process.env.YT_DLP_PATH = before;
    await rm(dir, { recursive: true, force: true });
  }
});

test("ytdlp rejects with a helpful message when the binary is missing", async () => {
  await assert.rejects(
    () => ytdlp("https://example.com/v", {}, { bin: "/nonexistent/yt-dlp" }),
    /yt-dlp binary not found/
  );
});

test("ytdlp spawns the binary, passes args, and resolves stdout", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake binary uses a shebang");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  const fake = path.join(dir, "fake-yt-dlp");
  writeFileSync(
    fake,
    "#!/usr/bin/env node\n" +
      "const args = process.argv.slice(2);\n" +
      "if (args.includes('--fail')) { console.error('HTTP 402 refused'); process.exit(1); }\n" +
      "console.log(JSON.stringify({ args }));\n"
  );
  await chmod(fake, 0o755);
  try {
    // denoPath pinned: auto-resolve would inject --js-runtimes and make
    // this exact-arg assertion depend on whether node_modules/deno ran
    // its postinstall in this checkout.
    const out = await ytdlp(
      "https://youtu.be/abc",
      { audioFormat: "opus", quiet: true },
      { bin: fake, denoPath: null }
    );
    assert.deepEqual(out.args, [
      "--audio-format",
      "opus",
      "--quiet",
      "--extractor-args",
      YOUTUBE_LADDER,
      "--",
      "https://youtu.be/abc",
    ]);

    await assert.rejects(
      () => ytdlp("https://youtu.be/abc", { fail: true }, { bin: fake, denoPath: null }),
      /HTTP 402 refused/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("toArgs converts the bot-check flag keys yt-dlp understands", () => {
  assert.deepEqual(
    toArgs({
      extractorArgs: YOUTUBE_LADDER,
      jsRuntimes: "deno:/opt/deno",
      forceIpv4: true,
    }),
    [
      "--extractor-args",
      YOUTUBE_LADDER,
      "--js-runtimes",
      "deno:/opt/deno",
      "--force-ipv4",
    ]
  );
});

test("buildAttempts produces the three rungs with deno on every attempt", () => {
  const attempts = buildAttempts({ quiet: true, audioFormat: "opus" }, { denoPath: "/opt/deno" });
  assert.equal(attempts.length, 3);

  // Rung 1: plain client ladder.
  assert.equal(attempts[0].extractorArgs, YOUTUBE_LADDER);
  assert.equal(attempts[0].forceIpv4, undefined);
  // Rung 2: same ladder, no-webpage + force-ipv4.
  assert.equal(attempts[1].extractorArgs, `${YOUTUBE_LADDER};player_skip=webpage`);
  assert.equal(attempts[1].forceIpv4, true);
  // Rung 3: alternate client mix, no-webpage + force-ipv4.
  assert.equal(attempts[2].extractorArgs, `${YOUTUBE_LADDER_RETRY};player_skip=webpage`);
  assert.equal(attempts[2].forceIpv4, true);
  // ios must stay out of every rung (GVS PO-token required=True).
  for (const a of attempts) assert.ok(!/ios/.test(a.extractorArgs), "no ios client");

  // Caller flags ride along on every rung; deno is attached to every rung.
  for (const a of attempts) {
    assert.equal(a.quiet, true);
    assert.equal(a.audioFormat, "opus");
    assert.equal(a.jsRuntimes, "deno:/opt/deno");
  }

  // denoPath: null disables --js-runtimes entirely.
  for (const a of buildAttempts({}, { denoPath: null })) {
    assert.equal(a.jsRuntimes, undefined);
  }

  // Auto-detect (no denoPath in opts) matches resolveDenoPath().
  const auto = buildAttempts({})[0];
  const detected = resolveDenoPath();
  assert.equal(auto.jsRuntimes, detected ? `deno:${detected}` : undefined);
});

test("resolveDenoPath points at the npm-installed binary or null", () => {
  const p = resolveDenoPath();
  const expected = process.platform === "win32" ? "deno.exe" : "deno";
  const binary = path.join(__dirname, "..", "node_modules", "deno", expected);
  if (p === null) {
    // No binary — valid state (package absent, or installed with
    // --ignore-scripts so its postinstall never created the hardlink).
    assert.equal(existsSync(binary), false, "null means the binary is absent");
    return;
  }
  assert.equal(p, binary, "resolved path is the package's binary");
  assert.ok(existsSync(p), "resolved path exists");
});

test("ytdlp retries the bot-check wall once with force-ipv4 + no-webpage", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake binary uses a shebang");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  const fake = path.join(dir, "fake-yt-dlp");
  const log = path.join(dir, "spawns.log");
  writeFileSync(fake, fakeYtDlpScript());
  await chmod(fake, 0o755);
  const prevMode = process.env.FAKE_YTDLP_MODE;
  const prevLog = process.env.FAKE_YTDLP_LOG;
  try {
    process.env.FAKE_YTDLP_MODE = "bot-once";
    process.env.FAKE_YTDLP_LOG = log;
    const out = await ytdlp("https://youtu.be/abc", { quiet: true }, { bin: fake, denoPath: null });

    const spawns = readSpawns(log);
    assert.equal(spawns.length, 2, "wall on rung 1 → exactly one retry");
    // Rung 1: plain ladder, no force-ipv4.
    assert.deepEqual(spawns[0].slice(0, 4), ["--quiet", "--extractor-args", YOUTUBE_LADDER, "--"]);
    // Rung 2: force-ipv4 + player_skip=webpage on the same ladder.
    assert.deepEqual(out.args, spawns[1]);
    assert.ok(out.args.includes("--force-ipv4"), "retry carries --force-ipv4");
    const ea = out.args[out.args.indexOf("--extractor-args") + 1];
    assert.equal(ea, `${YOUTUBE_LADDER};player_skip=webpage`);
  } finally {
    restoreEnv("FAKE_YTDLP_MODE", prevMode);
    restoreEnv("FAKE_YTDLP_LOG", prevLog);
    await rm(dir, { recursive: true, force: true });
  }
});

test("ytdlp climbs all three rungs on a persistent wall, then strips the cookie hint", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake binary uses a shebang");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  const fake = path.join(dir, "fake-yt-dlp");
  const log = path.join(dir, "spawns.log");
  writeFileSync(fake, fakeYtDlpScript());
  await chmod(fake, 0o755);
  const prevMode = process.env.FAKE_YTDLP_MODE;
  const prevLog = process.env.FAKE_YTDLP_LOG;
  try {
    process.env.FAKE_YTDLP_MODE = "bot-always";
    process.env.FAKE_YTDLP_LOG = log;
    await assert.rejects(
      () => ytdlp("https://youtu.be/abc", {}, { bin: fake, denoPath: null }),
      (err) => {
        // Cookie how-to is dropped; the actual reason stays.
        assert.doesNotMatch(err.message, /Use --cookies/i);
        assert.match(err.message, /Sign in to confirm you're not a bot/);
        return true;
      }
    );

    const spawns = readSpawns(log);
    assert.equal(spawns.length, 3, "wall persists → all three rungs tried");
    // Rung 3 uses the alternate ladder, still no-webpage + force-ipv4.
    assert.ok(spawns[2].includes("--force-ipv4"));
    const ea = spawns[2][spawns[2].indexOf("--extractor-args") + 1];
    assert.equal(ea, `${YOUTUBE_LADDER_RETRY};player_skip=webpage`);
  } finally {
    restoreEnv("FAKE_YTDLP_MODE", prevMode);
    restoreEnv("FAKE_YTDLP_LOG", prevLog);
    await rm(dir, { recursive: true, force: true });
  }
});

test("ytdlp does not retry failures that aren't the bot check", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake binary uses a shebang");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  const fake = path.join(dir, "fake-yt-dlp");
  const log = path.join(dir, "spawns.log");
  writeFileSync(fake, fakeYtDlpScript());
  await chmod(fake, 0o755);
  const prevMode = process.env.FAKE_YTDLP_MODE;
  const prevLog = process.env.FAKE_YTDLP_LOG;
  try {
    process.env.FAKE_YTDLP_MODE = "http-always";
    process.env.FAKE_YTDLP_LOG = log;
    await assert.rejects(
      () => ytdlp("https://youtu.be/abc", {}, { bin: fake, denoPath: null }),
      /HTTP Error 402/
    );
    assert.equal(readSpawns(log).length, 1, "non-wall failure surfaces after one spawn");
  } finally {
    restoreEnv("FAKE_YTDLP_MODE", prevMode);
    restoreEnv("FAKE_YTDLP_LOG", prevLog);
    await rm(dir, { recursive: true, force: true });
  }
});

test("ytdlp kills a hung binary at the timeout", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake binary uses a shebang");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  const fake = path.join(dir, "slow-yt-dlp");
  writeFileSync(fake, "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n");
  await chmod(fake, 0o755);
  try {
    const started = Date.now();
    await assert.rejects(
      () => ytdlp("https://youtu.be/abc", {}, { bin: fake, timeoutMs: 300 }),
      /timed out after/
    );
    assert.ok(Date.now() - started < 5000, "rejected promptly, not after 60s");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
