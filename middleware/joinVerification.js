const { getSettings } = require("../utils/groupSettings");
const {
  isParticipantAdmin,
  findParticipant,
  getGroupMetadata,
  botAliases,
  aliasesOf,
  intersects,
} = require("../utils/groupPermissions");
const { addPending, getPending, removePending } = require("../utils/verificationStore");

const VERIFY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function randomMathQuestion() {
  const a = Math.floor(Math.random() * 8) + 1; // 1-8
  const b = Math.floor(Math.random() * 8) + 1; // 1-8
  return { a, b, answer: a + b };
}

function bareDigits(jid) {
  return (jid || "").split("@")[0].split(":")[0];
}

function mention(jid) {
  return `@${bareDigits(jid)}`;
}

// Tagging a raw @lid doesn't render as a real mention, so prefer the phone jid.
// In Baileys v7 the join event hands us a participant object that usually
// already carries both ids; fall back to group metadata if it doesn't.
async function resolveTaggableJid(sock, groupJid, participant) {
  const p = typeof participant === "string" ? { id: participant } : participant;
  if (p.phoneNumber?.endsWith("@s.whatsapp.net")) return p.phoneNumber;
  if (p.id && !p.id.endsWith("@lid")) return p.id;

  try {
    const metadata = await getGroupMetadata(sock, groupJid);
    const found = findParticipant(metadata, p);
    if (found?.phoneNumber?.endsWith("@s.whatsapp.net")) return found.phoneNumber;
  } catch (err) {
    console.error("resolveTaggableJid: metadata lookup failed:", err.message || err);
  }
  return p.id;
}

/**
 * Called from the group-participants.update event when someone joins.
 * `participant` is a Baileys v7 participant object ({ id, lid, phoneNumber })
 * or, for older versions, a plain jid string.
 */
async function startVerification(sock, groupJid, participant) {
  const p = typeof participant === "string" ? { id: participant } : participant;
  if (!p?.id) return;

  const settings = getSettings(groupJid);
  if (!settings.welcome) return;

  // Never challenge the bot itself (e.g. when it is added to a group).
  if (intersects(aliasesOf(p), botAliases(sock))) return;

  const metadata = await getGroupMetadata(sock, groupJid, { fresh: true }).catch(() => null);
  const botAdmin = metadata ? isParticipantAdmin(metadata, [...botAliases(sock)]) : false;

  const taggableJid = await resolveTaggableJid(sock, groupJid, p);
  const { a, b, answer } = randomMathQuestion();

  const timeout = setTimeout(async () => {
    const entry = getPending(groupJid, p);
    if (!entry || entry.stage !== "math") return; // already verified or cleared
    removePending(groupJid, p);

    try {
      if (botAdmin) {
        await sock.groupParticipantsUpdate(groupJid, [p.id], "remove");
        await sock.sendMessage(groupJid, {
          text: `⏱️ ${mention(taggableJid)} didn't complete verification in time and was removed.`,
          mentions: [taggableJid],
        });
      } else {
        await sock.sendMessage(groupJid, {
          text: `⏱️ ${mention(taggableJid)} didn't complete verification in time, but I'm not an admin here so I can't remove them.`,
          mentions: [taggableJid],
        });
      }
    } catch (err) {
      console.error("verification timeout action failed:", err.message || err);
    }
  }, VERIFY_TIMEOUT_MS);

  addPending(groupJid, p, { answer, stage: "math", timeout });

  // Tiny delay so the join notification lands before our message.
  await sleep(1200);

  await sock.sendMessage(groupJid, {
    text:
      `👋 Welcome ${mention(taggableJid)}!\n\n` +
      `To make sure you're human, please solve: *${a} + ${b} = ?*\n` +
      `Just reply with the number. You have 5 minutes.`,
    mentions: [taggableJid],
  });
}

/**
 * Called on every group message before command routing. Checks if the
 * sender has a pending verification and processes their reply if so.
 * Returns true if the message was consumed as a verification answer.
 */
async function checkVerificationReply(sock, msg, text) {
  const groupJid = msg.key.remoteJid;
  if (!groupJid?.endsWith("@g.us")) return false;

  const senderJids = [msg.key.participant, msg.key.participantAlt];
  const entry = getPending(groupJid, senderJids);
  if (!entry) return false;

  const sender = { id: msg.key.participant, phoneNumber: msg.key.participantAlt };
  const taggableJid = await resolveTaggableJid(sock, groupJid, sender);

  if (entry.stage === "math") {
    const num = Number((text || "").trim().match(/-?\d+/)?.[0]);

    if (!Number.isNaN(num) && num === entry.answer) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
      entry.stage = "profile"; // keep entry, no further kick risk

      await sock.sendMessage(groupJid, {
        text:
          `✅ ${mention(taggableJid)} verified, welcome aboard!\n\n` +
          `While you're here, tell us a bit about yourself:\n` +
          `• Your name\n` +
          `• Your age\n` +
          `• Best anime\n` +
          `• Worst anime\n` +
          `• Year you started watching anime`,
        mentions: [taggableJid],
      });
      return true;
    }

    // wrong answer — ignore and let them keep trying until the timeout fires
    return false;
  }

  if (entry.stage === "profile") {
    // Profile step is informational only — just acknowledge and clear.
    await sock.sendMessage(groupJid, {
      text: `🎉 Thanks for sharing, ${mention(taggableJid)}! Enjoy the group.`,
      mentions: [taggableJid],
    });
    removePending(groupJid, senderJids);
    return true;
  }

  return false;
}

module.exports = { startVerification, checkVerificationReply };
