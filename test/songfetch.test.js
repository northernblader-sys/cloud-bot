// Offline tests for utils/songfetch.js — the Node port of songfetch.py
// (search once, rank live/karaoke/cover to the back, try each candidate
// until a file appears, clear .part files between attempts). No network:
// ytdlp/fetch/ffmpeg are all injected fakes.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { mkdtemp, rm, writeFile, readFile } = require("node:fs/promises");

const {
  fold,
  sanitize,
  rank,
  activeTerms,
  parseArtistTitle,
  search,
  clearPartials,
  fetchCover,
  fetchDeezerCover,
  downloadTrack,
} = require(path.join(__dirname, "..", "utils", "songfetch.js"));

const { ytdlpBaseFlags, isBotCheckError } = require(
  path.join(__dirname, "..", "utils", "ytdlp.js")
);

test("fold lowercases and strips diacritics", () => {
  assert.equal(fold("Kóncert LIVE"), "koncert live");
  assert.equal(fold("Beyoncé"), "beyonce");
  assert.equal(fold(""), "");
  assert.equal(fold(null), "");
});

test("sanitize replaces path-hostile characters and trims trailing dots", () => {
  assert.equal(sanitize('a/b\\c:d*e?f"g<h>i|j'), "a_b_c_d_e_f_g_h_i_j");
  assert.equal(sanitize("  hello...  "), "hello");
  assert.equal(sanitize(""), "");
});

test("rank demotes live/karaoke/cover but never drops them", () => {
  const candidates = [
    { id: "1", title: "Daft Punk - One More Time (Live)", url: "u1" },
    { id: "2", title: "Daft Punk - One More Time", url: "u2" },
    { id: "3", title: "One More Time Karaoke Version", url: "u3" },
    { id: "4", title: "One More Time (Cover)", url: "u4" },
    { id: "5", title: "Daft Punk - One More Time (Official Audio)", url: "u5" },
  ];
  const ranked = rank(candidates, "Daft Punk One More Time");
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["2", "5", "1", "3", "4"]
  );
});

test("rank does not demote keywords already in the query", () => {
  // "Live and Let Die" contains "live" — penalising it would demote
  // every result equally, so the term is dropped from the penalties.
  const candidates = [
    { id: "1", title: "Paul McCartney - Live and Let Die", url: "u1" },
    { id: "2", title: "Live and Let Die (Live)", url: "u2" },
  ];
  const ranked = rank(candidates, "Live and Let Die");
  assert.deepEqual(
    ranked.map((c) => c.id),
    ["1", "2"]
  );
  assert.equal(activeTerms("Live and Let Die").length, 2); // karaoke + cover remain
});

test("parseArtistTitle splits on ' - ' like songfetch.py", () => {
  assert.deepEqual(parseArtistTitle("Daft Punk - One More Time"), {
    artist: "Daft Punk",
    title: "One More Time",
  });
  assert.deepEqual(parseArtistTitle("One More Time"), { artist: "", title: "One More Time" });
});

test("search parses id/title/duration lines and skips NA", async () => {
  const fakeRunner = async () =>
    "abc123\tDaft Punk - One More Time\t321\n" +
    "NA\tMissing\tNA\n" +
    "def456\tOne More Time (Live)\t400\n";
  const out = await search("Daft Punk One More Time", { ytdlpImpl: fakeRunner });
  assert.deepEqual(out, [
    { id: "abc123", title: "Daft Punk - One More Time", url: "https://www.youtube.com/watch?v=abc123", duration: 321 },
    { id: "def456", title: "One More Time (Live)", url: "https://www.youtube.com/watch?v=def456", duration: 400 },
  ]);
});

test("search returns [] on runner failure but rethrows missing binary", async () => {
  const failing = async () => {
    throw new Error("HTTP 429 too many requests");
  };
  assert.deepEqual(await search("x", { ytdlpImpl: failing }), []);

  const missing = async () => {
    throw new Error("yt-dlp binary not found at bin/yt-dlp");
  };
  await assert.rejects(() => search("x", { ytdlpImpl: missing }), /binary not found/);
});

test("clearPartials deletes scratch files but keeps the final file", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    await writeFile(path.join(dir, "Song.mp3"), "final");
    await writeFile(path.join(dir, "Song.mp3.part"), "half");
    await writeFile(path.join(dir, "Song.mp3.ytdl"), "half");
    await writeFile(path.join(dir, "Song.mp3.temp"), "half");
    await writeFile(path.join(dir, "Other.mp3.part"), "other");
    clearPartials(dir, "Song");
    assert.equal(fs.existsSync(path.join(dir, "Song.mp3")), true);
    assert.equal(fs.existsSync(path.join(dir, "Song.mp3.part")), false);
    assert.equal(fs.existsSync(path.join(dir, "Song.mp3.ytdl")), false);
    assert.equal(fs.existsSync(path.join(dir, "Song.mp3.temp")), false);
    assert.equal(fs.existsSync(path.join(dir, "Other.mp3.part")), true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetchCover downloads via injected fetch and fails soft", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    const dest = path.join(dir, "cover.jpg");
    const okFetch = async () => ({
      ok: true,
      arrayBuffer: async () => new TextEncoder().encode("JPEGDATA").buffer,
    });
    assert.equal(await fetchCover("https://example.com/c.jpg", dest, okFetch), true);
    assert.equal(await readFile(dest, "utf8"), "JPEGDATA");

    const badFetch = async () => ({ ok: false });
    assert.equal(await fetchCover("https://example.com/c.jpg", dest, badFetch), false);
    assert.equal(await fetchCover("", dest, okFetch), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetchDeezerCover returns cover_big and fails soft", async () => {
  const deezerFetch = async () => ({
    ok: true,
    json: async () => ({ data: [{ album: { cover_big: "https://cdn.example/big.jpg" } }] }),
  });
  assert.equal(
    await fetchDeezerCover("Daft Punk", "One More Time", deezerFetch),
    "https://cdn.example/big.jpg"
  );
  const badFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await fetchDeezerCover("Daft Punk", "One More Time", badFetch), "");
  assert.equal(await fetchDeezerCover("", "", deezerFetch), "");
});

