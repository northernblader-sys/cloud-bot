// The .cloud brain: personality + memory + OpenRouter.
//
// utils/gemini.js still owns the *tool routing table* (what .cloud can do).
// This module imports that table, translates it to OpenAI's tool format, and
// runs both stages through OpenRouter:
//
//   1. routeMessage      — forced tool call, decides command vs conversation
//   2. answerWithSearch  — real answer, grounded with OpenRouter's web plugin,
//                          with this person's name, facts and last turns
//
// Conversations are never shared: every call is built from
// cloudMemory.identify(msg), so two people in one group get two separate
// histories and two separate names.

const { chatWithRetry } = require("./openrouter");
const memory = require("./cloudMemory");
const personality = require("./cloudPersonality");
const { ROUTER_TOOLS } = require("./gemini");

// ── tool format conversion ────────────────────────────────────────
// Gemini: [{ functionDeclarations: [{ name, description, parameters }] }]
// OpenAI: [{ type: "function", function: { name, description, parameters } }]
function toOpenAiTools(geminiTools) {
  const out = [];
  for (const block of geminiTools || []) {
    for (const declaration of block.functionDeclarations || []) {
      out.push({
        type: "function",
        function: {
          name: declaration.name,
          description: declaration.description,
          parameters: declaration.parameters || { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

const ROUTER_TOOLS_OPENAI = toOpenAiTools(ROUTER_TOOLS);

// ── message building ──────────────────────────────────────────────
function userContent(text, imageBase64, imageMime) {
  if (!imageBase64) return text;
  return [
    { type: "text", text },
    {
      type: "image_url",
      image_url: { url: `data:${imageMime || "image/jpeg"};base64,${imageBase64}` },
    },
  ];
}

function systemPromptFor(identity) {
  // identity is null when the caller had no message context (e.g. the Gemini
  // fallback path), so fall through to a memory-less prompt.
  const person = identity ? memory.getPerson(identity.personId) : null;
  return personality.buildSystemPrompt({
    memberName: person?.name || null,
    pushName: identity?.pushName,
    isGroup: Boolean(identity?.isGroup),
    facts: person?.facts || [],
  });
}

/**
 * Route a message to a tool, or to no_tool_needed for a normal conversation.
 * Returns the same { name, args } shape utils/gemini.js returns.
 */
async function routeMessage(userText, { imageBase64, imageMime, msg } = {}) {
  const identity = msg ? memory.identify(msg) : null;

  const messages = [
    {
      role: "system",
      content:
        systemPromptFor(identity) +
        "\n\nyou are acting as a router right now, not replying yet. read the last message and " +
        "call exactly one tool. if it maps to a real action (play a named song, fetch a manga " +
        "chapter, tell the time, look up a named movie/anime, download a link, make a sticker, " +
        "find a gif, make a qr code, do arithmetic, shorten a url) call that tool with its " +
        "arguments. for small talk, opinions, identity questions or open-ended questions " +
        "('best anime right now', 'what should i watch'), call no_tool_needed instead. " +
        "never answer in plain text at this stage.",
    },
    ...(identity ? memory.getHistory(identity) : []),
    { role: "user", content: userContent(userText, imageBase64, imageMime) },
  ];

  const result = await chatWithRetry({
    messages,
    tools: ROUTER_TOOLS_OPENAI,
    toolChoice: "required",
    temperature: 0.2,
    maxTokens: 200,
  });

  const call = result.toolCalls[0];
  if (!call) return { name: "no_tool_needed", args: {} };

  let args = {};
  try {
    args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
  } catch {
    args = {};
  }

  return { name: call.function?.name || "no_tool_needed", args };
}

/**
 * Answer a normal message in cloud's voice, using this person's memory and
 * (optionally) live web results.
 */
async function answerWithSearch(userText, { imageBase64, imageMime, msg } = {}) {
  const identity = msg ? memory.identify(msg) : null;

  const messages = [
    { role: "system", content: systemPromptFor(identity) },
    ...(identity ? memory.getHistory(identity) : []),
    { role: "user", content: userContent(userText, imageBase64, imageMime) },
  ];

  let result;
  try {
    result = await chatWithRetry({ messages, web: true, temperature: 0.9 });
  } catch (err) {
    // The web plugin is optional on OpenRouter; if it is the thing that broke,
    // answer without it rather than failing the whole command.
    if (!/plugin|web/i.test(err.message)) throw err;
    result = await chatWithRetry({ messages, web: false, temperature: 0.9 });
  }

  const reply = personality.styleReply(result.text) ||
    "hmm, i blanked. say that again?";

  // Save the exchange (and any <remember> tags) for the next message.
  if (identity) {
    const cleaned = memory.recordExchange(identity, userText, reply);
    return cleaned || reply;
  }

  return reply;
}

/** Small helper used by .cloud whoami / .cloud forget. */
function describeMember(msg) {
  const identity = memory.identify(msg);
  const person = memory.getPerson(identity.personId);
  return {
    identity,
    name: person?.name || null,
    facts: person?.facts || [],
    turns: memory.historySize(identity),
    isGroup: identity.isGroup,
  };
}

module.exports = {
  routeMessage,
  answerWithSearch,
  describeMember,
  ROUTER_TOOLS_OPENAI,
  toOpenAiTools,
};
