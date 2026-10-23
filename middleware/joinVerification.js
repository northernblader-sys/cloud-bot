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
const animeQuiz = require("../utils/animeQuiz");

const VERIFY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// How many wrong guesses before we stop nudging (they can still keep trying).
const MAX_NUDGES = 2;

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
  // Instead of "2 + 3 = ?" the new member has to answer one anime question,
  // picked at random from 40. Answers are fuzzy-matched, so any recognisable
  // form of the right answer counts (see utils/animeQuiz.js).
  const question = animeQuiz.pickQuestion();

  const timeout = setTimeout(async () => {
    const entry = getPending(groupJid, p);
    if (!entry || entry.stage !== "quiz") return; // already verified or cleared
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

  addPending(groupJid, p, { stage: "quiz", attempts: 0, ...animeQuiz.questionPayload(question), timeout });

  // Tiny delay so the join notification lands before our message.
  await sleep(1200);

  await sock.sendMessage(groupJid, {
    text:
      `👋 Welcome ${mention(taggableJid)}!\n\n` +
      `Answer this to get in — *${question.question}*\n` +
      `_(${question.category})_\n\n` +
      `Any answer that's close enough will do. You have 5 minutes.`,
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

  if (entry.stage === "quiz") {
    const question = animeQuiz.getQuestion(entry.questionId);

    // A question that vanished from the list (renamed id) must never trap
    // someone: accept and move on rather than kicking a real person.
    const correct = question ? animeQuiz.isCorrect(question, text) : true;

    if (correct) {
      clearTimeout(entry.timeout);
      entry.timeout = null;
      entry.stage = "profile"; // keep entry, no further kick risk

      await sock.sendMessage(groupJid, {
        text:
          `✅ ${mention(taggableJid)} got it${entry.attempts ? " in the end" : ""}, welcome aboard!\n\n` +
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

    // Wrong answer: nudge twice, then stay quiet and let the timeout decide.
    entry.attempts = (entry.attempts || 0) + 1;
    if (entry.attempts <= MAX_NUDGES) {
      await sock.sendMessage(groupJid, {
        text: `❌ not quite ${mention(taggableJid)}, try again. you still have time.`,
        mentions: [taggableJid],
      });
    }
    return true; // consumed, so it isn't also parsed as a command
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
