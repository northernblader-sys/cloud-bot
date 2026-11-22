// Offline tests for utils/soundcloud.js — the Prexzy SoundCloud stage
// that is the FIRST choice in the .play audio chain. No network: fetch
// is injected, ffmpeg is a fake executable when the HLS path is hit.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { mkdtemp, readFile, rm, chmod, writeFile } = require("node:fs/promises");

const {
  extractSoundCloudUrl,
  isSoundCloudUrl,
  stripTracking,
  searchSoundCloud,
  resolveSoundCloud,
  downloadSoundCloud,
  downloadSoundCloudCandidates,
  rankSoundCloud,
  SC_DEMOTE,
} = require(path.join(__dirname, "..", "utils", "soundcloud.js"));

/** Fake fetch from a routing function (handler gets the URL as a string). */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const s = String(url);
    calls.push({ url: s, opts });
    return handler(s, opts, calls.length);
  };
  impl.calls = calls;
  return impl;
}

function okJson(obj) {
  return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(obj) };
}

// A real-ish AAC-in-MP4 header: box size 0x0000001c, then 'ftyp', then brand.
const M4A = Buffer.concat([
  Buffer.from("0000001c667479706d34342000000000", "hex"), // [size=28]['ftyp']['M4 ']
  Buffer.alloc(2 * 1024 * 1024, 7),
]);

function m4aResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Map([["content-length", String(M4A.length)]]),
    arrayBuffer: async () => M4A.buffer.slice(M4A.byteOffset, M4A.byteOffset + M4A.length),
  };
}

const SEARCH_ROWS = {
  status: true,
  statusCode: 200,
  data: [
    { id: 1, title: "Mockingbird", url: "https://soundcloud.com/eminemofficial/mockingbird?si=x&utm_source=y", duration: "4:11", thumbnail: "th1" },
    { id: 2, title: "Eminem - MockingBird (sped up)", url: "https://soundcloud.com/its-hossam1/mockingbird-sped", duration: "3:28", thumbnail: "th2" },
    { id: 3, title: "Eminem - Mockingbird (slowed + reverb)", url: "https://soundcloud.com/hfennnyf5ugz/mockingbird-slow", duration: "4:40", thumbnail: "th3" },
  ],
};

const DETAILS = {
  status: true,
  statusCode: 200,
  data: {
    id: 50660948,
    title: "Eminem-Mockingbird",
    author: { username: "Blogger_" },
    duration: "4:24",
    durationMs: 264452,
    artwork: "https://i.scdn.co/art.jpg",
    url: "https://soundcloud.com/blogger-2/eminem-mockingbird-lyrics",
    downloadable: false, // uploader setting — meaningless here, must be ignored
    streams: { hq: "https://play.media/playlist.m3u8?expires=123" },
  },
};

test("extractSoundCloudUrl finds links and strips tracking junk; ignores non-SC text", () => {
  assert.equal(
    extractSoundCloudUrl(
      "check this https://soundcloud.com/blogger-2/eminem-mockingbird-lyrics?si=1055&utm_source=chat out"
    ),
    "https://soundcloud.com/blogger-2/eminem-mockingbird-lyrics"
  );
  assert.equal(
    extractSoundCloudUrl("https://snd.sc/abc123?si=zz"),
    "https://snd.sc/abc123"
  );
  assert.equal(extractSoundCloudUrl("https://www.soundcloud.com/a/b"), "https://www.soundcloud.com/a/b");
  assert.equal(extractSoundCloudUrl("eminem mockingbird"), null);
  assert.equal(extractSoundCloudUrl("https://youtube.com/watch?v=x"), null);
  assert.equal(isSoundCloudUrl("soundcloud.com/x/y"), false, "bare hostname without protocol is not a link here");
  assert.equal(isSoundCloudUrl("https://soundcloud.com/x/y"), true);
});

test("stripTracking keeps the path exactly (no decode/re-encode)", () => {
  assert.equal(
    stripTracking("https://soundcloud.com/blogger-2/eminem-mockingbird-lyrics?si=1"),
    "https://soundcloud.com/blogger-2/eminem-mockingbird-lyrics"
  );
  // Path segments are preserved verbatim, even odd ones.
  assert.equal(stripTracking("https://soundcloud.com/a-b_c/d-e?f=1"), "https://soundcloud.com/a-b_c/d-e");
});

