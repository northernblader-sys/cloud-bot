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
  lookupCover,
  lookupTrackInfo,
  downloadTrack,
  classifyError,
  cooldownRemainingMs,
  clearCooldown,
  lastFailureInfo,
  YT_COOLDOWN_MS,
  ATTEMPT_GAP_MS,
} = require(path.join(__dirname, "..", "utils", "songfetch.js"));

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

test("parseArtistTitle splits on ' - ' and strips artist prefix like songfetch.py", () => {
  assert.deepEqual(parseArtistTitle("Daft Punk - One More Time"), {
    artist: "Daft Punk",
    title: "One More Time",
  });
  assert.deepEqual(parseArtistTitle("One More Time"), { artist: "", title: "One More Time" });
  // `--artist X "X Title"` should not search for "X X Title".
  assert.deepEqual(parseArtistTitle("Adele Love in the Dark", "Adele"), {
    artist: "Adele",
    title: "Love in the Dark",
  });
});

test("search parses id/title lines and skips NA", async () => {
  const fakeRunner = async () =>
    "abc123\tDaft Punk - One More Time\n" +
    "NA\tMissing\n" +
    "def456\tOne More Time (Live)\n";
  const out = await search("Daft Punk One More Time", { ytdlpImpl: fakeRunner });
  assert.deepEqual(out, [
    { id: "abc123", title: "Daft Punk - One More Time", url: "https://www.youtube.com/watch?v=abc123" },
    { id: "def456", title: "One More Time (Live)", url: "https://www.youtube.com/watch?v=def456" },
  ]);
});

test("search returns [] on runner failure but rethrows missing binary", async () => {
  clearCooldown();
  // An ordinary failure (not a bot check / 429) still returns [] — and
  // must NOT start the IP cooldown.
  const failing = async () => {
    throw new Error("flat-playlist failed: yt-dlp exploded");
  };
  assert.deepEqual(await search("x", { ytdlpImpl: failing }), []);
  assert.equal(cooldownRemainingMs(), 0, "ordinary search failure: no cooldown");

  const missing = async () => {
    throw new Error("yt-dlp binary not found at bin/yt-dlp");
  };
  await assert.rejects(() => search("x", { ytdlpImpl: missing }), /binary not found/);
});

test("classifyError maps yt-dlp's failure lines to the real cause", () => {
  // From the diagnosis: "use --cookies" is a static suffix; the real
  // cause is the line before it.
  assert.equal(
    classifyError(new Error("ERROR: [youtube] oytOOA9sOiE: Sign in to confirm you're not a bot.")),
    "botcheck"
  );
  assert.equal(classifyError(new Error("ERROR: HTTP Error 429: Too Many Requests")), "ratelimit");
  assert.equal(classifyError(new Error("ERROR: [youtube] x: Private video. Sign in if you have access")), "unavailable");
  assert.equal(classifyError(new Error("ERROR: [youtube] x: Video unavailable")), "unavailable");
  assert.equal(classifyError(new Error("ERROR: [youtube] x: This video is age restricted")), "age");
  assert.equal(classifyError(new Error("ERROR: Requested format is not available")), "format");
  assert.equal(classifyError(new Error("something else entirely")), "other");
});

