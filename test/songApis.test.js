// Offline tests for utils/songApis.js — the Knight/Prexzy HTTP APIs used
// before the yt-dlp fallback. No network: fetch is injected, files land
// in a temp dir.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { mkdtemp, readFile, rm } = require("node:fs/promises");

const {
  fetchKnight,
  fetchPrexzy,
  downloadTo,
  downloadViaApis,
  MIN_BYTES,
} = require(path.join(__dirname, "..", "utils", "songApis.js"));

/** Build a fake fetch from a routing function. */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(url, opts, calls.length);
  };
  impl.calls = calls;
  return impl;
}

const AUDIO = Buffer.alloc(2 * 1024 * 1024, 9); // 2 MB — above the 64 KB floor

/** Response pair for the actual media URLs (ranged probe + full GET). */
function mediaResponse(url, opts) {
  if (opts.headers && opts.headers.Range) {
    return { ok: true, status: 206, headers: new Map() };
  }
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-length", String(AUDIO.length)]]),
    arrayBuffer: async () => AUDIO.buffer.slice(AUDIO.byteOffset, AUDIO.byteOffset + AUDIO.length),
  };
}

function okJson(obj) {
  return { ok: true, status: 200, headers: new Map(), json: async () => obj };
}

test("fetchKnight builds the documented endpoint and returns the download URL", async () => {
  const f = fakeFetch((url) => {
    assert.match(url, /^https:\/\/knight\.example\/api\/download\/ytaudio\?/);
    assert.match(url, /format=128kbps/);
    assert.match(url, /apikey=knight/);
    assert.match(url, /url=https%3A%2F%2Fwww\.youtube\.com%2Fwatch%3Fv%3Dabc/);
    return okJson({
      success: true,
      result: { title: "Song", id: "abc", download: "https://cdn.example/media/song.mp3" },
    });
  });
  const info = await fetchKnight("https://www.youtube.com/watch?v=abc", {
    baseUrl: "https://knight.example",
    fetchImpl: f,
  });
  assert.equal(info.download, "https://cdn.example/media/song.mp3");
  assert.equal(info.title, "Song");
});

test("fetchKnight rejects on HTTP errors, success=false, and missing/non-http download", async () => {
  await assert.rejects(
    () => fetchKnight("u", { baseUrl: "https://k.example", fetchImpl: async () => ({ ok: false, status: 500 }) }),
    /Knight API HTTP 500/
  );
  await assert.rejects(
    () =>
      fetchKnight("u", {
        baseUrl: "https://k.example",
        fetchImpl: async () => okJson({ success: false, message: "Video unavailable" }),
      }),
    /success=false.*Video unavailable/
  );
  await assert.rejects(
    () =>
      fetchKnight("u", {
        baseUrl: "https://k.example",
        fetchImpl: async () => okJson({ success: true, result: { title: "t" } }),
      }),
    /no download URL/
  );
  await assert.rejects(
    () =>
      fetchKnight("u", {
        baseUrl: "https://k.example",
        fetchImpl: async () => okJson({ success: true, result: { download: "ftp://nope" } }),
      }),
    /no download URL/
  );
});

test("fetchPrexzy builds its endpoint and returns the expiring googlevideo URL", async () => {
  const f = fakeFetch((url) => {
    assert.match(url, /^https:\/\/prexzy\.example\/download\/ytmp3\?url=/);
    assert.match(url, /url=https%3A%2F%2Fyoutu\.be%2Fxyz/);
    return okJson({
      status: true,
      statusCode: 200,
      info: { id: "xyz", title: "Prexzy Song", uploader: "Someone" },
      download_url: "https://rr5---sn-x.googlevideo.com/videoplayback?expire=123",
      ext: "m4a",
    });
  });
  const info = await fetchPrexzy("https://youtu.be/xyz", {
    baseUrl: "https://prexzy.example",
    fetchImpl: f,
  });
  assert.match(info.download, /googlevideo\.com/);
  assert.equal(info.ext, "m4a");
  assert.equal(info.title, "Prexzy Song");
});

test("fetchPrexzy rejects on status=false and missing download_url", async () => {
  await assert.rejects(
    () => fetchPrexzy("u", { baseUrl: "https://p.example", fetchImpl: async () => okJson({ status: false }) }),
    /status=false/
  );
  await assert.rejects(
    () => fetchPrexzy("u", { baseUrl: "https://p.example", fetchImpl: async () => okJson({ status: true }) }),
    /no download_url/
  );
});