test("searchSoundCloud maps data[] rows and cleans their URLs", async () => {
  const f = fakeFetch((url) => {
    assert.match(url, /^https:\/\/prexzyapis\.com\/search\/soundcloud\?q=eminem(\%20|\+)mockingbird$/);
    return okJson(SEARCH_ROWS);
  });
  const rows = await searchSoundCloud("eminem mockingbird", 8, f);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].title, "Mockingbird");
  assert.equal(rows[0].url, "https://soundcloud.com/eminemofficial/mockingbird");
  assert.equal(rows[0].author, "");
});

test("searchSoundCloud rejects status:false and non-JSON bodies", async () => {
  await assert.rejects(
    () => searchSoundCloud("x", 8, fakeFetch(() => okJson({ status: false, error: "no results" }))),
    /no results/
  );
  await assert.rejects(
    () =>
      searchSoundCloud(
        "x",
        8,
        fakeFetch(() => ({ ok: true, status: 200, headers: new Map(), text: async () => "<html>oops</html>" }))
      ),
    /non-JSON/
  );
});

test("resolveSoundCloud: link input hits the details endpoint with the cleaned URL", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("/download/soundcloud?url=")) {
      assert.match(url, /url=https%3A%2F%2Fsoundcloud\.com%2Fblogger-2%2Feminem-mockingbird-lyrics$/);
      return okJson(DETAILS);
    }
    throw new Error("unexpected call: " + url);
  });
  const t = await resolveSoundCloud("https://soundcloud.com/blogger-2/eminem-mockingbird-lyrics?si=junk", f);
  assert.equal(t.id, 50660948);
  assert.equal(t.title, "Eminem-Mockingbird");
  assert.equal(t.author, "Blogger_");
  assert.equal(t.durationMs, 264452);
  assert.match(t.streamUrl, /playlist\.m3u8/);
  assert.equal(t.downloadable, undefined, "uploader's downloadable flag is not surfaced");
});

test("resolveSoundCloud builds the byte link from the id (Step 5)", async () => {
  const f = fakeFetch(() => okJson(DETAILS));
  const t = await resolveSoundCloud("https://soundcloud.com/blogger-2/x", f);
  assert.equal(
    t.downloadUrl,
    "https://prexzyapis.com/download/soundcloud?id=50660948&mode=audio&quality=hq"
  );
});

test("resolveSoundCloud: name input searches first, then resolves data[0]", async () => {
  const f = fakeFetch((url) => {
    if (url.includes("/search/soundcloud")) return okJson(SEARCH_ROWS);
    if (url.includes("eminemofficial%2Fmockingbird")) return okJson(DETAILS);
    throw new Error("expected the first search row's URL, got: " + url);
  });
  const t = await resolveSoundCloud("eminem mockingbird", f);
  assert.equal(t.id, 50660948);
});

test("downloadSoundCloud: direct byte link wins (audio/mp4, ftyp verified)", async () => {
  const expectUA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
  const f = fakeFetch((url, opts) => {
    if (url.includes("/download/soundcloud?url=")) return okJson(DETAILS);
    // The byte link fetch must carry a UA.
    assert.equal(opts.headers["User-Agent"], expectUA);
    return m4aResponse();
  });
  const got = await downloadSoundCloud("https://soundcloud.com/blogger-2/x", { fetchImpl: f });
  assert.equal(got.via, "prexzy-direct");
  assert.equal(got.ext, "m4a");
  assert.equal(got.buffer.length, M4A.length);
  assert.equal(got.title, "Eminem-Mockingbird");
});

test("downloadSoundCloud: a JSON error page served as 200 is rejected (ftyp + size)", async () => {
  // DETAILS without streams: no HLS fallback possible, so the direct-path
  // rejection is what must propagate.
  const noStreams = { ...DETAILS, data: { ...DETAILS.data, streams: {} } };
  const f = fakeFetch((url) => {
    if (url.includes("/download/soundcloud?url=")) return okJson(noStreams);
    return {
      ok: true,
      status: 200,
      headers: new Map(),
      arrayBuffer: async () => new TextEncoder().encode('{"error":"rate limited"}').buffer,
    };
  });
  await assert.rejects(
    () => downloadSoundCloud("https://soundcloud.com/blogger-2/x", { fetchImpl: f }),
    /not an MP4|too small/
  );
});

