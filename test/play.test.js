// Offline tests for the `.play` audio pipeline.
//
// Run with `npm test` (Node's built-in test runner). Nothing here touches the
// network: InnerTube is replaced with a fake module, the "media server" is a
// local HTTP server, and the y2mate module is stubbed.
//
// The first test is the regression that started all this: y2mate stopped
// labelling its audio button exactly "MP3", the old code required that label,
// and every song answered "No audio format was available for that video".

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { readFileSync, writeFileSync } = require("node:fs");
const { chmod, mkdtemp } = require("node:fs/promises");

const ROOT = path.join(__dirname, "..");
const inner = require(path.join(ROOT, "utils", "youtube", "innertube.js"));
const { pickAudioOption } = require(path.join(ROOT, "utils", "y2mate", "audio.js"));
const realIsLikelyAudio = require(path.join(ROOT, "utils", "youtube", "audioApis.js")).isLikelyAudio;

// A fake-but-plausible MP3: real magic bytes, so the audio sniffers accept it.
const PAYLOAD = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(3 * 1024 * 1024 + 74, 5)]);

function startMediaServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ range: req.headers.range, url: req.url });
    const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
    if (!match) {
      res.writeHead(200, { "content-length": PAYLOAD.length });
      return res.end(PAYLOAD);
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), PAYLOAD.length - 1);
    const slice = PAYLOAD.subarray(start, end + 1);
    res.writeHead(206, {
      "content-range": `bytes ${start}-${end}/${PAYLOAD.length}`,
      "content-length": slice.length,
    });
    res.end(slice);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}/media` })
    );
  });
}

function fakeYoutubeModule({ url, failClients = [], status, noAudio = false }) {
  const format = {
    itag: 140,
    has_audio: true,
    has_video: false,
    has_text: false,
    is_type_otf: false,
    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
    bitrate: 129000,
    content_length: PAYLOAD.length,
    url,
    decipher: async (player) => (player ? player.decipher(url, null, null) : url),
  };

  return {
    UniversalCache: class {},
    Innertube: {
      create: async ({ client_type }) => ({
        session: { player: { decipher: (value) => value } },
        getInfo: async () => {
          if (failClients.includes(client_type)) throw new Error("fetch failed");
          if (status) {
            return {
              playability_status: {
                status,
                reason: status === "LOGIN_REQUIRED" ? "Sign in to confirm you're not a bot" : undefined,
              },
              basic_info: {},
              streaming_data: null,
            };
          }
          return {
            playability_status: { status: "OK" },
            basic_info: {
              title: "Test Song",
              author: "Tester",
              duration: 214.4,
              thumbnail: [{ url: "https://i.ytimg.com/vi/x/hq.jpg" }],
            },
            streaming_data: noAudio
              ? { formats: [], adaptive_formats: [] }
              : { formats: [], adaptive_formats: [format] },
          };
        },
      }),
    },
  };
}

test("y2mate: audio options are no longer required to be labelled exactly MP3", () => {
  // This is what the site returns today: no MP3 button, just audio renders.
  const options = [
    { token: "a", quality: "1080p", mime: "video/mp4", hasAudio: true },
    { token: "b", quality: "128kbps", mime: "", hasAudio: true },
    { token: "c", quality: "320kbps", mime: "", hasAudio: true },
    { token: "d", quality: "H.264", mime: "video/mp4", hasAudio: false },
  ];

  const picked = pickAudioOption(options);
  assert.ok(picked, "an audio option should be found even without an MP3 label");
  assert.equal(picked.token, "c", "the highest bitrate audio render wins");

  const mp3 = pickAudioOption([
    { token: "x", quality: "128kbps", mime: "", hasAudio: true },
    { token: "y", quality: "MP3", mime: "audio/mpeg", hasAudio: true },
  ]);
  assert.equal(mp3.token, "y", "a real MP3 render is still preferred");
});

test("innertube: prefers AAC audio and skips OTF/packaged formats", () => {
  const picked = inner.pickAudioFormat({
    formats: [{ itag: 18, has_audio: true, has_video: true, mime_type: "video/mp4", bitrate: 500000 }],
    adaptive_formats: [
      { itag: 251, has_audio: true, has_video: false, has_text: false, mime_type: 'audio/webm; codecs="opus"', bitrate: 160000 },
      { itag: 999, has_audio: true, has_video: false, has_text: false, mime_type: "audio/mp4", bitrate: 256000, is_type_otf: true },
      { itag: 140, has_audio: true, has_video: false, has_text: false, mime_type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 129000 },
    ],
  });

  assert.equal(picked.itag, 140);
  assert.equal(inner.pickAudioFormat(undefined), null);
});

test("innertube: downloads the whole track in byte ranges and strips stale range params", async () => {
  const { server, requests, url } = await startMediaServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "play-test-"));
  const file = path.join(dir, "track.source");

  try {
    inner._setYoutubeModule(fakeYoutubeModule({ url: `${url}?range=0-999999&keep=1` }));
    const result = await inner.fetchAudioToFile("video-id", file);

    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(result.durationSec, 214);
    assert.equal(readFileSync(file).length, PAYLOAD.length);
    assert.ok(readFileSync(file).equals(PAYLOAD), "downloaded bytes must match the source");
    assert.ok(!requests[0].url.includes("range="), "stale range query param should be stripped");
    assert.match(requests[0].range, /^bytes=0-/);
  } finally {
    server.close();
  }
});

test("innertube: falls back through clients and remembers the one that worked", async () => {
  const { server, url } = await startMediaServer();
  const dir = await mkdtemp(path.join(os.tmpdir(), "play-test-"));
  const file = path.join(dir, "track.source");

  try {
    inner._setYoutubeModule(
      fakeYoutubeModule({ url, failClients: ["TVHTML5", "TVHTML5_SIMPLY"] })
    );
    const result = await inner.fetchAudioToFile("video-id", file);
    assert.notEqual(result.client, "TVHTML5");
    assert.equal(inner._getPreferredClient(), result.client);
  } finally {
    server.close();
  }
});

test("innertube: reports blocked / audio-less videos instead of pretending", async () => {
  const { server, url } = await startMediaServer();

  try {
    inner._setYoutubeModule(fakeYoutubeModule({ url, status: "LOGIN_REQUIRED" }));
    await assert.rejects(inner.fetchAudioToFile("video-id", "/tmp/never"), (err) => {
      assert.equal(err.code, "ALL_CLIENTS_FAILED");
      assert.match(err.failures[0].error, /LOGIN_REQUIRED/);
      return true;
    });

    inner._setYoutubeModule(fakeYoutubeModule({ url, noAudio: true }));
    await assert.rejects(inner.fetchAudioToFile("video-id", "/tmp/never"), (err) => {
      assert.match(err.failures[0].error, /no audio format/i);
      return true;
    });
  } finally {
    server.close();
  }
});

function withPlayDependencies({ innertube, y2mate, audioApis, ytdlp }) {
  const playPath = path.join(ROOT, "commands", "downloaders", "play.js");
  const originalLoad = Module._load;

  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === playPath) {
      if (request === "../../utils/y2mate/search") {
        return {
          searchYoutube: async () => ({
            id: "video-id",
            title: "Test Song",
            author: "Tester",
            thumbnail: null,
            durationSec: 200,
          }),
        };
      }
      if (request === "../../utils/youtube/innertube") return innertube;
      if (request === "../../utils/youtube/audioApis") {
        return audioApis || {
          isLikelyAudio: realIsLikelyAudio,
          fetchAudioFromApis: async () => {
            throw new Error("public APIs unavailable in this test");
          },
        };
      }
      if (request === "../../utils/youtube/ytdlp") {
        return (
          ytdlp || {
            hasYtdlp: () => false,
            fetchAudioWithYtdlp: async () => {
              throw new Error("yt-dlp unavailable in this test");
            },
          }
        );
      }
      if (request === "../../utils/y2mate/audio") return { downloadY2mateAudioToFile: y2mate };
    }
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve(playPath)];
  const { playSong } = require(playPath);
  Module._load = originalLoad;
  return playSong;
}

function fakeSock() {
  const sent = [];
  return { sent, sendMessage: async (to, message) => sent.push(message) };
}

const idleCleanup = { TEMP_DIR: os.tmpdir(), cleanupFile: async () => {} };

test("play: sends the InnerTube download back as an audio message", async () => {
  const playSong = withPlayDependencies({
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async (id, file) => {
        writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2048, 7)]));
        return { mimeType: "audio/mpeg", title: "Test Song", author: "Tester", durationSec: 213 };
      },
    },
    y2mate: async () => {
      throw new Error("should not be used");
    },
  });

  const sock = fakeSock();
  const result = await playSong(sock, { key: { remoteJid: "1@g.us" } }, "test song");

  assert.ok(Buffer.isBuffer(result.audio));
  assert.equal(result.mimetype, "audio/mpeg");
  assert.equal(result.ptt, false);
  assert.equal(result.seconds, 213);
  assert.match(sock.sent[0].text, /Searching/);
  assert.match(sock.sent[1].text, /Found \*Test Song\*/);
});

test("play: uses a public API when YouTube refuses every client", async () => {
  let apiCalls = 0;
  let y2mateCalls = 0;
  const playSong = withPlayDependencies({
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async () => {
        throw new Error("LOGIN_REQUIRED");
      },
    },
    audioApis: {
      isLikelyAudio: realIsLikelyAudio,
      fetchAudioFromApis: async (id, file) => {
        apiCalls += 1;
        writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(3072, 1)]));
        return { source: "piped:example", mimeType: "audio/mpeg", title: "Test Song", durationSec: 0 };
      },
    },
    y2mate: async () => {
      y2mateCalls += 1;
      throw new Error("should not be reached");
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "test song");

  assert.equal(apiCalls, 1);
  assert.equal(y2mateCalls, 0, "y2mate is only a last resort");
  assert.ok(Buffer.isBuffer(result.audio));
});

test("play: falls back to y2mate when YouTube and the APIs refuse", async () => {
  let y2mateCalls = 0;
  const playSong = withPlayDependencies({
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async () => {
        throw new Error("LOGIN_REQUIRED");
      },
    },
    y2mate: async (id, file) => {
      y2mateCalls += 1;
      writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 3)]));
      return { mimeType: "audio/mpeg", title: "Test Song", durationSec: 0 };
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "test song");

  assert.equal(y2mateCalls, 1);
  assert.ok(Buffer.isBuffer(result.audio));
  assert.equal(result.mimetype, "audio/mpeg");
  assert.equal(result.seconds, 200, "falls back to the search result's duration");
});

test("play: explains the failure when both sources are blocked", async () => {
  const playSong = withPlayDependencies({
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async () => {
        throw new Error("LOGIN_REQUIRED: Sign in to confirm you're not a bot");
      },
    },
    audioApis: {
      isLikelyAudio: realIsLikelyAudio,
      fetchAudioFromApis: async () => {
        throw new Error("no public audio API had this track");
      },
    },
    y2mate: async () => {
      throw new Error("y2mate exposed no audio option");
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "test song");

  assert.equal(result.audio, undefined);
  // One line per source, with the real reason — never an empty "Details:".
  assert.match(result.text, /• YouTube: LOGIN_REQUIRED/);
  assert.match(result.text, /• public APIs:/);
  assert.match(result.text, /• y2mate:/);
  assert.match(result.text, /\.play cookie/, "should point at the fix");
  assert.doesNotMatch(result.text, /Details:\s*$/m);
  assert.doesNotMatch(result.text, /No audio format/);
});

test("play: oversized tracks are sent as a document instead of failing", async () => {
  const playSong = withPlayDependencies({
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async (id, file) => {
        writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(18 * 1024 * 1024, 7)]));
        return { mimeType: "audio/mpeg", title: "Long Mix", durationSec: 7200 };
      },
    },
    y2mate: async () => {
      throw new Error("should not be used");
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "long mix");

  assert.ok(Buffer.isBuffer(result.document));
  assert.equal(result.audio, undefined);
  assert.equal(result.mimetype, "audio/mpeg");
  assert.equal(result.fileName, "Long Mix.mp3");
});

// ── public API layer (utils/youtube/audioApis.js) ──────────────────

function startApiServer(routes) {
  const server = http.createServer((req, res) => {
    const route = routes[req.url.split("?")[0]];
    if (!route) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("not found");
    }
    return route(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` })
    );
  });
}

