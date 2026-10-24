// ═══════════════════════════════════════════════════════
//   🏰 ASTRAL RPG — game data & balance knobs
//
//   Everything tunable lives in this file: prices, images,
//   character stats, hospital fees, spin odds, Clane's lines.
//   Change a number here and the whole game follows.
// ═══════════════════════════════════════════════════════

// ── images (hosted links) ──────────────────────────────
const IMAGES = {
  menu: "https://i.ibb.co/0jkMrkXS/menu-2026-10-24-04-16-13-393126.webp",
  // No hospital image link was provided — paste one here (e.g.
  // "https://i.ibb.co/xxxx/hospital.jpg") and it will be sent with
  // every hospital message. null = text only.
  hospital: null,
  mansion: "https://i.ibb.co/WWwkt1fX/Mansion.jpg",
};

// ── new-player starting kit ────────────────────────────
const STARTER = {
  level: 1,
  xp: 0,
  maxHp: 100,
  atk: 10,
  def: 5,
  spd: 5,
  solars: 10_000,
  gems: 15,
};

// ── daily reward (.daily, once every 24h) ──────────────
const DAILY = { solars: 5_000, gems: 3, cooldownMs: 24 * 60 * 60 * 1000 };

// ── passive HP regen while alive: +2% of max HP / 5 min ─
const REGEN = { pctOfMaxHp: 0.02, everyMs: 5 * 60 * 1000 };

// ── Astral Town Hospital ───────────────────────────────
// EVERY death respawns at Astral Town Hospital. The bill you must
// pay to leave depends on your level when you died:
//   Lv 1–29   →   5,000 solars  ("before 30 they pay 5k")
//   Lv 30–99  →  50,000 solars  ("below 100 they pay 50k")
//   Lv 100    → 400,000 solars  (the flat 400k fee)
//   Lv 101+   → 500,000 solars  ("above 100 they pay 500k")
function hospitalFeeForLevel(level) {
  const lv = Math.max(1, Math.floor(level) || 1);
  if (lv < 30) return 5_000;
  if (lv < 100) return 50_000;
  if (lv === 100) return 400_000;
  return 500_000;
}

// ── 🧛‍♀️ Clane — the vampire ────────────────────────────
const Clane = {
  id: "clane",
  name: "Clane",
  title: "the Crimson Vampire",
  images: {
    info: "https://i.ibb.co/vxL8GXTw/Info-Clane.webp",
    spin: "https://i.ibb.co/zHGdtRYP/spin-clane.webp",
    talkAdultForm: "https://i.ibb.co/1t704TQQ/talk-adult-form.webp",
  },
  ability:
    "Blood Siphon — every turn in battle she sucks 30% of the " +
    "opponent's current HP… and 5% of her owner's current HP.",
  // Spin: roll 1–300. 1–257 is the deadzone (nothing). 258+ enters
  // a 50/50 — win it and Clane is yours. Cost: 1.5 gems per spin.
  spin: {
    total: 300,
    deadzoneMax: 257,
    fiftyFiftyChance: 0.5,
    costGems: 1.5,
    duplicateGemRefund: 5, // winning her again converts to gems + bond
  },
  battle: {
    opponentDrainPct: 0.3, // 30% of opponent's CURRENT hp, every owner turn
    ownerDrainPct: 0.05, //   5% of owner's CURRENT hp, every owner turn
  },
};

/**
 * One spin for Clane.
 * @returns {{ roll:number, outcome:"deadzone"|"lost-fifty"|"win" }}
 */
function rollClaneSpin(rng = Math.random) {
  const roll = 1 + Math.floor(rng() * Clane.spin.total);
  if (roll <= Clane.spin.deadzoneMax) return { roll, outcome: "deadzone" };
  return { roll, outcome: rng() < Clane.spin.fiftyFiftyChance ? "win" : "lost-fifty" };
}

/** Clane's battle drain for one of her owner's turns (current-HP %). */
function claneBattleDrains(ownerHp, opponentHp) {
  return {
    opponentDrain: Math.max(1, Math.floor(opponentHp * Clane.battle.opponentDrainPct)),
    ownerDrain: Math.max(1, Math.floor(ownerHp * Clane.battle.ownerDrainPct)),
  };
}

// ── talking to Clane (.clane <text>) ────────────────────
// The more you talk, the thirstier she gets for YOUR blood.
// thirst +1 per talk, decays by 1 per hour you leave her alone.
// Once thirst ≥ 3 she starts sipping HP off you with every reply,
// and the sip grows as she gets thirstier. If she drinks you to
// 0 HP you die and wake up in Astral Town Hospital.
function thirstStage(thirst) {
  if (thirst >= 10) return { key: "ravenous", label: "RAVENOUS", drinkPctOfMaxHp: 0.15 };
  if (thirst >= 6) return { key: "thirsty", label: "Thirsty", drinkPctOfMaxHp: 0.1 };
  if (thirst >= 3) return { key: "piqued", label: "Blood-scented", drinkPctOfMaxHp: 0.05 };
  return { key: "calm", label: "Calm", drinkPctOfMaxHp: 0 };
}