test("downloadSoundCloud: direct failure falls back to the HLS playlist (Step 7)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sc-test-"));
  const fakeFfmpeg = path.join(dir, "fake-ffmpeg");
  // The fake ffmpeg writes a valid ftyp file to its last arg and exits 0.
  await writeFile(
    fakeFfmpeg,
    "#!/usr/bin/env node\n" +
      "const fs = require('fs');\n" +
      "const out = process.argv[process.argv.length - 1];\n" +
      "const head = Buffer.from('0000001c667479706d34342000000000', 'hex');\n" +
      "fs.writeFileSync(out, Buffer.concat([head, Buffer.alloc(3 * 1024 * 1024, 7)]));\n"
  );
  await chmod(fakeFfmpeg, 0o755);
  try {
    const f = fakeFetch((url) => {
      if (url.includes("/download/soundcloud?url=")) return okJson(DETAILS);
      // The direct byte link 500s — HLS must take over.
      return { ok: false, status: 500, headers: new Map() };
    });
    const got = await downloadSoundCloud("https://soundcloud.com/blogger-2/x", {
      fetchImpl: f,
      ffmpegPath: fakeFfmpeg,
    });
    assert.equal(got.via, "hls");
    assert.ok(got.buffer.length > 20_000);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rankSoundCloud pushes sped/slowed/remix to the back, but not when the query asks for them", () => {
  const rows = SEARCH_ROWS.data.map((r) => ({ ...r, url: stripTracking(r.url) }));
  const ranked = rankSoundCloud(rows, "eminem mockingbird");
  assert.equal(ranked[0].title, "Mockingbird", "studio version first");
  assert.ok(ranked[1].title.includes("sped") || ranked[1].title.includes("slowed"));
  assert.ok(ranked[2].title.includes("sped") || ranked[2].title.includes("slowed"));

  // "drop a keyword the user asked for": searching for the remix itself
  // must not demote every result.
  const remixOnly = [
    { id: 1, title: "Song (sped up)", url: "https://soundcloud.com/a/1" },
    { id: 2, title: "Song (sped up) 2", url: "https://soundcloud.com/a/2" },
  ];
  const ranked2 = rankSoundCloud(remixOnly, "song sped up");
  assert.deepEqual(ranked2.map((r) => r.id), [1, 2], "no demotion when the query names the pattern");
  assert.ok(Object.values(SC_DEMOTE).every((re) => re instanceof RegExp));
});

test("downloadSoundCloudCandidates: next candidate on failure, file written to outBase.m4a", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sc-test-"));
  try {
    const candidates = [
      { id: 1, title: "dead upload", url: "https://soundcloud.com/a/dead" },
      { id: 2, title: "works", url: "https://soundcloud.com/a/works" },
    ];
    const labels = [];
    const f = fakeFetch((url) => {
      if (url.includes("/download/soundcloud?url=")) {
        if (url.includes("a%2Fdead") || url.includes("%2Fdead")) return okJson({ status: false, error: "gone" });
        return okJson(DETAILS);
      }
      return m4aResponse();
    });
    const result = await downloadSoundCloudCandidates({
      candidates,
      outBase: path.join(dir, "Song"),
      onAttempt: (l) => labels.push(l),
      fetchImpl: f,
    });
    assert.ok(result);
    assert.equal(result.source, "soundcloud");
    assert.equal(result.path, path.join(dir, "Song.m4a"));
    assert.equal((await readFile(result.path)).length, M4A.length);
    assert.equal(labels.length, 2, "one status label per candidate");
    assert.ok(labels[0].includes("dead upload"), "label is the bare title (caller adds the API number)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("downloadSoundCloudCandidates returns null when every candidate fails", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sc-test-"));
  try {
    const f = fakeFetch((url) => {
      if (url.includes("/download/soundcloud")) return okJson({ status: false, error: "private" });
      return { ok: false, status: 500, headers: new Map() };
    });
    const result = await downloadSoundCloudCandidates({
      candidates: [{ id: 1, title: "a", url: "https://soundcloud.com/a/1" }],
      outBase: path.join(dir, "Song"),
      fetchImpl: f,
    });
    assert.equal(result, null);
    assert.equal(fs.existsSync(path.join(dir, "Song.m4a")), false, "no stray file left behind");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