function mediaRoute(req, res) {
  const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
  if (!match) {
    res.writeHead(200, { "content-length": PAYLOAD.length });
    return res.end(PAYLOAD);
  }
  const start = Number(match[1]);
  const end = Math.min(Number(match[2]), PAYLOAD.length - 1);
  const slice = PAYLOAD.subarray(start, end + 1);
  res.writeHead(206, {
    "content-range": `bytes ${start}-${end}/${PAYLOAD.length}`,
    "content-length": slice.length,
  });
  res.end(slice);
}

function jsonRoute(payload) {
  return (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  };
}

function clearApiEnv() {
  for (const key of ["YT_AUDIO_APIS", "PIPED_INSTANCES", "INVIDIOUS_INSTANCES", "COBALT_API_URL", "COBALT_INSTANCES"]) {
    delete process.env[key];
  }
}

test("apis: resolves audio from a Piped instance and downloads it", async () => {
  const { server, origin } = await startApiServer({
    "/streams/video-id": jsonRoute({
      title: "Piped Song",
      uploader: "Piped Artist",
      duration: 187,
      audioStreams: [
        { url: "/media?itag=139", mimeType: "audio/mp4", bitrate: 48000 },
        { url: "/media?itag=140", mimeType: "audio/mp4", bitrate: 129000 },
      ],
    }),
    "/media": mediaRoute,
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "play-api-"));
  const file = path.join(dir, "track.source");

  try {
    clearApiEnv();
    process.env.PIPED_INSTANCES = origin;
    process.env.YT_AUDIO_APIS = "piped";

    const { fetchAudioFromApis } = require(path.join(ROOT, "utils", "youtube", "audioApis.js"));
    const result = await fetchAudioFromApis("video-id", file);

    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(result.title, "Piped Song");
    assert.equal(result.author, "Piped Artist");
    assert.equal(result.durationSec, 187);
    assert.match(result.source, /^piped:/);
    assert.ok(readFileSync(file).equals(PAYLOAD));
  } finally {
    clearApiEnv();
    server.close();
  }
});

