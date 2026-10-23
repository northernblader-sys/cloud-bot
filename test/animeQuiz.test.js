// Welcome-question tests: the 40-question pool, the fuzzy matcher, and the
// join-verification flow that uses them. All offline.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const Module = require("node:module");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-quiz-"));
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const quiz = require(path.join(ROOT, "utils", "animeQuiz.js"));

function ask(id, guesses) {
  const question = quiz.getQuestion(id);
  return guesses.map((guess) => ({ guess, ok: quiz.isCorrect(question, guess) }));
}

// ── the pool ──────────────────────────────────────────────────────
test("quiz: has the 40 questions, each with an answer", () => {
  assert.equal(quiz.QUESTIONS.length, 40);
  for (const question of quiz.QUESTIONS) {
    assert.ok(question.id && question.question, "every question needs an id and text");
    assert.ok(Array.isArray(question.answers) && question.answers.length > 0, `${question.id} has answers`);
  }
  // ids are unique, so a stored pending entry always resolves
  assert.equal(new Set(quiz.QUESTIONS.map((q) => q.id)).size, 40);
  assert.ok(quiz.pickQuestion());
  assert.notEqual(quiz.pickQuestion(["op-crew"]).id, "op-crew");
});

// ── fuzzy matching: the cases the group actually types ─────────────
test("quiz: One Piece answers survive how people really type them", () => {
  const crew = ask("op-crew", [
    "straw hat",
    "straw hats",
    "Straw Hats",
    "STRAWHAT PIRATES",
    "the straw hat pirates",
    "mugiwara",
    "straw hat pirates crew",
  ]);
  for (const { guess, ok } of crew) assert.equal(ok, true, `crew should accept "${guess}"`);

  const zoro = ask("op-zoro", ["zoro", "Zoro", "RORONOA ZORO", "roronoa", "zoroo", "zoro the swordsman"]);
  for (const { guess, ok } of zoro) assert.equal(ok, true, `zoro should accept "${guess}"`);

  const dream = ask("op-dream", ["king of the pirates", "pirate king", "to become the pirate king"]);
  for (const { guess, ok } of dream) assert.equal(ok, true, `dream should accept "${guess}"`);
});

test("quiz: no capitals, punctuation, emoji or accents needed", () => {
  const cases = [
    ["naruto-fox", ["KURAMA!!", "kurama 🦊", "Kurama,"]],
    ["ds-sister", ["NEZUKO", "nezuko!", "Nézuko"]],
    ["jjk-gojo-eyes", ["six eyes", "Six Eyes.", "SIX EYES"]],
    ["poke-meowth", ["meowth", "MEOWTH"]],
    ["hxh-energy", ["nen", "NEN!"]],
  ];
  for (const [id, guesses] of cases) {
    for (const { guess, ok } of ask(id, guesses)) {
      assert.equal(ok, true, `${id} should accept "${guess}"`);
    }
  }
});

test("quiz: partial answers and small typos are accepted", () => {
  const partial = [
    ["naruto-team7-leader", "kakashi"],
    ["mha-deku-name", "izuku"],
    ["mha-deku-name", "midoriya"],
    ["dbs-god-destruction", "beerus"],
    ["dbs-angel", "whis"],
    ["dn-detective", "L"],
    ["dn-detective", "lawliet"],
    ["op-devil-fruit", "gomu gomu no mi"],
    ["bc-asta-magic", "anti magic"],
    ["mha-school", "UA"],
    ["mha-school", "u.a."],
    ["dbs-ultra-instinct", "UI"],
    ["eis-alias", "cid"],
    ["eis-org", "shadow garden"],
    ["eis-elf", "alpha"],
    ["hxh-killua", "zoldyck"],
    ["naruto-fox", "9 tails"],
    ["ds-inosuke-mask", "pig"],
  ];
  for (const [id, guess] of partial) {
    assert.equal(quiz.isCorrect(quiz.getQuestion(id), guess), true, `${id} should accept "${guess}"`);
  }

  const typos = [
    ["naruto-fox", "kuruma"],
    ["ds-sister", "nezuki"],
    ["jjk-sukuna", "ryomen sukunaa"],
    ["dbs-goku-name", "kakarott"],
  ];
  for (const [id, guess] of typos) {
    assert.equal(quiz.isCorrect(quiz.getQuestion(id), guess), true, `${id} should accept typo "${guess}"`);
  }
});

test("quiz: wrong answers are still rejected", () => {
  const wrong = [
    ["naruto-rival", "naruto"],
    ["naruto-rival", "kurama"],
    ["naruto-fox", "sasuke"],
    ["op-crew", "naruto"],
    ["op-zoro", "luffy"],
    ["ds-sister", "tanjiro"],
    ["jjk-protagonist", "gojo"],
    ["poke-first", "raichu"],
    ["mha-school", "hero school"],
    ["dn-ryuk-food", "chocolate"],
    ["", "anything"],
  ];
  for (const [id, guess] of wrong) {
    const question = id ? quiz.getQuestion(id) : { answers: [] };
    assert.equal(quiz.isCorrect(question, guess), false, `${id || "(none)"} must reject "${guess}"`);
  }

  // empty / junk input never passes
  const crew = quiz.getQuestion("op-crew");
  for (const junk of ["", "   ", "?!", "🙂", null, undefined]) {
    assert.equal(quiz.isCorrect(crew, junk), false);
  }
});

test("quiz: no question accepts another question's answer", () => {
  // The fuzzy matcher is generous, so this is the guard rail: answering one
  // question's answer to a different question must never pass.
  const collisions = [];
  for (const source of quiz.QUESTIONS) {
    for (const guess of source.answers) {
      for (const target of quiz.QUESTIONS) {
        if (target.id === source.id) continue;
        if (quiz.isCorrect(target, guess)) {
          collisions.push(`${source.id} "${guess}" passed ${target.id}`);
        }
      }
    }
  }
  assert.deepEqual(collisions, [], `unexpected cross-accepts:\n${collisions.join("\n")}`);
});

