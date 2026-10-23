const { normalizeMessageContent } = require("@whiskeysockets/baileys");

// Returns the message body with disappearing-message / view-once / document-
// caption wrappers removed, so text lives at a predictable place no matter how
// the sender's chat is configured.
function unwrap(message) {
  return normalizeMessageContent(message) || message || {};
}

function textOf(content) {
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    content.buttonsResponseMessage?.selectedDisplayText ||
    content.listResponseMessage?.title ||
    ""
  );
}

function extractText(msg) {
  const m = msg?.message;
  if (!m) return "";
  return String(textOf(unwrap(m))).trim();
}

module.exports = { extractText, unwrap, textOf };
