const fs = require("fs")
const path = require("path")
const { pipeline } = require("stream/promises")
const { Readable } = require("stream")

// Tulsi media API — override with TULSI_API if you ever mirror it.
const TULSI_API = process.env.TULSI_API || "https://tulsi.hidenplay.net"

// Temp files land in tmp/ (gitignored) and are unlinked right after
// WhatsApp uploads them, so the disk never fills up.
const TMP_DIR = path.join(process.cwd(), "tmp")

async function ensureTmpDir() {
  await fs.promises.mkdir(TMP_DIR, { recursive: true }).catch(() => {})
}

function tempFile() {
  return path.join(TMP_DIR, `${Date.now()}.tmp`)
}

/**
 * Downloads media through the Tulsi API and saves it to a temp file.
 * params are passed straight through as query params, e.g.
 *   { type: 'audio', audio_format: 'mp3' }
 *   { quality: 720, container: 'mp4' }
 */
async function download(url, params = {}) {
  await ensureTmpDir()
  const q = new URLSearchParams({ url, ...params })
  const res = await fetch(`${TULSI_API}/api/v1/get?${q}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) || {}
    throw new Error(body.error?.message || `Tulsi API error (${res.status})`)
  }
  const file = tempFile()
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file))
  return file
}

/**
 * Sends a downloaded local file as a WhatsApp message, then deletes it.
 * baileys reads local file paths from `url` and uploads them; awaiting
 * sendMessage means the upload is done before we unlink.
 */
async function sendAndCleanup(sock, from, msg, media, file) {
  try {
    await sock.sendMessage(from, media, { quoted: msg })
    return null
  } catch (err) {
    return err.message || "send failed"
  } finally {
    if (file) {
      try {
        fs.unlinkSync(file)
      } catch {
        // already gone — fine
      }
    }
  }
}

/**
 * .tulsi mp3 <url> — audio extracted as MP3, sent as a WhatsApp audio message.
 */
async function downloadTulsiAudio(sock, msg, argText) {
  const url = (argText || "").trim()
  if (!url) {
    return "📥 *Usage:* .tulsi mp3 <url>\nExample: .tulsi mp3 https://..."
  }
  let file
  try {
    file = await download(url, { type: "audio", audio_format: "mp3" })
    return await sendAndCleanup(sock, msg.key.remoteJid, msg, { audio: { url: file }, mimetype: "audio/mpeg" }, file)
  } catch (err) {
    if (file) fs.unlinkSync(file)
    return `❌ Tulsi MP3 download failed: ${err.message || "unknown error"}`
  }
}

/**
 * .tulsi mp4 <url> — 720p MP4 video, sent as a WhatsApp video message.
 */
async function downloadTulsiVideo(sock, msg, argText) {
  const url = (argText || "").trim()
  if (!url) {
    return "📥 *Usage:* .tulsi mp4 <url>\nExample: .tulsi mp4 https://..."
  }
  let file
  try {
    file = await download(url, { quality: 720, container: "mp4" })
    return await sendAndCleanup(sock, msg.key.remoteJid, msg, { video: { url: file }, caption: "Done" }, file)
  } catch (err) {
    if (file) fs.unlinkSync(file)
    return `❌ Tulsi video download failed: ${err.message || "unknown error"}`
  }
}

/**
 * .tulsi <mp3|mp4> <url>
 */
async function downloadTulsi(sock, msg, argText) {
  const parts = (argText || "").trim().split(/\s+/)
  const mode = parts[0] ? parts[0].toLowerCase() : ""
  const url = parts.slice(1).join(" ")

  if (mode === "mp3" || mode === "audio") return downloadTulsiAudio(sock, msg, url)
  if (mode === "mp4" || mode === "video") return downloadTulsiVideo(sock, msg, url)

  return "📥 *Usage:* .tulsi <mp3|mp4> <url>\n" +
    "• .tulsi mp3 <link> — audio as MP3\n" +
    "• .tulsi mp4 <link> — 720p video as MP4"
}

module.exports = { downloadTulsi, downloadTulsiAudio, downloadTulsiVideo }
