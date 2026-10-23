// OpenRouter client — the brain behind .cloud.
//
// WHERE THE KEY LIVES
// -------------------
// GitHub refuses to accept a live credential committed to a public repo
// (push protection), and rightly so: anyone reading the file could spend
// against it. So the key is read, in this order:
//
//   1. process.env.OPENROUTER_API_KEY        <- set this on the host (Render,
//                                               Railway, VPS…). Recommended.
//   2. <DATA_DIR>/openrouter.key             <- one-line file next to the
//                                               bot's data (gitignored, and
//                                               survives restarts on hosts
//                                               with a persistent volume).
//
// If neither is present the command says exactly that instead of failing
// silently. utils/openrouter.key.example shows the two ways to set it.

const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("./dataDir");

const API_URL = "https://openrouter.ai/api/v1/chat/completions";

// gpt-4o-mini: cheap, fast, handles tool calling and images. Swap for
// "openai/gpt-4o" for smarter answers at ~15x the cost.
const DEFAULT_MODEL = "openai/gpt-4o-mini";
const FALLBACK_MODEL = "google/gemini-2.0-flash-001";

// OpenRouter asks for these so usage can be attributed in their dashboard.
const SITE_URL = "https://github.com/northernblader-sys/cloud-bot";
const SITE_NAME = "astral cloud";

const REQUEST_TIMEOUT_MS = 60000;

const KEY_FILE = path.join(DATA_DIR, "openrouter.key");

function apiKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  try {
    const fromFile = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (fromFile) return fromFile.replace(/^["']|["']$/g, "");
  } catch {
    // no key file, fall through to the error below
  }

  const error = new Error(
    "no OpenRouter key configured. set OPENROUTER_API_KEY in the environment, " +
      `or put the key on its own line in ${KEY_FILE}`
  );
  error.code = "NO_API_KEY";
  throw error;
}

/** True when a key is available (used to pick the brain without crashing). */
function hasKey() {
  try {
    apiKey();
    return true;
  } catch {
    return false;
  }
}

function modelName() {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

function headers() {
  return {
    Authorization: `Bearer ${apiKey()}`,
    "HTTP-Referer": SITE_URL,
    "X-Title": SITE_NAME,
    "Content-Type": "application/json",
  };
}

/**
 * One chat completion.
 *
 * @param {object} options
 * @param {Array}  options.messages   openai-style message list
 * @param {Array}  [options.tools]    openai function tools
 * @param {string} [options.toolChoice] "auto" | "required" | "none"
 * @param {boolean}[options.web]      attach OpenRouter's web-search plugin
 * @param {string} [options.model]
 */
async function chatCompletion({
  messages,
  tools,
  toolChoice,
  web = false,
  model = modelName(),
  temperature = 0.8,
  maxTokens = 700,
} = {}) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    // OpenRouter routes to whichever provider is healthy for this model.
    route: "fallback",
  };

  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  if (web) body.plugins = [{ id: "web", max_results: 3 }];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      const error = new Error(
        `openrouter ${response.status}: ${text.slice(0, 240) || response.statusText}`
      );
      error.status = response.status;
      throw error;
    }

    const data = await response.json();
    if (data?.error) throw new Error(`openrouter: ${data.error.message || "unknown error"}`);

    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error("openrouter returned no message");

    return {
      message,
      text: String(message.content || "").trim(),
      toolCalls: message.tool_calls || [],
      model: data.model || model,
      usage: data.usage || null,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same call, but retries once on the fallback model when the primary is
 * unavailable/rate-limited. Keeps .cloud answering during a provider wobble.
 */
async function chatWithRetry(options = {}) {
  try {
    return await chatCompletion(options);
  } catch (err) {
    const retryable = !err.status || err.status === 429 || err.status >= 500;
    if (!retryable || options.model) throw err;
    console.warn(`[cloud] ${options.model || modelName()} failed (${err.message}), trying fallback`);
    return chatCompletion({ ...options, model: FALLBACK_MODEL });
  }
}

module.exports = {
  chatCompletion,
  chatWithRetry,
  apiKey,
  hasKey,
  KEY_FILE,
  modelName,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
};
