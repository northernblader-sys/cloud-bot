# ☁️ Astral Cloud

A small WhatsApp utility bot built with [Baileys](https://github.com/WhiskeySockets/Baileys).

## Setup

```bash
npm install
node index.js
```

On first run, a QR code will print in your terminal. Scan it from
**WhatsApp → Linked Devices → Link a Device**.

Once paired, your session is saved to `auth_info/` — you won't need to
re-scan on future restarts (as long as that folder persists).

## Running with PM2 (recommended for VPS)

```bash
pm2 start index.js --name astral-cloud
pm2 save
```

## Commands

| Command | Description |
|---|---|
| `.menu` | Show the full command list |
| `.time` | Current time (or `.time japan` for another country) |
| `.date` | Today's date |
| `.ping` | Check bot response speed |
| `.calc <expr>` | Quick calculator, e.g. `.calc 12 * (4 + 1)` |
| `.shorten <url>` | Shorten a link |
| `.qr <text>` | Generate a QR code image |
| `.sticker` | Reply to an image with this to turn it into a sticker |
| `.tenor <query>[, count]` | Search Tenor and send back animated stickers |
| `.about` | About Astral Cloud |

## The `.cloud` brain

`.cloud <anything>` routes a natural-language message to one of the bot's
commands, or answers it conversationally.

- **Model:** OpenRouter (`utils/openrouter.js`), `openai/gpt-4o-mini` by
  default — cheap, fast, handles tool calling and images. Set
  `OPENROUTER_MODEL` to switch (e.g. `openai/gpt-4o`). The key is read from,
  in order: `OPENROUTER_API_KEY`, a key saved at runtime, or
  `<DATA_DIR>/openrouter.key` (see `utils/openrouter.key.example`). It is
  deliberately not committed: GitHub's push protection rejects live
  credentials in a public repo, and anyone who could read the file could spend
  against it.

  Quickest way to set it: **DM the bot** `.cloud key sk-or-v1-...` as the
  owner. It is stored through `utils/persist.js` (MongoDB when
  `MONGODB_URI` is set, otherwise the local data dir), validated, and tested
  with a real call before it confirms. `.cloud key` shows the masked key and
  where it came from; `.cloud key clear` removes it. Keys are refused in group
  chats so they never end up in chat history.
- **Personality:** `utils/cloudPersonality.js` — identity, tone rules, voice
  examples and reply clean-up (no em dashes, no markdown). Edit this file to
  change how cloud talks; nothing else needs touching.
- **Memory:** `utils/cloudMemory.js` — remembers each member by phone number
  and name, plus a running transcript **per person per chat**, so two people in
  the same group never share a conversation. Names/facts are learned from the
  model's `<remember .../>` tags (stripped before sending) with a regex backup
  for "my name is …" / "call me …". Stored through `utils/persist.js`, so it
  survives restarts (MongoDB when `MONGODB_URI` is set, JSON files otherwise).
- **Grounding:** answers use OpenRouter's web plugin for live info.
- **Housekeeping:** `.cloud whoami` shows what the bot remembers about you,
  `.cloud forget me` wipes your name, facts and transcripts.
- If OpenRouter is unreachable **and** `GEMINI_API_KEY` is set, it falls back
  to the old Gemini path so `.cloud` still answers.

## Downloaders

| Command | Description |
|---|---|
| `.play <song name>` | Search YouTube and send the audio as an inline Opus/OGG message |
| `.play -v <song name>` | Same search, but send the video (MP4) instead |
| `.tiktok <url>` | Download a TikTok video (or images) |
| `.ig <url>` | Download an Instagram post/reel |
| `.pinterest <url>` | Download a Pinterest image/video/gif |
| `.fb <url>` | Download a Facebook video/photo |
| `.dl <url>` | Auto-detect the platform and download |
| `.tulsi mp3 <url>` | Audio extracted via the Tulsi API, sent as an MP3 audio message |
| `.tulsi mp4 <url>` | 720p MP4 video via the Tulsi API, sent as a video message |

`.play` searches YouTube with the `yt-search` package (a plain search-results
lookup, no login), downloads the audio with the standalone `yt-dlp` binary,
and re-muxes it with `ffmpeg-static` into mono 48 kHz Opus
in an OGG container — the exact format WhatsApp inline-plays as an audio
message (anything else shows up as a tap-to-open document). `.play -v <song>`
sends the video as a 480p MP4 instead.

The yt-dlp binary is fetched into `bin/` by `scripts/install-ytdlp.js`, which
runs automatically on `npm install`. It's yt-dlp's official standalone build
(the one that embeds its own interpreter), so there's no Python, no apt, no
pip, no Dockerfile changes — plain `npm install` works on Render's default
Node environment. (`youtube-dl-exec` was tried first and dropped: its installer
demands a system Python 3.11+, which Render doesn't ship, and its default
download is a Python zipapp that would need that interpreter at runtime too.)
ffmpeg comes from the `ffmpeg-static` npm package. The optional `deno` npm
package rides along as yt-dlp's JavaScript runtime (needed by most YouTube
clients to decode their streams); it's a prebuilt binary, so it installs the
same plain-`npm-install` way and, if it ever fails to install, yt-dlp just
falls back to the JS-free clients. Downloads are cached in
`cache/music/`, so repeating the same query is instant until the next deploy
(Render's disk is ephemeral; mount a Render Disk at `./cache` if you want the
cache to survive redeploys).

