const { getSettings } = require("../utils/groupSettings");
const { detectViolation } = require("../utils/violationDetector");
const { recordAndCheckSpam } = require("../utils/spamTracker");
const {
  getGroupMetadata,
  findParticipant,
  isParticipantAdmin,
  botAliases,
} = require("../utils/groupPermissions");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

// Burst protection: once someone has been actioned, further messages from
// them in the next 30s are only deleted (no second kick, no second notice).
const recentlyActioned = new Map(); // `${group}:${user}` -> timestamp
const ACTION_COOLDOWN_MS = 30_000;

function bare(jid) {
  return (jid || "").split("@")[0].split(":")[0];
}

/**
 * Runs on every group message. Returns true if the message was actioned
 * (deleted/kicked) and should stop further processing (e.g. command routing).
 */
async function groupGuard(sock, msg) {
  const groupJid = msg.key.remoteJid;
  if (!groupJid?.endsWith("@g.us")) return false;

  const senderJid = msg.key.participant;
  if (!senderJid) return false;
  const senderJids = [senderJid, msg.key.participantAlt];

  // 1) Cheap checks first (no network). Most messages are clean and stop here,
  //    so we don't hit WhatsApp for group metadata on every single message.
  const settings = getSettings(groupJid);
  const violation = detectViolation(msg.message, settings);
  const isSpam = settings.antispam && recordAndCheckSpam(groupJid, senderJid);
  const finalViolation =
    violation || (isSpam ? { type: "antispam", reason: "spamming messages" } : null);
  if (!finalViolation) return false;

  // 2) Only now look at who's who.
  const metadata = await getGroupMetadata(sock, groupJid);
  if (isParticipantAdmin(metadata, senderJids)) return false; // never moderate admins

  const botIsAdmin = isParticipantAdmin(metadata, [...botAliases(sock)]);
  if (!botIsAdmin) return false; // can't enforce without admin rights

  const target = findParticipant(metadata, senderJids);
  const targetJid = target?.id || senderJid; // use the id form the group itself uses
  const mentionJid = target?.phoneNumber || msg.key.participantAlt || targetJid;

  const cooldownKey = `${groupJid}:${bare(targetJid)}`;
  const alreadyActioned = Date.now() - (recentlyActioned.get(cooldownKey) || 0) < ACTION_COOLDOWN_MS;

  // Delete the offending message (always).
  try {
    await sock.sendMessage(groupJid, { delete: msg.key });
  } catch (err) {
    console.error("Failed to delete message:", err.message || err);
  }
  if (alreadyActioned) return true;
  recentlyActioned.set(cooldownKey, Date.now());

  // Small human-like gaps between actions so WhatsApp doesn't see a burst of
  // delete + remove + send in the same millisecond.
  await sleep(jitter(400, 900));

  let removed = false;
  try {
    const res = await sock.groupParticipantsUpdate(groupJid, [targetJid], "remove");
    removed = !res || res.every?.((r) => !r.status || String(r.status).startsWith("2"));
  } catch (err) {
    console.error("Failed to remove participant:", err.message || err);
  }

  await sleep(jitter(300, 700));

  try {
    const tag = `@${bare(mentionJid)}`;
    await sock.sendMessage(groupJid, {
      text: removed
        ? `🚫 *${finalViolation.type}*\n${tag} was removed for ${finalViolation.reason}.`
        : `🚫 *${finalViolation.type}*\n${tag} — message deleted for ${finalViolation.reason}.`,
      mentions: [mentionJid],
    });
  } catch (err) {
    console.error("Failed to send moderation notice:", err.message || err);
  }

  return true;
}

module.exports = { groupGuard };
