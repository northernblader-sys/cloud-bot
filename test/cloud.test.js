// Offline tests for the .cloud brain: personality, per-person memory and the
// OpenRouter call shape. No network: global fetch is stubbed.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

// Keep persist's JSON files out of the repo.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-memory-"));
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const memory = require(path.join(ROOT, "utils", "cloudMemory.js"));
const personality = require(path.join(ROOT, "utils", "cloudPersonality.js"));
const openrouter = require(path.join(ROOT, "utils", "openrouter.js"));

// The key is never committed; tests inject a fake one.
process.env.OPENROUTER_API_KEY = "sk-or-v1-test-key";
const brain = require(path.join(ROOT, "utils", "cloudBrain.js"));

const GROUP = "1203630@g.us";
const OTHER_GROUP = "9999999@g.us";

function groupMsg(participant, text = "", pushName = "") {
  return { key: { remoteJid: GROUP, participant, fromMe: false }, pushName, text };
}

function dmMsg(jid, text = "", pushName = "") {
  return { key: { remoteJid: jid, fromMe: false }, pushName, text };
}

function resetMemory() {
  memory._reset();
}

// ── identity / isolation ──────────────────────────────────────────
test("memory: two people in the same group get separate conversations", () => {
  resetMemory();
  const sam = memory.identify(groupMsg("2348011111111@s.whatsapp.net"));
  const ada = memory.identify(groupMsg("2348022222222@s.whatsapp.net"));

  assert.notEqual(sam.conversationKey, ada.conversationKey);
  assert.equal(sam.chatId, ada.chatId, "same group");
  assert.equal(sam.personId, "2348011111111");
  assert.equal(sam.isGroup, true);
});

test("memory: the same person in two chats keeps two transcripts", () => {
  resetMemory();
  const inGroup = memory.identify(groupMsg("2348011111111@s.whatsapp.net"));
  const inDm = memory.identify(dmMsg("2348011111111@s.whatsapp.net"));

  assert.notEqual(inGroup.conversationKey, inDm.conversationKey);
  assert.equal(inGroup.personId, inDm.personId, "but it is the same person");
});

test("memory: prefers the phone jid over an @lid participant", () => {
  resetMemory();
  const msg = {
    key: {
      remoteJid: GROUP,
      participant: "123456789012345@lid",
      participantPn: "2348033333333@s.whatsapp.net",
    },
  };
  const identity = memory.identify(msg);
  assert.equal(identity.personId, "2348033333333");
});

test("memory: transcripts never leak between people", () => {
  resetMemory();
  const sam = memory.identify(groupMsg("2348011111111@s.whatsapp.net"));
  const ada = memory.identify(groupMsg("2348022222222@s.whatsapp.net"));

  memory.recordExchange(sam, "i like burna boy", "noted, burna is elite");
  memory.recordExchange(ada, "i like wizkid", "wizkid dey give vibes");

  assert.deepEqual(
    memory.getHistory(sam).map((turn) => turn.content),
    ["i like burna boy", "noted, burna is elite"]
  );
  assert.deepEqual(
    memory.getHistory(ada).map((turn) => turn.content),
    ["i like wizkid", "wizkid dey give vibes"]
  );
});

// ── name learning ─────────────────────────────────────────────────
test("memory: learns a name from the model's <remember> tag and strips it", () => {
  resetMemory();
  const identity = memory.identify(groupMsg("2348011111111@s.whatsapp.net", "", "Sammy"));

  const sent = memory.recordExchange(identity, "im sam", 'nice to meet you sam.<remember name="sam"/>');

  assert.equal(sent, "nice to meet you sam.", "the tag never reaches whatsapp");
  assert.equal(memory.nameOf(identity), "sam");
  assert.equal(memory.getPerson(identity.personId).name, "sam");
});

test("memory: also catches a plain 'my name is ...' if the model forgets the tag", () => {
  resetMemory();
  const identity = memory.identify(dmMsg("2348044444444@s.whatsapp.net"));

  memory.recordExchange(identity, "hi my name is Ada", "hey ada");
  assert.equal(memory.nameOf(identity), "ada");

  // ...but ordinary sentences are not names.
  resetMemory();
  const other = memory.identify(dmMsg("2348055555555@s.whatsapp.net"));
  memory.recordExchange(other, "i'm tired", "go sleep");
  assert.equal(memory.nameOf(other), null);
});

test("memory: remembers facts and forgets everything on request", () => {
  resetMemory();
  const identity = memory.identify(dmMsg("2348066666666@s.whatsapp.net"));

  memory.recordExchange(identity, "i play chess", 'classy.<remember name="tunde"/><remember fact="plays chess"/>');
  const person = memory.getPerson(identity.personId);
  assert.equal(person.name, "tunde");
  assert.deepEqual(person.facts, ["plays chess"]);

  memory.forgetPerson(identity);
  assert.equal(memory.getPerson(identity.personId), null);
  assert.deepEqual(memory.getHistory(identity), []);
});

test("memory: history is capped so a long chat cannot grow forever", () => {
  resetMemory();
  const identity = memory.identify(dmMsg("2348077777777@s.whatsapp.net"));

  for (let i = 0; i < 40; i += 1) memory.recordExchange(identity, `msg ${i}`, `reply ${i}`);

  const history = memory.getHistory(identity);
  assert.equal(history.length, memory.MAX_TURNS);
  assert.equal(history[history.length - 1].content, "reply 39");
});