test("downloadTo probes with a ranged GET, then saves the full file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "songapis-test-"));
  try {
    const f = fakeFetch((url, opts) => {
      if (opts.headers && opts.headers.Range) {
        // Ranged probe: 200 OK from a server that ignores Range is fine too.
        return { ok: true, status: 206, headers: new Map([["content-length", String(200 * 1024)]]) };
      }
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-length", String(AUDIO.length)]]),
        arrayBuffer: async () => AUDIO.buffer.slice(AUDIO.byteOffset, AUDIO.byteOffset + AUDIO.length),
      };
    });
    const dest = path.join(dir, "song.mp3");
    const r = await downloadTo("https://cdn.example/song.mp3", dest, { fetchImpl: f });
    assert.equal(r.bytes, AUDIO.length);
    assert.equal((await readFile(dest)).length, AUDIO.length);
    assert.equal(f.calls.length, 2, "probe then full download");
    assert.match(f.calls[0].url, /cdn\.example/);
    assert.equal(f.calls[0].opts.headers.Range, "bytes=0-204799");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadTo rejects failed probes, tiny bodies, and oversized files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "songapis-test-"));
  try {
    const dest = path.join(dir, "song.mp3");
    const dead = fakeFetch(() => ({ ok: false, status: 403, headers: new Map() }));
    await assert.rejects(() => downloadTo("u", dest, { fetchImpl: dead }), /probe HTTP 403/);

    const tiny = fakeFetch((url, opts) => {
      if (opts.headers && opts.headers.Range) return { ok: true, status: 206, headers: new Map() };
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        arrayBuffer: async () => new ArrayBuffer(1024), // < MIN_BYTES
      };
    });
    await assert.rejects(() => downloadTo("u", dest, { fetchImpl: tiny }), /truncated\/broken/);
    assert.equal(fs.existsSync(dest), false, "no file written for a broken download");

    const huge = fakeFetch((url, opts) => {
      if (opts.headers && opts.headers.Range) return { ok: true, status: 206, headers: new Map() };
      return {
        ok: true,
        status: 200,
        headers: new Map([["content-length", String(50 * 1024 * 1024)]]),
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    await assert.rejects(() => downloadTo("u", dest, { fetchImpl: huge, maxBytes: 40 * 1024 * 1024 }), /too large/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadTo floors at MIN_BYTES (64 KB) — anything smaller is broken", () => {
  assert.ok(MIN_BYTES === 64 * 1024);
});

test("downloadViaApis retries the SAME API with the next candidate before switching", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "songapis-test-"));
  const candidates = [
    { id: "1", title: "Song (dead upload)", url: "https://www.youtube.com/watch?v=1" },
    { id: "2", title: "Song (works)", url: "https://www.youtube.com/watch?v=2" },
  ];
  const knightUrls = [];
  const prevEnv = process.env.KNIGHT_API_URL;
  process.env.KNIGHT_API_URL = "https://knight.example";
  try {
    const f = fakeFetch((url, opts) => {
      if (url.includes("cdn.example")) return mediaResponse(url, opts);
      if (url.includes("knight.example")) {
        knightUrls.push(url);
        if (knightUrls.length === 1) return { ok: false, status: 500, headers: new Map() };
        return okJson({ success: true, result: { title: "Song", id: "2", download: "https://cdn.example/a.mp3" } });
      }
      throw new Error("Prexzy must not be called while Knight still has candidates");
    });
    const result = await downloadViaApis({
      candidates,
      outBase: path.join(dir, "Song"),
      fetchImpl: f,
      onAttempt: () => {},
    });
    assert.ok(result, "second candidate succeeded");
    assert.equal(result.source, "knight");
    assert.equal(result.path, path.join(dir, "Song.mp3"));
    assert.ok(fs.existsSync(result.path));
    assert.equal(knightUrls.length, 2, "same API, next video ID");
    assert.match(knightUrls[0], /v%3D1/);
    assert.match(knightUrls[1], /v%3D2/);
    assert.equal(f.calls.filter((c) => c.url.includes("prexzy")).length, 0, "never switched APIs");
  } finally {
    if (prevEnv === undefined) delete process.env.KNIGHT_API_URL;
    else process.env.KNIGHT_API_URL = prevEnv;
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadViaApis falls to Prexzy only after every Knight candidate fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "songapis-test-"));
  const candidates = [
    { id: "1", title: "A", url: "https://www.youtube.com/watch?v=1" },
    { id: "2", title: "B", url: "https://www.youtube.com/watch?v=2" },
  ];
  const prevEnv = {
    k: process.env.KNIGHT_API_URL,
    p: process.env.PREXZY_API_URL,
  };
  process.env.KNIGHT_API_URL = "https://knight.example";
  process.env.PREXZY_API_URL = "https://prexzy.example";
  try {
    let knightCalls = 0;
    let prexzyCalls = 0;
    const labels = [];
    const f = fakeFetch((url, opts) => {
      if (url.includes("googlevideo.com")) return mediaResponse(url, opts);
      if (url.includes("knight.example")) {
        knightCalls++;
        return { ok: false, status: 500, headers: new Map() };
      }
      // Prexzy: candidate 1 fails, candidate 2 works.
      prexzyCalls++;
      if (prexzyCalls === 1) return { ok: false, status: 500, headers: new Map() };
      return okJson({
        status: true,
        info: { id: "2", title: "B" },
        download_url: "https://rr5---sn-x.googlevideo.com/videoplayback?expire=1",
        ext: "m4a",
      });
    });
    const result = await downloadViaApis({
      candidates,
      outBase: path.join(dir, "Song"),
      fetchImpl: f,
      onAttempt: (l) => labels.push(l),
    });
    assert.ok(result);
    assert.equal(result.source, "prexzy");
    assert.equal(result.path, path.join(dir, "Song.m4a"));
    assert.ok(fs.existsSync(result.path));
    assert.equal(knightCalls, 2, "all Knight candidates first");
    assert.equal(prexzyCalls, 2, "then Prexzy candidates");
    assert.equal(labels.length, 4, "status edit per attempt");
    assert.ok(labels[0].includes("Knight") && labels[2].includes("Prexzy"));
  } finally {
    if (prevEnv.k === undefined) delete process.env.KNIGHT_API_URL;
    else process.env.KNIGHT_API_URL = prevEnv.k;
    if (prevEnv.p === undefined) delete process.env.PREXZY_API_URL;
    else process.env.PREXZY_API_URL = prevEnv.p;
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadViaApis returns null when everything fails (yt-dlp fallback next)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "songapis-test-"));
  try {
    const f = fakeFetch((url) => ({ ok: false, status: 500, headers: new Map() }));
    const result = await downloadViaApis({
      candidates: [{ id: "1", title: "A", url: "https://www.youtube.com/watch?v=1" }],
      outBase: path.join(dir, "Song"),
      fetchImpl: f,
    });
    assert.equal(result, null);
    assert.equal(fs.existsSync(path.join(dir, "Song.mp3")), false);
    assert.equal(fs.existsSync(path.join(dir, "Song.m4a")), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadViaApis honors KNIGHT_API_URL / PREXZY_API_URL env overrides", async () => {
  const before = { k: process.env.KNIGHT_API_URL, p: process.env.PREXZY_API_URL };
  const dir = await mkdtemp(path.join(os.tmpdir(), "songapis-test-"));
  process.env.KNIGHT_API_URL = "https://knight-mirror.example/";
  process.env.PREXZY_API_URL = "https://prexzy-mirror.example";
  try {
    const f = fakeFetch((url) => {
      assert.ok(
        /^https:\/\/knight-mirror\.example\/api\//.test(url) ||
          /^https:\/\/prexzy-mirror\.example\/download\//.test(url),
        `unexpected endpoint: ${url}`
      );
      return { ok: false, status: 500, headers: new Map() };
    });
    await downloadViaApis({
      candidates: [{ id: "1", title: "A", url: "https://www.youtube.com/watch?v=1" }],
      outBase: path.join(dir, "Song"),
      fetchImpl: f,
    });
    assert.equal(f.calls.length, 2);
  } finally {
    if (before.k === undefined) delete process.env.KNIGHT_API_URL;
    else process.env.KNIGHT_API_URL = before.k;
    if (before.p === undefined) delete process.env.PREXZY_API_URL;
    else process.env.PREXZY_API_URL = before.p;
    await rm(dir, { recursive: true, force: true });
  }
});