test("apis: resolves audio from an Invidious instance (relative URLs too)", async () => {
  const { server, origin } = await startApiServer({
    "/api/v1/videos/video-id": jsonRoute({
      title: "Invidious Song",
      author: "Invidious Artist",
      lengthSeconds: 200,
      adaptiveFormats: [
        { url: "/media?itag=251", type: 'audio/webm; codecs="opus"', bitrate: "160000" },
        { url: "/media?itag=140", type: 'audio/mp4; codecs="mp4a.40.2"', bitrate: "129000" },
      ],
    }),
    "/media": mediaRoute,
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "play-api-"));
  const file = path.join(dir, "track.source");

  try {
    clearApiEnv();
    process.env.INVIDIOUS_INSTANCES = origin;
    process.env.YT_AUDIO_APIS = "invidious";

    const { fetchAudioFromApis } = require(path.join(ROOT, "utils", "youtube", "audioApis.js"));
    const result = await fetchAudioFromApis("video-id", file);

    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(result.title, "Invidious Song");
    assert.match(result.source, /^invidious:/);
  } finally {
    clearApiEnv();
    server.close();
  }
});

test("apis: supports a cobalt instance (POST -> tunnel URL)", async () => {
  const { server, origin } = await startApiServer({
    "/": (req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = JSON.parse(body || "{}");
        const ok = parsed.downloadMode === "audio" && /youtube\.com\/watch\?v=video-id/.test(parsed.url);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify(
            ok ? { status: "tunnel", url: `${origin}/media`, filename: "song.mp3" } : { status: "error" }
          )
        );
      });
    },
    "/media": mediaRoute,
  });
  const dir = await mkdtemp(path.join(os.tmpdir(), "play-api-"));
  const file = path.join(dir, "track.source");

  try {
    clearApiEnv();
    process.env.COBALT_INSTANCES = origin;
    process.env.YT_AUDIO_APIS = "cobalt";

    const { fetchAudioFromApis } = require(path.join(ROOT, "utils", "youtube", "audioApis.js"));
    const result = await fetchAudioFromApis("video-id", file);

    assert.equal(result.bytes, PAYLOAD.length);
    assert.match(result.source, /^cobalt:/);
  } finally {
    clearApiEnv();
    server.close();
  }
});

