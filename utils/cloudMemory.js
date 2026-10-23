// Per-person memory for the .cloud brain.
//
// Two separate things are stored:
//
//   1. people[personId]      — who they are: name, aliases, lasting facts.
//                              Keyed by phone number, so the same person is
//                              recognised in every chat.
//   2. conversations[key]    — the running transcript, keyed by
//                              "<chatJid>:<personId>". That is what keeps two
//                              people in the same group from sharing one
//                              conversation: the chat AND the person are both
//                              part of the key.
//
// Persisted through utils/persist.js, so it survives restarts (JSON files
// locally, MongoDB when MONGODB_URI is set).

const persist = require("./persist");

const STORE = "cloudMemory";
const MAX_TURNS = 16; // kept per conversation (user + assistant entries)
const MAX_PEOPLE = 2000; // hard cap so the document stays small
const MAX_FACTS = 20;

const emptyStore = () => ({ people: {}, conversations: {} });

function store() {
  const value = persist.get(STORE, null);
  if (!value || typeof value !== "object") return emptyStore();
  return {
    people: value.people && typeof value.people === "object" ? value.people : {},
    conversations:
      value.conversations && typeof value.conversations === "object"
        ? value.conversations
        : {},
  };
}

function save(value) {
  persist.set(STORE, value);
}

function bareNumber(jid) {
  return String(jid || "").split("@")[0].split(":")[0];
}

/**
 * Work out who sent this message and which chat it came from.
 * Handles groups (participant), DMs, and the @lid participants newer
 * whatsapp builds use in place of a phone number.
 */
function identify(msg) {
  const chatId = msg?.key?.remoteJid || "unknown";

  // DM: the chat IS the person. Group: participant is the sender.
  const raw =
    msg?.key?.participantPn ||
    msg?.participantPn ||
    msg?.key?.participant ||
    msg?.participant ||
    (chatId.endsWith("@g.us") ? null : chatId) ||
    "unknown";

  const personId = bareNumber(raw) || "unknown";
  const chatType = chatId.endsWith("@g.us") ? "group" : "dm";

  return {
    chatId,
    chatType,
    isGroup: chatType === "group",
    personId,
    pushName: String(msg?.pushName || "").trim(),
    // Two people in one group never share a conversation; one person in two
    // groups keeps them separate too.
    conversationKey: `${chatId}:${personId}`,
  };
}

function getPerson(personId) {
  return store().people[personId] || null;
}

/** Name we can use for this person: learned name first, then whatsapp name. */
function nameOf(identity) {
  const person = getPerson(identity.personId);
  if (person?.name) return person.name;
  return null;
}

/** Update (or create) the person record. */
function rememberPerson(identity, { name, fact } = {}) {
  const value = store();
  const person =
    value.people[identity.personId] ||
    { id: identity.personId, name: null, facts: [], firstSeen: Date.now() };

  if (name) {
    const clean = String(name).trim().slice(0, 32);
    if (clean) {
      person.name = clean;
      person.aliases = Array.from(new Set([...(person.aliases || []), clean])).slice(-5);
    }
  }

  if (fact) {
    const clean = String(fact).trim().slice(0, 160);
    if (clean) {
      person.facts = Array.from(new Set([...(person.facts || []), clean])).slice(-MAX_FACTS);
    }
  }

  person.displayName = identity.pushName || person.displayName || null;
  person.lastChat = identity.chatId;
  person.lastSeen = Date.now();

  value.people[identity.personId] = person;

  // Trim the oldest people if the store grows too large.
  const ids = Object.keys(value.people);
  if (ids.length > MAX_PEOPLE) {
    ids
      .sort((a, b) => (value.people[a].lastSeen || 0) - (value.people[b].lastSeen || 0))
      .slice(0, ids.length - MAX_PEOPLE)
      .forEach((id) => delete value.people[id]);
  }

  save(value);
  return person;
}

function historySize(identity) {
  return (store().conversations[identity.conversationKey] || []).length;
}

/** Previous turns for THIS person in THIS chat, oldest first. */
function getHistory(identity) {
  const turns = store().conversations[identity.conversationKey] || [];
  return turns.map((turn) => ({ role: turn.role, content: turn.text }));
}

function appendTurn(identity, role, text) {
  const value = store();
  const key = identity.conversationKey;
  const turns = value.conversations[key] || [];
  turns.push({ role, text: String(text || "").slice(0, 2000), at: Date.now() });
  value.conversations[key] = turns.slice(-MAX_TURNS);
  save(value);
}

function clearConversation(identity) {
  const value = store();
  delete value.conversations[identity.conversationKey];
  save(value);
}

/** Forget everything about a person (their name, facts and every transcript). */
function forgetPerson(identity) {
  const value = store();
  delete value.people[identity.personId];
  for (const key of Object.keys(value.conversations)) {
    if (key.endsWith(`:${identity.personId}`)) delete value.conversations[key];
  }
  save(value);
}

// ── learning from a reply ─────────────────────────────────────────
// The personality file asks the model to end a reply with
//   <remember name="sam"/>  or  <remember fact="loves burna boy"/>
// only when it actually learned something. Those tags never reach whatsapp.
const REMEMBER_RE = /<remember\s+([a-z]+)\s*=\s*"([^"]*)"\s*\/?>/gi;

function extractRememberTags(reply) {
  const updates = [];
  const cleaned = String(reply || "").replace(REMEMBER_RE, (_, key, value) => {
    updates.push({ key: key.toLowerCase(), value: value.trim() });
    return "";
  });
  return { text: cleaned.trim(), updates };
}

// Backup path: catch "my name is sam" / "call me sam" even if the model
// forgets to emit a tag. Deliberately narrow so "i'm tired" is not a name.
const NAME_PATTERNS = [
  /\bmy name is\s+([A-Za-z][A-Za-z'-]{1,20})\b/i,
  /\bcall me\s+([A-Za-z][A-Za-z'-]{1,20})\b/i,
  /\bthey call me\s+([A-Za-z][A-Za-z'-]{1,20})\b/i,
  /\bi go by\s+([A-Za-z][A-Za-z'-]{1,20})\b/i,
];

function detectName(text) {
  const value = String(text || "");
  for (const pattern of NAME_PATTERNS) {
    const match = value.match(pattern);
    // cloud talks in lowercase, so store and reuse the name that way.
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Record one exchange. Called after a successful reply, so a failed API call
 * never leaves a dangling user message in the transcript.
 */
function recordExchange(identity, userText, replyText) {
  const { text, updates } = extractRememberTags(replyText);

  const learnedName =
    updates.find((update) => update.key === "name")?.value || detectName(userText);
  const facts = updates
    .filter((update) => update.key === "fact" || update.key === "note")
    .map((update) => update.value);

  if (learnedName || facts.length) {
    rememberPerson(identity, { name: learnedName || undefined, fact: facts[0] });
    for (const fact of facts.slice(1)) rememberPerson(identity, { fact });
  } else {
    // Touch the record so lastSeen/lastChat stay fresh.
    rememberPerson(identity, {});
  }

  appendTurn(identity, "user", userText);
  appendTurn(identity, "assistant", text);
  return text;
}

module.exports = {
  identify,
  nameOf,
  getPerson,
  rememberPerson,
  getHistory,
  appendTurn,
  historySize,
  clearConversation,
  forgetPerson,
  extractRememberTags,
  detectName,
  recordExchange,
  MAX_TURNS,
  _reset: () => save(emptyStore()),
};
