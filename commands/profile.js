const { extractTargetJid } = require("../utils/targetJid");
const { isTrusted } = require("../utils/trustedUsers");
const { isOwnerJid } = require("../utils/owner");
const {
  normJid,
  aliasesOf,
  intersects,
  botAliases,
  getGroupMetadata,
  findParticipant,
} = require("../utils/groupPermissions");

function bareUser(jid) {
  return normJid(jid).split("@")[0];
}

function isLidJid(jid) {
  const n = normJid(jid);
  return n.endsWith("@lid") || n.endsWith("@hosted.lid");
}

function isPnJid(jid) {
  const n = normJid(jid);
  return n.endsWith("@s.whatsapp.net") || n.endsWith("@c.us") || n.endsWith("@hosted");
}

function toPnJid(jid) {
  const digits = bareUser(jid).replace(/\D/g, "");
  return digits ? `${digits}@s.whatsapp.net` : "";
}

function toLidJid(jid) {
  const digits = bareUser(jid).replace(/\D/g, "");
  return digits ? `${digits}@lid` : "";
}

/**
 * Resolves a user's WhatsApp LID, UID (PN JID), phone number, and username/display
 * name from the incoming message, group metadata, Baileys LID mapping store, and USync.
 */
async function resolveProfileIdentity(sock, msg, argText) {
  const chatJid = msg?.key?.remoteJid || "";
  const isGroup = chatJid.endsWith("@g.us");

  const senderCandidates = isGroup
    ? [
        msg?.key?.participant,
        msg?.key?.participantAlt,
        msg?.key?.participantPn,
        msg?.participant,
        msg?.participantPn,
        msg?.key?.participantLid,
      ]
    : [
        msg?.key?.remoteJid,
        msg?.key?.remoteJidAlt,
        msg?.key?.participant,
        msg?.key?.participantAlt,
        msg?.key?.participantPn,
        msg?.participant,
        msg?.participantPn,
      ];

  const senderJid = msg?.key?.participant || msg?.key?.remoteJid || "";
  const explicitTarget = extractTargetJid(msg, argText);
  const senderSet = aliasesOf(senderCandidates);
  const isSelfTarget = !explicitTarget || intersects(aliasesOf(explicitTarget), senderSet);
  const initialTargetJid = explicitTarget || senderJid;

  let pnJid = "";
  let lidJid = "";
  let pushName = "";
  let waUsername = "";

  const recordJid = (candidate) => {
    if (!candidate || typeof candidate !== "string") return;
    if (isLidJid(candidate) && !lidJid) {
      lidJid = toLidJid(candidate);
    } else if (isPnJid(candidate) && !pnJid) {
      pnJid = toPnJid(candidate);
    }
  };

  if (isSelfTarget) {
    for (const c of senderCandidates) recordJid(c);
    pushName = (msg?.pushName || msg?.verifiedBizName || "").trim();
    waUsername = (
      (isGroup ? msg?.key?.participantUsername : msg?.key?.remoteJidUsername) ||
      msg?.key?.participantUsername ||
      msg?.key?.remoteJidUsername ||
      msg?.username ||
      ""
    ).trim();
  } else {
    recordJid(explicitTarget);
    const ctx = msg?.message?.extendedTextMessage?.contextInfo;
    if (ctx && ctx.participant === explicitTarget) {
      recordJid(ctx.participantAlt);
      recordJid(ctx.participantPn);
      if (ctx.participantUsername && !waUsername) {
        waUsername = String(ctx.participantUsername).trim();
      }
    }
  }

  // 1) Group metadata lookup (provides { id, lid, phoneNumber, username } in Baileys v7).
  if (isGroup && typeof sock?.groupMetadata === "function") {
    try {
      const metadata = await getGroupMetadata(sock, chatJid);
      const participant = metadata
        ? findParticipant(metadata, [initialTargetJid, pnJid, lidJid])
        : null;
      if (participant) {
        recordJid(participant.id);
        recordJid(participant.lid);
        recordJid(participant.phoneNumber);
        if (!waUsername && participant.username) {
          waUsername = String(participant.username).trim();
        }
        if (!pushName && (participant.notify || participant.name || participant.verifiedName)) {
          pushName = String(
            participant.notify || participant.name || participant.verifiedName
          ).trim();
        }
      }
      if (
        metadata &&
        intersects(
          aliasesOf(initialTargetJid, pnJid, lidJid),
          aliasesOf(metadata.owner, metadata.ownerPn)
        )
      ) {
        recordJid(metadata.owner);
        recordJid(metadata.ownerPn);
        if (!waUsername && metadata.ownerUsername) {
          waUsername = String(metadata.ownerUsername).trim();
        }
      }
    } catch {
      // group metadata unavailable — continue with other sources
    }
  }

  // 2) If target is the bot itself, check sock.user / creds.me.
  const botSet = botAliases(sock || {});
  if (botSet.size && intersects(aliasesOf(initialTargetJid, pnJid, lidJid), botSet)) {
    recordJid(sock?.user?.id);
    recordJid(sock?.user?.lid);
    recordJid(sock?.authState?.creds?.me?.id);
    recordJid(sock?.authState?.creds?.me?.lid);
    if (!pushName) {
      pushName = String(sock?.user?.name || sock?.authState?.creds?.me?.name || "").trim();
    }
  }

  // 3) Baileys v7 signalRepository.lidMapping (maps PN <-> LID via cache, key store, or USync).
  const lidMapping = sock?.signalRepository?.lidMapping;
  if (pnJid && !lidJid && typeof lidMapping?.getLIDForPN === "function") {
    try {
      const mappedLid = await lidMapping.getLIDForPN(pnJid);
      if (mappedLid) recordJid(mappedLid);
    } catch {
      // ignore mapping lookup error
    }
  }
  if (lidJid && !pnJid && typeof lidMapping?.getPNForLID === "function") {
    try {
      const mappedPn = await lidMapping.getPNForLID(lidJid);
      if (mappedPn) recordJid(mappedPn);
    } catch {
      // ignore reverse mapping lookup error
    }
  }

  // 4) USync query for LID and/or WhatsApp @username when executeUSyncQuery is available.
  if ((!lidJid || !waUsername) && typeof sock?.executeUSyncQuery === "function") {
    try {
      const { USyncQuery, USyncUser } = require("@whiskeysockets/baileys");
      const queryJid = pnJid || lidJid || normJid(initialTargetJid);
      if (queryJid && USyncQuery && USyncUser) {
        const user = new USyncUser().withId(queryJid);
        if (lidJid) user.withLid(lidJid);
        const usyncQuery = new USyncQuery()
          .withLIDProtocol()
          .withUsernameProtocol()
          .withUser(user);
        const usyncRes = await sock.executeUSyncQuery(usyncQuery);
        const item = usyncRes?.list?.[0];
        if (item) {
          recordJid(item.id);
          if (item.lid) {
            recordJid(String(item.lid).includes("@") ? String(item.lid) : `${item.lid}@lid`);
          }
          if (!waUsername && typeof item.username === "string" && item.username.trim()) {
            waUsername = item.username.trim();
          }
        }
      }
    } catch {
      // USync not supported or failed — continue
    }
  }

  // 5) Check configured owner env vars if one side matches the owner.
  const ownerNumber = (process.env.OWNER_NUMBERS || "").replace(/\D/g, "");
  const ownerLid = (process.env.OWNER_LID || "").replace(/\D/g, "");
  if (ownerNumber && ownerLid) {
    if (pnJid && bareUser(pnJid) === ownerNumber && !lidJid) {
      lidJid = `${ownerLid}@lid`;
    } else if (lidJid && bareUser(lidJid) === ownerLid && !pnJid) {
      pnJid = `${ownerNumber}@s.whatsapp.net`;
    }
  }

  // 6) Fallback to saved displayName in cloudMemory when targeting another user.
  if (!pushName) {
    try {
      const memory = require("../utils/cloudMemory");
      const person =
        memory.getPerson(bareUser(pnJid)) ||
        memory.getPerson(bareUser(lidJid)) ||
        memory.getPerson(bareUser(initialTargetJid));
      if (person?.displayName || person?.name) {
        pushName = String(person.displayName || person.name).trim();
      }
    } catch {
      // cloudMemory optional
    }
  }

  return {
    initialTargetJid: normJid(initialTargetJid),
    pnJid,
    lidJid,
    pushName,
    waUsername: waUsername.replace(/^@+/, ""),
  };
}