test("apis: accepts a custom {id} endpoint and rejects non-audio responses", async () => {
  const routes = {
    "/html": (req, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html><body>rate limited</body></html>");
    },
    "/media": mediaRoute,
  };
  const { server, origin } = await startApiServer(routes);
  // Absolute media URL, like a real "custom API" would return.
  routes["/good"] = jsonRoute({ data: { downloadUrl: `${origin}/media` } });
  const dir = await mkdtemp(path.join(os.tmpdir(), "play-api-"));
  const file = path.join(dir, "track.source");
  const { fetchAudioFromApis } = require(path.join(ROOT, "utils", "youtube", "audioApis.js"));

  try {
    clearApiEnv();
    process.env.YT_AUDIO_APIS = `${origin}/good?id={id}`;
    let result = await fetchAudioFromApis("video-id", file);
    assert.equal(result.bytes, PAYLOAD.length);
    assert.equal(result.source, "custom-api");

    // An HTML "200 OK" must not be mistaken for audio.
    clearApiEnv();
    process.env.YT_AUDIO_APIS = `${origin}/html?id={id}`;
    await assert.rejects(fetchAudioFromApis("video-id", file), (err) => {
      assert.match(err.failures[0].error, /not audio|no media URL/i);
      return true;
    });
  } finally {
    clearApiEnv();
    server.close();
  }
});