test("a 429 during search also starts the IP cooldown", async () => {
  clearCooldown();
  const failing = async () => {
    throw new Error("ERROR: HTTP Error 429: Too Many Requests");
  };
  assert.deepEqual(await search("x", { ytdlpImpl: failing }), []);
  assert.ok(cooldownRemainingMs() > 0, "cooldown started");
  assert.equal(lastFailureInfo().kind, "ratelimit");
  assert.equal(YT_COOLDOWN_MS, 300 * 1000, "300s, like player.py's YT_COOLDOWN");
  clearCooldown();
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

test("lookupCover requires exact artist match (iTunes, no wrong karaoke art)", async () => {
  // Deezer's top hit for "adele love in the dark" is a karaoke tribute.
  // lookupCover must skip it and return the real "25" artwork instead.
  const itunesFetch = async () => ({
    ok: true,
    json: async () => ({
      results: [
        {
          artistName: "Delayed Karma",
          trackName: "Love in the Dark (Originally Performed by Adele)",
          artworkUrl100: "https://example.com/karaoke100.jpg",
        },
        {
          artistName: "Adele",
          trackName: "Love in the Dark",
          artworkUrl100: "https://example.com/25-100x100bb.jpg",
        },
      ],
    }),
  });
  assert.equal(
    await lookupCover("Adele", "Love in the Dark", itunesFetch),
    "https://example.com/25-600x600bb.jpg"
  );

  const badFetch = async () => {
    throw new Error("network down");
  };
  assert.equal(await lookupCover("Adele", "Love in the Dark", badFetch), "");
  assert.equal(await lookupCover("", "", itunesFetch), "");
});

test("lookupTrackInfo returns the full card metadata (names, album, duration)", async () => {
  const itunesFetch = async () => ({
    ok: true,
    json: async () => ({
      results: [
        {
          artistName: "Adele",
          trackName: "Love in the Dark",
          collectionName: "25",
          trackTimeMillis: 285935,
          artworkUrl100: "https://example.com/25-100x100bb.jpg",
        },
      ],
    }),
  });
  const info = await lookupTrackInfo("Adele", "Love in the Dark", itunesFetch);
  assert.ok(info);
  assert.equal(info.artworkUrl, "https://example.com/25-600x600bb.jpg");
  assert.equal(info.artistName, "Adele");
  assert.equal(info.trackName, "Love in the Dark");
  assert.equal(info.collectionName, "25");
  assert.equal(info.durationMs, 285935);

  // No confident match -> null (never wrong metadata on the card).
  const noMatch = async () => ({
    ok: true,
    json: async () => ({ results: [{ artistName: "Someone Else", trackName: "Different Song" }] }),
  });
  assert.equal(await lookupTrackInfo("Adele", "Love in the Dark", noMatch), null);

  // No artwork -> empty string URL, other fields intact.
  const noArt = async () => ({
    ok: true,
    json: async () => ({
      results: [{ artistName: "Adele", trackName: "Love in the Dark", trackTimeMillis: 285935 }],
    }),
  });
  const bare = await lookupTrackInfo("Adele", "Love in the Dark", noArt);
  assert.equal(bare.artworkUrl, "");
  assert.equal(bare.durationMs, 285935);
});

test("downloadTrack tries ranked candidates until a file appears", async () => {
  clearCooldown();
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
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
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
    clearCooldown();
  }
});

test("a bot check stops the candidate loop and starts the 300s cooldown", async () => {
  clearCooldown();
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    // 5 candidates, first one hits the IP wall. Hammering the rest would
    // only extend the block (player.py), so the loop must stop at 1.
    const searchImpl = async () =>
      [1, 2, 3, 4, 5].map((n) => ({
        id: String(n),
        title: `Song ${n}`,
        url: `https://www.youtube.com/watch?v=${n}`,
      }));
    const tried = [];
    const ytdlpImpl = async (target) => {
      tried.push(target);
      throw new Error("ERROR: Sign in to confirm you're not a bot");
    };
    const result = await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl,
      ytdlpImpl,
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
    });
    assert.equal(result, null);
    assert.equal(tried.length, 1, "did NOT hammer the other candidates");
    assert.ok(cooldownRemainingMs() > 0, "cooldown started");
    assert.equal(lastFailureInfo().kind, "botcheck");
    assert.match(lastFailureInfo().detail, /not a bot/);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});

test("while the cooldown is active, downloadTrack fails fast without touching YouTube", async () => {
  clearCooldown();
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    // Trigger the cooldown once.
    const ytdlpImplBlock = async () => {
      throw new Error("ERROR: HTTP Error 429: Too Many Requests");
    };
    await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl: async () => [{ id: "1", title: "Song", url: "https://www.youtube.com/watch?v=1" }],
      ytdlpImpl: ytdlpImplBlock,
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
    });
    assert.ok(cooldownRemainingMs() > 0, "cooldown is now active");

    // Next .play must fail fast: search/ytdlp are never called.
    let calls = 0;
    const result = await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl: async () => {
        calls++;
        return [];
      },
      ytdlpImpl: async () => {
        calls++;
        throw new Error("should not be called");
      },
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
    });
    assert.equal(result, null);
    assert.equal(calls, 0, "no YouTube requests during the cooldown");
  } finally {
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});

test("ordinary failures (private video) do not start the cooldown", async () => {
  clearCooldown();
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    const result = await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl: async () => [{ id: "1", title: "Song", url: "https://www.youtube.com/watch?v=1" }],
      ytdlpImpl: async () => {
        throw new Error("ERROR: [youtube] 1: Private video. Sign in if you've been granted access");
      },
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
    });
    assert.equal(result, null);
    assert.equal(cooldownRemainingMs(), 0, "no cooldown for a genuinely gone video");
    assert.equal(lastFailureInfo().kind, "unavailable");
  } finally {
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});

