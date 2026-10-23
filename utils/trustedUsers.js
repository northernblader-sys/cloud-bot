const persist = require("./persist");

function bareDigits(jid) {
  return (jid || "").split("@")[0].split(":")[0];
}

function loadAll() {
  return persist.get("trustedUsers", []);
}

function saveAll(list) {
  persist.set("trustedUsers", list);
}

function isTrusted(jid) {
  const digits = bareDigits(jid);
  if (!digits) return false;
  return loadAll().includes(digits);
}

function addTrusted(jid) {
  const digits = bareDigits(jid);
  if (!digits) return false;
  const all = loadAll();
  if (!all.includes(digits)) {
    all.push(digits);
    saveAll(all);
  }
  return true;
}

function removeTrusted(jid) {
  const digits = bareDigits(jid);
  const all = loadAll();
  const next = all.filter((d) => d !== digits);
  saveAll(next);
  return next.length !== all.length;
}

module.exports = { isTrusted, addTrusted, removeTrusted };