test("apis: magic-number checks recognise real audio containers", () => {
  const { isLikelyAudio } = require(path.join(ROOT, "utils", "youtube", "audioApis.js"));

  assert.equal(
    isLikelyAudio(Buffer.concat([Buffer.from("ID3\u0004\u0000\u0000", "latin1"), Buffer.alloc(12)])),
    true
  );
  assert.equal(isLikelyAudio(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(12)])), true);
  assert.equal(isLikelyAudio(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.alloc(8)])), true);
  assert.equal(isLikelyAudio(Buffer.from("<html>blocked</html>")), false);
  assert.equal(isLikelyAudio(Buffer.from('{"error":"nope"}')), false);
  assert.equal(isLikelyAudio(Buffer.alloc(0)), false);
});

// ── yt-dlp source (utils/youtube/ytdlp.js) ─────────────────────────

async function writeFakeYtdlp(script) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-bin-"));
  const bin = path.join(dir, "yt-dlp");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  await chmod(bin, 0o755);
  return bin;
}

// Emits a fake MP3 to whatever -o template was passed, like the real thing.
const GOOD_YTDLP = `
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
file=$(printf '%s' "$out" | sed 's/%(ext)s/m4a/')
printf 'ID3' > "$file"
head -c 5000 /dev/zero | tr '\\0' 'A' >> "$file"
printf '{"title":"yt-dlp Song","uploader":"yt-dlp Artist","duration":190}' > "$file.info.json"
exit 0
`;

test("ytdlp: downloads audio via the binary and reports metadata", async () => {
  const bin = await writeFakeYtdlp(GOOD_YTDLP);
  const ytdlp = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-out-"));
  const file = path.join(dir, "track.source");

  process.env.YTDLP_PATH = bin;
  ytdlp._reset();

  try {
    const result = await ytdlp.fetchAudioWithYtdlp("video-id", file);

    assert.equal(result.source, "yt-dlp");
    assert.equal(result.bytes, 5003);
    assert.equal(result.title, "yt-dlp Song");
    assert.equal(result.author, "yt-dlp Artist");
    assert.equal(result.durationSec, 190);
    assert.equal(result.mimeType, "audio/mp4");
    assert.ok(readFileSync(file).subarray(0, 3).toString() === "ID3");
  } finally {
    delete process.env.YTDLP_PATH;
    ytdlp._reset();
  }
});

test("ytdlp: surfaces the real error and never accepts garbage output", async () => {
  const ytdlp = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));
  const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-out-"));

  // 1) hard failure -> stderr is surfaced
  process.env.YTDLP_PATH = await writeFakeYtdlp(
    'echo "ERROR: [youtube] video-id: Sign in to confirm you are not a bot" >&2\nexit 1'
  );
  ytdlp._reset();
  await assert.rejects(ytdlp.fetchAudioWithYtdlp("video-id", path.join(dir, "a.bin")), (err) => {
    assert.match(err.message, /Sign in to confirm/i);
    return true;
  });

  // 2) exit 0 but HTML written -> rejected
  process.env.YTDLP_PATH = await writeFakeYtdlp(`
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
file=$(printf '%s' "$out" | sed 's/%(ext)s/m4a/')
printf '<html>blocked</html>' > "$file"
exit 0
`);
  ytdlp._reset();
  await assert.rejects(ytdlp.fetchAudioWithYtdlp("video-id", path.join(dir, "b.bin")), (err) => {
    assert.match(err.message, /not audio/i);
    return true;
  });

  delete process.env.YTDLP_PATH;
  ytdlp._reset();
});