test("candidate attempts are spaced apart (5s gap by default)", async () => {
  clearCooldown();
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    const searchImpl = async () =>
      [1, 2].map((n) => ({ id: String(n), title: `Song ${n}`, url: `https://www.youtube.com/watch?v=${n}` }));
    const stamps = [];
    const ytdlpImpl = async () => {
      stamps.push(Date.now());
      throw new Error("nope");
    };
    await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl,
      ytdlpImpl,
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 30,
    });
    assert.equal(stamps.length, 2);
    assert.ok(stamps[1] - stamps[0] >= 25, "second attempt waited for the gap");
    assert.equal(ATTEMPT_GAP_MS, 5000, "default gap is 5s");
  } finally {
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});

test("downloadTrack falls back to one-shot ytsearch when search is empty", async () => {
  clearCooldown();
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
      attemptGapMs: 0,
    });
    assert.ok(result);
    assert.equal(sawSearchTarget, true);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});

test("a blocked search skips the one-shot fallback (no hammering)", async () => {
  clearCooldown();
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    // The flat search hits the bot check: search() returns [] and starts
    // the cooldown, so the ytsearch fallback must NOT fire.
    const searchImpl = async () => [];
    let fallbackCalled = false;
    const ytdlpImpl = async (target) => {
      if (String(target).startsWith("ytsearch5:")) {
        fallbackCalled = true;
        return "";
      }
      throw new Error("unreachable: no candidates were given");
    };
    // Real search() behavior: ytdlp throws → [] + cooldown. Simulate by
    // calling search with a blocked runner, then feeding that result in.
    const blockedSearch = async () =>
      search("Song", {
        ytdlpImpl: async () => {
          throw new Error("ERROR: Sign in to confirm you're not a bot");
        },
      });
    const result = await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl: blockedSearch,
      ytdlpImpl,
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
    });
    assert.equal(result, null);
    assert.equal(fallbackCalled, false, "fallback did not hammer YouTube");
    assert.ok(cooldownRemainingMs() > 0);
  } finally {
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});

// ── rotating proxy pool: the global cooldown applies only to single-IP setups ──

const { resetProxyPool } = require(path.join(__dirname, "..", "utils", "ytdlp.js"));

function withProxyList( list) {
  const before = process.env.YT_DLP_PROXY_LIST;
  resetProxyPool();
  if (list === undefined) delete process.env.YT_DLP_PROXY_LIST;
  else process.env.YT_DLP_PROXY_LIST = list;
  return () => {
    if (before === undefined) delete process.env.YT_DLP_PROXY_LIST;
    else process.env.YT_DLP_PROXY_LIST = before;
    resetProxyPool();
  };
}

test("with a rotating pool, a bot check benches the proxy but skips the 300s cooldown", async () => {
  clearCooldown();
  const undo = withProxyList( "http://u:p@a:1,http://u:p@b:2");
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    // Candidate 1 rides proxy a and gets bot-checked; candidate 2 rides
    // proxy b and fails ordinarily. Rotation must keep going (2 attempts)
    // and the global cooldown must NOT start.
    const tried = [];
    const searchImpl = async () =>
      [1, 2].map((n) => ({ id: String(n), title: `Song ${n}`, url: `https://www.youtube.com/watch?v=${n}` }));
    let call = 0;
    const result = await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl,
      ytdlpImpl: async (target) => {
        tried.push(target);
        call++;
        throw new Error(
          call === 1
            ? "ERROR: Sign in to confirm you're not a bot"
            : "ERROR: [youtube] 2: Video unavailable"
        );
      },
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
    });
    assert.equal(result, null);
    assert.equal(tried.length, 2, "rotation kept trying the next IP");
    assert.equal(cooldownRemainingMs(), 0, "no global cooldown while rotating");
    assert.equal(lastFailureInfo().kind, "unavailable", "last failure was candidate 2's");
  } finally {
    undo();
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});

test("with a single proxy (no rotation), the cooldown still applies", async () => {
  clearCooldown();
  const undo = withProxyList( "http://u:p@a:1");
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "songfetch-test-"));
  try {
    await downloadTrack({
      artist: "",
      title: "Song",
      outRoot,
      searchImpl: async () => [{ id: "1", title: "Song", url: "https://www.youtube.com/watch?v=1" }],
      ytdlpImpl: async () => {
        throw new Error("ERROR: Sign in to confirm you're not a bot");
      },
      ffmpegImpl: async () => 0,
      fetchImpl: async () => ({ ok: false }),
      attemptGapMs: 0,
    });
    assert.ok(cooldownRemainingMs() > 0, "single proxy = one IP = cooldown applies");
  } finally {
    undo();
    await rm(outRoot, { recursive: true, force: true });
    clearCooldown();
  }
});
