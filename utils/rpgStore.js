// Astral RPG persistence: players + active battles, stored through
// utils/persist.js (MongoDB when MONGODB_URI is set, JSON otherwise),
// following the same pattern as utils/chessStore.js.
//
// Time-based effects are settled lazily whenever a player is touched:
//   - passive HP regen while alive
//   - Clane's thirst decaying while you ignore her
//   - mansion hours: butler wages, cleanliness, +5 random stat/hour
const persist = require("./persist");
const {
  STARTER, REGEN, MANSION, hospitalFeeForLevel, xpForNextLevel, LEVEL_UP_GAINS,
} = require("./rpgData");

const HOUR_MS = 60 * 60 * 1000;

let players = null; // jid -> player
let battles = null; // chatId -> battle
const pendingBattles = new Map(); // challengerJid -> { target, chat, expiry } (memory only, like chess)
const pendingNotes = new Map(); // jid -> [lines produced by lazy settling]

function ensureLoaded() {
  if (!players) players = persist.get("rpgPlayers", {});
  if (!battles) battles = persist.get("rpgBattles", {});
}
function savePlayers() { ensureLoaded(); persist.set("rpgPlayers", players); }
function saveBattles() { ensureLoaded(); persist.set("rpgBattles", battles); }

function freshPlayer(jid, name) {
  const now = Date.now();
  return {
    jid,
    name: name || "Adventurer",
    level: STARTER.level,
    xp: STARTER.xp,
    hp: STARTER.maxHp,
    maxHp: STARTER.maxHp,
    atk: STARTER.atk,
    def: STARTER.def,
    spd: STARTER.spd,
    solars: STARTER.solars,
    gems: STARTER.gems,
    status: "alive", // "alive" | "hospital"  (every death -> Astral Town Hospital)
    hospitalBill: 0,
    deathCause: "",
    diedAt: 0,
    deaths: 0,
    battlesWon: 0,
    spins: 0,
    lastDailyAt: 0,
    lastRegenAt: now,
    characters: {
      clane: { owned: false, summoned: true, bond: 0, thirst: 0, lastTalkAt: 0 },
    },
    mansion: {
      owned: false,
      stayingSince: null, // timestamp when the current stay began
      lastSettleAt: null, // timestamp up to which stay-hours are settled
      cleanliness: MANSION.cleanlinessMax,
      butlers: [], // butler ids, max MANSION.maxButlers
      servants: 0, // hired servants — as many as you can afford
      harem: [], // waifu ids from the brothel, max MANSION.haremMax
    },
    createdAt: now,
  };
}

function note(jid, line) {
  if (!pendingNotes.has(jid)) pendingNotes.set(jid, []);
  pendingNotes.get(jid).push(line);
}
/** Lines produced by lazy settling since the player's last command. */
function takeNotes(jid) {
  const lines = pendingNotes.get(jid) || [];
  pendingNotes.delete(jid);
  return lines;
}

// ── lazy settling ──────────────────────────────────────
function settlePlayer(p, now = Date.now()) {
  let changed = false;

  // passive regen while alive
  if (p.status === "alive" && p.hp > 0 && p.hp < p.maxHp) {
    const ticks = Math.floor((now - (p.lastRegenAt || now)) / REGEN.everyMs);
    if (ticks > 0) {
      const heal = ticks * Math.max(1, Math.round(p.maxHp * REGEN.pctOfMaxHp));
      p.hp = Math.min(p.maxHp, p.hp + heal);
      p.lastRegenAt = (p.lastRegenAt || now) + ticks * REGEN.everyMs;
      changed = true;
    }
  } else if (now - (p.lastRegenAt || 0) > REGEN.everyMs) {
    p.lastRegenAt = now; // don't bank regen while dead/full
  }

  // Clane gets less thirsty the longer you leave her alone (-1/hour)
  const c = p.characters?.clane;
  if (c && c.thirst > 0 && c.lastTalkAt) {
    const idleHours = Math.floor((now - c.lastTalkAt) / HOUR_MS);
    if (idleHours > 0) {
      c.thirst = Math.max(0, c.thirst - idleHours);
      c.lastTalkAt += idleHours * HOUR_MS;
      changed = true;
    }
  }

  if (settleMansion(p, now)) changed = true;
  return changed;
}

/**
 * Settles whole hours stayed in the mansion: butler wages
 * (50k/butler/hour), cleanliness, and +5 to a random stat per hour.
 * A stay auto-ends after MANSION.maxStayHours so wages/gains can
 * never run away while someone is offline for a week.
 */
