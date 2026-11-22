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
const { mkdtemp, chmod, stat, utimes, rm } = require("node:fs/promises");

const { ytdlp, toArgs, assetFor, binPath, installYtDlp } = require(
  path.join(__dirname, "..", "utils", "ytdlp.js")
);

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

test("installYtDlp refreshes a stale binary (24h max age)", async () => {
  const { server, base } = await startServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  try {
    const dest = path.join(dir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    writeFileSync(dest, Buffer.alloc(2 * 1024 * 1024, 7));
    // Age the binary past the refresh threshold (default: 24 h).
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(dest, old, old);

    const result = await installYtDlp({ dir, url: `${base}/good` });
    assert.equal(result.skipped, false, "stale binary was re-downloaded");
    assert.ok(Date.now() - (await stat(dest)).mtimeMs < 60000, "binary was rewritten");
    assert.equal((await stat(dest)).size, 2 * 1024 * 1024);
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("installYtDlp always refreshes with maxAgeMs: 0, never with a negative", async () => {
  const { server, base } = await startServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  try {
    const dest = path.join(dir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    writeFileSync(dest, Buffer.alloc(2 * 1024 * 1024, 7));

    const always = await installYtDlp({ dir, url: `${base}/good`, maxAgeMs: 0 });
    assert.equal(always.skipped, false, "maxAgeMs 0 = always refresh");

    writeFileSync(dest, Buffer.alloc(2 * 1024 * 1024, 7));
    const never = await installYtDlp({ dir, url: `${base}/good`, maxAgeMs: -1 });
    assert.equal(never.skipped, true, "negative maxAgeMs = never refresh");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("installYtDlp keeps a stale binary when the refresh download fails", async () => {
  const { server, base } = await startServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  try {
    const dest = path.join(dir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    writeFileSync(dest, Buffer.alloc(2 * 1024 * 1024, 7));
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(dest, old, old);

    const result = await installYtDlp({ dir, url: `${base}/missing` });
    assert.equal(result.skipped, true, "soft-keep, not a hard failure");
    assert.match(result.reason, /refresh failed/);
    // The old binary is still there and still valid-sized.
    assert.equal((await stat(dest)).size, 2 * 1024 * 1024);
    assert.ok(!existsSync(`${dest}.part`), "no temp file left behind");
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
    const out = await ytdlp("https://youtu.be/abc", { audioFormat: "opus", quiet: true }, { bin: fake });
    assert.deepEqual(out.args, [
      "--audio-format",
      "opus",
      "--quiet",
      "--",
      "https://youtu.be/abc",
    ]);

    await assert.rejects(
      () => ytdlp("https://youtu.be/abc", { fail: true }, { bin: fake }),
      /HTTP 402 refused/
    );
  } finally {
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

test("ytdlp injects --proxy from YT_DLP_PROXY; opts.proxy overrides and '' disables", async (t) => {
  if (process.platform === "win32") {
    t.skip("fake binary uses a shebang");
    return;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  const fake = path.join(dir, "proxy-yt-dlp");
  writeFileSync(
    fake,
    "#!/usr/bin/env node\n" +
      "const args = process.argv.slice(2);\n" +
      "console.log(JSON.stringify({ args }));\n"
  );
  await chmod(fake, 0o755);

  const before = process.env.YT_DLP_PROXY;
  const proxyOf = (out) => {
    const i = out.args.indexOf("--proxy");
    return i === -1 ? null : out.args[i + 1];
  };
  try {
    // No proxy configured -> no --proxy flag at all.
    delete process.env.YT_DLP_PROXY;
    const direct = await ytdlp("https://youtu.be/abc", {}, { bin: fake });
    assert.equal(proxyOf(direct), null, "no --proxy when unset");

    // Env var -> applied to every call (search and downloads share this runner).
    process.env.YT_DLP_PROXY = "socks5h://user:pass@proxy.example:1080";
    const viaEnv = await ytdlp("https://youtu.be/abc", {}, { bin: fake });
    assert.equal(proxyOf(viaEnv), "socks5h://user:pass@proxy.example:1080");
    assert.ok(viaEnv.args[viaEnv.args.length - 1] === "https://youtu.be/abc", "URL stays last");

    // Per-call override wins over the env var.
    const viaOpt = await ytdlp("https://youtu.be/abc", {}, { bin: fake, proxy: "http://other:8080" });
    assert.equal(proxyOf(viaOpt), "http://other:8080");

    // Empty per-call value disables the env-configured proxy.
    const disabled = await ytdlp("https://youtu.be/abc", {}, { bin: fake, proxy: "" });
    assert.equal(proxyOf(disabled), null, "opts.proxy '' disables the env proxy");
  } finally {
    if (before === undefined) delete process.env.YT_DLP_PROXY;
    else process.env.YT_DLP_PROXY = before;
    await rm(dir, { recursive: true, force: true });
  }
});

// ── proxy pool: rotation per call + benching ────────────────────────────────

const {
  parseProxyList,
  rotatingProxiesActive,
  proxyPool,
  nextProxy,
  proxyBenchRemaining,
  penalizeProxy,
  resetProxyPool,
} = require(path.join(__dirname, "..", "utils", "ytdlp.js"));

function withProxyEnv( { list, single, benchMs } = {}) {
  const before = {
    LIST: process.env.YT_DLP_PROXY_LIST,
    SINGLE: process.env.YT_DLP_PROXY,
    BENCH: process.env.YT_DLP_PROXY_BENCH_MS,
  };
  resetProxyPool();
  if (list === undefined) delete process.env.YT_DLP_PROXY_LIST;
  else process.env.YT_DLP_PROXY_LIST = list;
  if (single === undefined) delete process.env.YT_DLP_PROXY;
  else process.env.YT_DLP_PROXY = single;
  if (benchMs === undefined) delete process.env.YT_DLP_PROXY_BENCH_MS;
  else process.env.YT_DLP_PROXY_BENCH_MS = String(benchMs);
  return () => {
    if (before.LIST === undefined) delete process.env.YT_DLP_PROXY_LIST;
    else process.env.YT_DLP_PROXY_LIST = before.LIST;
    if (before.SINGLE === undefined) delete process.env.YT_DLP_PROXY;
    else process.env.YT_DLP_PROXY = before.SINGLE;
    if (before.BENCH === undefined) delete process.env.YT_DLP_PROXY_BENCH_MS;
    else process.env.YT_DLP_PROXY_BENCH_MS = before.BENCH;
    resetProxyPool();
  };
}

test("parseProxyList splits commas, newlines, semicolons and dedupes", () => {
  assert.deepEqual(
    parseProxyList("http://u:p@1.1.1.1:6014,\nhttp://u:p@2.2.2.2:6641 ; http://u:p@1.1.1.1:6014"),
    ["http://u:p@1.1.1.1:6014", "http://u:p@2.2.2.2:6641"]
  );
  assert.deepEqual(parseProxyList(""), []);
  assert.deepEqual(parseProxyList(null), []);
});

test("rotatingProxiesActive is true only for 2+ proxies", () => {
  const undo = withProxyEnv( { list: "http://u:p@a:1,http://u:p@b:2" });
  try {
    assert.equal(rotatingProxiesActive(), true);
    assert.equal(proxyPool().length, 2);
  } finally {
    undo();
  }

  const undoSingle = withProxyEnv( { single: "http://u:p@a:1" });
  try {
    assert.equal(rotatingProxiesActive(), false, "single proxy is not a rotating pool");
    assert.deepEqual(proxyPool(), ["http://u:p@a:1"]);
  } finally {
    undoSingle();
  }

  const undoNone = withProxyEnv( {});
  try {
    assert.equal(rotatingProxiesActive(), false);
    assert.deepEqual(proxyPool(), []);
  } finally {
    undoNone();
  }
});

test("proxy pool rotates per call: a, b, c, then back to a", () => {
  const undo = withProxyEnv( { list: "http://u:p@a:1, http://u:p@b:2, http://u:p@c:3" });
  try {
    assert.deepEqual([nextProxy(), nextProxy(), nextProxy(), nextProxy()], [
      "http://u:p@a:1",
      "http://u:p@b:2",
      "http://u:p@c:3",
      "http://u:p@a:1",
    ]);
  } finally {
    undo();
  }
});

test("a failed proxy is benched and skipped; YT_DLP_PROXY_LIST wins over YT_DLP_PROXY", () => {
  const undo = withProxyEnv( {
    list: "http://u:p@a:1,http://u:p@b:2",
    benchMs: 10000,
  });
  try {
    // First call gets a; it dies at the transport level -> benched.
    const a = nextProxy();
    assert.equal(penalizeProxy(a, new Error("ERROR: unable to connect to proxy")), true);
    assert.ok(proxyBenchRemaining(a) > 0);
    // Next picks b, then wraps to... a is still benched -> b again.
    assert.equal(nextProxy(), "http://u:p@b:2");
    assert.equal(nextProxy(), "http://u:p@b:2");
    // A bot-check on b's IP also benches it (reputation fault).
    assert.equal(penalizeProxy("http://u:p@b:2", new Error("Sign in to confirm you're not a bot")), true);
    // All benched -> rotation falls back to the cursor entry anyway.
    assert.ok([a, "http://u:p@b:2"].includes(nextProxy()));
  } finally {
    undo();
  }
});

test("content failures (private video) do NOT bench a proxy", () => {
  const undo = withProxyEnv( { list: "http://u:p@a:1,http://u:p@b:2", benchMs: 10000 });
  try {
    const a = nextProxy();
    assert.equal(
      penalizeProxy(a, new Error("ERROR: [youtube] x: Private video. Sign in if you've been granted access")),
      false
    );
    assert.equal(proxyBenchRemaining(a), 0);
  } finally {
    undo();
  }
});

test("bench window expires and the proxy rejoins the rotation", async () => {
  const undo = withProxyEnv( { list: "http://u:p@a:1,http://u:p@b:2", benchMs: 40 });
  try {
    const a = nextProxy();
    penalizeProxy(a, new Error("ECONNREFUSED 1.2.3.4"));
    assert.ok(proxyBenchRemaining(a) > 0);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(proxyBenchRemaining(a), 0, "bench expired");
  } finally {
    undo();
  }
});

test("ytdlp calls rotate through the pool (observed via fake binary)", async () => {
  if (process.platform === "win32") {
    t2.skip("fake binary uses a shebang");
    return;
  }
  const undo = withProxyEnv( { list: "http://u:p@a:1,http://u:p@b:2" });
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-test-"));
  const fake = path.join(dir, "rot-yt-dlp");
  writeFileSync(
    fake,
    "#!/usr/bin/env node\n" +
      "const args = process.argv.slice(2);\n" +
      "const i = args.indexOf('--proxy');\n" +
      "console.log(JSON.stringify({ proxy: i === -1 ? null : args[i + 1] }));\n"
  );
  await chmod(fake, 0o755);
  try {
    const seen = [];
    for (let i = 0; i < 4; i++) {
      const out = await ytdlp("https://youtu.be/abc", {}, { bin: fake });
      seen.push(out.proxy);
    }
    assert.deepEqual(seen, [
      "http://u:p@a:1",
      "http://u:p@b:2",
      "http://u:p@a:1",
      "http://u:p@b:2",
    ]);
  } finally {
    undo();
    await rm(dir, { recursive: true, force: true });
  }
});
