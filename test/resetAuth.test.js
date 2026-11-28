// Offline tests for commands/resetAuth.js — the owner-only session wipe.
// No WhatsApp, no Mongo, no filesystem: wipeAuth is injected.

const test = require("node:test");
const assert = require("node:assert/strict");

// owner.js reads OWNER_NUMBERS at module load — set it before requiring.
process.env.OWNER_NUMBERS = "2347000000001";

const { resetAuth, scheduleExit } = require(
  path()
);

function path() {
  return require("node:path").join(__dirname, "..", "commands", "resetAuth.js");
}

function ownerMsg() {
  return { key: { remoteJid: "2347000000001@s.whatsapp.net", fromMe: false }, pushName: "Owner" };
}

function otherMsg() {
  return { key: { remoteJid: "2345555555555@s.whatsapp.net", fromMe: false }, pushName: "Random" };
}

test("non-owner: refuses and does NOT wipe", async () => {
  let wiped = 0;
  const reply = await resetAuth(otherMsg(), {
    wipeAuthImpl: async () => {
      wiped++;
    },
  });
  assert.match(reply, /Only the owner/);
  assert.equal(wiped, 0, "nothing wiped for a non-owner");
});

test("owner: wipes auth storage and returns the pairing instructions", async () => {
  let wiped = 0;
  const reply = await resetAuth(ownerMsg(), {
    wipeAuthImpl: async () => {
      wiped++;
    },
  });
  assert.equal(wiped, 1, "wipe ran exactly once");
  assert.match(reply, /Session wiped/);
  assert.match(reply, /pairing code/);
});

test("scheduleExit exits after the delay", async () => {
  let exited = 0;
  let code = 0;
  const t0 = Date.now();
  scheduleExit({ delayMs: 30, exitImpl: (c) => {
    exited++;
    code = c;
  } });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(exited, 1);
  assert.equal(code, 1);
  assert.ok(Date.now() - t0 >= 25, "waited for the delay (message flush)");
});

test("module shape: loadAuth still exported alongside wipeAuth", () => {
  const loader = require("node:path").join(__dirname, "..", "utils", "authLoader.js");
  const exports = require(loader);
  assert.deepEqual(Object.keys(exports).sort(), ["loadAuth", "wipeAuth"]);
});