/**
 * .me / .info — shows a user's WhatsApp username, phone number, UID, LID,
 * bio, current profile picture, and a trusted/owner badge. Targets the
 * sender by default, or whoever is mentioned/replied-to.
 */
async function showProfile(sock, msg, argText) {
  const { initialTargetJid, pnJid, lidJid, pushName, waUsername } =
    await resolveProfileIdentity(sock, msg, argText);

  const queryJids = [...new Set([pnJid, initialTargetJid, lidJid].filter(Boolean))];

  let bio = "No bio set.";
  if (typeof sock?.fetchStatus === "function") {
    for (const jid of queryJids) {
      try {
        // Baileys v7 fetchStatus() returns an array [{ id, status: { status, setAt } }];
        // older versions returned { list: [...] } or { status: "..." }.
        const result = await sock.fetchStatus(jid);
        const first = Array.isArray(result) ? result[0] : result?.list?.[0] || result;
        const statusText =
          typeof first?.status === "string" ? first.status : first?.status?.status;
        if (statusText) {
          bio = statusText;
          break;
        }
      } catch {
        // try next candidate JID
      }
    }
  }

  let ppUrl = null;
  if (typeof sock?.profilePictureUrl === "function") {
    for (const jid of queryJids) {
      try {
        ppUrl = await sock.profilePictureUrl(jid, "image");
        if (ppUrl) break;
      } catch {
        // no profile picture set, or privacy settings block it
      }
    }
  }

  let badge = "";
  if (queryJids.some((jid) => isOwnerJid(jid))) badge = "👑 Owner";
  else if (queryJids.some((jid) => isTrusted(jid))) badge = "✅ Trusted";

  const numberDigits = pnJid ? bareUser(pnJid) : "";
  const displayName =
    pushName ||
    (waUsername ? `@${waUsername}` : "") ||
    numberDigits ||
    bareUser(initialTargetJid) ||
    "Unknown";

  let usernameDisplay = "Unknown";
  if (pushName && waUsername) {
    usernameDisplay =
      pushName.toLowerCase() === waUsername.toLowerCase()
        ? `@${waUsername}`
        : `${pushName} (@${waUsername})`;
  } else if (waUsername) {
    usernameDisplay = `@${waUsername}`;
  } else if (pushName) {
    usernameDisplay = pushName;
  }

  const numberDisplay = numberDigits ? `+${numberDigits}` : "Unavailable";
  const uidDisplay = pnJid || initialTargetJid || "Unavailable";
  const lidDisplay = lidJid || "Unavailable";

  const caption =
    `👤 *${displayName}*\n` +
    `━━━━━━━━━━━━━━━━━━━━\n` +
    (badge ? `${badge}\n` : "") +
    `🏷️ *Username:* ${usernameDisplay}\n` +
    `📞 *Number:* ${numberDisplay}\n` +
    `🆔 *UID:* ${uidDisplay}\n` +
    `🔗 *LID:* ${lidDisplay}\n` +
    `📝 *Bio:* ${bio}`;

  const mentionJid = pnJid || initialTargetJid || lidJid;

  return {
    image: ppUrl ? { url: ppUrl } : null,
    caption,
    mentions: mentionJid ? [mentionJid] : [],
  };
}

module.exports = { showProfile, resolveProfileIdentity };
