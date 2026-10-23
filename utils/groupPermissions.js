// Group permission helpers.
//
// WhatsApp now addresses many group members by LID ("123@lid") instead of
// phone number ("234...@s.whatsapp.net"). A single person can therefore show
// up under either id depending on the event (message key, group metadata,
// participant update). Comparing raw ids with === makes admin checks fail
// randomly, which is why moderation silently did nothing. Everything here
// compares by *alias sets* (id + lid + phoneNumber, device suffix stripped).

const METADATA_TTL_MS = 60_000;
const metaCache = new Map(); // groupJid -> { at, data }

// "1234:5@s.whatsapp.net" -> "1234@s.whatsapp.net"
function normJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const [left, server] = jid.split("@");
  if (!server) return left.split(":")[0];
  return `${left.split(":")[0]}@${server}`;
}

function aliasesOf(...jidsOrContacts) {
  const out = new Set();
  const add = (j) => {
    const n = normJid(j);
    if (n) out.add(n);
  };
  for (const item of jidsOrContacts.flat(Infinity)) {
    if (!item) continue;
    if (typeof item === "string") add(item);
    else {
      add(item.id);
      add(item.lid);
      add(item.phoneNumber);
    }
  }
  return out;
}

function intersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

async function getGroupMetadata(sock, groupJid, { fresh = false } = {}) {
  const hit = metaCache.get(groupJid);
  if (!fresh && hit && Date.now() - hit.at < METADATA_TTL_MS) return hit.data;
  const data = await sock.groupMetadata(groupJid);
  metaCache.set(groupJid, { at: Date.now(), data });
  return data;
}

// Used for Baileys' `cachedGroupMetadata` socket option, so sending to a group
// doesn't trigger a metadata fetch every time.
async function getCachedMetadataOnly(groupJid) {
  const hit = metaCache.get(groupJid);
  return hit && Date.now() - hit.at < METADATA_TTL_MS ? hit.data : undefined;
}

function invalidateGroupMetadata(groupJid) {
  metaCache.delete(groupJid);
}

function findParticipant(metadata, ...jids) {
  const wanted = aliasesOf(...jids);
  if (!wanted.size) return null;
  return metadata.participants.find((p) => intersects(aliasesOf(p), wanted)) || null;
}

function isParticipantAdmin(metadata, ...jids) {
  const p = findParticipant(metadata, ...jids);
  return !!p && (p.admin === "admin" || p.admin === "superadmin" || p.isAdmin || p.isSuperAdmin);
}

async function isSenderAdmin(sock, groupJid, senderJid) {
  const metadata = await getGroupMetadata(sock, groupJid);
  return isParticipantAdmin(metadata, senderJid);
}

function botAliases(sock) {
  return aliasesOf(sock.user?.id, sock.user?.lid, sock.authState?.creds?.me);
}

async function isBotAdmin(sock, groupJid) {
  const metadata = await getGroupMetadata(sock, groupJid);
  return isParticipantAdmin(metadata, [...botAliases(sock)]);
}

module.exports = {
  normJid,
  aliasesOf,
  intersects,
  botAliases,
  getGroupMetadata,
  getCachedMetadataOnly,
  invalidateGroupMetadata,
  findParticipant,
  isParticipantAdmin,
  isSenderAdmin,
  isBotAdmin,
};
