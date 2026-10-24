// ═══════════════════════════════════════════════════════
//   🏰 ASTRAL RPG
//   .start                → create your profile
//   .stats [@user]        → profile / stats card
//   .bal                  → solars + gems
//   .daily                → daily solars + gems
//   .spin                 → spin for Clane (1.5 gems)
//   .clane                → Clane status / info
//   .clane info           → Clane's info card
//   .clane <text>         → talk to her (owner only) 🩸
//   .clane summon/dismiss → battle Blood Siphon on/off
//   .battle @user         → challenge · accept · attack · flee · status
//   .hospital             → Astral Town Hospital (ALL deaths land here)
//   .hospital pay         → pay your bill & get discharged
//   .mansion              → your mansion (5,000,000 solars to buy)
//   .brothel              → Astral Town Brothel (mansion harem waifus)
//   .give                 → owner-only economy grants
//   Game data / prices / odds: utils/rpgData.js
// ═══════════════════════════════════════════════════════
const { isOwnerMessage } = require("../../utils/owner");
const store = require("../../utils/rpgStore");
const {
  IMAGES, STARTER, DAILY, Clane, rollClaneSpin, claneBattleDrains, thirstStage,
  Clane_LINES, BATTLE, attackDamage, xpForNextLevel, hospitalFeeForLevel,
  MANSION, BUTLERS, WAIFUS, parseAmount,
} = require("../../utils/rpgData");

const fmt = (n) => Math.round(n).toLocaleString("en-US");
const fmtGems = (g) => (Math.round(g * 10) / 10).toString();
const roundGems = (g) => Math.round(g * 10) / 10;
const jnum = (jid) => String(jid || "").split("@")[0].split(":")[0];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

function hpBar(p, size = 10) {
  const filled = Math.max(0, Math.min(size, Math.round((p.hp / p.maxHp) * size)));
  return "█".repeat(filled) + "░".repeat(size - filled);
}

function mentionTarget(msg) {
  const ctx = msg.message?.extendedTextMessage?.contextInfo;
  return ctx?.mentionedJid?.[0] || ctx?.participant || null;
}

function locationOf(p) {
  if (store.isInHospital(p)) return "🏥 Astral Town Hospital";
  if (p.mansion?.stayingSince) return "🏰 Your Mansion";
  return "🌆 Astral Town";
}

function hospitalBlockText(p) {
  return (
    `🏥 *You're in Astral Town Hospital!*\n` +
    `💀 Cause: ${p.deathCause || "unknown"}\n` +
    `🧾 Bill to leave: *${fmt(p.hospitalBill)} solars* (your Lv${p.level} fee)\n` +
    `💰 You have: ${fmt(p.solars)} solars\n\n` +
    `Pay with *.hospital pay* to continue your life.\n` +
    `Short on solars? *.daily* still works in here (hospital charity).`
  );
}

function statsCard(p, { viewerIsOwner = false } = {}) {
  const c = p.characters?.clane;
  const m = p.mansion || {};
  const stage = c ? thirstStage(c.thirst) : null;
  const lines = [
    `🏰 *${p.name}* — Lv${p.level} Adventurer`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `❤️ HP: ${fmt(p.hp)}/${fmt(p.maxHp)} [${hpBar(p)}]`,
    `⭐ XP: ${fmt(p.xp)}/${fmt(xpForNextLevel(p.level))}`,
    `⚔️ ATK ${p.atk} · 🛡️ DEF ${p.def} · 💨 SPD ${p.spd}`,
    `💰 Solars: ${fmt(p.solars)} · 💎 Gems: ${fmtGems(p.gems)}`,
    `📍 ${locationOf(p)}`,
    `⚔️ Battles won: ${p.battlesWon || 0} · 💀 Deaths: ${p.deaths || 0} · 🎰 Spins: ${p.spins || 0}`,
  ];
  if (c?.owned) {
    lines.push(
      `🧛‍♀️ *Clane:* owned ${c.summoned ? "(summoned)" : "(dismissed)"} · ❤️ Bond ${c.bond} · 🩸 Thirst: ${stage.label} (${c.thirst})`
    );
  } else {
    lines.push(`🧛‍♀️ *Clane:* not owned — *.spin* to try your luck`);
  }
  if (m.owned) {
    const butlerNames = (m.butlers || [])
      .map((id) => BUTLERS.find((b) => b.id === id)?.name || id).join(", ") || "none";
    const haremNames = (m.harem || [])
      .map((id) => WAIFUS.find((w) => w.id === id)?.name || id).join(", ") || "empty";
    lines.push(
      `🏰 *Mansion:* 🧹 ${m.cleanliness}% clean${m.stayingSince ? " · staying now" : ""}`,
      `🤵 Butlers: ${butlerNames} · 🧎 Servants: ${m.servants || 0}`,
      `💃 Harem (${(m.harem || []).length}/${MANSION.haremMax}): ${haremNames}`
    );
  }
  if (store.isInHospital(p)) lines.push(`\n${hospitalBlockText(p)}`);
  return lines.join("\n");
}