// ── personality ───────────────────────────────────────────────────
test("personality: prompt carries identity, tone and the member's name", () => {
  const prompt = personality.buildSystemPrompt({
    memberName: "sam",
    isGroup: true,
    facts: ["plays chess"],
  });

  assert.match(prompt, /cloud astral 1\.2/);
  assert.match(prompt, /never say you are gemini/i);
  assert.match(prompt, /no em dashes/i);
  assert.match(prompt, /this person's name is sam/);
  assert.match(prompt, /plays chess/);
  assert.match(prompt, /group chat/);
  assert.match(prompt, /separate conversations/);
});

test("personality: with no name it is told not to guess", () => {
  const prompt = personality.buildSystemPrompt({ pushName: "🔥🔥" });
  assert.match(prompt, /do not know this person's name/);
  assert.doesNotMatch(prompt, /this person's name is/);
});

test("personality: em dashes and markdown are cleaned from replies", () => {
  const styled = personality.styleReply("sure — **i can** do that");
  assert.equal(styled, "sure, i can do that");
});

// ── openrouter call shape ─────────────────────────────────────────
function stubFetch(handler) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    return handler(body, calls.length);
  };
  return {
    calls,
    restore: () => {
      global.fetch = original;
    },
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test("openrouter: sends the hardcoded key and the site headers", async () => {
  const stub = stubFetch(() =>
    jsonResponse({ model: "openai/gpt-4o-mini", choices: [{ message: { role: "assistant", content: "hi" } }] })
  );

  try {
    const result = await openrouter.chatCompletion({ messages: [{ role: "user", content: "hey" }] });
    const call = stub.calls[0];

    assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.match(call.options.headers.Authorization, /^Bearer sk-or-v1-/);
    assert.equal(call.options.headers["X-Title"], "astral cloud");
    assert.ok(call.options.headers["HTTP-Referer"]);
    assert.equal(call.body.model, "openai/gpt-4o-mini");
    assert.equal(result.text, "hi");
  } finally {
    stub.restore();
  }
});

test("openrouter: falls back to the secondary model on 429", async () => {
  const stub = stubFetch((body) =>
    body.model === "openai/gpt-4o-mini"
      ? jsonResponse({ error: { message: "rate limited" } }, 429)
      : jsonResponse({ model: body.model, choices: [{ message: { content: "from fallback" } }] })
  );

  try {
    const result = await openrouter.chatWithRetry({ messages: [{ role: "user", content: "hey" }] });
    assert.equal(result.text, "from fallback");
    assert.equal(stub.calls.length, 2);
    assert.equal(stub.calls[1].body.model, openrouter.FALLBACK_MODEL);
  } finally {
    stub.restore();
  }
});

test("brain: passes the model one message per person and no one else's history", async () => {
  resetMemory();
  const samMsg = groupMsg("2348011111111@s.whatsapp.net", "hello");
  const adaMsg = groupMsg("2348022222222@s.whatsapp.net", "hello");

  memory.recordExchange(memory.identify(samMsg), "my name is sam", "hey sam");

  const stub = stubFetch(() =>
    jsonResponse({ choices: [{ message: { content: "hey sam, whats good" } }] })
  );

  try {
    await brain.answerWithSearch("whats up", { msg: samMsg });

    const samRequest = JSON.stringify(stub.calls[0].body.messages);
    assert.match(samRequest, /this person's name is sam/);
    assert.match(samRequest, /my name is sam/, "prior turn included");
    assert.ok(stub.calls[0].body.plugins?.some((plugin) => plugin.id === "web"), "grounded");

    await brain.answerWithSearch("whats up", { msg: adaMsg });
    const adaRequest = JSON.stringify(stub.calls[1].body.messages);
    assert.doesNotMatch(adaRequest, /my name is sam/, "ada must not see sam's history");
    assert.doesNotMatch(adaRequest, /this person's name is sam/);
  } finally {
    stub.restore();
  }
});

test("brain: routing asks for exactly one tool in openai's format", async () => {
  resetMemory();
  const stub = stubFetch(() =>
    jsonResponse({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "1", type: "function", function: { name: "play_song", arguments: '{"query":"burna boy ye"}' } },
            ],
          },
        },
      ],
    })
  );

  try {
    const routed = await brain.routeMessage("play ye by burna boy", { msg: dmMsg("2348088888888@s.whatsapp.net") });

    assert.deepEqual(routed, { name: "play_song", args: { query: "burna boy ye" } });
    assert.equal(stub.calls[0].body.tool_choice, "required");
    assert.ok(stub.calls[0].body.tools.every((tool) => tool.type === "function"));
    assert.ok(stub.calls[0].body.tools.some((tool) => tool.function.name === "no_tool_needed"));
  } finally {
    stub.restore();
  }
});

test("brain: a reply's <remember> tag is stored and never sent to whatsapp", async () => {
  resetMemory();
  const msg = dmMsg("2348099999999@s.whatsapp.net", "im sam");

  const stub = stubFetch(() =>
    jsonResponse({ choices: [{ message: { content: 'hey sam, noted.<remember name="sam"/><remember fact="likes chess"/>' } }] })
  );

  try {
    const reply = await brain.answerWithSearch("im sam", { msg });
    assert.equal(reply, "hey sam, noted.");

    const identity = memory.identify(msg);
    assert.equal(memory.nameOf(identity), "sam");
    assert.deepEqual(memory.getPerson(identity.personId).facts, ["likes chess"]);
  } finally {
    stub.restore();
  }
});
