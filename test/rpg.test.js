// Offline tests for the Astral RPG: Clane (spin odds, battle drain,
// talk-to-death), Astral Town Hospital fees/death flow, battles and
// the mansion (butler wages, stat-per-hour, harem). No network: the
// WhatsApp socket is faked and all data lands in a temp dir.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Keep persist's JSON files out of the repo.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "astral-rpg-"));
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const data = require(path.join(ROOT, "utils", "rpgData.js"));
const store = require(path.join(ROOT, "utils", "rpgStore.js"));
const { handleRpg } = require(path.join(ROOT, "commands", "games", "rpg.js"));

const GROUP = "1203630@g.us";
const ALICE = "2348011111111@s.whatsapp.net";
const BOB = "2348022222222@s.whatsapp.net";

function fakeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(chat, content) {
      sent.push({ chat, content });
      return {};
    },
  };
}

function groupMsg(participant, { mentionedJid, pushName = "Tester" } = {}) {
  const msg = { key: { remoteJid: GROUP, participant, fromMe: false }, pushName };
  if (mentionedJid) {
    msg.message = { extendedTextMessage: { contextInfo: { mentionedJid } } };
  }
  return msg;
}

async function run(sock, msg, command, argText = "") {
  const before = sock.sent.length;
  const result = await handleRpg(sock, msg, command, argText);
  const sentNow = sock.sent.slice(before);
  const text =
    result?.text ||
    sentNow.map((s) => s.content.caption || s.content.text || "").join("\n");
  return { result, sentNow, text };
}

function stubRandom(seq) {
  const orig = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  return () => { Math.random = orig; };
}

// ── pure data / odds ─────────────────────────────────────
test("hospital fees: <30 pays 5k, below 100 pays 50k, Lv100 pays 400k, above 100 pays 500k", () => {
  assert.equal(data.hospitalFeeForLevel(1), 5_000);
  assert.equal(data.hospitalFeeForLevel(29), 5_000);
  assert.equal(data.hospitalFeeForLevel(30), 50_000);
  assert.equal(data.hospitalFeeForLevel(99), 50_000);
  assert.equal(data.hospitalFeeForLevel(100), 400_000);
  assert.equal(data.hospitalFeeForLevel(101), 500_000);
  assert.equal(data.hospitalFeeForLevel(500), 500_000);
});

test("Clane spin: 1-257 deadzone, 258+ is a 50/50, total 300", () => {
  assert.deepEqual(data.rollClaneSpin(() => 0), { roll: 1, outcome: "deadzone" });
  // roll 257: rng in [256/300, 257/300)
  assert.equal(data.rollClaneSpin(() => 256.5 / 300).outcome, "deadzone");
  assert.equal(data.rollClaneSpin(() => 256.5 / 300).roll, 257);
  // roll 258 + winning coin
  const winSeq = [257.5 / 300, 0.49];
  let i = 0;
  assert.deepEqual(data.rollClaneSpin(() => winSeq[i++]), { roll: 258, outcome: "win" });
  // roll 300 + losing coin
  const loseSeq = [0.9999, 0.5];
  i = 0;
  assert.deepEqual(data.rollClaneSpin(() => loseSeq[i++]), { roll: 300, outcome: "lost-fifty" });
});

test("Clane battle drain: 30% of opponent HP and 5% of owner HP (min 1)", () => {
  assert.deepEqual(data.claneBattleDrains(200, 100), { opponentDrain: 30, ownerDrain: 10 });
  assert.deepEqual(data.claneBattleDrains(1, 1), { opponentDrain: 1, ownerDrain: 1 });
});

test("thirst stages: she only drinks from thirst 3, and drinks more as it rises", () => {
  assert.equal(data.thirstStage(2).drinkPctOfMaxHp, 0);
  assert.equal(data.thirstStage(3).drinkPctOfMaxHp, 0.05);
  assert.equal(data.thirstStage(6).drinkPctOfMaxHp, 0.1);
  assert.equal(data.thirstStage(10).drinkPctOfMaxHp, 0.15);
  assert.equal(data.thirstStage(99).key, "ravenous");
});

test("attack damage respects min damage and crits", () => {
  const weak = { atk: 1 };
  const tank = { def: 10_000 };
  assert.equal(data.attackDamage(weak, tank, () => 0.5).dmg, data.BATTLE.minDamage);
  const crit = data.attackDamage({ atk: 10 }, { def: 0 }, () => 0.01);
  assert.equal(crit.crit, true);
});

test("parseAmount handles 400k / 5m for .give", () => {
  assert.equal(data.parseAmount("400k"), 400_000);
  assert.equal(data.parseAmount("5m"), 5_000_000);
  assert.equal(data.parseAmount("1.5"), 1.5);
  assert.ok(Number.isNaN(data.parseAmount("abc")));
});