const RPG_HELP =
  `🏰 *Astral RPG*\n` +
  `.start — create your profile (Lv1, ${fmt(STARTER.solars)} solars, ${STARTER.gems} gems)\n` +
  `.stats [@user] — profile card\n` +
  `.bal — solars & gems\n` +
  `.daily — ${fmt(DAILY.solars)} solars + ${DAILY.gems} gems, every 24h\n\n` +
  `🧛‍♀️ *Clane the vampire*\n` +
  `.spin — spin for Clane (${Clane.spin.costGems} gems, roll 1–${Clane.spin.total}: 1–${Clane.spin.deadzoneMax} deadzone, ${Clane.spin.deadzoneMax + 1}+ is a 50/50)\n` +
  `.clane info — her info card\n` +
  `.clane <text> — talk to her (the more you talk, the thirstier she gets for YOUR blood 🩸)\n` +
  `.clane summon / .clane dismiss — her battle Blood Siphon on/off\n` +
  `Battle ability: every turn she sucks ${Clane.battle.opponentDrainPct * 100}% of the opponent's HP and ${Clane.battle.ownerDrainPct * 100}% of yours.\n\n` +
  `⚔️ *Battles*\n` +
  `.battle @user · .battle accept · .battle attack · .battle flee · .battle status\n\n` +
  `🏥 *Astral Town Hospital*\n` +
  `Every death respawns you there. Bill to leave: Lv<30 = 5,000 · Lv30–99 = 50,000 · Lv100 = 400,000 · Lv100+ = 500,000 solars. Pay with .hospital pay\n\n` +
  `🏰 *The Mansion* (${fmt(MANSION.priceSolars)} solars)\n` +
  `.mansion buy · .mansion enter/leave (+${MANSION.statGainPerHour} random stat per hour stayed)\n` +
  `.mansion butlers · .mansion hire butler <name> (${fmt(MANSION.butlerWagePerHourSolars)}/hr, max ${MANSION.maxButlers})\n` +
  `.mansion hire servant [n] · .mansion fire ... · .mansion clean · .mansion harem\n` +
  `.brothel — view/take up to ${MANSION.haremMax} waifus into your mansion harem`;

// ── shared spin logic (.spin and .clane spin) ──────────
function doSpin(p) {
  if (p.gems < Clane.spin.costGems) {
    return {
      error:
        `💎 Not enough gems! A spin costs *${Clane.spin.costGems} gems* and you have ${fmtGems(p.gems)}.\n` +
        `Claim *.daily* for more gems.`,
    };
  }
  p.gems = roundGems(p.gems - Clane.spin.costGems);
  p.spins = (p.spins || 0) + 1;
  const { roll, outcome } = rollClaneSpin();
  const c = p.characters.clane;

  let caption =
    `🎰 *Clane Spin*\n` +
    `🎲 Roll: *${roll} / ${Clane.spin.total}*\n`;

  if (outcome === "deadzone") {
    caption +=
      `💀 *DEADZONE* (1–${Clane.spin.deadzoneMax})… nothing but cobwebs.\n` +
      `💎 Gems left: ${fmtGems(p.gems)}`;
  } else if (outcome === "lost-fifty") {
    caption +=
      `✨ You broke past ${Clane.spin.deadzoneMax} into the *50/50 zone*…\n` +
      `🪙 The coin flip… *FAILED.* Clane slips back into the night. 🧛‍♀️\n` +
      `💎 Gems left: ${fmtGems(p.gems)}`;
  } else if (!c.owned) {
    c.owned = true;
    c.summoned = true;
    caption +=
      `✨ You broke past ${Clane.spin.deadzoneMax} into the *50/50 zone*…\n` +
      `🪙 The coin flip… *WON!!!*\n\n` +
      `🧛‍♀️🩸 *Clane, ${Clane.title}, is YOURS!*\n` +
      `${Clane.ability}\n` +
      `Talk to her with *.clane <text>* — but be warned: the more you talk, the more she craves your blood…`;
  } else {
    p.gems = roundGems(p.gems + Clane.spin.duplicateGemRefund);
    c.bond += 5;
    caption +=
      `✨ *50/50 WON* — but Clane is already yours!\n` +
      `Converted: +${Clane.spin.duplicateGemRefund} gems, ❤️ Bond +5\n` +
      `💎 Gems: ${fmtGems(p.gems)} · ❤️ Bond: ${c.bond}`;
  }
  store.savePlayer(p);
  return { caption };
}

function battleStatusText(playersByJid, battle, extra = "") {
  const a = playersByJid[battle.p1];
  const b = playersByJid[battle.p2];
  return (
    `⚔️ *Battle in Astral!*\n` +
    `@${jnum(battle.p1)} ❤️ ${fmt(Math.max(0, a.hp))}/${fmt(a.maxHp)} [${hpBar(a)}]\n` +
    `@${jnum(battle.p2)} ❤️ ${fmt(Math.max(0, b.hp))}/${fmt(b.maxHp)} [${hpBar(b)}]\n` +
    (extra ? `${extra}\n` : "") +
    `🎯 Turn: @${jnum(battle.turn)} — *.battle attack*`
  );
}

function rewardWinner(winner, loser) {
  winner.solars += BATTLE.winSolars;
  winner.battlesWon = (winner.battlesWon || 0) + 1;
  const levels = store.addXp(winner, BATTLE.winXp);
  store.savePlayer(winner);
  return levels
    ? `🏆 @${jnum(winner.jid)} wins! +${fmt(BATTLE.winSolars)} solars, +${BATTLE.winXp} XP — 🎉 LEVEL UP! Now Lv${winner.level}!`
    : `🏆 @${jnum(winner.jid)} wins! +${fmt(BATTLE.winSolars)} solars, +${BATTLE.winXp} XP`;
}

