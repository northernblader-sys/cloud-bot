// Detects rule violations. Works on the *unwrapped* message so disappearing
// messages, view-once and document-caption wrappers can't be used to dodge it.
// Returns { type, reason } if a violation is found, or null if clean.

const { unwrap, textOf } = require("./extractText");

// Explicit links, known invite/shortener hosts, plus bare domains on a short
// list of link-y TLDs (e.g. "example.com/abc"). Short TLDs like .me/.co/.ng
// are deliberately left out because sentences like "ok.me" would false-positive
// and the penalty here is a kick.
const LINK_REGEX = new RegExp(
  [
    "(?:https?:\\/\\/|www\\.)\\S+",
    "(?:chat\\.whatsapp\\.com|wa\\.me|whatsapp\\.com\\/channel|t\\.me|discord\\.gg|bit\\.ly|tinyurl\\.com)\\/?\\S*",
    "\\b[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|net|org|xyz|info|link|site|online|app|club|shop|store|live|vip|top)\\b(?:\\/\\S*)?",
  ].join("|"),
  "i"
);

// Zero-width / formatting characters people use to break up a link.
const INVISIBLES = /[\u200B-\u200F\u202A-\u202E\u2060\uFEFF]/g;

function contextInfoOf(content) {
  // Every message type carries its own contextInfo; grab whichever exists.
  for (const key of Object.keys(content)) {
    const ci = content[key]?.contextInfo;
    if (ci) return ci;
  }
  return content.contextInfo || null;
}

function detectLink(content) {
  const text = textOf(content).replace(INVISIBLES, "");
  if (LINK_REGEX.test(text)) return true;
  // WhatsApp's own link-preview match, even if the text was reformatted.
  const matched = content.extendedTextMessage?.matchedText;
  return !!(matched && LINK_REGEX.test(matched));
}

function detectChannelForward(content) {
  const ci = contextInfoOf(content);
  return !!(ci?.forwardedNewsletterMessageInfo || ci?.forwardedNewsletterMessageInfo?.newsletterJid);
}

// Modern WhatsApp reports "this status mentions the group" in a few shapes:
//   - message.groupStatusMentionMessage   (what groups receive today)
//   - message.statusMentionMessage        (older shape)
//   - protocolMessage.type === 25         (STATUS_MENTION_MESSAGE)
function detectStatusMention(content) {
  if (content.groupStatusMentionMessage || content.statusMentionMessage) return true;
  if (content.protocolMessage?.type === 25) return true;
  return false;
}

function detectViolation(message, settings) {
  const content = unwrap(message);
  if (!content) return null;

  if (settings.antistatus && detectStatusMention(content)) {
    return { type: "antistatus", reason: "sharing a Status update to the group" };
  }
  if (settings.antichannel && detectChannelForward(content)) {
    return { type: "antichannel", reason: "forwarding a WhatsApp Channel post" };
  }
  if (settings.antilink && detectLink(content)) {
    return { type: "antilink", reason: "posting a link" };
  }
  return null;
}

module.exports = { detectViolation, detectLink, detectChannelForward, detectStatusMention };
