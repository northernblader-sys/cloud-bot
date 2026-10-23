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
//   2. the key saved at runtime              <- send `.cloud key sk-or-v1-…`
//                                               to the bot in a DM as the owner.
//                                               Stored through utils/persist.js,
//                                               so it lands in MongoDB when
//                                               MONGODB_URI is set and survives
//                                               redeploys.
//   3. <DATA_DIR>/openrouter.key             <- one-line file next to the
//                                               bot's data (gitignored; only
//                                               survives on a persistent disk).
//
// If none is present the command says exactly that instead of failing
// silently. utils/openrouter.key.example shows every way to set it.

const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("./dataDir");
const persist = require("./persist");

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
const KEY_STORE = "openrouterKey"; // runtime-saved key (persist -> Mongo/JSON)

/** The key saved with `.cloud key …`, or null. */
function storedKey() {
  const value = persist.get(KEY_STORE, null);
  if (!value) return null;
  const key = typeof value === "string" ? value : value.key;
  return key && String(key).trim() ? String(key).trim() : null;
}

/** Save a key at runtime. `by` is recorded for the log only, never shown. */
function setApiKey(key, by = null) {
  const clean = String(key || "").trim();
  if (!/^sk-or-v1-[A-Za-z0-9]{20,}$/.test(clean)) {
    throw new Error("that doesn't look like an openrouter key (it should start with sk-or-v1-)");
  }
  persist.set(KEY_STORE, { key: clean, savedAt: Date.now(), by });
  return clean;
}

function clearApiKey() {
  const existed = Boolean(storedKey());
  persist.set(KEY_STORE, null);
  return existed;
}

/** sk-or-v1-…abcd -> sk-or-v1-•••abcd (never log or send a full key). */
function maskKey(key) {
  const value = String(key || "");
  if (value.length < 12) return "•••";
  return `${value.slice(0, 9)}•••${value.slice(-4)}`;
}

/** Which source the current key comes from: "env" | "saved" | "file" | null. */
function keySource() {
  if (process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.trim()) return "env";
  if (storedKey()) return "saved";
  try {
    if (fs.readFileSync(KEY_FILE, "utf8").trim()) return "file";
  } catch {
    // no key file
  }
  return null;
}

function apiKey() {
  const fromEnv = process.env.OPENROUTER_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const saved = storedKey();
  if (saved) return saved;

  try {
    const fromFile = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (fromFile) return fromFile.replace(/^["']|["']$/g, "");
  } catch {
    // no key file, fall through to the error below
  }

  const error = new Error(
    "no openrouter key yet. dm the bot `.cloud key sk-or-v1-...` as the owner, " +
      "or set OPENROUTER_API_KEY on the host"
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
  setApiKey,
  clearApiKey,
  storedKey,
  maskKey,
  keySource,
  KEY_FILE,
  modelName,
  DEFAULT_MODEL,
  FALLBACK_MODEL,
};
