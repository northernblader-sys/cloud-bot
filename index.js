require("dotenv").config();

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
} = require("@whiskeysockets/baileys");
const { Boom } = require("@hapi/boom");
const pino = require("pino");
const path = require("path");
const http = require("http");

const { handleMessage } = require("./handlers/router");
const { startVerification } = require("./middleware/joinVerification");
const { getSettings } = require("./utils/groupSettings");

const { AUTH_DIR } = require("./utils/dataDir");
const mongo = require("./utils/mongo");
const persist = require("./utils/persist");
const { loadAuth } = require("./utils/authLoader");
const { getCachedMetadata, invalidateGroupMetadata } = require("./utils/groupPermissions");

// ── Health endpoint ────────────────────────────────────────────────
// Lets hosts that need an open HTTP port (Render web service, etc.) run the
// bot, and gives an uptime pinger (UptimeRobot, cron-job.org) something to hit.
//   GET /        -> plain text
//   GET /health  -> JSON status (also answers HEAD)
const PORT = Number(process.env.PORT) || 3000;
const botState = { connection: "starting", since: Date.now(), reconnects: 0, lastCode: null };

http
  .createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    if (url === "/health" || url === "/healthz") {
      const body = JSON.stringify({
        ok: true,
        bot: botState.connection, // "starting" | "connecting" | "open" | "closed" | "replaced" | "logged_out"
        uptimeSec: Math.round(process.uptime()),
        reconnects: botState.reconnects,
        lastDisconnectCode: botState.lastCode,
      });
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(req.method === "HEAD" ? undefined : body);
    }
    res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(req.method === "HEAD" ? undefined : "☁️ Astral Cloud is running");
  })
  .listen(PORT, "0.0.0.0", () => console.log(`HTTP endpoint listening on :${PORT} (/ and /health)`));

// Hardcoded bot number for pairing (digits only, country code + number, no + or spaces).
// Can be overridden with a BOT_NUMBER env var in Render; otherwise uses the default below.
const BOT_NUMBER = (process.env.BOT_NUMBER || "2347073323366").replace(/\D/g, "");

let currentSock = null; // only the newest socket is allowed to request pairing codes