// ── profiles / spin ──────────────────────────────────────
test("new players get the starter kit", () => {
  store._reset();
  const p = store.getPlayer(ALICE, "Alice");
  assert.equal(p.level, 1);
  assert.equal(p.solars, data.STARTER.solars);
  assert.equal(p.gems, data.STARTER.gems);
  assert.equal(p.hp, p.maxHp);
  assert.equal(p.characters.clane.owned, false);
  assert.equal(p._isNew, true);
  assert.equal(store.getPlayer(ALICE)._isNew, false);
});

test("spin costs 1.5 gems and the 50/50 win grants Clane", async () => {
  store._reset();
  const sock = fakeSock();
  const restore = stubRandom([257.5 / 300, 0.1]);
  try {
    const { text } = await run(sock, groupMsg(ALICE), "spin", "");
    assert.match(text, /Clane.*YOURS/);
    const p = store.peekPlayer(ALICE);
    assert.equal(p.characters.clane.owned, true);
    assert.equal(p.gems, data.STARTER.gems - 1.5);
    assert.equal(p.spins, 1);
    // the spin image was sent
    assert.equal(sock.sent[0].content.image.url, data.Clane.images.spin);
  } finally {
    restore();
  }
});

test("spin deadzone gives nothing; spin without gems is refused", async () => {
  store._reset();
  const sock = fakeSock();
  const restore = stubRandom([0]); // roll 1
  try {
    const { text } = await run(sock, groupMsg(ALICE), "spin", "");
    assert.match(text, /DEADZONE/);
    assert.equal(store.peekPlayer(ALICE).characters.clane.owned, false);
  } finally {
    restore();
  }
  const p = store.peekPlayer(ALICE);
  p.gems = 0;
  store.savePlayer(p);
  const { text } = await run(sock, groupMsg(ALICE), "spin", "");
  assert.match(text, /Not enough gems/);
});

