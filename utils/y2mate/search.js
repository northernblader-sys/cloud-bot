// YouTube search + video metadata.
//
// youtubei.js is ESM-only; this bot is CommonJS, so we load it via dynamic
// import. Search is tried across several InnerTube clients because YouTube
// periodically starts rejecting the default one ("Sign in to confirm you're
// not a bot"), and a different client usually still answers.

const YOUTUBE_ID_RE = /(?:v=|\/embed\/|\/shorts\/|youtu\.be\/|\/v\/)([-_0-9A-Za-z]{11})/;

const SEARCH_CLIENTS = ["WEB", "iOS", "MWEB", "TVHTML5"];
const CLIENT_TTL_MS = 6 * 60 * 60 * 1000;

let youtubeModulePromise;
const clientPromises = new Map();

function extractVideoId(input) {
  const value = String(input || "").trim();
  if (/^[-_0-9A-Za-z]{11}$/.test(value)) return value;
  return value.match(YOUTUBE_ID_RE)?.[1] || null;
}

function isYoutubeInput(input) {
  return /(?:youtube\.com|youtu\.be)/i.test(String(input || ""));
}

function loadYoutubeModule() {
  if (!youtubeModulePromise) {
    youtubeModulePromise = import("youtubei.js").catch((err) => {
      youtubeModulePromise = null;
      throw err;
    });
  }
  return youtubeModulePromise;
}

async function createClient(clientName) {
  const youtube = await loadYoutubeModule();
  return youtube.Innertube.create({
    client_type: clientName,
    cache: new youtube.UniversalCache(false),
    generate_session_locally: true,
    lang: "en",
    location: "US",
  });
}

function getClientFor(clientName) {
  const cached = clientPromises.get(clientName);
  if (cached && Date.now() - cached.createdAt < CLIENT_TTL_MS) return cached.promise;

  const entry = { createdAt: Date.now() };
  entry.promise = createClient(clientName).catch((err) => {
    clientPromises.delete(clientName);
    throw err;
  });
  clientPromises.set(clientName, entry);
  return entry.promise;
}

async function lookupVideoId(clientName, videoId) {
  const client = await getClientFor(clientName);
  const info = await client.getBasicInfo(videoId);
  const basic = info.basic_info || {};
  return {
    id: videoId,
    title: basic.title || videoId,
    thumbnail: basic.thumbnail?.[0]?.url || null,
    author: basic.author || "",
    durationSec: Math.round(Number(basic.duration) || 0),
  };
}

async function searchWithClient(clientName, query) {
  const client = await getClientFor(clientName);
  const results = (await client.search(query, { type: "video" })).results || [];
  const result = results.find((entry) => entry.id && entry.title);
  if (!result) throw new Error("No YouTube result found for that search");

  return {
    id: result.id,
    title: result.title?.text || result.title || query,
    thumbnail: result.best_thumbnail?.url || result.thumbnails?.[0]?.url || null,
    author: result.author?.name || "",
    durationSec: Math.round(Number(result.duration?.seconds) || 0),
  };
}

async function lookupViaOembed(videoId) {
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !data.title) return null;
    return {
      id: videoId,
      title: String(data.title).trim(),
      thumbnail: data.thumbnail_url || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      author: String(data.author_name || "").trim(),
      durationSec: 0,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function searchYoutube(query) {
  const input = String(query || "").trim();
  const directId = extractVideoId(input);
  const attempts = isYoutubeInput(input) && directId
    ? SEARCH_CLIENTS.map((client) => () => lookupVideoId(client, directId))
    : SEARCH_CLIENTS.map((client) => () => searchWithClient(client, input));

  const failures = [];
  for (const attempt of attempts) {
    try {
      const found = await attempt();
      if (found && found.title && found.title !== directId) return found;
      if (found && !directId) return found;
    } catch (err) {
      failures.push(err.message);
    }
  }

  // A direct link or bare video id is still usable for downloading even when
  // InnerTube metadata lookup is blocked — oEmbed never triggers YouTube's
  // player bot-check and still gives us the real song title + artist for
  // SoundCloud/API fallbacks.
  if (directId && (isYoutubeInput(input) || /^[-_0-9A-Za-z]{11}$/.test(input))) {
    const oembed = await lookupViaOembed(directId);
    if (oembed) return oembed;
    return { id: directId, title: directId, thumbnail: null, author: "", durationSec: 0 };
  }

  throw new Error(failures[failures.length - 1] || "YouTube search failed");
}

module.exports = { searchYoutube, extractVideoId };