async function startBot() {
  // Session lives in MongoDB when MONGODB_URI is set (survives redeploys on
  // hosts with no disk), otherwise in the local auth_info/ folder. Stale or
  // half-finished sessions are cleared automatically.
  const { state, saveCreds } = await loadAuth(BOT_NUMBER);
  const { version } = await fetchLatestBaileysVersion();

  const silentLogger = pino({ level: "silent" });

  let sock;
  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Rapid signal-session key lookups during pairing can desync without
      // this cache and cause WhatsApp to kill the connection almost
      // immediately (a fast 401 right after the code is issued) — this is
      // the most likely cause of the instant "couldn't link device" reject.
      keys: makeCacheableSignalKeyStore(state.keys, silentLogger),
    },
    logger: silentLogger,
    printQRInTerminal: false,
    // A recognized Baileys browser preset instead of a custom identity
    // string — unrecognized browser identities are more likely to get
    // flagged by WhatsApp's pairing endpoint.
    browser: Browsers.ubuntu("Chrome"),
    // Serve group info from our own cache when sending to groups, instead of
    // WhatsApp being asked for it on every send (rate-limit friendly).
    // Cache misses use our shared metadata lookup so group sends don't pay
    // for an uncached WhatsApp lookup on every reply.
    cachedGroupMetadata: (groupJid) => getCachedMetadata(sock, groupJid),
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 25_000,
    // The actual "60 second timer": without this Baileys falls back to a
    // shorter default connect timeout, which can cut the handshake before
    // pairing finishes.
    connectTimeoutMs: 60_000,
  });

  // Pairing-code flow: only needed the first time, before a session exists.
  // Once auth_info/creds.json exists, sock.authState.creds.registered is
  // true and Baileys skips straight to reconnecting with the saved session.
  currentSock = sock;
  if (!sock.authState.creds.registered) {
    const requestCode = async (attempt = 1) => {
      // A newer socket replaced this one (reconnect) or pairing already
      // succeeded: stop, so retries from dead sockets don't pile up and
      // spam WhatsApp with pairing requests.
      if (currentSock !== sock || sock.authState.creds.registered) return;
      try {
        console.log(`Requesting pairing code for +${BOT_NUMBER} (attempt ${attempt}) ...`);
        const code = await sock.requestPairingCode(BOT_NUMBER);
        console.log("═══════════════════════════════════");
        console.log(`  Pairing code: ${code}`);
        console.log("  Enter this in WhatsApp > Linked Devices > Link with phone number (within 60s)");
        console.log("═══════════════════════════════════");
      } catch (err) {
        if (attempt < 5) {
          console.log(`Pairing code request failed (${err.message}), retrying in 3s...`);
          setTimeout(() => requestCode(attempt + 1), 3000);
        } else {
          console.error("Failed to request pairing code after multiple attempts:", err);
        }
      }
    };

    // Give the socket a moment to establish its connection before asking
    // for a pairing code, otherwise WhatsApp can reject the request.
    setTimeout(() => requestCode(), 3000);
  }

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "connecting") botState.connection = "connecting";

    if (connection === "close") {
      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      botState.lastCode = statusCode ?? null;

      if (statusCode === DisconnectReason.loggedOut) {
        botState.connection = "logged_out";
        console.log("Logged out. Delete the auth_info folder and restart to re-pair.");
        return;
      }

      // 440: the same session was opened somewhere else (e.g. the old Railway
      // copy came back). Reconnecting here would just kick that copy off and
      // the two would fight forever, so stop and wait for a human.
      if (statusCode === DisconnectReason.connectionReplaced) {
        botState.connection = "replaced";
        console.log(
          "⚠️ Session replaced: another instance is using this WhatsApp session. " +
            "Not reconnecting. Stop the other instance, then restart this one."
        );
        return;
      }

      botState.connection = "closed";
      botState.reconnects += 1;
      console.log("Connection closed. Reconnecting in 3s | Status code:", statusCode);
      setTimeout(() => startBot().catch((e) => console.error("Reconnect failed:", e)), 3000);
    } else if (connection === "open") {
      botState.connection = "open";
      console.log("✅ Astral Cloud is connected and online.");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    // A batch can hold several messages. Process independently instead of
    // waiting for one slow command/API call before even starting the next —
    // this is especially important for busy groups where Baileys batches
    // incoming messages together.
    await Promise.all(
      messages.map(async (msg) => {
        if (!msg.message || msg.key.fromMe) return;
        if (msg.key.remoteJid === "status@broadcast") return;

        try {
          await handleMessage(sock, msg);
        } catch (err) {
          console.error("Error handling message:", err);
        }
      })
    );
  });

  // Keep the cached group info (admin list, members) fresh when it changes.
  sock.ev.on("groups.update", (updates) => {
    for (const u of updates) if (u.id) invalidateGroupMetadata(u.id);
  });

  sock.ev.on("group-participants.update", async (update) => {
    const { id: groupJid, participants, action } = update;
    invalidateGroupMetadata(groupJid);
    if (action !== "add") return;

    try {
      const settings = getSettings(groupJid);
      if (!settings.welcome) return;

      // Baileys v7 sends participant OBJECTS ({ id, lid, phoneNumber, admin }),
      // older versions sent plain jid strings. startVerification accepts both.
      for (const participant of participants) {
        await startVerification(sock, groupJid, participant);
      }
    } catch (err) {
      console.error("Error handling group join:", err);
    }
  });

  return sock;
}

// Flush pending writes when the host stops the container (deploys send SIGTERM).
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    try {
      await persist.flush();
    } finally {
      process.exit(0);
    }
  });
}

(async () => {
  await persist.init(); // connects to Mongo (if configured) and loads saved data
  await startBot();
})().catch((err) => {
  console.error("Fatal error starting Astral Cloud:", err);
  process.exit(1);
});
