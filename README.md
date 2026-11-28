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
| `.resetauth` | *(owner)* Wipe the WhatsApp session and restart into pairing — the fix when the bot keeps disconnecting. Watch the host logs for the fresh pairing code. |

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

`.play` audio uses a **five-stage fallback chain**. The chat never shows
the API service names — stages appear only as **API 1**, **API 2**,
**API 3** (the mapping below is for operators, not for the chat).

1. **Cache hit** → send immediately.
2. **API 1 = Knight** (`utils/songApis.js`): one GET per candidate
   returns an MP3 already sitting on a CDN (`result.download`) — no IP
   lock, no expiry. Every ranked candidate is tried before switching
   APIs, because one dead upload is not a dead API (measured: the
   official Adele upload failed on both APIs while 5 of 6 other uploads
   worked instantly).
3. **API 2 = Prexzy** (`utils/songApis.js`): one GET returns a
   `download_url` — a raw googlevideo.com `.m4a` that **expires within
   hours** — downloaded immediately, the URL never stored.
4. **API 3 = SoundCloud** (`utils/soundcloud.js`, Prexzy's SC
   endpoints): its own search (`/search/soundcloud`), rows ranked (sped
   up / slowed + reverb / remix / cover to the back — but a keyword the
   user searched for is never a penalty), then each candidate goes
   resolve → byte link (`?id=<id>&mode=audio&quality=hq`; `lq` accepted
   when no HQ upload exists) → ftyp+size sanity check. If the byte link
   fails, the signed HLS playlist is remuxed with
   `ffmpeg -c copy -bsf:a aac_adtstoasc`. No bot check, no proxy needed,
   ~4 s per track. Every URL here carries an `expires=` stamp — only the
   file is ever stored. A pasted SoundCloud link (`...soundcloud.com/...`
   or `snd.sc/...`, share-tracking junk stripped) skips the chain
   entirely and uses the track's own metadata for the card (the platform
   name appears in chat only there, because the user pasted the link).
5. **yt-dlp** (`utils/songfetch.js`, the songfetch.py search-rank-retry
   method): the last resort, and the only stage the server's own IP /
   proxy pool touches. The 300 s YouTube cooldown gates ONLY this stage —
   every API stage runs first even while the YouTube route cools down.

The YouTube flat search runs up front: both YouTube APIs take watch
URLs, so the ranked video-ID list is needed immediately.

Whichever stage won, the audio file is sent **directly** as a WhatsApp
audio message with its true mimetype — `audio/mpeg` for MP3, `audio/mp4`
for M4A. Both are natively playable formats in WhatsApp (the same music
bubble a phone gets when sending an `.m4a`), so there is **no
transcode** and no "Converting for WhatsApp..." wait at all — this also
means SoundCloud's AAC 160 kbps stereo reaches the chat untouched
(previously it was re-encoded down to 64 kbps mono Opus). The Opus/OGG
path is kept only as a fallback if a direct send errors out (it's
mandatory only for voice-note mode, `ptt: true`, which the bot doesn't
use). The metadata card arrives right after the download, before the audio —
built from the **serving stage's own thumbnail** (the artwork of the
exact upload being sent: Prexzy/Knight return one, SoundCloud has
artwork), falling back to the iTunes exact-artist match, and to a dark
♪-glyph card only when nothing has art. Cards without artwork are not
cached, so a later play can still pick up real art. For pasted SC links
the card comes from the SoundCloud response itself.
`.play -v <song>` still uses yt-dlp directly (video APIs weren't part of
the switch), with the same retry logic.

The API base URLs live in env vars so a dead endpoint can be swapped
without a code deploy (10 endpoints tested in the wild: 3 deleted, 2
without DNS):

| Env var | Default | Purpose |
| --- | --- | --- |
| `KNIGHT_API_URL` | `https://knightbotapi.stream` | Knight base URL |
| `KNIGHT_API_KEY` | `knight` | the free shared key from KnightBot's public repo — not a secret |
| `PREXZY_API_URL` | `https://prexzyapis.com` | Prexzy base URL |

