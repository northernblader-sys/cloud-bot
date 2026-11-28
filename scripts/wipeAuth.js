#!/usr/bin/env node
"use strict";

/**
 * One-shot: wipe the WhatsApp session out of MongoDB.
 *
 * Deletes every document in the auth collection (<BOT_ID>_auth, default
 * astral_auth in database astral_cloud) — the Mongo equivalent of
 * `rm -rf auth_info/`. Same wipe mongoAuthState.clearAuth() does, but
 * runnable from anywhere (your laptop, a VPS shell) while the bot is
 * offline or stuck in a disconnect loop. Nothing else is touched.
 *
 * Usage (any machine with Node + the repo's node_modules installed):
 *
 *   node scripts/wipeAuth.js --uri="mongodb+srv://user:pass@cluster/..."
 *
 *   --uri=...     Mongo connection string (or set MONGODB_URI instead)
 *   --db=name     database name        (default: astral_cloud, or MONGODB_DB)
 *   --bot-id=x    collection prefix    (default: astral, or BOT_ID)
 *   --yes         skip the confirmation prompt (for pipes/CI)
 *
 * Must match the bot's env vars on Render — if you set MONGODB_DB or BOT_ID
 * there, pass the same values here, otherwise the script wipes an empty
 * collection and the real session stays untouched.
 *
 * After wiping: restart the bot (Render → Manual Deploy or Restart). It
 * boots with no session and prints a fresh pairing code into the logs.
 *
 * Prefer NOT to put the URI on the command line? Use the env var instead:
 *   MONGODB_URI="mongodb+srv://..." node scripts/wipeAuth.js
 */

// Pure helpers exported for tests.
function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([a-z][a-z0-9-]*)(?:=(.*))?$/.exec(a);
    if (!m) continue; // ignore positional junk
    out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

// Maps parsed flags onto an env-style object BEFORE utils/mongo.js loads
// (it captures env at module load).
function applyFlags(flags, env) {
  if (typeof flags.uri === "string") env.MONGODB_URI = flags.uri;
  if (typeof flags.db === "string") env.MONGODB_DB = flags.db;
  if (typeof flags["bot-id"] === "string") env.BOT_ID = flags["bot-id"];
  return env;
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false; // non-interactive: caller must pass --yes
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return String(answer).trim().toUpperCase() === "YES";
  } finally {
    rl.close();
  }
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  applyFlags(flags, process.env);

  // utils/mongo.js reads env at load, so it must be required AFTER applyFlags.
  const mongo = require("../utils/mongo");

  if (!mongo.enabled()) {
    console.error(
      "❌ No MongoDB URI.\n" +
        '   Pass it:  node scripts/wipeAuth.js --uri="mongodb+srv://..."\n' +
        "   or set:   MONGODB_URI in the environment."
    );
    return 1;
  }

  const collection = `${mongo.BOT_ID}_auth`;

  if (!flags.yes) {
    const ok = await confirm(
      `Delete ALL documents in "${collection}" (database "${mongo.DB_NAME}") — the WhatsApp session? Type YES: `
    );
    if (!ok) {
      console.log("Aborted — nothing deleted.");
      return 1;
    }
  }

  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15_000,
  });
  await client.connect();
  const col = client.db(mongo.DB_NAME).collection(collection);

  const before = await col.countDocuments({});
  const result = await col.deleteMany({});
  const after = await col.countDocuments({}).catch(() => -1);

  console.log(
    `✅ Wiped ${mongo.DB_NAME}.${collection}: ${result.deletedCount} document(s) deleted` +
      (before !== result.deletedCount ? ` (found ${before})` : "") +
      (after === 0 ? ", collection now empty." : after === -1 ? "" : `, ${after} left!`)
  );
  if (before === 0) {
    console.log("ℹ️  That collection was already empty — if you expected a session here,");
    console.log("   the bot probably uses a different MONGODB_DB or BOT_ID. Check Render → Environment");
    console.log("   and rerun with matching --db=... --bot-id=...");
  }
  await client.close();

  console.log("\nNext steps:");
  console.log("  1. Restart the bot (Render → Manual Deploy → Restart / Deploy).");
  console.log("  2. Watch the logs for 'Pairing code: XXXX-XXXX'.");
  console.log("  3. WhatsApp → Linked Devices → Link with phone number, within 60 s.");
  return 0;
}

// Only run when invoked directly — tests require this file for parseArgs/applyFlags.
if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error("❌", (err && err.message) || err);
      process.exit(1);
    });
}

module.exports = { parseArgs, applyFlags };