test("quiz: nicknames and short forms people actually use", () => {
  const shortForms = [
    ["mha-deku-name", "deku"],
    ["mha-deku-name", "Deku"],
    ["op-crew", "hats"],
    ["op-crew", "straw"],
    ["naruto-village", "leaf"],
    ["naruto-village", "Konoha"],
    ["hxh-energy", "Nen"],
    ["dbs-ultra-instinct", "UI"],
    ["dn-detective", "L"],
  ];
  for (const [id, guess] of shortForms) {
    assert.equal(quiz.isCorrect(quiz.getQuestion(id), guess), true, `${id} should accept "${guess}"`);
  }
});

// ── the verification flow ────────────────────────────────────────
// Loads middleware/joinVerification.js with its group helpers stubbed, so the
// flow can be driven end to end without whatsapp.
function loadVerification({ welcome = true } = {}) {
  const joinPath = path.join(ROOT, "middleware", "joinVerification.js");
  const store = require(path.join(ROOT, "utils", "verificationStore.js"));
  const sent = [];
  const removed = [];

  const sock = {
    user: { id: "999@s.whatsapp.net" },
    sendMessage: async (jid, payload) => sent.push(payload),
    groupParticipantsUpdate: async (jid, ids, action) => removed.push({ ids, action }),
    groupMetadata: async () => ({ id: "g@g.us", participants: [] }),
  };

  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (parent && parent.filename === joinPath) {
      if (request === "../utils/groupSettings") return { getSettings: () => ({ welcome }) };
      if (request === "../utils/groupPermissions") {
        return {
          isParticipantAdmin: () => true,
          findParticipant: () => null,
          getGroupMetadata: async () => ({ id: "g@g.us", participants: [] }),
          botAliases: () => ["999@s.whatsapp.net"],
          aliasesOf: (p) => {
            const value = typeof p === "string" ? p : p?.id;
            return value ? [value] : [];
          },
          intersects: () => false,
        };
      }
    }
    return originalLoad.apply(this, arguments);
  };

  delete require.cache[require.resolve(joinPath)];
  const verification = require(joinPath);
  Module._load = originalLoad;

  return { ...verification, sock, sent, removed, store };
}

const GROUP = "1203630@g.us";
const MEMBER = "2348011111111@s.whatsapp.net";

test("verification: asks an anime question instead of arithmetic", async () => {
  const flow = loadVerification();
  flow.store.removePending(GROUP, MEMBER);

  await flow.startVerification(flow.sock, GROUP, { id: MEMBER });

  const text = flow.sent.at(-1).text;
  assert.match(text, /Welcome/);
  assert.doesNotMatch(text, /\d+ \+ \d+ = \?/, "no more maths");
  assert.doesNotMatch(text, /Just reply with the number/);

  // the asked question is one of the 40, and it is what the store remembers
  const entry = flow.store.getPending(GROUP, MEMBER);
  const question = quiz.getQuestion(entry.questionId);
  assert.ok(question, "pending entry points at a real question");
  assert.ok(text.includes(question.question));
  assert.equal(entry.stage, "quiz");

  flow.store.removePending(GROUP, MEMBER);
});

test("verification: any close-enough answer passes and moves to the profile step", async () => {
  const flow = loadVerification();
  flow.store.removePending(GROUP, MEMBER);
  await flow.startVerification(flow.sock, GROUP, { id: MEMBER });
  const entry = flow.store.getPending(GROUP, MEMBER);
  const question = quiz.getQuestion(entry.questionId);

  // Answer the way a person would: one word from the accepted variants.
  const shortAnswer = question.answers[0].split(" ")[0].toUpperCase();

  const consumed = await flow.checkVerificationReply(
    flow.sock,
    { key: { remoteJid: GROUP, participant: MEMBER } },
    shortAnswer
  );

  assert.equal(consumed, true);
  assert.match(flow.sent.at(-1).text, /verified|welcome aboard/i);
  assert.equal(flow.store.getPending(GROUP, MEMBER).stage, "profile");
  flow.store.removePending(GROUP, MEMBER);
});

test("verification: a wrong answer does not pass, and nudges at most twice", async () => {
  const flow = loadVerification();
  flow.store.removePending(GROUP, MEMBER);
  await flow.startVerification(flow.sock, GROUP, { id: MEMBER });
  const entry = flow.store.getPending(GROUP, MEMBER);
  const question = quiz.getQuestion(entry.questionId);

  // pick a guess that is definitely not this answer
  const wrongGuess = question.id === "op-zoro" ? "naruto" : "zzz nonsense";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await flow.checkVerificationReply(
      flow.sock,
      { key: { remoteJid: GROUP, participant: MEMBER } },
      wrongGuess
    );
    assert.equal(flow.store.getPending(GROUP, MEMBER).stage, "quiz", "still unverified");
  }

  const nudges = flow.sent.filter((message) => /not quite/.test(message.text || ""));
  assert.equal(nudges.length, 2, "nudges stop after two tries but they can still answer");
  flow.store.removePending(GROUP, MEMBER);
});

test("verification: no challenge when welcome is off", async () => {
  const flow = loadVerification({ welcome: false });
  flow.store.removePending(GROUP, MEMBER);

  await flow.startVerification(flow.sock, GROUP, { id: MEMBER });

  assert.equal(flow.sent.length, 0);
  assert.equal(flow.store.getPending(GROUP, MEMBER), undefined);
});