// ── talking to Clane → death → hospital ───────────────────
test("only her owner can talk to Clane; thirst and bond grow per talk", async () => {
  store._reset();
  const sock = fakeSock();
  const { text: blocked } = await run(sock, groupMsg(ALICE), "clane", "hello there");
  assert.match(blocked, /Only Clane's \*owner\*/);

  const p = store.getPlayer(ALICE);
  p.characters.clane.owned = true;
  store.savePlayer(p);

  const { text, sentNow } = await run(sock, groupMsg(ALICE), "clane", "hi Clane");
  assert.match(text, /Clane \(adult form\)/);
  assert.equal(sentNow[0].content.image.url, data.Clane.images.talkAdultForm);
  const after = store.peekPlayer(ALICE);
  assert.equal(after.characters.clane.bond, 1);
  assert.equal(after.characters.clane.thirst, 1);
  assert.equal(after.hp, after.maxHp, "no drinking yet at low thirst");
});

test("Clane drinks her owner to death while talking → Astral Town Hospital, then .hospital pay discharges", async () => {
  store._reset();
  const sock = fakeSock();
  const p = store.getPlayer(ALICE, "Alice");
  p.characters.clane.owned = true;
  p.characters.clane.thirst = 9; // next talk -> ravenous, 15% of max HP
  p.hp = 10; // nearly dead
  p.solars = 0;
  store.savePlayer(p);

  const { text } = await run(sock, groupMsg(ALICE), "clane", "one more thing...");
  assert.match(text, /YOU DIED/);
  assert.match(text, /Astral Town Hospital/);

  const dead = store.peekPlayer(ALICE);
  assert.equal(dead.status, "hospital");
  assert.equal(dead.hp, 0);
  assert.equal(dead.hospitalBill, 5_000, "Lv1 fee");
  assert.equal(dead.characters.clane.thirst, 0, "thirst resets on death");

  // hospital confinement: spinning is blocked, daily charity works
  const { text: blockedSpin } = await run(sock, groupMsg(ALICE), "spin", "");
  assert.match(blockedSpin, /Astral Town Hospital/);
  const { text: cantPay } = await run(sock, groupMsg(ALICE), "hospital", "pay");
  assert.match(cantPay, /Can't discharge/);
  await run(sock, groupMsg(ALICE), "daily", "");
  assert.equal(store.peekPlayer(ALICE).solars, data.DAILY.solars);

  const { text: out } = await run(sock, groupMsg(ALICE), "hospital", "pay");
  assert.match(out, /Discharged/);
  const alive = store.peekPlayer(ALICE);
  assert.equal(alive.status, "alive");
  assert.equal(alive.hp, alive.maxHp);
  assert.equal(alive.solars, 0, "5k daily minus 5k Lv1 bill");
});

// ── battles with Clane ────────────────────────────────────
test("battle: Clane drains 30%/5% each owner turn; loser dies to hospital, winner is paid", async () => {
  store._reset();
  const sock = fakeSock();
  const alice = store.getPlayer(ALICE, "Alice");
  alice.characters.clane.owned = true;
  alice.characters.clane.summoned = true;
  store.savePlayer(alice);
  const Bob = store.getPlayer(BOB, "Bob");
  Bob.hp = 10;
  store.savePlayer(Bob);

  await run(sock, groupMsg(ALICE, { mentionedJid: [BOB] }), "battle", `@${BOB.split("@")[0]}`);
  await run(sock, groupMsg(BOB), "battle", "accept");
  const { text } = await run(sock, groupMsg(ALICE), "battle", "attack");
  assert.match(text, /Blood Siphon/);
  assert.match(text, /Astral Town Hospital/);

  const aliceAfter = store.peekPlayer(ALICE);
  const bobAfter = store.peekPlayer(BOB);
  assert.equal(bobAfter.status, "hospital");
  assert.equal(bobAfter.hospitalBill, 5_000);
  assert.equal(aliceAfter.solars, data.STARTER.solars + data.BATTLE.winSolars);
  assert.equal(aliceAfter.hp, aliceAfter.maxHp - 5, "Clane took 5% of her owner's 100 HP");
  assert.equal(store.getBattle(GROUP), null);
});

// ── mansion ───────────────────────────────────────────────
test("mansion: buy for 5m, hire butler+servants, take waifu, hourly wages + stat gains while staying", async () => {
  store._reset();
  const sock = fakeSock();
  const p = store.getPlayer(ALICE, "Alice");
  p.solars = 6_000_000;
  store.savePlayer(p);

  const { text: bought, sentNow } = await run(sock, groupMsg(ALICE), "mansion", "buy");
  assert.match(bought, /MANSION IS YOURS/);
  assert.equal(sentNow[0].content.image.url, data.IMAGES.mansion);
  assert.equal(store.peekPlayer(ALICE).solars, 1_000_000);

  await run(sock, groupMsg(ALICE), "mansion", "hire butler Reginald");
  await run(sock, groupMsg(ALICE), "mansion", "hire servant 3");
  const { text: took } = await run(sock, groupMsg(ALICE), "brothel", "take cin");
  assert.match(took, /moves into your mansion/);

  let after = store.peekPlayer(ALICE);
  assert.deepEqual(after.mansion.butlers, ["Reginald Ashworth"]);
  assert.equal(after.mansion.servants, 3);
  assert.deepEqual(after.mansion.harem, ["cin"]);
  assert.equal(
    after.solars,
    1_000_000 - 3 * data.MANSION.servantHireSolars - data.MANSION.waifuPriceSolars
  );

  // stay 3 hours (rewind the stay timestamps, then touch the player)
  await run(sock, groupMsg(ALICE), "mansion", "enter");
  after = store.peekPlayer(ALICE);
  const threeHoursAgo = Date.now() - 3 * 3600_000;
  after.mansion.stayingSince = threeHoursAgo;
  after.mansion.lastSettleAt = threeHoursAgo;
  const statsBefore = after.atk + after.def + after.spd;
  const solarsBefore = after.solars;
  store.savePlayer(after);

  const settled = store.getPlayer(ALICE); // lazy settle happens here
  assert.equal(
    settled.solars,
    solarsBefore - 3 * data.MANSION.butlerWagePerHourSolars,
    "butler paid 50k/hour for 3 hours"
  );
  assert.equal(
    settled.atk + settled.def + settled.spd,
    statsBefore + 3 * data.MANSION.statGainPerHour,
    "+5 to a random stat for each of the 3 hours"
  );
  assert.equal(settled.mansion.cleanliness, 100, "butler kept it clean");

  // duplicate waifu is refused
  const { text: dup } = await run(sock, groupMsg(ALICE), "brothel", "take cin");
  assert.match(dup, /already in your mansion harem/);
});

test("mansion without a butler gets dirty and stops granting stats at 0% clean", async () => {
  store._reset();
  const sock = fakeSock();
  const p = store.getPlayer(ALICE, "Alice");
  p.solars = 5_000_000;
  store.savePlayer(p);
  await run(sock, groupMsg(ALICE), "mansion", "buy");
  await run(sock, groupMsg(ALICE), "mansion", "enter");

  const q = store.peekPlayer(ALICE);
  const ago = Date.now() - 2 * 3600_000;
  q.mansion.stayingSince = ago;
  q.mansion.lastSettleAt = ago;
  const statsBefore = q.atk + q.def + q.spd;
  store.savePlayer(q);

  const settled = store.getPlayer(ALICE);
  assert.equal(settled.mansion.cleanliness, 100 - 2 * data.MANSION.cleanlinessDecayPerHour);
  assert.equal(settled.atk + settled.def + settled.spd, statsBefore + 10);
});

// ── wiring ────────────────────────────────────────────────
test("router wires the RPG commands and the new menu image", () => {
  const router = fs.readFileSync(path.join(ROOT, "handlers", "router.js"), "utf8");
  assert.match(router, /0jkMrkXS\/menu-2026-10-24-04-16-13-393126\.webp/);
  for (const c of ["clane", "spin", "hospital", "mansion", "brothel", "battle", "stats", "start"]) {
    assert.match(router, new RegExp(`case "${c}"`));
  }
  const menu = require(path.join(ROOT, "commands", "menu.js")).buildMenu("Tester");
  assert.match(menu, /clane/);
  assert.match(menu, /mansion/);
  assert.match(menu, /hospital/);
});
