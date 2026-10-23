// The anime quiz used by the welcome verification flow.
//
// 40 questions, each with every answer variant a normal person might type.
// Matching is deliberately generous: lowercase, punctuation/emoji ignored,
// "the/a/an/of" ignored, plurals folded, partial answers accepted ("straw hat",
// "hats", "zoro") and small typos tolerated ("kuruma", "nezuki").
//
// A wrong answer never passes: the guess has to match one of the variants for
// that specific question, so answering "sasuke" to a Naruto question is fine
// but answering "naruto" to "who is his rival" is not.

const QUESTIONS = [
  // ── Naruto ──────────────────────────────────────────────────────
  {
    id: "naruto-fox",
    category: "Naruto",
    question: "What is the name of the Nine-Tailed Fox sealed inside Naruto?",
    answers: ["kurama", "nine tails", "nine tailed fox", "the nine tails", "kyuubi", "kurama the nine tails"],
  },
  {
    id: "naruto-team7-leader",
    category: "Naruto",
    question: "Who is the leader of Team 7?",
    answers: ["kakashi", "kakashi hatake", "hatake kakashi", "copy ninja kakashi"],
  },
  {
    id: "naruto-village",
    category: "Naruto",
    question: "Which village is Naruto from?",
    answers: ["konoha", "hidden leaf", "hidden leaf village", "leaf village", "leaf", "konohagakure", "the leaf", "village hidden in the leaves", "konoha village"],
  },
  {
    id: "naruto-rival",
    category: "Naruto",
    question: "Who is Naruto's biggest rival?",
    answers: ["sasuke", "sasuke uchiha", "uchiha sasuke"],
  },

  // ── Demon Slayer ────────────────────────────────────────────────
  {
    id: "ds-sister",
    category: "Demon Slayer",
    question: "What is Tanjiro's sister's name?",
    answers: ["nezuko", "nezuko kamado", "kamado nezuko"],
  },
  {
    id: "ds-breathing",
    category: "Demon Slayer",
    question: "What breathing style does Tanjiro mainly use?",
    answers: ["water breathing", "water", "water style", "water breath", "mizu no kokyu"],
  },
  {
    id: "ds-demon-king",
    category: "Demon Slayer",
    question: "Who is the king of the demons?",
    answers: ["muzan", "muzan kibutsuji", "kibutsuji muzan", "kibutsuji"],
  },
  {
    id: "ds-inosuke-mask",
    category: "Demon Slayer",
    question: "What animal head does Inosuke wear as a mask?",
    answers: ["boar", "boar head", "a boar", "wild boar", "pig", "pig head"],
  },

  // ── Jujutsu Kaisen ──────────────────────────────────────────────
  {
    id: "jjk-protagonist",
    category: "Jujutsu Kaisen",
    question: "Who is the main protagonist?",
    answers: ["yuji", "yuji itadori", "itadori", "itadori yuji"],
  },
  {
    id: "jjk-sukuna",
    category: "Jujutsu Kaisen",
    question: "Which King of Curses is sealed inside Yuji?",
    answers: ["sukuna", "ryomen sukuna", "ryomen", "the king of curses sukuna"],
  },
  {
    id: "jjk-gojo-eyes",
    category: "Jujutsu Kaisen",
    question: "What are Gojo's special eyes called?",
    answers: ["six eyes", "the six eyes", "rokugan"],
  },
  {
    id: "jjk-fight",
    category: "Jujutsu Kaisen",
    question: "What do jujutsu sorcerers fight?",
    answers: ["curses", "cursed spirits", "curse spirits", "cursed energy spirits"],
  },

  // ── Dragon Ball Super ───────────────────────────────────────────
  {
    id: "dbs-goku-name",
    category: "Dragon Ball Super",
    question: "What is Goku's Saiyan birth name?",
    answers: ["kakarot", "kakarotto", "kakarot son"],
  },
  {
    id: "dbs-god-destruction",
    category: "Dragon Ball Super",
    question: "Who is the God of Destruction of Universe 7?",
    answers: ["beerus", "lord beerus", "bills"],
  },
  {
    id: "dbs-angel",
    category: "Dragon Ball Super",
    question: "What is Beerus's angel attendant called?",
    answers: ["whis", "whis the angel"],
  },
  {
    id: "dbs-ultra-instinct",
    category: "Dragon Ball Super",
    question: "What silver-haired form does Goku unlock in the Tournament of Power?",
    answers: ["ultra instinct", "ui", "ultra instinct sign", "mastered ultra instinct", "mui"],
  },

  // ── Death Note ──────────────────────────────────────────────────
  {
    id: "dn-finds-note",
    category: "Death Note",
    question: "Who finds the Death Note?",
    answers: ["light", "light yagami", "yagami light", "kira"],
  },
  {
    id: "dn-shinigami",
    category: "Death Note",
    question: "Which Shinigami follows Light around?",
    answers: ["ryuk", "ryuk the shinigami", "ryuuk"],
  },
  {
    id: "dn-detective",
    category: "Death Note",
    question: "Which famous detective hunts Kira?",
    answers: ["l", "lawliet", "l lawliet", "detective l", "ryuzaki"],
  },
  {
    id: "dn-ryuk-food",
    category: "Death Note",
    question: "What is Ryuk's favorite food?",
    answers: ["apples", "apple", "red apples"],
  },

  // ── The Eminence in Shadow ──────────────────────────────────────
  {
    id: "eis-alias",
    category: "The Eminence in Shadow",
    question: "What is the protagonist's \"shadow\" alias?",
    answers: ["shadow", "cid", "cid kagenou", "kagenou cid", "shadow cid"],
  },
  {
    id: "eis-org",
    category: "The Eminence in Shadow",
    question: "What is the name of Shadow's organization?",
    answers: ["shadow garden", "the shadow garden", "shadow gardens"],
  },
  {
    id: "eis-elf",
    category: "The Eminence in Shadow",
    question: "Who is the elf who leads the Seven Shadows?",
    answers: ["alpha", "alpha the elf", "lady alpha"],
  },

  // ── My Hero Academia ────────────────────────────────────────────
  {
    id: "mha-deku-name",
    category: "My Hero Academia",
    question: "What is Deku's real name?",
    answers: ["izuku", "izuku midoriya", "midoriya", "midoriya izuku", "deku"],
  },
  {
    id: "mha-allmight-quirk",
    category: "My Hero Academia",
    question: "What is All Might's quirk called?",
    answers: ["one for all", "oneforall", "ofa"],
  },
  {
    id: "mha-bakugo-quirk",
    category: "My Hero Academia",
    question: "What is Bakugo's quirk?",
    answers: ["explosion", "explosions", "explosion quirk", "nitroglycerin"],
  },
  {
    id: "mha-school",
    category: "My Hero Academia",
    question: "What is the name of the hero school?",
    answers: ["ua", "u a", "ua high", "ua high school", "u a high school", "yuei"],
  },

  // ── Black Clover ────────────────────────────────────────────────
  {
    id: "bc-asta-magic",
    category: "Black Clover",
    question: "What kind of magic does Asta have?",
    answers: ["anti magic", "antimagic", "anti magic swords", "no magic", "none"],
  },
  {
    id: "bc-asta-dream",
    category: "Black Clover",
    question: "What is Asta's dream?",
    answers: ["wizard king", "to become the wizard king", "become wizard king", "magic emperor"],
  },
  {
    id: "bc-yuno",
    category: "Black Clover",
    question: "Who is Asta's rival and fellow orphan?",
    answers: ["yuno", "yuno grinnberyall", "yuno grinberryall"],
  },

  // ── Hunter x Hunter ─────────────────────────────────────────────
  {
    id: "hxh-gon-father",
    category: "Hunter x Hunter",
    question: "Who is Gon's father?",
    answers: ["ging", "ging freecss", "freecss", "ging freecs"],
  },
  {
    id: "hxh-killua",
    category: "Hunter x Hunter",
    question: "Who is Gon's best friend, from an assassin family?",
    answers: ["killua", "killua zoldyck", "zoldyck killua", "zoldyck"],
  },
  {
    id: "hxh-energy",
    category: "Hunter x Hunter",
    question: "What is the energy system in HxH called?",
    answers: ["nen", "nen aura"],
  },

  // ── Pokémon ─────────────────────────────────────────────────────
  {
    id: "poke-first",
    category: "Pokémon",
    question: "What was Ash's first Pokémon?",
    answers: ["pikachu", "pika"],
  },
  {
    id: "poke-evolve",
    category: "Pokémon",
    question: "What does Pikachu evolve into?",
    answers: ["raichu", "alolan raichu"],
  },
  {
    id: "poke-meowth",
    category: "Pokémon",
    question: "Which Team Rocket member is a talking Pokémon?",
    answers: ["meowth", "meowth the pokemon", "team rocket meowth"],
  },

  // ── One Piece ───────────────────────────────────────────────────
  {
    id: "op-devil-fruit",
    category: "One Piece",
    question: "What Devil Fruit did Luffy eat?",
    answers: ["gum gum", "gum gum fruit", "gomu gomu", "gomu gomu no mi", "gum gum no mi", "hito hito no mi model nika", "nika"],
  },
  {
    id: "op-crew",
    category: "One Piece",
    question: "What is Luffy's crew called?",
    answers: ["straw hat pirates", "straw hats", "strawhat pirates", "strawhats", "straw hat crew", "the straw hats", "mugiwara", "mugiwara pirates", "hats", "straw", "hat", "straw hat"],
  },
  {
    id: "op-dream",
    category: "One Piece",
    question: "What is Luffy's dream?",
    answers: ["king of the pirates", "pirate king", "to be pirate king", "to become king of the pirates", "to become the pirate king", "become the pirate king"],
  },
  {
    id: "op-zoro",
    category: "One Piece",
    question: "Which swordsman uses three swords and is Luffy's first crewmate?",
    answers: ["zoro", "roronoa zoro", "zoro roronoa", "roronoa", "zoro the swordsman"],
  },
];

