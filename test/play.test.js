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
const { mkdtemp } = require("node:fs/promises");

const ROOT = path.join(__dirname, "..");
const inner = require(path.join(ROOT, "utils", "youtube", "innertube.js"));
const { pickAudioOption } = require(path.join(ROOT, "utils", "y2mate", "audio.js"));

const PAYLOAD = Buffer.alloc(3 * 1024 * 1024 + 77, 5);

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

function withPlayDependencies({ innertube, y2mate }) {
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

test("play: falls back to y2mate when YouTube refuses every client", async () => {
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
    y2mate: async () => {
      throw new Error("y2mate exposed no audio option");
    },
  });

  const result = await playSong(fakeSock(), { key: { remoteJid: "1@g.us" } }, "test song");

  assert.equal(result.audio, undefined);
  assert.match(result.text, /anti-bot/);
  assert.match(result.text, /Details: LOGIN_REQUIRED/);
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
