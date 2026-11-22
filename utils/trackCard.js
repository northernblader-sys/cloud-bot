"use strict";

/**
 * trackCard — the ".play" metadata card.
 *
 * Before the audio, the bot sends ONE image: the track's cover art with
 * the real metadata drawn on it (name, artist, album • duration). This
 * is the image the user described: "on the image is the metadata like
 * time and name and artist and other, after that the audio comes".
 *
 * Everything comes from the iTunes Search API (already used for the
 * cover lookup — zero extra YouTube requests). The image itself is
 * composited with sharp, which is already a dependency: the cover is
 * the base, and an SVG overlay paints a translucent gradient plus the
 * text. No WhatsApp caption needed — the card IS the caption.
 *
 * Fonts: librsvg (sharp's SVG renderer) needs at least one font on the
 * host, and minimal images (Render's Node image, containers) often ship
 * none — text would silently vanish. So `dejavu-fonts-ttf` (a small npm
 * package, BSD-licensed) is bundled and registered through a generated
 * fontconfig file, making the card render identically everywhere.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const sharp = require("sharp");

const CARD_SIZE = 600;
// Where the text block starts / its vertical rhythm.
const BAR_HEIGHT = 190;
const TITLE_SIZE = 40;
const ARTIST_SIZE = 27;
const META_SIZE = 21;

// ── pure helpers (unit-tested) ──────────────────────────────────────────────

/** 285935 -> "4:45"; null/undefined -> "" */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Clip to `max` chars on a word boundary, adding an ellipsis when cut. */
function truncate(text, max) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}

/** Escape a string for inline XML text content and attribute values. */
function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** "  Adele " -> "Adele"; drops YouTube's junk parentheses for display. */
function cleanDisplay(text) {
  return String(text || "")
    .replace(/\((official|lyrics?|audio|video|hd|4k|visualizer|hq)[^)]*\)/gi, "")
    .replace(/\[(official|lyrics?|audio|video|hd|4k)[^\]]*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── font registration (once per process) ────────────────────────────────────

let fontsReady = false;
function ensureBundledFonts() {
  if (fontsReady) return;
  fontsReady = true;
  if (process.env.FONTCONFIG_FILE) return; // host already manages fonts
  let ttfDir;
  try {
    ttfDir = path.dirname(require.resolve("dejavu-fonts-ttf/ttf/DejaVuSans.ttf"));
  } catch {
    return; // package missing — fall back to whatever system fonts exist
  }
  try {
    const confDir = fs.mkdtempSync(path.join(os.tmpdir(), "trackcard-fonts-"));
    const cacheDir = path.join(confDir, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(confDir, "fonts.conf"),
      `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "fonts.dtd">
<fontconfig>
  <dir prefix="default">${ttfDir}</dir>
  <cachedir prefix="default">${cacheDir}</cachedir>
</fontconfig>
`
    );
    process.env.FONTCONFIG_FILE = path.join(confDir, "fonts.conf");
  } catch {
    // A read-only tmp or similar — system fonts (if any) still apply.
  }
}

// ── the SVG overlay ─────────────────────────────────────────────────────────

function overlaySvg({ title, artist, meta, hasCover }) {
  // NOTE: only the gradient lives in <defs> — elements inside <defs>
  // are definitions and are never rendered.
  const defs = [];
  const body = [];
  const barTop = CARD_SIZE - BAR_HEIGHT;
  // Translucent scrim so text reads on any cover.
  defs.push(
    `<linearGradient id="scrim" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="0" stop-color="#000000" stop-opacity="0"/>` +
      `<stop offset="0.45" stop-color="#000000" stop-opacity="0.72"/>` +
      `<stop offset="1" stop-color="#000000" stop-opacity="0.88"/>` +
      `</linearGradient>`
  );
  body.push(
    `<rect x="0" y="${barTop}" width="${CARD_SIZE}" height="${BAR_HEIGHT}" fill="url(#scrim)"/>`
  );

  const titleY = hasCover ? barTop + 64 : CARD_SIZE / 2 - 34;
  const artistY = titleY + 44;
  const metaY = artistY + 34;

  body.push(
    `<text x="30" y="${titleY}" font-family="DejaVu Sans" font-weight="bold" font-size="${TITLE_SIZE}" fill="#ffffff">` +
      `${escapeXml(truncate(cleanDisplay(title), 30))}</text>`
  );
  if (artist) {
    body.push(
      `<text x="30" y="${artistY}" font-family="DejaVu Sans" font-size="${ARTIST_SIZE}" fill="#e6e6e6">` +
        `${escapeXml(truncate(cleanDisplay(artist), 38))}</text>`
    );
  }
  if (meta) {
    body.push(
      `<text x="30" y="${metaY}" font-family="DejaVu Sans" font-size="${META_SIZE}" fill="#b8b8b8">` +
        `${escapeXml(truncate(meta, 52))}</text>`
    );
  }
  if (!hasCover) {
    // No cover art: a centered ♪ above the text so it isn't a plain box.
    body.push(
      `<text x="${CARD_SIZE / 2}" y="150" font-family="DejaVu Sans" font-size="120" fill="#3a3a3a" text-anchor="middle">♪</text>`
    );
  }
  return Buffer.from(
    `<svg width="${CARD_SIZE}" height="${CARD_SIZE}" xmlns="http://www.w3.org/2000/svg">` +
      `<defs>${defs.join("")}</defs>${body.join("")}</svg>`
  );
}

// ── entry point ─────────────────────────────────────────────────────────────

/**
 * Build the metadata card.
 *
 * @param {object} opts
 * @param {string} opts.title        track name (required)
 * @param {string} [opts.artist]
 * @param {string} [opts.album]      shown in the meta line
 * @param {number} [opts.durationMs] shown as m:ss in the meta line
 * @param {Buffer|string} [opts.cover] cover image buffer or file path (optional)
 * @returns {Promise<Buffer>} PNG buffer, 600x600
 */
async function buildTrackCard({ title, artist = "", album = "", durationMs = 0, cover = null } = {}) {
  if (!title) throw new Error("title is required");
  ensureBundledFonts();

  const metaParts = [];
  if (album) metaParts.push(cleanDisplay(album));
  const dur = formatDuration(durationMs);
  if (dur) metaParts.push(dur);

  let base;
  if (cover) {
    // Re-encode the cover to a normalized square PNG — iTunes art is
    // square already; this guards against odd sizes/formats.
    base = await sharp(cover)
      .resize(CARD_SIZE, CARD_SIZE, { fit: "cover" })
      .png()
      .toBuffer();
  } else {
    base = await sharp({
      create: { width: CARD_SIZE, height: CARD_SIZE, channels: 3, background: "#141414" },
    })
      .png()
      .toBuffer();
  }

  const svg = overlaySvg({
    title,
    artist,
    meta: metaParts.join("  •  "),
    hasCover: Boolean(cover),
  });

  return sharp(base).composite([{ input: svg }]).png().toBuffer();
}

module.exports = {
  buildTrackCard,
  formatDuration,
  truncate,
  escapeXml,
  cleanDisplay,
  CARD_SIZE,
};