test("ytdlp: a bot-blocked client is not the end of the run", async () => {
  // The real-world case: the first client group gets "Sign in to confirm
  // you're not a bot", a later one is let through. Before the ladder existed
  // the whole source gave up on the first refusal.
  const ytdlp = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));
  const log = path.join(await mkdtemp(path.join(os.tmpdir(), "ytdlp-calls-")), "calls.log");

  const bin = await writeFakeYtdlp(`
echo "$@" >> "${log}"
case "$@" in
  *player_client=default,web_safari*)
    echo "ERROR: [youtube] video-id: Sign in to confirm you're not a bot. Use --cookies" >&2
    exit 1
    ;;
esac
${GOOD_YTDLP}
`);

  process.env.YTDLP_PATH = bin;
  ytdlp._reset();

  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-out-"));
    const target = path.join(dir, "a.bin");
    const result = await ytdlp.fetchAudioWithYtdlp("video-id", target);

    assert.equal(result.source, "yt-dlp");
    assert.match(result.title, /yt-dlp Song/);

    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(calls.length >= 2, `expected a second client to be tried, got ${calls.length}`);
    // The second attempt has to be a *different* client, not a repeat.
    assert.doesNotMatch(calls[1], /player_client=default,web_safari/);
  } finally {
    delete process.env.YTDLP_PATH;
    ytdlp._reset();
  }
});

test("ytdlp: cookies are handed to yt-dlp, and a known block is not retried", async () => {
  const ytdlp = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));
  const session = require(path.join(ROOT, "utils", "youtube", "session.js"));
  const log = path.join(await mkdtemp(path.join(os.tmpdir(), "ytdlp-cookie-")), "calls.log");

  const savedEnv = {};
  for (const name of ["YT_COOKIES_B64", "YT_COOKIES", "YT_COOKIE", "YT_COOKIES_FILE"]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  session.clearCookies();
  session._reset();
  session.setCookies("SID=sid-value; HSID=hsid-value; VISITOR_INFO1_LIVE=visitor");

  const bin = await writeFakeYtdlp(`
echo "$@" >> "${log}"
echo "ERROR: [youtube] video-id: Sign in to confirm you're not a bot. Use --cookies" >&2
exit 1
`);
  process.env.YTDLP_PATH = bin;
  ytdlp._reset();

  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-out-"));

    await assert.rejects(
      ytdlp.fetchAudioWithYtdlp("video-id", path.join(dir, "a.bin"), { strategy: "arroxy" })
    );
    const first = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(first.length >= 2);
    // Every attempt carries the cookie file...
    for (const call of first) assert.match(call, /--cookies \S+yt-cookies\.txt/);
    // ...and the block message survives to the user.
    assert.match(
      await ytdlp
        .fetchAudioWithYtdlp("video-id", path.join(dir, "b.bin"), { strategy: "arroxy" })
        .then(() => "")
        .catch((err) => err.message),
      /Sign in to confirm/i
    );

    // Second run in the same window: every client is a known block, so it must
    // not hit YouTube again — but it still reports the real reason.
    const before = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
    const err = await ytdlp
      .fetchAudioWithYtdlp("video-id", path.join(dir, "c.bin"), { strategy: "arroxy" })
      .then(() => null)
      .catch((e) => e);
    const after = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(after, before, "a known block must not be retried immediately");
    assert.match(err.message, /Sign in to confirm/i);
  } finally {
    session.clearCookies();
    delete process.env.YTDLP_PATH;
    ytdlp._reset();
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("play: prefers yt-dlp, then InnerTube, then APIs, then y2mate", async () => {
  const calls = [];
  const write = (file, byte) => writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2048, byte)]));

  const playSong = withPlayDependencies({
    ytdlp: {
      hasYtdlp: () => true,
      fetchAudioWithYtdlp: async (id, file) => {
        calls.push("ytdlp");
        write(file, 1);
        return { source: "yt-dlp", mimeType: "audio/mpeg", title: "T", durationSec: 180 };
      },
    },
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async (id, file) => {
        calls.push("innertube");
        write(file, 2);
        return { mimeType: "audio/mpeg", title: "T", durationSec: 180 };
      },
    },
    audioApis: {
      isLikelyAudio: realIsLikelyAudio,
      fetchAudioFromApis: async (id, file) => {
        calls.push("apis");
        write(file, 3);
        return { mimeType: "audio/mpeg", title: "T", durationSec: 180 };
      },
    },
    y2mate: async (id, file) => {
      calls.push("y2mate");
      write(file, 4);
      return { mimeType: "audio/mpeg", title: "T", durationSec: 180 };
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "song");
  assert.ok(Buffer.isBuffer(result.audio));
  assert.deepEqual(calls, ["ytdlp"], "the first working source wins");
});

// ── Arroxy ladder (second yt-dlp pass) ─────────────────────────────