function settleMansion(p, now = Date.now(), rng = Math.random) {
  const m = p.mansion;
  if (!m?.owned || !m.stayingSince) return false;

  const stayEnd = m.stayingSince + MANSION.maxStayHours * HOUR_MS;
  const settleUpTo = Math.min(now, stayEnd);
  const from = m.lastSettleAt || m.stayingSince;
  const hours = Math.floor((settleUpTo - from) / HOUR_MS);
  let changed = false;

  if (hours > 0) {
    const gains = { atk: 0, def: 0, spd: 0 };
    let wagesPaid = 0;
    let unpaidHours = 0;
    let filthyHours = 0;

    for (let h = 0; h < hours; h++) {
      const butlerCount = (m.butlers || []).length;
      const wages = butlerCount * MANSION.butlerWagePerHourSolars;
      if (butlerCount > 0 && p.solars >= wages) {
        p.solars -= wages;
        wagesPaid += wages;
        m.cleanliness = MANSION.cleanlinessMax; // butlers keep the house clean
      } else {
        if (butlerCount > 0) unpaidHours++;
        m.cleanliness = Math.max(0, m.cleanliness - MANSION.cleanlinessDecayPerHour);
      }
      if (m.cleanliness > 0) {
        const stat = MANSION.statPool[Math.floor(rng() * MANSION.statPool.length)];
        p[stat] += MANSION.statGainPerHour;
        gains[stat] += MANSION.statGainPerHour;
      } else {
        filthyHours++; // too filthy to rest properly — no stat gain
      }
    }
    m.lastSettleAt = from + hours * HOUR_MS;
    changed = true;

    const gainText = Object.entries(gains)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `+${v} ${k.toUpperCase()}`)
      .join(", ");
    let line = `🏰 *Mansion:* ${hours}h stayed`;
    if (gainText) line += ` → ${gainText}`;
    if (wagesPaid) line += ` · butler wages −${wagesPaid.toLocaleString("en-US")} solars`;
    note(p.jid, line);
    if (unpaidHours)
      note(p.jid, `🤵⚠️ Your butler(s) went unpaid for ${unpaidHours}h and stopped cleaning!`);
    if (filthyHours)
      note(p.jid, `🗑️ The mansion was too filthy to rest in for ${filthyHours}h — no stat gains. Hire a butler or use *.mansion clean*.`);
  }

  if (now >= stayEnd) {
    m.stayingSince = null;
    m.lastSettleAt = null;
    note(p.jid, `🏰 You left the mansion after a ${MANSION.maxStayHours}h stay. *.mansion enter* to stay again.`);
    changed = true;
  }
  return changed;
}

// ── players ────────────────────────────────────────────
/** Get a player, auto-creating a fresh Lv1 profile on first use. */
function getPlayer(jid, name) {
  ensureLoaded();
  let p = players[jid];
  let isNew = false;
  if (!p) {
    p = players[jid] = freshPlayer(jid, name);
    isNew = true;
  }
  if (name && name !== "there") p.name = name;
  const changed = settlePlayer(p);
  if (isNew || changed) savePlayers();
  // Transient welcome flag — non-enumerable so it never gets persisted.
  Object.defineProperty(p, "_isNew", { value: isNew, writable: true, configurable: true });
  return p;
}

/** Get a player only if they already have a profile (for @targets). */
function peekPlayer(jid) {
  ensureLoaded();
  const p = players[jid];
  if (!p) return null;
  if (settlePlayer(p)) savePlayers();
  return p;
}

function savePlayer(p) {
  ensureLoaded();
  const { _isNew, ...clean } = p;
  players[p.jid] = clean;
  Object.assign(p, clean);
  savePlayers();
}

const isInHospital = (p) => p?.status === "hospital";

/**
 * The ONE way to die in Astral: any death, from any source, sends
 * you to Astral Town Hospital with a level-scaled bill to leave.
 */
function killPlayer(p, cause) {
  p.hp = 0;
  p.status = "hospital";
  p.hospitalBill = hospitalFeeForLevel(p.level);
  p.deathCause = cause || "unknown causes";
  p.diedAt = Date.now();
  p.deaths = (p.deaths || 0) + 1;
  if (p.mansion) { p.mansion.stayingSince = null; p.mansion.lastSettleAt = null; }
  if (p.characters?.clane) p.characters.clane.thirst = 0;
  savePlayer(p);
  return p.hospitalBill;
}

/** Add XP, applying level-ups. Returns how many levels were gained. */
function addXp(p, amount) {
  p.xp += amount;
  let gained = 0;
  while (p.xp >= xpForNextLevel(p.level)) {
    p.xp -= xpForNextLevel(p.level);
    p.level += 1;
    p.maxHp += LEVEL_UP_GAINS.maxHp;
    p.atk += LEVEL_UP_GAINS.atk;
    p.def += LEVEL_UP_GAINS.def;
    p.spd += LEVEL_UP_GAINS.spd;
    gained++;
  }
  if (gained && p.status === "alive") p.hp = p.maxHp; // level-up full heal
  return gained;
}

// ── battles (per chat, like chess) ─────────────────────
function getBattle(chatId) {
  ensureLoaded();
  return battles[chatId] || null;
}
function saveBattle(chatId, battle) {
  ensureLoaded();
  if (battle) battles[chatId] = battle;
  else delete battles[chatId];
  saveBattles();
}
function findBattleByPlayer(jid) {
  ensureLoaded();
  for (const [chatId, b] of Object.entries(battles)) {
    if (b.p1 === jid || b.p2 === jid) return { chatId, battle: b };
  }
  return null;
}

/** Used by tests to start from a clean slate. */
function _reset() {
  players = {};
  battles = {};
  pendingBattles.clear();
  pendingNotes.clear();
  savePlayers();
  saveBattles();
}

module.exports = {
  getPlayer, peekPlayer, savePlayer, isInHospital, killPlayer, addXp,
  settlePlayer, settleMansion, takeNotes,
  getBattle, saveBattle, findBattleByPlayer, pendingBattles,
  _reset,
};