The yt-dlp binary is fetched into `bin/` by `scripts/install-ytdlp.js`, which
runs automatically on `npm install`. It's yt-dlp's official standalone build
(the one that embeds its own interpreter), so there's no Python, no apt, no
pip, no Dockerfile changes — plain `npm install` works on Render's default
Node environment. The binary is also re-checked at every bot start and
re-downloaded once it's older than 24 hours (`YT_DLP_MAX_AGE_HOURS`) —
YouTube breaks old extractors between releases, so a stale binary shows up
as mystery bot checks. (`youtube-dl-exec` was tried first and dropped: its installer
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

- `.play` with no query just prints usage.

### When YouTube says no (bot check / 429)

yt-dlp never asks for cookies interactively — "use --cookies-from-browser
or --cookies" is a static remedy suffix it glues onto failures
(extractor/common.py). The line *before* it names the real cause:

| What yt-dlp says | Real cause | Do cookies help? |
| --- | --- | --- |
| Sign in to confirm you're not a bot | IP reputation / too many requests (datacenter, VPN) | Rarely — it's the IP, not the login |
| HTTP Error 429 | Rate limited | No — slow down |
| Age-restricted video | Needs an account | Yes, but the bot doesn't use cookies |
| Private video / Video unavailable | Deleted or private | No |

The bot handles this the way music-seeker's `player.py` does — that repo
hit the exact same wall and chose **not** to use cookies:

- After a bot check or 429 it starts a **5-minute cooldown** (300 s, like
  their `YT_COOLDOWN = 300.0`) and every `.play` fails fast with the
  remaining time instead of hammering YouTube — more requests from a
  flagged IP only extend the block. Bot checks/429s also stop the
  candidate loop immediately instead of trying all 5 uploads.
- Candidate attempts within one track are spaced **5 s apart**
  ("50 requests in a row from one IP is what earns the bot check").
- The yt-dlp binary is **refreshed when older than 24 h** — at every bot
  start and on `npm install` (`YT_DLP_MAX_AGE_HOURS` to tune, `0` =
  always refresh, `-1` = never). YouTube breaks old extractors between
  releases, and a current binary alone clears a lot of "bot checks".
- Failure messages name the real cause (bot check, 429, age-restricted,
  private/removed) instead of a generic error.
- Every video download also rides a **client ladder** instead of
  YouTube's default clients: `android_vr,tv_downgraded,tv,web_embedded,mweb`
  via `--extractor-args`, with two escalation rungs (`--force-ipv4`, a
  webpage-free fetch, then an alternate client mix) that only start when
  yt-dlp's stderr actually shows the wall — no cookies anywhere. The
  optional `deno` npm package (installed by the same plain
  `npm install`) is passed via `--js-runtimes` so the JS-dependent
  clients can decode their streams; `android_vr` — the rung that
  bypasses the check — needs no runtime at all.

The biggest lever is outside the code: a datacenter IP (Render, a VPS)
is what earns the bot check in the first place. A residential IP or a
different host fixes it outright. Cookies were deliberately **not**
built in — the source repo made the same call — because they bind
downloads to a personal Google account (bulk automated downloading is a
real ban risk), expire in weeks, and are a patch on an IP problem, not
a fix.

### If the IP stays blocked: route yt-dlp through a different IP

Set `YT_DLP_PROXY` and every yt-dlp call (search + download, audio +
video) goes through it — **WhatsApp traffic stays direct**, so the bot
session is untouched. yt-dlp accepts standard URLs:

```bash
YT_DLP_PROXY="socks5h://user:pass@proxy-host:1080"
# or an HTTP proxy:
YT_DLP_PROXY="http://user:pass@proxy-host:8080"
```

Use `socks5h://` (not `socks5://`) for SOCKS endpoints — the `h` makes
DNS resolve *through the proxy*, which is the point when your local IP
is the problem.

What to point it at, roughly cheapest-first:

| Endpoint | Cost | Trade-offs |
| --- | --- | --- |
| Cloudflare WARP in proxy mode (`warp-cli proxy`, local SOCKS5) | free | needs to run on the bot host, so Render must use the Docker runtime — it can't be installed on the default Node image; Cloudflare egress works for YouTube most of the time but is shared too |
| Cheap VPS + a tiny SOCKS5 server (`3proxy`, `gost`, `microsocks`) | ~$4–5/mo | a fresh datacenter IP that usually isn't flagged; can get flagged again if volume gets abusive — then move it |
| Residential proxy service (IPRoyal, Smartproxy, Soax, …) | ~$1.5–4/GB | the most reliable against the bot check; audio traffic is small — a 4-minute song at best quality is ~8 MB, so 1,000 songs ≈ 8 GB; use a **sticky session** so one download doesn't change IP mid-flight |
| Home machine as exit node (Tailscale/WireGuard) | free | egress = your home (residential) IP; needs the VPN client on the bot host, so again Docker runtime on Render — or just run the bot at home |

Notes:

- The 300 s cooldown still applies while a proxy is set — it protects
  the proxy's IP from the same hammering.
- Only yt-dlp traffic is proxied. `npm install`, Baileys, and every
  other fetch go out the normal route.
- Pick a proxy whose other users don't hammer YouTube — a shared VPN
  exit with abuse history is the same problem you're escaping.

#### Rotating through several proxies

`YT_DLP_PROXY_LIST` takes several proxy URLs (comma, semicolon, or
newline separated — Webshare-style `http://user:pass@host:port`):

```bash
YT_DLP_PROXY_LIST="http://user:pass@1.2.3.4:6014,http://user:pass@5.6.7.8:6641,..."
```

- **Every yt-dlp call rotates to the next IP** (round-robin): the flat
  search and each candidate download ride different addresses, which
  spreads the request rate the way "space requests apart" wants.
- A proxy that fails — dead endpoint, auth error, hang, or an IP YouTube
  flags with a bot check/429 — is **benched for 10 minutes**
  (`YT_DLP_PROXY_BENCH_MS` to change) and the rest keep working. Content
  failures ("private video") don't bench anything; that's not the
  proxy's fault.
- While rotation is active (2+ proxies), the 300 s global cooldown is
  **not** applied — one flagged IP shouldn't stall the other nine, and
  each call is already on a different address. With a single proxy or a
  direct connection, the cooldown applies exactly as before.
- Only yt-dlp traffic rotates. Baileys/WhatsApp always stays direct.

For Webshare's dashboard: Authentication = Username/Password, Connection
= Direct Connection, then build `http://<username>:<password>@<address>:<port>`
for each row.

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