test("arroxy: the ladder walks clients instead of repeating one request", () => {
  const ytdlp = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));

  // No cookies: a PO token attempt (none here), then one attempt per client
  // group, ending with yt-dlp's own defaults. Repeating the same client after
  // "Sign in to confirm you're not a bot" can never succeed.
  const without = ytdlp.arroxyLadder({ url: "u", template: "t", poToken: null, visitorData: null });
  assert.deepEqual(without.map((entry) => entry.label), [
    "tv_simply,tv",
    "android_vr",
    "ios",
    "mweb,web_safari",
    "default,-web,-web_safari",
    "no-extractor-args",
  ]);

  const args = without.map((entry) => entry.args.join(" "));
  // VidBee's trick survives as one rung of the ladder.
  assert.ok(args.some((entry) => /player_client=default,-web,-web_safari/.test(entry)));
  // Every rung before the last passes exactly one --extractor-args block.
  for (const entry of args.slice(0, -1)) {
    assert.equal((entry.match(/--extractor-args/g) || []).length, 1);
  }
  // No cookies means no --cookies flag.
  assert.ok(args.every((entry) => !entry.includes("--cookies")));

  const withToken = ytdlp.arroxyLadder({
    url: "u",
    template: "t",
    poToken: "TOKEN123",
    visitorData: "VD456",
  });
  assert.equal(withToken[0].label, "po-token");

  const potArgs = withToken[0].args.join(" ");
  // One --extractor-args block per extractor, carrying token + visitor data.
  assert.equal((potArgs.match(/--extractor-args/g) || []).length, 1);
  assert.match(potArgs, /po_token=web\.gvs\+TOKEN123/);
  assert.match(potArgs, /visitor_data=VD456/);

  // A token without visitor data is useless to yt-dlp, so no PoT attempt.
  const tokenOnly = ytdlp.arroxyLadder({ url: "u", template: "t", poToken: "TOKEN123", visitorData: null });
  assert.equal(tokenOnly[0].label, "tv_simply,tv");

  // With cookies the session is what YouTube wants, so web clients lead and
  // every rung carries --cookies. A PO token is never combined with cookies.
  const withCookies = ytdlp.arroxyLadder({
    url: "u",
    template: "t",
    poToken: "TOKEN123",
    visitorData: "VD456",
    cookiePath: "/tmp/cookies.txt",
  });
  assert.deepEqual(withCookies.map((entry) => entry.label), [
    "yt-dlp defaults",
    "web_safari,web,mweb",
    "tv_simply,tv",
  ]);
  for (const entry of withCookies) {
    const joined = entry.args.join(" ");
    assert.match(joined, /--cookies \/tmp\/cookies\.txt/);
    assert.doesNotMatch(joined, /po_token=/);
  }

  // Hardening flags from Arroxy's download path.
  const hardened = without[0].args.join(" ");
  for (const flag of ["--ignore-config", "--http-chunk-size", "--abort-on-unavailable-fragments", "--no-js-runtimes"]) {
    assert.ok(hardened.includes(flag), `expected ${flag}`);
  }
  assert.ok(hardened.includes(`node:${process.execPath}`), "passes the bot's own node runtime");
});

test("arroxy: classifies yt-dlp failures into actionable kinds", () => {
  const { classifyYtdlpError } = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));

  assert.equal(classifyYtdlpError("ERROR: [youtube] x: Sign in to confirm you're not a bot").kind, "botBlock");
  assert.equal(classifyYtdlpError("ERROR: HTTP Error 429: Too Many Requests").kind, "rateLimit");
  assert.equal(classifyYtdlpError("ERROR: [youtube] x: Video unavailable").kind, "unavailable");
  assert.equal(classifyYtdlpError("ERROR: [youtube] x: This video is age-restricted").kind, "ageRestricted");
  assert.equal(classifyYtdlpError("ERROR: ffmpeg not found. Please install").kind, "missingDependency");
  assert.equal(classifyYtdlpError("something else broke").kind, "other");

  const blocked = classifyYtdlpError("Sign in to confirm you're not a bot");
  assert.equal(blocked.retryable, true);
  assert.match(blocked.fix, /YT_COOKIE|PIPED/);
});

