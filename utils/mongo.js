// MongoDB connection (optional). If MONGODB_URI is not set the bot falls back
// to local files exactly like before, so nothing breaks in local dev.
//
//   MONGODB_URI  required to enable Mongo (mongodb+srv://user:pass@cluster/...)
//   MONGODB_DB   database name            (default: astral_cloud)
//   BOT_ID       prefix for collections   (default: astral) — give each bot
//                its own value if two bots share one database.

const URI = process.env.MONGODB_URI || "";
const DB_NAME = process.env.MONGODB_DB || "astral_cloud";
const BOT_ID = (process.env.BOT_ID || "astral").replace(/[^a-zA-Z0-9_-]/g, "");

let client = null;
let db = null;

function enabled() {
  return !!URI;
}

async function connect() {
  if (!URI) return null;
  if (db) return db;
  const { MongoClient } = require("mongodb");
  client = new MongoClient(URI, {
    serverSelectionTimeoutMS: 15_000,
    maxPoolSize: 5,
    retryWrites: true,
  });
  await client.connect();
  db = client.db(DB_NAME);
  await db.command({ ping: 1 });
  return db;
}

// Collections are namespaced per bot: astral_auth, astral_kv, ...
function getCollection(name) {
  if (!db) throw new Error("Mongo not connected yet — call connect() first");
  return db.collection(`${BOT_ID}_${name}`);
}

async function close() {
  try {
    await client?.close();
  } catch {}
}

module.exports = { enabled, connect, getCollection, close, BOT_ID, DB_NAME };
