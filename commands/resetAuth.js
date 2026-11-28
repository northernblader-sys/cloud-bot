"use strict";

/**
 * .resetauth — owner-only recovery switch for a dead WhatsApp session.
 *
 * When the bot keeps disconnecting ("Connection Closed", stream errored,
 * logged out from the phone, stale keys after a number change), the fix
 * is to wipe the saved session and pair again. The storage differs by
 * host (Mongo collection when MONGODB_URI is set, /data/auth_info or
 * ./auth_info otherwise) — wipeAuth() handles both, so the command works
 * everywhere, including Render where there is no shell on the free plan.
 *
 * After the wipe the process exits; Render restarts the service, and
 * index.js automatically requests a fresh pairing code (it lands in the
 * Render logs — enter it in WhatsApp > Linked Devices within 60 s).
 *
 * Owner-only on purpose: wiping the session logs the BOT out of
 * WhatsApp and needs the owner to re-pair physically.
 */

const { isOwnerMessage } = require("../utils/owner");
const { wipeAuth } = require("../utils/authLoader");

/**
 * Wipe the saved session. Returns the confirmation text for the chat,
 * or the refusal text for non-owners (nothing is wiped then).
 *
 * @param {object} msg original Baileys message
 * @param {object} [opts] injection points for tests
 * @param {Function} [opts.wipeAuthImpl] replaces wipeAuth()
 */
async function resetAuth(msg, { wipeAuthImpl } = {}) {
  if (!isOwnerMessage(msg)) {
    return "⚠️ Only the owner can reset the WhatsApp session.";
  }
  const wipe = wipeAuthImpl || wipeAuth;
  await wipe();
  return (
    "🧹 Session wiped (auth storage cleared).\n" +
    "Restarting in a few seconds — watch the Render logs for a fresh *pairing code* and enter it in WhatsApp > Linked Devices > Link with phone number within 60 s."
  );
}

/**
 * Exit the process so the host (Render) restarts the service into a
 * clean pairing flow. Delayed a moment so the confirmation message
 * flushes out before the socket dies.
 *
 * @param {object} [opts]
 * @param {number} [opts.delayMs] default 2 s
 * @param {Function} [opts.exitImpl] injection point for tests
 */
function scheduleExit({ delayMs = 2000, exitImpl } = {}) {
  const exit = exitImpl || ((code) => process.exit(code));
  setTimeout(() => exit(1), delayMs);
}

module.exports = { resetAuth, scheduleExit };