// Words that carry no meaning for matching. "the straw hat pirates" and
// "straw hats" must be considered the same answer.
const STOPWORDS = new Set(["the", "a", "an", "of", "is", "named", "called", "in", "to", "and", "his", "her", "its"]);

const DIGIT_WORDS = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
  6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
};

/** Lowercase, strip accents/punctuation, collapse whitespace. */
function normalize(text) {
  return String(text || "")
    .replace(/\b(10|[1-9])\b/g, (digit) => DIGIT_WORDS[Number(digit)] || digit)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // é -> e
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’`]/g, "") // gojo's -> gojos
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Meaningful tokens, with simple plural folding ("hats" -> "hat"). */
function tokens(text) {
  return normalize(text)
    .split(" ")
    .filter((token) => token && !STOPWORDS.has(token))
    .map(singular);
}

function singular(token) {
  if (token.length <= 3) return token;
  if (/ies$/.test(token)) return `${token.slice(0, -3)}y`;
  if (/es$/.test(token) && /(ch|sh|x|ss)$/.test(token.slice(0, -2))) return token.slice(0, -2);
  if (/s$/.test(token) && !/ss$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Small Levenshtein with an early exit on length difference. */
function distance(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 3;

  const previous = new Array(b.length + 1).fill(0).map((_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let last = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const saved = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        last + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      last = saved;
    }
  }
  return previous[b.length];
}

/**
 * Are two tokens the same word, typos included?
 *
 * Short words are the risky ones: "king" and "ging" are one edit apart, as are
 * "yuji" and "yuei", so a 4-letter word only tolerates a typo when it is the
 * same word with a letter added ("zoro"/"zoroo"). From 5 letters up, a single
 * edit is a typo ("kurama"/"kuruma"), and long words get two.
 */
function tokenMatches(a, b) {
  if (a === b) return true;

  const shortest = Math.min(a.length, b.length);
  if (shortest < 4) return false;

  const edits = distance(a, b);
  if (edits === 0) return true;
  if (shortest === 4) return edits === 1 && (a.startsWith(b) || b.startsWith(a));
  if (shortest <= 8) return edits === 1;
  return edits <= 2;
}

/**
 * Does this guess answer the question?
 *
 * Accepts, in order of strictness:
 *   1. the whole string matches a variant
 *   2. the guess is a subset of a variant ("zoro" for "roronoa zoro",
 *      "straw hat" for "straw hat pirates")
 *   3. most of a variant's words appear in the guess ("pirates straw hat")
 *   4. the strings are near-identical apart from typos
 */
function isCorrect(question, guess) {
  const guessText = normalize(guess);
  if (!guessText) return false;

  const guessTokens = tokens(guess);

  for (const variant of question.answers || []) {
    const variantText = normalize(variant);
    if (!variantText) continue;

    // 1. same thing, once case/punctuation/plurals are normalised
    if (guessText === variantText) return true;

    const variantTokens = tokens(variant);
    if (!variantTokens.length) continue;

    const matchedVariantTokens = variantTokens.filter((v) =>
      guessTokens.some((token) => tokenMatches(token, v))
    );
    const matchedGuessTokens = guessTokens.filter((token) =>
      variantTokens.some((v) => tokenMatches(token, v))
    );

    const coverage = matchedVariantTokens.length / variantTokens.length;
    const guessIsSubset = guessTokens.length > 0 && matchedGuessTokens.length === guessTokens.length;

    if (!guessIsSubset && matchedVariantTokens.length === 0) continue;

    // A one-word answer ("shadow") is a different thing from a phrase that
    // merely contains it ("shadow garden"), so single-word variants have to be
    // answered with a single word. Longer variants are listed in the data when
    // a longer phrasing is legitimately correct.
    if (variantTokens.length === 1) {
      if (guessTokens.length === 1 && tokenMatches(guessTokens[0], variantTokens[0])) return true;
      continue;
    }

    // 2. the whole answer appears inside a longer guess
    //    ("straw hat pirates crew" ~ "straw hat pirates")
    if (matchedVariantTokens.length === variantTokens.length && guessTokens.length <= variantTokens.length + 3) {
      return true;
    }

    // 3. the guess is a real part of the answer, but it has to be most of it:
    //    "straw hat" (2 of 3) passes, a single stray word never does
    //    ("curses" must not answer "the king of curses sukuna").
    const needed = variantTokens.length === 1 ? 1 : 0.6;
    if (guessIsSubset && coverage >= needed) return true;

    // 4. near-complete coverage in either direction
    if (coverage >= 0.8) return true;

    // 5. whole-string typo tolerance ("ryomen sukunaa"), same first letter so
    //    unrelated names can't drift into each other
    if (
      guessText.length >= 5 &&
      guessText[0] === variantText[0] &&
      distance(guessText, variantText) <= (variantText.length >= 10 ? 2 : 1)
    ) {
      return true;
    }
  }

  return false;
}

/** Pick a random question, optionally avoiding ones already used recently. */
function pickQuestion(excludeIds = []) {
  const pool = QUESTIONS.filter((entry) => !excludeIds.includes(entry.id));
  const list = pool.length ? pool : QUESTIONS;
  return list[Math.floor(Math.random() * list.length)];
}

/** Build the pending-record payload for a question. */
function questionPayload(question) {
  return { questionId: question.id, category: question.category, question: question.question };
}

function getQuestion(id) {
  return QUESTIONS.find((entry) => entry.id === id) || null;
}

module.exports = {
  QUESTIONS,
  pickQuestion,
  isCorrect,
  getQuestion,
  questionPayload,
  // exposed for tests
  normalize,
  tokens,
  distance,
};
