// Tiny persistence layer for the bot's JSON data (group settings, trusted
// users, chess games).
//
// - Keeps everything in memory, so the rest of the code can stay synchronous.
// - Writes are debounced and saved to MongoDB when MONGODB_URI is set,
//   otherwise to JSON files in DATA_DIR (the old behaviour).
// - Call `await init()` once at startup, before the bot starts handling messages.
const fs = require("fs");
const path = require("path");
const mongo = require("./mongo");
const { DATA_DIR } = require("./dataDir");

const FILES = {
  groupSettings: "groupSettings.json",
  trustedUsers: "trustedUsers.json",
  chessGames: "chessGames.json",
  rpgPlayers: "rpgPlayers.json",
  rpgBattles: "rpgBattles.json",
};

const cache = new Map(); // name -> value
const dirty = new Set();
let timer = null;
const DEBOUNCE_MS = 400;

const fileOf = (name) => path.join(DATA_DIR, FILES[name] || `${name}.json`);

async function init() {
  if (!mongo.enabled()) {
    console.log("💾 Storage: local files (set MONGODB_URI to use MongoDB)");
    return;
  }
  try {
    await mongo.connect();
  } catch (err) {
    console.error(
      "❌ Could not connect to MongoDB: " + (err.message || err) + "\n" +
        "   Check: (1) MONGODB_URI is correct and the password is URL-encoded,\n" +
        "          (2) Atlas > Network Access allows 0.0.0.0/0 (Render has no fixed IP),\n" +
        "          (3) the database user has read/write access."
    );
    throw err;
  }
  const docs = await mongo.getCollection("kv").find({}).toArray();
  for (const d of docs) {
    try {
      cache.set(d._id, JSON.parse(d.json));
    } catch {
      console.error(`persist: ignoring unreadable document "${d._id}"`);
    }
  }
  console.log(`💾 Storage: MongoDB (${mongo.DB_NAME}, prefix "${mongo.BOT_ID}_"), loaded ${docs.length} record(s)`);
}

function readFileFallback(name) {
  try {
    const f = fileOf(name);
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {}
  return undefined;
}

function get(name, fallback) {
  if (cache.has(name)) return cache.get(name);
  // First use: seed from a local file if one exists (handy for migrating).
  const fromFile = readFileFallback(name);
  const value = fromFile !== undefined ? fromFile : fallback;
  cache.set(name, value);
  if (fromFile !== undefined && mongo.enabled()) schedule(name);
  return value;
}

function set(name, value) {
  cache.set(name, value);
  schedule(name);
}

function schedule(name) {
  dirty.add(name);
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush().catch((e) => console.error("persist flush failed:", e.message || e));
  }, DEBOUNCE_MS);
}

async function flush() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  const names = [...dirty];
  dirty.clear();
  for (const name of names) {
    const value = cache.get(name);
    try {
      if (mongo.enabled()) {
        await mongo
          .getCollection("kv")
          .replaceOne({ _id: name }, { _id: name, json: JSON.stringify(value), at: new Date() }, { upsert: true });
      } else {
        fs.mkdirSync(path.dirname(fileOf(name)), { recursive: true });
        fs.writeFileSync(fileOf(name), JSON.stringify(value, null, 2));
      }
    } catch (err) {
      console.error(`persist: failed to save "${name}":`, err.message || err);
      dirty.add(name); // retry on next flush
    }
  }
}

module.exports = { init, get, set, flush };