Notes:

- Tracks over 10 minutes are rejected up front (a 3-hour mix would stall the
  bot).
- `.play` with no query just prints usage.
- The download path runs `yt-dlp` against YouTube directly. YouTube shows
  datacenter IPs (like Render's) a "Sign in to confirm you're not a bot"
  check on its default clients; rather than using cookies, `.play` asks
  yt-dlp for a ladder of client impersonations
  (`android_vr,tv_downgraded,tv,web_embedded,mweb`) and, if the wall still
  shows up, retries with `--force-ipv4` and a second client ladder. The
  optional `deno` package gives those clients the JS runtime they need.
  If every rung fails, the error (minus yt-dlp's cookie suggestion)
  surfaces in the chat ("Download failed...") rather than failing silently.

`.tiktok`/`.ig`/`.pinterest`/`.fb` use tikwm.com and api-faa.my.id. Those are third-party scraper APIs, not official platform APIs — they can change or go down without notice. If one stops working, the fix is updating the relevant fetch function in `utils/downloaders/fetchers.js`.

Replying to a message that contains a supported link also works for `.dl`.

## Welcome verification

When `.welcome` is on and someone joins, the bot asks **one anime question**
instead of the old "2 + 3 = ?" maths challenge. There are 40 questions
(Naruto, Demon Slayer, Jujutsu Kaisen, Dragon Ball Super, Death Note, The
Eminence in Shadow, My Hero Academia, Black Clover, Hunter x Hunter, Pokémon,
One Piece) in `utils/animeQuiz.js`.

Answers are matched generously, because people type how they type:

- capitals, emoji, punctuation and accents are ignored (`KURAMA!!`, `Nézuko`);
- `the` / `a` / `of` are ignored and plurals folded, so `straw hat`, `hats`,
  `Straw Hats`, `STRAWHAT PIRATES` and `mugiwara` all count for "the Straw Hat
  Pirates";
- partial answers work (`zoro`, `roronoa`, `kakashi`, `deku`, `leaf`);
- small typos are forgiven (`kuruma`, `nezuki`, `ryomen sukunaa`);
- digits read as words, so `9 tails` works.

It stays strict where it matters: a wrong answer never passes, and a question
never accepts another question's answer (a test enforces that across the whole
pool). Two wrong guesses get a short nudge, then the person can keep trying
until the 5-minute timeout.

To change the pool, edit `utils/animeQuiz.js` — each entry is
`{ id, category, question, answers: [...] }`; add every phrasing you want
accepted to `answers`.

## Files

| Command | Description |
|---|---|
| `.7zip` | Reply to an archive to extract it |
| `.7zip add <path/name.ext>` | Reply to a file to add it to the compression queue |
| `.7zip up` | Compress everything in the queue and send it back as a .zip |

`.7zip` auto-downloads a portable 7-Zip binary on first use (into
`media/bin/7ZIP/`) and shells out to it. Queue size, max file size, and
compression timeout can be tuned via `MAX_QUEUE_SIZE`, `MAX_UPLOAD` (in MB),
and `COMPRESS_TIMEOUT` (in ms) environment variables.

## Search

| Command | Description |
|---|---|
| `.anime <title>` | Search AniList — poster, short synopsis, rating |
| `.movie <title>` / `.omdb <title>` | Search OMDb — poster, short synopsis, IMDb rating |

`.movie`/`.omdb` needs an OMDb API key set as the `OMDB_API_KEY` environment
variable (free key from [omdbapi.com](https://www.omdbapi.com/apikey.aspx)).
`.anime` uses AniList's public GraphQL API and needs no key.

## Group moderation (admin-only)

| Command | Description |
|---|---|
| `.kick @user` | Remove a member (mention, reply, or number) |
| `.add <number>` | Add a member by number |
| `.promote @user` | Make a member admin |
| `.demote @user` | Remove admin status |
| `.tagall <text>` | Mention every member, visibly |
| `.hidetag <text>` | Ping every member without showing the tags |
| `.mute` | Only admins can send messages |
| `.unmute` | Everyone can send messages again |
| `.setname <name>` | Change the group name |
| `.setdesc <text>` | Change the group description |
| `.antilink on/off` | Auto-delete + kick on links |
| `.antistatus on/off` | Auto-delete + kick on Status shares |
| `.antichannel on/off` | Auto-delete + kick on Channel forwards |
| `.antispam on/off` | Auto-delete + kick on rapid message spam |
| `.welcome on/off` | Verify new members with a math check before they can stay |

All anti-features are **ON by default** in every group. Only group admins can
run these commands, and group admins are always exempt from the anti-features
(so an admin sharing a link won't get kicked).

`.welcome` is **OFF by default**. When on: new members get tagged with a
random simple addition question (e.g. `3 + 5 = ?`) and 5 minutes to answer
correctly in the group. Wrong answers are ignored (they can keep trying until
the timer runs out). On a correct answer they're tagged again and asked for
their name, age, best/worst anime, and the year they started watching —
that part is just for fun, nothing is required or stored. If they don't
answer the math question correctly within 5 minutes, the bot removes them
(only if it has admin rights in the group — otherwise it just posts that it
couldn't).

Admin-only commands fire immediately once the sender is confirmed an admin —
they don't pre-check whether the bot itself is a group admin. If the bot
lacks admin rights, the underlying WhatsApp API call fails and the bot
reports it couldn't complete the action.

## Project structure

```
astral-cloud/
├── index.js              # Entry point — connection + message listener
├── handlers/
│   └── router.js         # Parses commands, dispatches to command modules
├── commands/
│   ├── menu.js
│   ├── datetime.js
│   ├── calc.js
│   ├── shorten.js
│   ├── qr.js
│   ├── sticker.js
│   └── misc.js
├── utils/
│   └── extractText.js
└── auth_info/             # Session data (auto-created, gitignored)
```

## Adding a new command

1. Create a new file in `commands/` that exports a function.
2. Import it in `handlers/router.js` and add a `case` in the switch statement.
3. Add it to the menu list in `commands/menu.js`.

## Notes

- Uses `.` as the command prefix (change `PREFIX` in `commands/menu.js`).
- `auth_info/` contains your WhatsApp session — never commit it or share it.
- Deleting `auth_info/` will require re-pairing via QR code.

## Health endpoint

The bot also starts a tiny HTTP server on `$PORT` (default `3000`):

- `GET /` → `☁️ Astral Cloud is running`
- `GET /health` → JSON: `{ ok, bot, uptimeSec, reconnects, lastDisconnectCode }`
  where `bot` is `open`, `connecting`, `closed`, `replaced` or `logged_out`.

Point an uptime pinger (UptimeRobot / cron-job.org) at `/health` to keep a
free web service awake. On Render use Start Command `npm start`.

## MongoDB storage (recommended on Render/other hosts without a disk)

Set these environment variables and the WhatsApp session, group settings,
trusted users and chess games are stored in MongoDB instead of local files,
so they survive restarts and redeploys:

| Variable | Description |
|---|---|
| `MONGODB_URI` | Connection string, e.g. `mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/` |
| `MONGODB_DB` | Optional. Database name (default `astral_cloud`) |
| `BOT_ID` | Optional. Collection prefix (default `astral`). Use a different value per bot if two bots share one database |

Without `MONGODB_URI` the bot keeps using `auth_info/` and `data/` as before.
