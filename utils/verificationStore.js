// In-memory store of pending verifications.
//
// One person can be known by several ids (phone jid, LID), and the id on the
// "joined" event is often NOT the id on their later message. So an entry is
// registered under every alias we know, and lookups try every alias we have.
const { aliasesOf } = require("./groupPermissions");

const pending = new Map(); // `${groupJid}|${alias}` -> entry

const k = (groupJid, alias) => `${groupJid}|${alias}`;

function addPending(groupJid, jids, data) {
  const aliases = [...aliasesOf(jids)];
  const entry = { ...data, aliases, groupJid };
  for (const a of aliases) pending.set(k(groupJid, a), entry);
  return entry;
}

function getPending(groupJid, ...jids) {
  for (const a of aliasesOf(...jids)) {
    const hit = pending.get(k(groupJid, a));
    if (hit) return hit;
  }
  return undefined;
}

function removePending(groupJid, ...jids) {
  const entry = getPending(groupJid, ...jids);
  if (!entry) return;
  if (entry.timeout) clearTimeout(entry.timeout);
  for (const a of entry.aliases) pending.delete(k(groupJid, a));
}

module.exports = { addPending, getPending, removePending };