test("arroxy: a rate limit ends the ladder instead of burning more requests", async () => {
  const ytdlp = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));
  // Fake binary: always reports a 429 and records each invocation.
  const log = path.join(await mkdtemp(path.join(os.tmpdir(), "ytdlp-log-")), "calls.log");
  const bin = await writeFakeYtdlp(`
echo "call" >> "${log}"
echo "ERROR: HTTP Error 429: Too Many Requests" >&2
exit 1
`);
  process.env.YTDLP_PATH = bin;
  ytdlp._reset();

  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-out-"));
    await assert.rejects(
      ytdlp.fetchAudioWithYtdlp("video-id", path.join(dir, "a.bin"), { strategy: "arroxy" }),
      (err) => {
        assert.equal(err.kind, "rateLimit");
        return true;
      }
    );
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    assert.equal(calls.length, 1, "the ladder must stop at the first rate limit");
  } finally {
    delete process.env.YTDLP_PATH;
    ytdlp._reset();
  }
});

test("play: tries both yt-dlp passes before other sources", async () => {
  const calls = [];
  const playSong = withPlayDependencies({
    ytdlp: {
      hasYtdlp: () => true,
      fetchAudioWithYtdlp: async (id, file, options = {}) => {
        calls.push(options.strategy);
        if (options.strategy === "basic") {
          const error = new Error("ERROR: Sign in to confirm you're not a bot");
          error.kind = "botBlock";
          throw error;
        }
        writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(2048, 1)]));
        return { source: "yt-dlp (arroxy ladder)", mimeType: "audio/mpeg", title: "T", durationSec: 180 };
      },
    },
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async () => {
        calls.push("innertube");
        throw new Error("should not be reached");
      },
    },
    y2mate: async () => {
      throw new Error("should not be reached");
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "song");
  assert.ok(Buffer.isBuffer(result.audio));
  assert.deepEqual(calls, ["basic", "arroxy"]);
});

test("ytdlp: SoundCloud search fallback strips YouTube noise and accepts exit code 101", async () => {
  const ytdlp = require(path.join(ROOT, "utils", "youtube", "ytdlp.js"));
  const log = path.join(await mkdtemp(path.join(os.tmpdir(), "ytdlp-sc-")), "calls.log");

  const bin = await writeFakeYtdlp(`
echo "$@" >> "${log}"
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then out="$arg"; fi
  prev="$arg"
done
file=$(printf '%s' "$out" | sed 's/%(ext)s/mp3/')
printf 'ID3' > "$file"
head -c 5000 /dev/zero | tr '\\0' 'A' >> "$file"
printf '{"title":"Sia - Snowman","uploader":"Sia","duration":173}' > "$file.info.json"
exit 101
`);

  process.env.YTDLP_PATH = bin;
  ytdlp._reset();

  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "ytdlp-sc-out-"));
    const target = path.join(dir, "sc.mp3");
    const result = await ytdlp.fetchAudioWithYtdlpSearch(
      {
        title: "Sia - Snowman [Official Video]",
        author: "SiaVEVO",
        durationSec: 173,
        query: "snowman",
      },
      target
    );

    assert.equal(result.source, "yt-dlp (soundcloud)");
    assert.equal(result.durationSec, 173);
    assert.ok(readFileSync(target).subarray(0, 3).toString() === "ID3");

    const calls = readFileSync(log, "utf8").trim();
    assert.match(calls, /scsearch5:Sia - Snowman/);
    assert.doesNotMatch(calls, /\[Official Video\]/);
  } finally {
    delete process.env.YTDLP_PATH;
    ytdlp._reset();
  }
});

test("play: rescues track via SoundCloud when YouTube blocks yt-dlp and InnerTube", async () => {
  const calls = [];
  const playSong = withPlayDependencies({
    ytdlp: {
      hasYtdlp: () => true,
      fetchAudioWithYtdlp: async (id, file, options = {}) => {
        calls.push(`yt:${options.strategy}`);
        const err = new Error("ERROR: [youtube] gset79KMmt0: Sign in to confirm you're not a bot");
        err.kind = "botBlock";
        throw err;
      },
      fetchAudioWithYtdlpSearch: async (meta, file) => {
        calls.push(`sc:${meta.title}`);
        writeFileSync(file, Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 2)]));
        return {
          source: "yt-dlp (soundcloud)",
          mimeType: "audio/mpeg",
          title: meta.title,
          durationSec: 200,
        };
      },
    },
    innertube: {
      ...idleCleanup,
      fetchAudioToFile: async () => {
        calls.push("innertube");
        throw new Error("LOGIN_REQUIRED: Sign in to confirm you're not a bot");
      },
    },
    y2mate: async () => {
      calls.push("y2mate");
      throw new Error("should not be reached");
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "snowman");
  assert.ok(Buffer.isBuffer(result.audio));
  assert.deepEqual(calls, ["yt:basic", "yt:arroxy", "innertube", "sc:Test Song"]);
});
