const persist = require("./persist");

const DEFAULT_SETTINGS = {
  antilink: true,
  antistatus: true,
  antichannel: true,
  antispam: true,
  welcome: false,
};

const all = () => persist.get("groupSettings", {});

function getSettings(groupJid) {
  return { ...DEFAULT_SETTINGS, ...(all()[groupJid] || {}) };
}

function setSetting(groupJid, key, value) {
  const data = all();
  data[groupJid] = { ...DEFAULT_SETTINGS, ...(data[groupJid] || {}), [key]: value };
  persist.set("groupSettings", data);
  return data[groupJid];
}

module.exports = { getSettings, setSetting, DEFAULT_SETTINGS };
