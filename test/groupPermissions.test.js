const test = require("node:test");
const assert = require("node:assert/strict");
const { getGroupMetadata, getCachedMetadata, invalidateGroupMetadata } = require("../utils/groupPermissions");

test("group sends reuse cached metadata and share concurrent cache misses", async () => {
  const groupJid = `metadata-cache-${Date.now()}@g.us`;
  let calls = 0;
  let resolveLookup;
  const metadata = { id: groupJid, participants: [] };
  const sock = {
    groupMetadata(jid) {
      calls += 1;
      assert.equal(jid, groupJid);
      if (calls > 1) return Promise.resolve(metadata);
      return new Promise((resolve) => {
        resolveLookup = () => resolve(metadata);
      });
    },
  };

  const first = getCachedMetadata(sock, groupJid);
  const concurrent = getGroupMetadata(sock, groupJid);
  await Promise.resolve(); // allow the shared lookup to start
  assert.equal(calls, 1);
  resolveLookup();

  assert.equal(await first, metadata);
  assert.equal(await concurrent, metadata);
  assert.equal(await getCachedMetadata(sock, groupJid), metadata);
  assert.equal(calls, 1);

  invalidateGroupMetadata(groupJid);
  assert.equal(await getCachedMetadata(sock, groupJid), metadata);
  assert.equal(calls, 2);
});