test("downloadTrack tries ranked candidates until a file appears", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    const candidates = [
      { id: "1", title: "Song (Live)", url: "https://www.youtube.com/watch?v=1" },
      { id: "2", title: "Song", url: "https://www.youtube.com/watch?v=2" },
    ];
    const searchImpl = async () => candidates;
    let attempts = 0;
    const tried = [];
    const ytdlpImpl = async (target, flags) => {
      attempts++;
      tried.push(target);
      // Ranked order is [v=2 (preferred), v=1 (live, demoted)].
      // The preferred one is "blocked" (no file); the demoted live
      // take succeeds — proving retry + ranking both work.
      if (target.endsWith("v=1")) {
        const final = flags.output.replace("%(ext)s", flags.audioFormat);
        await fs.promises.mkdir(path.dirname(final), { recursive: true });
        await writeFile(final, "AUDIO");
      }
      return "";
    };
    const ffmpegImpl = async (args) => {
      // Simulate the tag pass: copy input (args[2]) to output (last arg).
      const input = args[2];
      const output = args[args.length - 1];
      await writeFile(output, await readFile(input));
      return 0;
    };
    const result = await downloadTrack({
      artist: "Artist",
      title: "Song",
      album: "Album",
      fmt: "mp3",
      outRoot,
      searchImpl,
      ytdlpImpl,
      ffmpegImpl,
      fetchImpl: async () => ({ ok: false }), // no Deezer cover in tests
    });
    assert.ok(result, "downloadTrack returns a path");
    assert.equal(attempts, 2, "tried both candidates");
    assert.deepEqual(tried, [
      "https://www.youtube.com/watch?v=2",
      "https://www.youtube.com/watch?v=1",
    ]);
    assert.equal(await readFile(result, "utf8"), "AUDIO");
    assert.ok(result.endsWith(path.join("Artist", "Album", "Song.mp3")));
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test("downloadTrack returns null when every candidate fails", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    const searchImpl = async () => [{ id: "1", title: "Song", url: "https://www.youtube.com/watch?v=1" }];
    const ytdlpImpl = async () => {
      throw new Error("Sign in to confirm you're not a bot");
    };
    const result = await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl,
      ytdlpImpl,
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
    });
    assert.equal(result, null);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test("downloadTrack falls back to one-shot ytsearch when search is empty", async () => {
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    const searchImpl = async () => [];
    let sawSearchTarget = false;
    const ytdlpImpl = async (target, flags) => {
      if (target.startsWith("ytsearch")) {
        sawSearchTarget = true;
        const final = flags.output.replace("%(ext)s", flags.audioFormat);
        await fs.promises.mkdir(path.dirname(final), { recursive: true });
        await writeFile(final, "AUDIO");
      }
      return "";
    };
    const ffmpegImpl = async (args) => {
      await writeFile(args[args.length - 1], await readFile(args[2]));
      return 0;
    };
    const result = await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl,
      ytdlpImpl,
      ffmpegImpl,
      fetchImpl: async () => ({ ok: false }),
    });
    assert.ok(result);
    assert.equal(sawSearchTarget, true);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
  }
});

test("ytdlpBaseFlags defaults to android player client and honors env overrides", () => {
  const beforeExtractor = process.env.YT_DLP_EXTRACTOR_ARGS;
  const beforeClient = process.env.YT_DLP_PLAYER_CLIENT;
  const beforeCookies = process.env.YT_DLP_COOKIES;
  try {
    delete process.env.YT_DLP_EXTRACTOR_ARGS;
    delete process.env.YT_DLP_PLAYER_CLIENT;
    delete process.env.YT_DLP_COOKIES;
    const flags = ytdlpBaseFlags();
    assert.match(flags.extractorArgs, /player_client=android/);
    assert.equal(flags.retries, 3);

    process.env.YT_DLP_PLAYER_CLIENT = "ios";
    assert.match(ytdlpBaseFlags().extractorArgs, /player_client=ios/);

    process.env.YT_DLP_EXTRACTOR_ARGS = "youtube:player_client=web";
    assert.equal(ytdlpBaseFlags().extractorArgs, "youtube:player_client=web");

    process.env.YT_DLP_COOKIES = "/tmp/cookies.txt";
    assert.equal(ytdlpBaseFlags().cookies, "/tmp/cookies.txt");
  } finally {
    if (beforeExtractor === undefined) delete process.env.YT_DLP_EXTRACTOR_ARGS;
    else process.env.YT_DLP_EXTRACTOR_ARGS = beforeExtractor;
    if (beforeClient === undefined) delete process.env.YT_DLP_PLAYER_CLIENT;
    else process.env.YT_DLP_PLAYER_CLIENT = beforeClient;
    if (beforeCookies === undefined) delete process.env.YT_DLP_COOKIES;
    else process.env.YT_DLP_COOKIES = beforeCookies;
  }
});

test("isBotCheckError detects the YouTube bot wall", () => {
  assert.equal(isBotCheckError(new Error("Sign in to confirm you're not a bot")), true);
  assert.equal(isBotCheckError(new Error("Use --cookies-from-browser or --cookies for the authentication")), true);
  assert.equal(isBotCheckError(new Error("HTTP 429 too many requests")), false);
  assert.equal(isBotCheckError(null), false);
});
