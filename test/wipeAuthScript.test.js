// Offline tests for scripts/wipeAuth.js — flag parsing and env mapping only.
// (The Mongo deletion itself needs a live server, so it's not tested here;
// the same wipe is covered by the bot's own mongoAuthState behavior.)

const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs, applyFlags } = require("../scripts/wipeAuth.js");

test("parseArgs: --key=value, bare --flag, ignores positional junk", () => {
  const flags = parseArgs([
    "--uri=mongodb+srv://user:pass@cluster/astral_cloud",
    "--yes",
    "--db=astral_cloud",
    "some-positional",
    "--bot-id=mybot",
  ]);
  assert.equal(flags.uri, "mongodb+srv://user:pass@cluster/astral_cloud");
  assert.equal(flags.yes, true, "bare flag becomes true");
  assert.equal(flags.db, "astral_cloud");
  assert.equal(flags["bot-id"], "mybot");
});

test("applyFlags maps uri/db/bot-id onto env BEFORE mongo.js loads", () => {
  const env = {};
  applyFlags(
    { uri: "mongodb+srv://x", db: "other_db", "bot-id": "bot2", yes: true },
    env
  );
  assert.deepEqual(env, {
    MONGODB_URI: "mongodb+srv://x",
    MONGODB_DB: "other_db",
    BOT_ID: "bot2",
  });
});

test("applyFlags: non-string uri (bare --uri) does NOT set MONGODB_URI", () => {
  const env = {};
  applyFlags({ uri: true }, env);
  assert.deepEqual(env, {}, "a URI-less --uri is ignored, not set to true");
});

test("requiring the script never executes main (no mongo connection attempt)", () => {
  // If the require.main guard were broken, this require would have tried
  // to connect and the process would have exited — reaching this line is
  // the assertion. Export shape check keeps it meaningful.
  const mod = require("../scripts/wipeAuth.js");
  assert.deepEqual(Object.keys(mod).sort(), ["applyFlags", "parseArgs"]);
});
