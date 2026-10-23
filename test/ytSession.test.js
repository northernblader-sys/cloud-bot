// Offline tests for YouTube session cookies (utils/youtube/session.js) and the
// `.play cookie` command.
//
// These matter because cookies are the only thing that reliably gets past
// "Sign in to confirm you're not a bot" on a datacenter IP, and the failure
// modes are all silent: a visitor-only export looks fine but is useless, a
// base64 paste is mangled by chat clients, and a truncated Netscape line makes
// yt-dlp reject the whole file.

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const { readFileSync } = require("node:fs");

const ROOT = path.join(__dirname, "..");
const session = require(path.join(ROOT, "utils", "youtube", "session.js"));

const NETSCAPE = [
  "# Netscape HTTP Cookie File",
  "# https://curl.haxx.se/docs/http-cookies.html",
  "",
  ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tVISITOR_INFO1_LIVE\tvisitor123",
  ".youtube.com\tTRUE\t/\tTRUE\t1893456000\tPREF\tf6=400",
  ".google.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsid-value",
  ".google.com\tTRUE\t/\tTRUE\t1893456000\tHSID\thsid-value",
].join("\n");

function withoutEnv(fn) {
  const saved = {};
  for (const name of ["YT_COOKIES_B64", "YT_COOKIES", "YT_COOKIE", "YT_COOKIES_FILE"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  try {
    return fn();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("cookies: a Netscape export becomes both a header and a yt-dlp file", () => {
  withoutEnv(() => {
    session.clearCookies();
    session._reset();

    const saved = session.setCookies(NETSCAPE);
    assert.equal(saved.count, 4);
    assert.equal(saved.signedIn, true, "SID/HSID mean a real signed-in session");

    // InnerTube needs the header form.
    const header = session.header();
    assert.match(header, /VISITOR_INFO1_LIVE=visitor123/);
    assert.match(header, /SID=sid-value/);

    // yt-dlp needs a file it can parse: tabs, 7 fields, a Netscape header.
    const file = session.cookieFile();
    assert.ok(file, "a cookie file should have been written");
    const written = readFileSync(file, "utf8");
    assert.match(written, /^# Netscape HTTP Cookie File/);
    assert.match(written, /\.google\.com\tTRUE\t\/\tTRUE\t\d+\tSID\tsid-value/);

    // The header form must never leak into the file as one blob.
    assert.doesNotMatch(written, /VISITOR_INFO1_LIVE=visitor123/);
  });
});

test("cookies: a plain Cookie header is converted with the right domains", () => {
  withoutEnv(() => {
    session.clearCookies();
    session._reset();

    session.setCookies("SID=abc; HSID=def; VISITOR_INFO1_LIVE=ghi");
    const written = readFileSync(session.cookieFile(), "utf8");

    // Google-only cookies go to .google.com, everything else to .youtube.com.
    assert.match(written, /\.google\.com\tTRUE\t\/\tTRUE\t\d+\tSID\tabc/);
    assert.match(written, /\.google\.com\tTRUE\t\/\tTRUE\t\d+\tHSID\tdef/);
    assert.match(written, /\.youtube\.com\tTRUE\t\/\tTRUE\t\d+\tVISITOR_INFO1_LIVE\tghi/);
    // One line per cookie, never a "SID=abc; HSID=def" blob.
    const cookieLines = written
      .trim()
      .split("\n")
      .filter((line) => line && !line.startsWith("#"));
    assert.equal(cookieLines.length, 3);
  });
});

test("cookies: base64 is accepted, because a chat paste has no tabs", () => {
  withoutEnv(() => {
    session.clearCookies();
    session._reset();

    const encoded = Buffer.from(NETSCAPE, "utf8").toString("base64");
    const saved = session.setCookies(encoded);
    assert.equal(saved.count, 4);
    assert.equal(saved.signedIn, true);
    assert.match(session.header(), /SID=sid-value/);
  });
});

test("cookies: base64 split over several lines still works", () => {
  // WhatsApp (and copy/paste in general) wraps long pastes, which would make a
  // whitespace-sensitive base64 parser give up.
  withoutEnv(() => {
    session.clearCookies();
    session._reset();

    const encoded = Buffer.from(NETSCAPE, "utf8").toString("base64");
    const wrapped = encoded.replace(/(.{60})/g, "$1\n");

    const saved = session.setCookies(wrapped);
    assert.equal(saved.count, 4);
    assert.equal(saved.signedIn, true);
  });
});

test("cookies: a visitor-only export is flagged, not silently accepted", () => {
  withoutEnv(() => {
    session.clearCookies();
    session._reset();

    const saved = session.setCookies("VISITOR_INFO1_LIVE=abc; PREF=f6=400");
    assert.equal(saved.signedIn, false, "no SID means YouTube will still block");
    assert.match(session.status().text, /visitor export/);
  });
});

test("cookies: junk is rejected instead of writing a useless file", () => {
  withoutEnv(() => {
    session.clearCookies();
    session._reset();

    for (const junk of ["", "hello world", "{}", "a=b", "12345"]) {
      assert.throws(() => session.setCookies(junk), /doesn't look like youtube cookies/);
    }
    assert.equal(session.source(), null);
    assert.equal(session.header(), null);
    assert.equal(session.cookieFile(), null);
  });
});

test("cookies: status is honest about the source and never prints a value", () => {
  withoutEnv(() => {
    session.clearCookies();
    assert.equal(session.status().configured, false);
    assert.match(session.status().text, /no youtube cookies set/);

    session.setCookies(NETSCAPE);
    const status = session.status();
    assert.equal(status.configured, true);
    assert.equal(status.signedIn, true);
    assert.match(status.text, /signed-in session/);
    assert.doesNotMatch(status.text, /sid-value/, "cookie values must never be echoed");
  });
});

test("cookies: the environment wins, and clearing removes the saved copy", () => {
  withoutEnv(() => {
    session.clearCookies();
    session._reset();

    session.setCookies("VISITOR_INFO1_LIVE=saved-value");
    assert.equal(session.source(), "saved");

    process.env.YT_COOKIE = "SID=env-value";
    try {
      assert.equal(session.source(), "env");
      assert.match(session.header(), /SID=env-value/);
    } finally {
      delete process.env.YT_COOKIE;
    }

    assert.equal(session.clearCookies(), true);
    assert.equal(session.source(), null);
    assert.equal(session.cookieFile(), null);
  });
});

// ── the chat command ───────────────────────────────────────────────

function loadPlay() {
  const modulePath = path.join(ROOT, "commands", "downloaders", "play.js");
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function fakeSock() {
  return {
    sendMessage: async () => {},
    relayMessage: async () => {},
    updateMediaMessage: async () => {},
  };
}

test(".play cookie: owner can save in a DM, and it starts being used", async () => {
  const savedEnv = process.env.OWNER_NUMBERS;
  process.env.OWNER_NUMBERS = "2348000000001";
  delete require.cache[require.resolve(path.join(ROOT, "utils", "owner.js"))];

  withoutEnv(() => {
    session.clearCookies();
    session._reset();
  });

  try {
    const { playSong } = loadPlay();
    const dm = { key: { remoteJid: "2348000000001@s.whatsapp.net" } };

    const encoded = Buffer.from(NETSCAPE, "utf8").toString("base64");
    const result = await playSong(fakeSock(), dm, `cookie ${encoded}`);

    assert.match(result.text, /saved 4 cookies/);
    assert.match(result.text, /signed-in session/);
    assert.doesNotMatch(result.text, /sid-value/, "never echo the cookies back");
    assert.equal(session.source(), "saved");

    const status = await playSong(fakeSock(), dm, "cookie");
    assert.match(status.text, /youtube cookies active/);

    const cleared = await playSong(fakeSock(), dm, "cookie clear");
    assert.match(cleared.text, /removed/);
    assert.equal(session.source(), null);
  } finally {
    session.clearCookies();
    process.env.OWNER_NUMBERS = savedEnv;
    delete require.cache[require.resolve(path.join(ROOT, "utils", "owner.js"))];
  }
});

test(".play cookie: refused in a group and from non-owners", async () => {
  const savedEnv = process.env.OWNER_NUMBERS;
  process.env.OWNER_NUMBERS = "2348000000001";
  delete require.cache[require.resolve(path.join(ROOT, "utils", "owner.js"))];

  withoutEnv(() => {
    session.clearCookies();
    session._reset();
  });

  try {
    const { playSong } = loadPlay();
    const encoded = Buffer.from(NETSCAPE, "utf8").toString("base64");

    // Owner, in a group: refused, because everyone there could read it.
    const inGroup = await playSong(
      fakeSock(),
      { key: { remoteJid: "1203630@g.us", participant: "2348000000001@s.whatsapp.net" } },
      `cookie ${encoded}`
    );
    assert.match(inGroup.text, /dm me/);
    assert.equal(session.source(), null);

    // Someone else, in a DM: refused.
    const stranger = await playSong(
      fakeSock(),
      { key: { remoteJid: "2348999999999@s.whatsapp.net" } },
      `cookie ${encoded}`
    );
    assert.match(stranger.text, /only the owner/);
    assert.equal(session.source(), null);

    // Bad input gets a real explanation, not a silent failure.
    const junk = await playSong(
      fakeSock(),
      { key: { remoteJid: "2348000000001@s.whatsapp.net" } },
      "cookie hello"
    );
    assert.match(junk.text, /base64/);
  } finally {
    session.clearCookies();
    process.env.OWNER_NUMBERS = savedEnv;
    delete require.cache[require.resolve(path.join(ROOT, "utils", "owner.js"))];
  }
});

test(".play cookie: 'cookies' is not treated as a song search", async () => {
  // A regression guard: the subcommand must be matched before any search, or
  // `.play cookies` would go looking for a song called "cookies".
  let searched = false;
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    const resolved = (() => {
      try {
        return Module._resolveFilename(request, parent, isMain);
      } catch {
        return request;
      }
    })();
    if (String(resolved).endsWith(path.join("utils", "y2mate", "search.js"))) {
      return {
        searchYoutube: async () => {
          searched = true;
          throw new Error("should not search");
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  const savedEnv = process.env.OWNER_NUMBERS;
  process.env.OWNER_NUMBERS = "2348000000001";
  delete require.cache[require.resolve(path.join(ROOT, "utils", "owner.js"))];

  try {
    const { playSong } = loadPlay();
    const result = await playSong(
      fakeSock(),
      { key: { remoteJid: "2348000000001@s.whatsapp.net" } },
      "cookies"
    );
    assert.equal(searched, false);
    assert.match(result.text, /youtube cookies/);
  } finally {
    Module._load = originalLoad;
    process.env.OWNER_NUMBERS = savedEnv;
    delete require.cache[require.resolve(path.join(ROOT, "utils", "owner.js"))];
  }
});
