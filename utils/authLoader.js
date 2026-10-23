// Loads the WhatsApp auth state (Mongo or local folder) and automatically
// clears it when it is stale, so nobody has to delete anything by hand.
//
// Two stale cases:
//  1. Half-finished pairing: Baileys saves { me, pairingCode } the moment a
//     pairing code is requested, but `registered` only becomes true once the
//     code is actually entered on the phone. If the connection drops in
//     between (or you changed BOT_NUMBER), the next start sees a `me` and
//     tries to LOG IN instead of registering -> WhatsApp closes the
//     connection forever ("Connection Closed").
//  2. BOT_NUMBER was changed after a successful pairing: the saved session
//     belongs to a different number than the one configured now.
const fs = require("fs");
const { useMultiFileAuthState } = require("@whiskeysockets/baileys");
const mongo = require("./mongo");
const { AUTH_DIR } = require("./dataDir");
const { useMongoAuthState, clearAuth } = require("./mongoAuthState");

const bare = (jid) => (jid || "").split("@")[0].split(":")[0];

async function openAuth() {
  return mongo.enabled() ? useMongoAuthState() : useMultiFileAuthState(AUTH_DIR);
}

async function wipeAuth() {
  if (mongo.enabled()) {
    await clearAuth();
  } else {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }
}

async function loadAuth(botNumber) {
  let auth = await openAuth();
  const creds = auth.state.creds;
  const savedNumber = bare(creds.me?.id);

  const halfPaired = !creds.registered && !!creds.me;
  const wrongNumber = !!creds.registered && !!savedNumber && savedNumber !== botNumber;

  if (halfPaired || wrongNumber) {
    console.log(
      halfPaired
        ? "🧹 Found an unfinished pairing from an earlier attempt — clearing it and starting fresh."
        : `🧹 Saved session is for +${savedNumber} but BOT_NUMBER is +${botNumber} — clearing it so you can pair the new number.`
    );
    await wipeAuth();
    auth = await openAuth();
  }
  return auth;
}

module.exports = { loadAuth };
