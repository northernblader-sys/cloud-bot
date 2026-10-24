// Offline tests for the `.play` download chain. A local HTTP server stands in
// for the downloader APIs, so nothing here touches the network.

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const { readFileSync } = require("node:fs");
const { mkdtemp } = require("node:fs/promises");

const { _internals } = require(path.join(__dirname, "..", "commands", "downloaders", "play.js"));
const { downloadAudioSource, extractVideoId, isLikelyAudio } = _internals;

const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(4096, 7)]);

function startServer() {
  const server = http.createServer((req, res) => {
    if (req.url === "/good.mp3") {
      res.writeHead(200, { "content-type": "audio/mpeg" });
      return res.end(MP3);
    }
    if (req.url === "/error-page") {
      // A "successful" response that is really an HTML error page.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<html><body>rate limited, please wait a while</body></html>");
    }
    res.writeHead(403);
    res.end("nope");
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
    )
  );
}

test("extractVideoId reads the common YouTube link shapes", () => {
  assert.equal(extractVideoId("https://youtu.be/gset79KMmt0"), "gset79KMmt0");
  assert.equal(extractVideoId("https://www.youtube.com/watch?v=gset79KMmt0&t=5"), "gset79KMmt0");
  assert.equal(extractVideoId("https://youtube.com/shorts/gset79KMmt0"), "gset79KMmt0");
  assert.equal(extractVideoId("faded alan walker"), null);
});

test("isLikelyAudio accepts audio magic numbers and rejects HTML", () => {
  assert.equal(isLikelyAudio(MP3), true);
  assert.equal(isLikelyAudio(Buffer.from("<html>not audio at all</html>")), false);
});

test("falls through failing and fake-audio sources to the first real one", async () => {
  const { server, base } = await startServer();
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "play-test-"));
    const out = path.join(dir, "track.source");
    const sources = [
      { name: "Down", resolve: async () => { throw new Error("returned no download link"); } },
      { name: "Forbidden", resolve: async () => ({ download: `${base}/missing` }) },
      { name: "ErrorPage", resolve: async () => ({ download: `${base}/error-page` }) },
      { name: "Good", resolve: async () => ({ download: `${base}/good.mp3`, title: "Song" }) },
    ];

    const result = await downloadAudioSource("https://youtu.be/gset79KMmt0", out, sources);
    assert.equal(result.source, "Good");
    assert.equal(result.title, "Song");
    assert.equal(result.extension, "mp3");
    assert.deepEqual(readFileSync(out), MP3);
  } finally {
    server.close();
  }
});

test("reports one line per source when every source fails", async () => {
  const { server, base } = await startServer();
  try {
    const dir = await mkdtemp(path.join(os.tmpdir(), "play-test-"));
    const out = path.join(dir, "track.source");
    const sources = [
      { name: "A", resolve: async () => { throw new Error("returned no download link"); } },
      { name: "B", resolve: async () => ({ download: `${base}/error-page` }) },
      { name: "C", resolve: async () => ({ download: `${base}/missing` }) },
    ];

    await assert.rejects(
      () => downloadAudioSource("https://youtu.be/gset79KMmt0", out, sources),
      (err) => {
        assert.equal(err.code, "DOWNLOAD_FAILED");
        assert.match(err.message, /• A: returned no download link/);
        assert.match(err.message, /• B: returned a page instead of audio/);
        assert.match(err.message, /• C: HTTP 403/);
        return true;
      }
    );
  } finally {
    server.close();
  }
});
