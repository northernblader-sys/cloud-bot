// Offline tests for utils/trackCard.js — the .play metadata card
// (cover art + name/artist/album/duration composited with sharp).
// No network: covers are generated locally.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const sharp = require("sharp");
const {
  buildTrackCard,
  formatDuration,
  truncate,
  escapeXml,
  cleanDisplay,
  CARD_SIZE,
} = require(path.join(__dirname, "..", "utils", "trackCard.js"));

/** A deterministic test cover: 600x600 with two solid halves. */
async function fakeCover() {
  return sharp({
    create: { width: 600, height: 600, channels: 3, background: "#3355aa" },
  })
    .png()
    .toBuffer();
}

/**
 * True when the region contains near-white pixels (all channels bright).
 * This is text-proof: gradients, covers and scrims are never near-white,
 * so only actually-rendered glyphs (fill #ffffff / #e6e6e6) can pass.
 * (An earlier version of this check used plain contrast and silently
 * passed when the whole SVG overlay was accidentally inside <defs>.)
 */
async function hasWhitePixels(png, { left, top, width, height }, min = 190) {
  const { data, info } = await sharp(png)
    .extract({ left, top, width, height })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i + ch - 1 < data.length; i += ch) {
    if (data[i] > min && data[i + 1] > min && data[i + 2] > min) return true;
  }
  return false;
}

test("formatDuration renders m:ss and h:mm:ss", () => {
  assert.equal(formatDuration(285935), "4:46"); // iTunes' Love in the Dark
  assert.equal(formatDuration(60000), "1:00");
  assert.equal(formatDuration(3661000), "1:01:01");
  assert.equal(formatDuration(0), "");
  assert.equal(formatDuration(undefined), "");
  assert.equal(formatDuration(-5), "");
});

test("truncate clips on a word boundary with an ellipsis", () => {
  assert.equal(truncate("short", 10), "short");
  assert.equal(truncate("Adele Love In The Dark Official Video", 26), "Adele Love In The Dark…");
  assert.equal(truncate("Adele Love In The Dark Official Video", 22), "Adele Love In The…");
  assert.equal(truncate("", 10), "");
  assert.equal(truncate(null, 10), "");
});

test("escapeXml makes strings SVG-safe", () => {
  assert.equal(escapeXml('a<b>&"c"'), "a&lt;b&gt;&amp;&quot;c&quot;");
  assert.equal(escapeXml("it's"), "it&apos;s");
});

test("cleanDisplay strips YouTube junk parentheses for display", () => {
  assert.equal(cleanDisplay("Song (Official Video)"), "Song");
  assert.equal(cleanDisplay("Song [Official Audio] 4K"), "Song 4K");
  assert.equal(cleanDisplay("Song (Lyrics)"), "Song");
  assert.equal(cleanDisplay("Love In The Dark"), "Love In The Dark");
});

test("buildTrackCard composites metadata over the cover", async () => {
  const png = await buildTrackCard({
    title: "Love In The Dark",
    artist: "Adele",
    album: "25",
    durationMs: 285935,
    cover: await fakeCover(),
  });
  const meta = await sharp(png).metadata();
  assert.equal(meta.format, "png");
  assert.equal(meta.width, CARD_SIZE);
  assert.equal(meta.height, CARD_SIZE);

  // The text must have actually rendered (not just the scrim gradient):
  // white glyphs in the title line and the meta line regions.
  const barTop = CARD_SIZE - 190;
  assert.ok(
    await hasWhitePixels(png, { left: 25, top: barTop + 35, width: 400, height: 45 }),
    "white title glyphs present"
  );
  assert.ok(
    await hasWhitePixels(png, { left: 25, top: CARD_SIZE - 65, width: 400, height: 45 }, 170),
    "meta line glyphs present"
  );
});

test("buildTrackCard works without cover art (fallback background + ♪)", async () => {
  const png = await buildTrackCard({ title: "Mystery Track", artist: "Unknown", durationMs: 200000 });
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, CARD_SIZE);
  assert.equal(meta.height, CARD_SIZE);
  // Title text drawn, centered layout (no scrim bar to hide in).
  assert.ok(
    await hasWhitePixels(png, { left: 25, top: CARD_SIZE / 2 - 50, width: 500, height: 60 }),
    "white title glyphs present"
  );
});

test("buildTrackCard requires a title and handles hostile text", async () => {
  await assert.rejects(() => buildTrackCard({}), /title is required/);
  // XML-hostile characters must not break the SVG render.
  const png = await buildTrackCard({
    title: 'Weird <Title> & "Stuff"',
    artist: "A&B <Artists>",
    cover: await fakeCover(),
  });
  const meta = await sharp(png).metadata();
  assert.equal(meta.width, CARD_SIZE);
});