// {name} is replaced with the owner's name.
const Clane_LINES = {
  calm: [
    "Hm? Oh… it's you, master. How rare for you to seek me out. 🧛‍♀️",
    "You called, {name}? Very well. I shall grace you with a moment of my eternity.",
    "Speak then. A vampire's patience is long… but not endless.",
    "My, my. Visiting little old me? How bold of a warm-blooded thing.",
  ],
  piqued: [
    "Hehe… you know, {name}, your heartbeat gets louder every time you talk to me. I can hear it. 💓",
    "Mmm~ come closer when you speak. Your scent… it's sweet today. Suspiciously sweet.",
    "You keep coming back to me. Do you *want* something from me… or do you want *me* to want something from you?",
    "Careful, master. The more we talk, the more delicious you smell. 🩸",
  ],
  thirsty: [
    "Haah… {name}… your blood… I can taste it in the air already. Just… one sip? You won't miss one sip. 🧛‍♀️🩸",
    "Stop talking so much and bare your neck instead. Please? For me? I'm so, so thirsty…",
    "Every word out of your mouth makes my fangs ache. Do you have any idea what your blood smells like to me?",
    "Master… master… master~ Say my name again. Slower. Closer. Against my fangs.",
  ],
  ravenous: [
    "I CAN'T HOLD BACK ANYMORE, {name}!! Your blood is MINE — you talked to me this much, you KNEW what would happen!! 🩸🩸",
    "MORE. TALK MORE. Every word pumps it faster — hot, rich, DELICIOUS — right into my mouth!!",
    "Haah… haah… so sweet… so warm… don't run, master. A vampire always finishes her meal.",
    "You did this. You kept calling my name. Now let me drink until there's nothing left to call back. 🧛‍♀️",
  ],
  // when a talk-drink actually happens (thirst ≥ 3):
  drink: [
    "*She leans in mid-sentence — fangs sink into your neck and she drinks deep.* 🩸",
    "*Her eyes flash crimson. Before you can react, she's already feeding.*",
    "*She giggles against your throat as she sucks your blood.* \"Mmm… vintage {name}.\"",
  ],
  // when she drinks you to death while talking:
  drainedToDeath:
    "Ahh… until the very last drop. 🩸 Sleep now, master… the hospital will patch up what's left of you.",
};

// ── battle numbers ─────────────────────────────────────
const BATTLE = {
  challengeMs: 120_000,
  winSolars: 1_500,
  winXp: 30,
  fleePenaltySolars: 500,
  critChance: 0.1,
  critMultiplier: 1.5,
  minDamage: 5,
};

/** Damage for a normal attack: ATK×2 ±15%, minus DEF, 10% crit. */
function attackDamage(attacker, defender, rng = Math.random) {
  const variance = 0.85 + rng() * 0.3;
  const crit = rng() < BATTLE.critChance;
  let dmg = Math.round(attacker.atk * 2 * variance) - (defender.def || 0);
  if (crit) dmg = Math.round(dmg * BATTLE.critMultiplier);
  return { dmg: Math.max(BATTLE.minDamage, dmg), crit };
}

// ── levels ─────────────────────────────────────────────
const xpForNextLevel = (level) => 100 * Math.max(1, level);
const LEVEL_UP_GAINS = { maxHp: 20, atk: 2, def: 1, spd: 1 };

// ── 🏰 the Mansion (Astral) ─────────────────────
const MANSION = {
  priceSolars: 5_000_000, // 5 million solars
  servantHireSolars: 20_000, // one-time hire per servant, as many as you want
  maxButlers: 2,
  butlerWagePerHourSolars: 50_000, // per butler, per hour stayed in the mansion
  haremMax: 3,
  waifuPriceSolars: 250_000, // to take a waifu from the brothel (each)
  statGainPerHour: 5, // +5 to ONE random stat per hour stayed
  statPool: ["atk", "def", "spd"],
  cleanlinessMax: 100,
  cleanlinessDecayPerHour: 15, // per hour stayed with no butler on duty
  maxStayHours: 24, // one stay auto-ends after 24h (gains/wages stop there)
};

const BUTLERS = [
  {
    id: "Reginald Ashworth",
    name: "Reginald Ashworth",
    image: "https://i.ibb.co/wrgCXLtc/Reginald-Ashworth.jpg",
    line: "\"Very good, master. The halls shall gleam by the hour.\" 🤵",
  },
  {
    id: "Phineas Bellweather",
    name: "Phineas Bellweather",
    image: "https://i.ibb.co/jkXMhHs5/Phineas-Bellweather.jpg",
    line: "\"Consider every speck of dust already dealt with, master.\" 🤵",
  },
];

// ── Astral Town Brothel — move a waifu into your mansion harem (max 3) ──
const WAIFUS = [
  { id: "cin", name: "Cin", image: "https://i.ibb.co/JWxQVfc3/cin.jpg" },
  { id: "Noellle", name: "Noellle", image: "https://i.ibb.co/jktLqkMN/Noellle.jpg" },
  { id: "Kaspavor", name: "Kaspavor", image: "https://i.ibb.co/gb2yRj01/kaspavor.jpg" },
];

// "400k" / "5m" / "12.5" → number (for .give amounts)
function parseAmount(text) {
  const m = String(text || "").trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(k|m)?$/);
  if (!m) return NaN;
  const n = parseFloat(m[1]);
  if (m[2] === "k") return n * 1_000;
  if (m[2] === "m") return n * 1_000_000;
  return n;
}

module.exports = {
  IMAGES,
  STARTER,
  DAILY,
  REGEN,
  hospitalFeeForLevel,
  Clane,
  rollClaneSpin,
  claneBattleDrains,
  thirstStage,
  Clane_LINES,
  BATTLE,
  attackDamage,
  xpForNextLevel,
  LEVEL_UP_GAINS,
  MANSION,
  BUTLERS,
  WAIFUS,
  parseAmount,
};
