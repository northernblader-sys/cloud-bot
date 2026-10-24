const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-profile-"));
process.env.DATA_DIR = DATA_DIR;

const ROOT = path.join(__dirname, "..");
const { invalidateGroupMetadata } = require(path.join(ROOT, "utils", "groupPermissions.js"));

function loadProfile() {
  const ownerPath = path.join(ROOT, "utils", "owner.js");
  const profilePath = path.join(ROOT, "commands", "profile.js");
  delete require.cache[require.resolve(ownerPath)];
  delete require.cache[require.resolve(profilePath)];
  return require(profilePath);
}

test(".me: shows lid, uid, number, username, bio, and owner badge in LID-addressed group", async () => {
  const savedOwner = process.env.OWNER_NUMBERS;
  process.env.OWNER_NUMBERS = "2347062301848";

  try {
    const { showProfile } = loadProfile();

    const sock = {
      fetchStatus: async () => [{ id: "2347062301848@s.whatsapp.net", status: { status: "Building bots" } }],
      profilePictureUrl: async () => "https://example.com/pp.jpg",
    };

    const msg = {
      key: {
        remoteJid: "1203630111@g.us",
        participant: "87209327755401@lid",
        participantAlt: "2347062301848@s.whatsapp.net",
        participantUsername: "northernblader",
      },
      pushName: "Blade",
    };

    const res = await showProfile(sock, msg, "");

    assert.deepEqual(res.image, { url: "https://example.com/pp.jpg" });
    assert.deepEqual(res.mentions, ["2347062301848@s.whatsapp.net"]);
    assert.match(res.caption, /👤 \*Blade\*/);
    assert.match(res.caption, /👑 Owner/);
    assert.match(res.caption, /🏷️ \*Username:\* Blade \(@northernblader\)/);
    assert.match(res.caption, /📞 \*Number:\* \+2347062301848/);
    assert.match(res.caption, /🆔 \*UID:\* 2347062301848@s\.whatsapp\.net/);
    assert.match(res.caption, /🔗 \*LID:\* 87209327755401@lid/);
    assert.match(res.caption, /📝 \*Bio:\* Building bots/);
  } finally {
    process.env.OWNER_NUMBERS = savedOwner;
  }
});

test(".me: resolves LID via signalRepository.lidMapping when message only has phone JID", async () => {
  const { showProfile } = loadProfile();

  const sock = {
    signalRepository: {
      lidMapping: {
        getLIDForPN: async (pn) => (pn === "2348011112222@s.whatsapp.net" ? "99887766554433:0@lid" : null),
      },
    },
    fetchStatus: async () => ({ list: [{ status: { status: "Chilling" } }] }),
    profilePictureUrl: async () => null,
  };

  const msg = {
    key: {
      remoteJid: "2348011112222@s.whatsapp.net",
    },
    pushName: "Sammy",
  };

  const res = await showProfile(sock, msg, "");

  assert.equal(res.image, null);
  assert.match(res.caption, /🏷️ \*Username:\* Sammy/);
  assert.match(res.caption, /📞 \*Number:\* \+2348011112222/);
  assert.match(res.caption, /🆔 \*UID:\* 2348011112222@s\.whatsapp\.net/);
  assert.match(res.caption, /🔗 \*LID:\* 99887766554433@lid/);
  assert.match(res.caption, /📝 \*Bio:\* Chilling/);
});

test(".me: resolves target user's PN, LID, and username from groupMetadata when mentioning someone", async () => {
  const { showProfile } = loadProfile();
  const groupJid = "1203630222@g.us";
  invalidateGroupMetadata(groupJid);

  const sock = {
    groupMetadata: async () => ({
      id: groupJid,
      participants: [
        {
          id: "554433221100@lid",
          phoneNumber: "2348099998888@s.whatsapp.net",
          username: "ada_w",
          notify: "Ada",
        },
      ],
    }),
    fetchStatus: async () => [],
    profilePictureUrl: async () => null,
  };

  const msg = {
    key: {
      remoteJid: groupJid,
      participant: "111111111111@lid",
    },
    pushName: "Caller",
    message: {
      extendedTextMessage: {
        contextInfo: {
          mentionedJid: ["554433221100@lid"],
        },
      },
    },
  };

  const res = await showProfile(sock, msg, "@554433221100");

  assert.deepEqual(res.mentions, ["2348099998888@s.whatsapp.net"]);
  assert.match(res.caption, /👤 \*Ada\*/);
  assert.match(res.caption, /🏷️ \*Username:\* Ada \(@ada_w\)/);
  assert.match(res.caption, /📞 \*Number:\* \+2348099998888/);
  assert.match(res.caption, /🆔 \*UID:\* 2348099998888@s\.whatsapp\.net/);
  assert.match(res.caption, /🔗 \*LID:\* 554433221100@lid/);
});