// ── main dispatcher ────────────────────────────────────
async function handleRpg(sock, msg, command, argText) {
  const chat = msg.key.remoteJid;
  const sender = msg.key.participant || msg.key.remoteJid;
  const pushName = msg.pushName || "there";
  const isGroup = chat.endsWith("@g.us");
  const args = (argText || "").trim() ? argText.trim().split(/\s+/) : [];
  const sub = (args[0] || "").toLowerCase();

  const p = store.getPlayer(sender, pushName);
  const notes = store.takeNotes(sender);
  if (p._isNew) {
    notes.unshift(
      `🌟 *Welcome to the Astral!* Profile created: Lv${STARTER.level}, ${fmt(STARTER.solars)} solars, ${STARTER.gems} gems. Type *.rpg* for the game guide.`
    );
  }
  let notesUsed = false;
  const withNotes = (text) => {
    if (!notes.length || notesUsed) return text;
    notesUsed = true;
    return `${notes.join("\n")}\n━━━━━━━━━━━━━━━━━━━━\n${text}`;
  };

  // Like chess's sendBoard: send the image ourselves, fall back to text.
  const sendImage = async (url, caption, mentions) => {
    const full = withNotes(caption);
    try {
      if (!url) throw new Error("no image");
      await sock.sendMessage(chat, { image: { url }, caption: full, mentions }, { quoted: msg });
    } catch {
      await sock.sendMessage(chat, { text: url ? `${full}\n🔗 ${url}` : full, mentions }, { quoted: msg });
    }
    return null;
  };

  // 🏥 Hospital confinement: while you're a patient you can't live
  // your life until the bill is paid. Info-ish commands still work.
  if (store.isInHospital(p)) {
    const allowedSelf = ["hospital", "daily", "stats", "bal", "balance", "start", "rpg", "give"];
    const allowedClane = command === "clane" && sub === "info";
    if (!allowedSelf.includes(command) && !allowedClane) {
      return { text: withNotes(hospitalBlockText(p)) };
    }
  }

  // ── meta / profile ───────────────────────────────────
  if (command === "rpg") return { text: withNotes(RPG_HELP) };

  if (command === "start") {
    return { text: withNotes(p._isNew ? statsCard(p) : `🏰 You already have a profile!\n\n${statsCard(p)}`) };
  }

  if (command === "stats") {
    const target = mentionTarget(msg);
    if (target && target !== sender) {
      const other = store.peekPlayer(target);
      if (!other) return { text: `⚠️ @${jnum(target)} has no profile yet — tell them to type *.start*`, mentions: [target] };
      return { text: withNotes(statsCard(other)), mentions: [target] };
    }
    return { text: withNotes(statsCard(p)) };
  }

  if (command === "bal" || command === "balance") {
    return {
      text: withNotes(
        `💰 *${p.name}*\nSolars: *${fmt(p.solars)}* ☀️\nGems: *${fmtGems(p.gems)}* 💎` +
          (store.isInHospital(p) ? `\n🧾 Hospital bill: ${fmt(p.hospitalBill)} solars` : "")
      ),
    };
  }

  if (command === "daily") {
    const left = (p.lastDailyAt || 0) + DAILY.cooldownMs - Date.now();
    if (left > 0) {
      const h = Math.floor(left / 3600000);
      const min = Math.ceil((left % 3600000) / 60000);
      return { text: withNotes(`⏳ Daily already claimed. Next in ${h}h ${min}m.`) };
    }
    p.lastDailyAt = Date.now();
    p.solars += DAILY.solars;
    p.gems = roundGems(p.gems + DAILY.gems);
    store.savePlayer(p);
    const flavour = store.isInHospital(p)
      ? `🏥 *Hospital charity daily!*`
      : `☀️ *Daily claimed!*`;
    return {
      text: withNotes(
        `${flavour}\n+${fmt(DAILY.solars)} solars · +${DAILY.gems} gems\n💰 ${fmt(p.solars)} solars · 💎 ${fmtGems(p.gems)} gems` +
          (store.isInHospital(p) ? `\n🧾 Bill: ${fmt(p.hospitalBill)} — *.hospital pay* when you can cover it.` : "")
      ),
    };
  }

  // ── spin ─────────────────────────────────────────────
  if (command === "spin") {
    if (sub && sub !== "clane") {
      return { text: withNotes(`🎰 The only banner right now is *Clane*. Just type *.spin*`) };
    }
    const result = doSpin(p);
    if (result.error) return { text: withNotes(result.error) };
    return sendImage(Clane.images.spin, result.caption);
  }

  // ── Clane ───────────────────────────────────────────
  if (command === "clane") {
    const c = p.characters.clane;

    if (sub === "info") {
      return sendImage(
        Clane.images.info,
        `🧛‍♀️ *Clane — ${Clane.title}*\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🩸 *Ability:* ${Clane.ability}\n\n` +
          `🎰 *How to get her:* *.spin* — ${Clane.spin.costGems} gems per spin, roll 1–${Clane.spin.total}. ` +
          `1–${Clane.spin.deadzoneMax} = deadzone, ${Clane.spin.deadzoneMax + 1}+ = a 50/50 for Clane.\n\n` +
          `💬 *Owners* talk to her with *.clane <text>* (she takes her adult form to chat). ` +
          `But the more you talk, the more she craves your delicious blood… she CAN drink you to death and send you to Astral Town Hospital. 🏥` +
          (c.owned ? `\n\n✅ *You own her.* ❤️ Bond ${c.bond} · 🩸 Thirst: ${thirstStage(c.thirst).label} (${c.thirst}) · ${c.summoned ? "Summoned" : "Dismissed"}` : "")
      );
    }

    if (sub === "spin") {
      const result = doSpin(p);
      if (result.error) return { text: withNotes(result.error) };
      return sendImage(Clane.images.spin, result.caption);
    }

    if (sub === "summon" || sub === "dismiss") {
      if (!c.owned) return { text: withNotes(`🧛‍♀️ You don't own Clane yet. Win her with *.spin*`) };
      c.summoned = sub === "summon";
      store.savePlayer(p);
      return {
        text: withNotes(
          c.summoned
            ? `🧛‍♀️ Clane materialises at your side, fangs bared. In battle she'll suck 30% of your opponent's HP every turn… and 5% of yours. 🩸`
            : `🌙 Clane melts back into shadow. Her Blood Siphon won't trigger in battle (and your neck is safe there).`
        ),
      };
    }

    if (!sub) {
      if (!c.owned) {
        return sendImage(
          Clane.images.info,
          `🧛‍♀️ *Clane — ${Clane.title}*\n${Clane.ability}\n\nYou don't own her yet. *.spin* (${Clane.spin.costGems} gems) for a chance: 1–${Clane.spin.deadzoneMax} deadzone, ${Clane.spin.deadzoneMax + 1}+ is a 50/50.\n*.clane info* for her full card.`
        );
      }
      const stage = thirstStage(c.thirst);
      return sendImage(
        Clane.images.talkAdultForm,
        `🧛‍♀️ *Clane slips into her adult form to see you…*\n` +
          `❤️ Bond: ${c.bond} · 🩸 Thirst: ${stage.label} (${c.thirst}) · ${c.summoned ? "Summoned ⚔️" : "Dismissed 🌙"}\n` +
          `❤️ Your HP: ${fmt(p.hp)}/${fmt(p.maxHp)} [${hpBar(p)}]\n\n` +
          `Talk to her: *.clane <whatever you want to say>*\n` +
          `⚠️ The more you talk, the more she wants your delicious blood…`
      );
    }

    // 💬 talk to her — owner only
    if (!c.owned) {
      return { text: withNotes(`🧛‍♀️ Only Clane's *owner* can talk to her. Win her first with *.spin*`) };
    }
    const said = argText.trim().slice(0, 300);
    c.bond += 1;
    c.thirst += 1;
    c.lastTalkAt = Date.now();
    const stage = thirstStage(c.thirst);
    const line = pick(Clane_LINES[stage.key]).replace(/\{name\}/g, p.name);
    const lines = [
      `🗨️ *You:* ${said}`,
      `🧛‍♀️ *Clane (adult form):* ${line}`,
    ];

    const drain = Math.round(p.maxHp * stage.drinkPctOfMaxHp);
    if (drain > 0) {
      p.hp -= drain;
      lines.push(`${pick(Clane_LINES.drink).replace(/\{name\}/g, p.name)} *−${drain} HP*`);
    }

    if (p.hp <= 0) {
      // She drank you to death while talking → Astral Town Hospital.
      let battleNote = "";
      const inBattle = store.findBattleByPlayer(sender);
      if (inBattle) {
        const oppJid = inBattle.battle.p1 === sender ? inBattle.battle.p2 : inBattle.battle.p1;
        const opp = store.peekPlayer(oppJid);
        store.saveBattle(inBattle.chatId, null);
        if (opp) battleNote = `\n⚔️ Your battle ends — ${rewardWinner(opp, p)}`;
      }
      const bill = store.killPlayer(p, "drained dry by Clane while talking to her 🧛‍♀️🩸");
      lines.push(
        `🧛‍♀️ *Clane:* ${Clane_LINES.drainedToDeath}`,
        ``,
        `💀 *YOU DIED.* Clane sucked away the last of your HP.`,
        `🏥 You wake up in *Astral Town Hospital*. Bill to leave: *${fmt(bill)} solars* (Lv${p.level} fee).${battleNote}`,
        `Pay with *.hospital pay* to continue your life.`
      );
      return sendImage(Clane.images.talkAdultForm, lines.join("\n"));
    }

    store.savePlayer(p);
    lines.push(
      ``,
      `❤️ Bond ${c.bond} · 🩸 Thirst: *${stage.label}* (${c.thirst}) · ❤️ Your HP: ${fmt(p.hp)}/${fmt(p.maxHp)} [${hpBar(p)}]`
    );
    if (stage.key === "thirsty" || stage.key === "ravenous") {
      lines.push(`⚠️ She's losing control… keep talking and she may drink you to death and send you to hospital. Her thirst fades by 1 per hour you leave her alone.`);
    }
    return sendImage(Clane.images.talkAdultForm, lines.join("\n"));
  }

  // ── hospital ─────────────────────────────────────────
  if (command === "hospital") {
    if (sub === "pay" || sub === "discharge" || sub === "leave") {
      if (!store.isInHospital(p)) return { text: withNotes(`🏥 You're not a patient at Astral Town Hospital.`) };
      if (p.solars < p.hospitalBill) {
        return {
          text: withNotes(
            `🧾 *Can't discharge you yet.*\nBill: *${fmt(p.hospitalBill)} solars* · You have: ${fmt(p.solars)} (short ${fmt(p.hospitalBill - p.solars)})\n` +
              `*.daily* works in here (hospital charity) — save up, then *.hospital pay*`
          ),
        };
      }
      const bill = p.hospitalBill;
      p.solars -= bill;
      p.hospitalBill = 0;
      p.status = "alive";
      p.hp = p.maxHp;
      p.deathCause = "";
      p.lastRegenAt = Date.now();
      store.savePlayer(p);
      return sendImage(
        IMAGES.hospital,
        `🏥 *Discharged from Astral Town Hospital!*\n🧾 Paid: ${fmt(bill)} solars · 💰 Left: ${fmt(p.solars)}\n❤️ HP fully restored: ${fmt(p.hp)}/${fmt(p.maxHp)}\n\nWelcome back to your life. Try not to die again. ☀️`
      );
    }

    const feeTable =
      `🧾 *Discharge fees:* Lv<30 = ${fmt(hospitalFeeForLevel(1))} · Lv30–99 = ${fmt(hospitalFeeForLevel(50))} · Lv100 = ${fmt(hospitalFeeForLevel(100))} · Lv100+ = ${fmt(hospitalFeeForLevel(101))} solars`;
    if (store.isInHospital(p)) {
      return sendImage(IMAGES.hospital, `🏥 *Astral Town Hospital*\n${hospitalBlockText(p)}\n\n${feeTable}`);
    }
    return sendImage(
      IMAGES.hospital,
      `🏥 *Astral Town Hospital*\nEvery death in the Astral respawns here. You must pay your bill to leave and continue your life (you're discharged at full HP).\n\n${feeTable}\n\n✅ You're alive and not a patient right now. Your fee would be *${fmt(hospitalFeeForLevel(p.level))} solars* at Lv${p.level}.`
    );
  }

  // ── battle ───────────────────────────────────────────
  if (command === "battle") {
    if (!isGroup) return { text: withNotes(`⚔️ Battles only happen in group chats.`) };
    const battle = store.getBattle(chat);
    const target = mentionTarget(msg);

    if (!sub || sub === "help") {
      if (!target) {
        return {
          text: withNotes(
            `⚔️ *Battle*\n.battle @user — challenge\n.battle accept / .battle decline\n.battle attack — take your turn\n.battle flee — run (pay ${fmt(BATTLE.fleePenaltySolars)} solars, no death)\n.battle status — show HP\n\n💀 Loser at 0 HP dies → Astral Town Hospital. Winner gets ${fmt(BATTLE.winSolars)} solars + ${BATTLE.winXp} XP.` +
              (p.characters.clane.owned && p.characters.clane.summoned ? `\n🧛‍♀️ Your Clane is summoned: she'll suck 30% of the enemy's HP and 5% of yours each of your turns.` : "")
          ),
        };
      }
    }

    // challenge
    if (target && !["accept", "decline", "attack", "hit", "flee", "run", "status"].includes(sub)) {
      if (target === sender) return { text: withNotes(`⚔️ You can't battle yourself.`) };
      if (store.findBattleByPlayer(sender)) return { text: withNotes(`⚔️ You're already in a battle!`) };
      if (store.findBattleByPlayer(target)) return { text: withNotes(`⚔️ @${jnum(target)} is already in a battle.`), mentions: [target] };
      const opponent = store.peekPlayer(target);
      if (!opponent) return { text: withNotes(`⚠️ @${jnum(target)} has no profile yet — they need to type *.start*`), mentions: [target] };
      if (store.isInHospital(opponent)) return { text: withNotes(`🏥 @${jnum(target)} is in Astral Town Hospital and can't fight.`), mentions: [target] };
      store.pendingBattles.set(sender, { target, chat, expiry: Date.now() + BATTLE.challengeMs });
      return {
        text: withNotes(
          `⚔️ *Battle challenge!*\n@${jnum(sender)} (Lv${p.level}) challenges @${jnum(target)} (Lv${opponent.level})!\n@${jnum(target)} type *.battle accept* or *.battle decline*\nExpires in 2 minutes. 💀 Death = Astral Town Hospital.`
        ),
        mentions: [sender, target],
      };
    }

    if (sub === "accept") {
      let challenger = null;
      for (const [chal, info] of store.pendingBattles.entries()) {
        if (info.target === sender && info.chat === chat) { challenger = chal; break; }
      }
      if (!challenger) return { text: withNotes(`⚔️ No pending challenge for you.`) };
      const info = store.pendingBattles.get(challenger);
      store.pendingBattles.delete(challenger);
      if (Date.now() > info.expiry) return { text: withNotes(`⚔️ That challenge expired.`) };
      const foe = store.peekPlayer(challenger);
      if (!foe || store.isInHospital(foe)) return { text: withNotes(`⚔️ Your challenger can't fight right now.`) };
      if (battle) return { text: withNotes(`⚔️ A battle is already running in this chat.`) };
      const newBattle = { p1: challenger, p2: sender, turn: challenger, startedAt: Date.now() };
      store.saveBattle(chat, newBattle);
      const claneNotes = [foe, p]
        .filter((x) => x.characters?.clane?.owned && x.characters.clane.summoned)
        .map((x) => `🧛‍♀️ @${jnum(x.jid)}'s *Clane* is summoned — 30% enemy HP + 5% owner HP drained every turn!`)
        .join("\n");
      return {
        text: withNotes(battleStatusText({ [challenger]: foe, [sender]: p }, newBattle, claneNotes)),
        mentions: [challenger, sender],
      };
    }

    if (sub === "decline") {
      for (const [chal, info] of store.pendingBattles.entries()) {
        if (info.target === sender && info.chat === chat) {
          store.pendingBattles.delete(chal);
          return { text: withNotes(`⚔️ @${jnum(sender)} declined the battle.`), mentions: [sender] };
        }
      }
      return { text: withNotes(`⚔️ No pending challenge for you.`) };
    }

    if (!battle) return { text: withNotes(`⚔️ No active battle here. Challenge with *.battle @user*`) };
    if (battle.p1 !== sender && battle.p2 !== sender) return { text: withNotes(`⚔️ You're not in this battle.`) };
    const oppJid = battle.p1 === sender ? battle.p2 : battle.p1;
    const opp = store.peekPlayer(oppJid);
    if (!opp) { store.saveBattle(chat, null); return { text: withNotes(`⚔️ Battle ended (opponent profile missing).`) }; }

    if (sub === "status") {
      return { text: withNotes(battleStatusText({ [sender]: p, [oppJid]: opp }, battle)), mentions: [battle.p1, battle.p2] };
    }

    if (sub === "flee" || sub === "run") {
      const penalty = Math.min(p.solars, BATTLE.fleePenaltySolars);
      p.solars -= penalty;
      store.saveBattle(chat, null);
      store.savePlayer(p);
      return {
        text: withNotes(`🏃 @${jnum(sender)} fled the battle! −${fmt(penalty)} solars. No death, no hospital… this time.`),
        mentions: [sender, oppJid],
      };
    }

    if (sub === "attack" || sub === "hit") {
      if (battle.turn !== sender) return { text: withNotes(`⚔️ It's not your turn — @${jnum(battle.turn)} moves.`), mentions: [battle.turn] };
      const lines = [`⚔️ *@${jnum(sender)}'s turn*`];

      // 🧛‍♀️ Clane's Blood Siphon — every one of her owner's turns.
      const c = p.characters?.clane;
      if (c?.owned && c.summoned) {
        const { opponentDrain, ownerDrain } = claneBattleDrains(p.hp, opp.hp);
        opp.hp -= opponentDrain;
        p.hp -= ownerDrain;
        lines.push(
          `🧛‍♀️🩸 *Clane — Blood Siphon!* She sucks *${opponentDrain} HP* (30%) from @${jnum(oppJid)}… and *${ownerDrain} HP* (5%) from her owner @${jnum(sender)}.`
        );
      }

      const meDead = p.hp <= 0;
      const oppDead = opp.hp <= 0;
      if (meDead || oppDead) {
        store.saveBattle(chat, null);
        if (meDead && oppDead) {
          const myBill = store.killPlayer(p, "drained by his own Clane in battle 🧛‍♀️");
          const oppBill = store.killPlayer(opp, "drained dry by Clane in battle 🧛‍♀️🩸");
          lines.push(
            `💀💀 *BOTH FIGHTERS DROP!* Clane drank them both dry.`,
            `🏥 @${jnum(sender)} → Astral Town Hospital (bill ${fmt(myBill)}) · @${jnum(oppJid)} → Hospital (bill ${fmt(oppBill)})`,
            `No winner. Clane is the only one smiling. 🧛‍♀️`
          );
          return { text: withNotes(lines.join("\n")), mentions: [sender, oppJid] };
        }
        if (oppDead) {
          const bill = store.killPlayer(opp, "drained dry by Clane in battle 🧛‍♀️🩸");
          lines.push(`💀 @${jnum(oppJid)} was drained to death! → 🏥 *Astral Town Hospital* (bill ${fmt(bill)} solars, *.hospital pay*)`);
          lines.push(rewardWinner(p, opp));
        } else {
          const bill = store.killPlayer(p, "his own Clane sucked away the last of his HP in battle 🧛‍♀️");
          lines.push(`💀 @${jnum(sender)}'s own Clane drank him to death! → 🏥 *Astral Town Hospital* (bill ${fmt(bill)} solars, *.hospital pay*)`);
          lines.push(rewardWinner(opp, p));
        }
        store.savePlayer(p);
        store.savePlayer(opp);
        return { text: withNotes(lines.join("\n")), mentions: [sender, oppJid] };
      }

      // normal attack
      const { dmg, crit } = attackDamage(p, opp);
      opp.hp -= dmg;
      lines.push(`🗡️ @${jnum(sender)} hits @${jnum(oppJid)} for *${dmg}*${crit ? " — 💥 CRITICAL!" : ""}`);

      if (opp.hp <= 0) {
        store.saveBattle(chat, null);
        const bill = store.killPlayer(opp, `slain in battle by ${p.name} ⚔️`);
        lines.push(`💀 @${jnum(oppJid)} falls! → 🏥 *Astral Town Hospital* (bill ${fmt(bill)} solars, *.hospital pay*)`);
        lines.push(rewardWinner(p, opp));
        store.savePlayer(p);
        return { text: withNotes(lines.join("\n")), mentions: [sender, oppJid] };
      }

      battle.turn = oppJid;
      store.saveBattle(chat, battle);
      store.savePlayer(p);
      store.savePlayer(opp);
      lines.push(battleStatusText({ [sender]: p, [oppJid]: opp }, battle));
      return { text: withNotes(lines.join("\n")), mentions: [sender, oppJid] };
    }

    return { text: withNotes(`⚔️ Unknown move. Use *.battle attack*, *.battle flee* or *.battle status*`) };
  }

  // ── mansion ──────────────────────────────────────────
  if (command === "mansion") {
    const m = p.mansion;

    if (sub === "buy") {
      if (m.owned) return { text: withNotes(`🏰 You already own the mansion!`) };
      if (p.solars < MANSION.priceSolars) {
        return {
          text: withNotes(
            `🏰 The mansion costs *${fmt(MANSION.priceSolars)} solars*.\n💰 You have ${fmt(p.solars)} (short ${fmt(MANSION.priceSolars - p.solars)}).`
          ),
        };
      }
      p.solars -= MANSION.priceSolars;
      m.owned = true;
      m.cleanliness = MANSION.cleanlinessMax;
      store.savePlayer(p);
      return sendImage(
        IMAGES.mansion,
        `🏰🎉 *THE MANSION IS YOURS!*\n━━━━━━━━━━━━━━━━━━━━\nA new mansion rises for you in the Astral — paid ${fmt(MANSION.priceSolars)} solars.\n\n` +
          `🛏️ *.mansion enter* — every hour stayed gives +${MANSION.statGainPerHour} to a random stat\n` +
          `🤵 *.mansion butlers* → *.mansion hire butler <name>* (${fmt(MANSION.butlerWagePerHourSolars)}/hr, max ${MANSION.maxButlers}, they keep it clean)\n` +
          `🧎 *.mansion hire servant [n]* — as many servants as you like (${fmt(MANSION.servantHireSolars)} each)\n` +
          `💃 *.brothel* — take up to ${MANSION.haremMax} waifus into your mansion harem`
      );
    }

    if (!m.owned && sub !== "butlers") {
      return sendImage(
        IMAGES.mansion,
        `🏰 *A mansion has emerged in the Astral!*\n━━━━━━━━━━━━━━━━━━━━\n💰 Price: *${fmt(MANSION.priceSolars)} solars* (you have ${fmt(p.solars)})\n\n` +
          `Inside you can:\n🛏️ Stay and gain +${MANSION.statGainPerHour} in a random stat every hour\n` +
          `🤵 Hire up to ${MANSION.maxButlers} butlers (${fmt(MANSION.butlerWagePerHourSolars)}/hr) to keep it clean\n` +
          `🧎 Hire as many servants as you want\n` +
          `💃 Build a harem of ${MANSION.haremMax} waifus from the Astral Town Brothel\n\nBuy it: *.mansion buy*`
      );
    }

    if (sub === "butlers") {
      for (const b of BUTLERS) {
        const hired = (m.butlers || []).includes(b.id);
        await sendImage(
          b.image,
          `🤵 *${b.name}*${hired ? " — ✅ HIRED by you" : ""}\n💰 Wage: ${fmt(MANSION.butlerWagePerHourSolars)} solars/hour stayed · keeps your mansion spotless\n${b.line}` +
            (hired ? `\nFire: *.mansion fire butler ${b.name.split(" ")[0].toLowerCase()}*` : `\nHire: *.mansion hire butler ${b.name.split(" ")[0].toLowerCase()}*`)
        );
      }
      return null;
    }

    if (sub === "enter" || sub === "stay") {
      if (m.stayingSince) return { text: withNotes(`🏰 You're already staying in your mansion. *.mansion leave* when you're done.`) };
      m.stayingSince = Date.now();
      m.lastSettleAt = Date.now();
      store.savePlayer(p);
      return {
        text: withNotes(
          `🏰 You settle into your mansion.\n⏳ Every hour stayed: *+${MANSION.statGainPerHour} to a random stat* (ATK/DEF/SPD)` +
            ((m.butlers || []).length
              ? `\n🤵 Your butler(s) will keep it clean for ${fmt(MANSION.butlerWagePerHourSolars)}/hr each.`
              : `\n⚠️ No butler on duty — cleanliness drops ${MANSION.cleanlinessDecayPerHour}%/hour and stat gains stop at 0%. *.mansion clean* or hire a butler.`) +
            `\n🚪 *.mansion leave* to head out (a stay auto-ends after ${MANSION.maxStayHours}h).`
        ),
      };
    }

    if (sub === "leave") {
      if (!m.stayingSince) return { text: withNotes(`🏰 You aren't staying in the mansion right now.`) };
      // getPlayer() at the top already settled whole hours; notes carry the summary.
      m.stayingSince = null;
      m.lastSettleAt = null;
      store.savePlayer(p);
      return { text: withNotes(`🏰 You leave the mansion, refreshed. ATK ${p.atk} · DEF ${p.def} · SPD ${p.spd}`) };
    }

    if (sub === "clean") {
      m.cleanliness = MANSION.cleanlinessMax;
      store.savePlayer(p);
      return { text: withNotes(`🧹 You cleaned the mansion yourself. ✨ 100% clean. (A butler would do this for you every hour… *.mansion butlers*)`) };
    }

    if (sub === "hire") {
      const kind = (args[1] || "").toLowerCase();
      if (kind === "butler") {
        const wanted = args.slice(2).join(" ").toLowerCase();
        const butler = BUTLERS.find((b) => b.name.toLowerCase().includes(wanted) && wanted);
        if (!butler) {
          return { text: withNotes(`🤵 Which butler? *.mansion hire butler Reginald* or *.mansion hire butler Phineas*\nSee them: *.mansion butlers*`) };
        }
        if ((m.butlers || []).includes(butler.id)) return { text: withNotes(`🤵 ${butler.name} already works for you.`) };
        if ((m.butlers || []).length >= MANSION.maxButlers) return { text: withNotes(`🤵 You already have the max ${MANSION.maxButlers} butlers.`) };
        m.butlers.push(butler.id);
        store.savePlayer(p);
        return sendImage(
          butler.image,
          `🤵✅ *${butler.name} hired!*\n${butler.line}\n💰 ${fmt(MANSION.butlerWagePerHourSolars)} solars per hour while you stay in the mansion — and he'll keep the whole house spotless. ✨\nButlers: ${(m.butlers || []).length}/${MANSION.maxButlers}`
        );
      }
      if (["servant", "servants", "slave", "slaves"].includes(kind)) {
        const count = Math.min(1000, Math.max(1, parseInt(args[2], 10) || 1));
        const cost = count * MANSION.servantHireSolars;
        if (p.solars < cost) {
          return { text: withNotes(`🧎 Hiring ${count} servant(s) costs *${fmt(cost)} solars* — you have ${fmt(p.solars)}.`) };
        }
        p.solars -= cost;
        m.servants = (m.servants || 0) + count;
        store.savePlayer(p);
        return { text: withNotes(`🧎✅ Hired ${count} servant(s) for ${fmt(cost)} solars.\nMansion servants: *${m.servants}* (as many more as you can afford — no limit)`) };
      }
      return { text: withNotes(`🏰 Hire what?\n🤵 *.mansion hire butler Reginald/Phineas* (${fmt(MANSION.butlerWagePerHourSolars)}/hr)\n🧎 *.mansion hire servant [count]* (${fmt(MANSION.servantHireSolars)} each)`) };
    }

    if (sub === "fire") {
      const kind = (args[1] || "").toLowerCase();
      if (kind === "butler") {
        const wanted = args.slice(2).join(" ").toLowerCase();
        const butler = BUTLERS.find((b) => b.name.toLowerCase().includes(wanted) && wanted);
        if (!butler || !(m.butlers || []).includes(butler.id)) {
          return { text: withNotes(`🤵 That butler doesn't work for you.`) };
        }
        m.butlers = m.butlers.filter((id) => id !== butler.id);
        store.savePlayer(p);
        return { text: withNotes(`🤵 ${butler.name} bows once and leaves. No more ${fmt(MANSION.butlerWagePerHourSolars)}/hr wage for him.`) };
      }
      if (["servant", "servants", "slave", "slaves"].includes(kind)) {
        const count = Math.max(1, parseInt(args[2], 10) || 1);
        m.servants = Math.max(0, (m.servants || 0) - count);
        store.savePlayer(p);
        return { text: withNotes(`🧎 Dismissed servant(s). Mansion servants left: ${m.servants}`) };
      }
      return { text: withNotes(`🏰 Fire what? *.mansion fire butler <name>* or *.mansion fire servant [count]*`) };
    }

    if (sub === "harem") {
      const names = (m.harem || []).map((id) => WAIFUS.find((w) => w.id === id)?.name || id);
      return {
        text: withNotes(
          `💃 *Your mansion harem* (${names.length}/${MANSION.haremMax})\n` +
            (names.length ? names.map((n) => `• ${n}`).join("\n") : `Empty…`) +
            `\n\nTake waifus from the Astral Town Brothel: *.brothel*`
        ),
      };
    }

    // default: mansion status
    const butlerNames = (m.butlers || []).map((id) => BUTLERS.find((b) => b.id === id)?.name || id).join(", ") || "none";
    const haremNames = (m.harem || []).map((id) => WAIFUS.find((w) => w.id === id)?.name || id).join(", ") || "empty";
    return sendImage(
      IMAGES.mansion,
      `🏰 *${p.name}'s Mansion*\n━━━━━━━━━━━━━━━━━━━━\n` +
        `🧹 Cleanliness: ${m.cleanliness}% ${m.stayingSince ? "· 🛏️ staying now (+5 random stat/hour)" : "· not staying"}\n` +
        `🤵 Butlers (${(m.butlers || []).length}/${MANSION.maxButlers}): ${butlerNames}\n` +
        `🧎 Servants: ${m.servants || 0}\n` +
        `💃 Harem (${(m.harem || []).length}/${MANSION.haremMax}): ${haremNames}\n\n` +
        `.mansion enter/leave · .mansion butlers · .mansion hire ... · .mansion fire ... · .mansion clean · .mansion harem\n` +
        `💃 New waifus: *.brothel*`
    );
  }

  // ── brothel ──────────────────────────────────────────
  if (command === "brothel") {
    const findWaifu = (txt) => WAIFUS.find((w) => w.name.toLowerCase() === String(txt || "").toLowerCase());
    if (sub === "view" || sub === "take" || sub === "buy") {
      const waifu = findWaifu(args[1]);
      if (!waifu) return { text: withNotes(`💃 Who? Try: ${WAIFUS.map((w) => `*.brothel ${sub} ${w.name.toLowerCase()}*`).join(" · ")}`) };
      if (sub === "view") {
        const owned = (p.mansion.harem || []).includes(waifu.id);
        return sendImage(
          waifu.image,
          `💃 *${waifu.name}* — Astral Town Brothel\n💰 Take her to your mansion: *${fmt(MANSION.waifuPriceSolars)} solars*${owned ? "\n✅ She's already in your mansion harem!" : `\n*.brothel take ${waifu.name.toLowerCase()}* (needs a mansion, harem max ${MANSION.haremMax})`}`
        );
      }
      // take / buy
      if (!p.mansion.owned) return { text: withNotes(`🏰 You need a *mansion* first — a harem needs a home. *.mansion buy* (${fmt(MANSION.priceSolars)} solars)`) };
      if ((p.mansion.harem || []).includes(waifu.id)) return { text: withNotes(`💃 ${waifu.name} is already in your mansion harem.`) };
      if ((p.mansion.harem || []).length >= MANSION.haremMax) return { text: withNotes(`💃 Your harem is full (${MANSION.haremMax}/${MANSION.haremMax}).`) };
      if (p.solars < MANSION.waifuPriceSolars) {
        return { text: withNotes(`💰 Taking ${waifu.name} costs *${fmt(MANSION.waifuPriceSolars)} solars* — you have ${fmt(p.solars)}.`) };
      }
      p.solars -= MANSION.waifuPriceSolars;
      p.mansion.harem.push(waifu.id);
      store.savePlayer(p);
      return sendImage(
        waifu.image,
        `💃✅ *${waifu.name}* leaves the Astral Town Brothel and moves into your mansion!\n💰 Paid ${fmt(MANSION.waifuPriceSolars)} solars · Harem: ${p.mansion.harem.length}/${MANSION.haremMax}\n🏰 See them: *.mansion harem*`
      );
    }
    return {
      text: withNotes(
        `💃 *Astral Town Brothel*\n━━━━━━━━━━━━━━━━━━━━\nTake a waifu home to your *mansion harem* (max ${MANSION.haremMax}) for ${fmt(MANSION.waifuPriceSolars)} solars each:\n\n` +
          WAIFUS.map(
            (w) =>
              `• *${w.name}*${(p.mansion.harem || []).includes(w.id) ? " ✅ in your harem" : ""} — *.brothel view ${w.name.toLowerCase()}* · *.brothel take ${w.name.toLowerCase()}*`
          ).join("\n") +
          (p.mansion.owned ? "" : `\n\n⚠️ You need a mansion first: *.mansion buy* (${fmt(MANSION.priceSolars)} solars)`)
      ),
    };
  }

  // ── owner grants ─────────────────────────────────────
  if (command === "give") {
    if (!isOwnerMessage(msg)) return { text: withNotes(`👑 *.give* is owner-only.`) };
    const targetJid = mentionTarget(msg) || sender;
    const kinds = ["solars", "solar", "gems", "gem", "clane"];
    const kindToken = args.find((a) => kinds.includes(a.toLowerCase()));
    if (!kindToken) {
      return { text: withNotes(`👑 Usage: *.give @user solars 5000* · *.give @user gems 10* · *.give @user clane*\n(no @user = give to yourself · amounts accept 400k / 5m)`) };
    }
    const kind = kindToken.toLowerCase();
    const targetPlayer = store.getPlayer(targetJid);
    if (kind === "clane") {
      targetPlayer.characters.clane.owned = true;
      targetPlayer.characters.clane.summoned = true;
      store.savePlayer(targetPlayer);
      return { text: withNotes(`🧛‍♀️ @${jnum(targetJid)} now owns *Clane*.`), mentions: [targetJid] };
    }
    const amountToken = args.find((a) => !a.startsWith("@") && a !== kindToken && !Number.isNaN(parseAmount(a)));
    const amount = parseAmount(amountToken || "");
    if (!(amount > 0)) return { text: withNotes(`👑 How much? e.g. *.give @user solars 5000* (400k / 5m work too)`) };
    const isGems = kind.startsWith("gem");
    if (isGems) targetPlayer.gems = roundGems(targetPlayer.gems + amount);
    else targetPlayer.solars = Math.round(targetPlayer.solars + amount);
    store.savePlayer(targetPlayer);
    return {
      text: withNotes(
        `👑 @${jnum(targetJid)} received +${isGems ? fmtGems(amount) : fmt(amount)} ${isGems ? "gems 💎" : "solars ☀️"}\n💰 ${fmt(targetPlayer.solars)} solars · 💎 ${fmtGems(targetPlayer.gems)} gems`
      ),
      mentions: [targetJid],
    };
  }

  return { text: withNotes(RPG_HELP) };
}

module.exports = { handleRpg, RPG_HELP, _internal: { doSpin, statsCard, hpBar } };
