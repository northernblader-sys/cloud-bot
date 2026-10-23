const persist = require("./persist");

const GAMES = new Map(); // chatId -> game
const PLAYERS = new Map(); // jid -> chatId
const PENDING = new Map(); // challengerJid -> { target, chat, expiry }
const DRAW_OFFERS = new Map(); // chatId -> jid who offered the draw

let loaded = false;
function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  const data = persist.get("chessGames", {});
  for (const [chatId, game] of Object.entries(data)) {
    GAMES.set(chatId, game);
    PLAYERS.set(game.white, chatId);
    PLAYERS.set(game.black, chatId);
  }
}

function persistGames() {
  const obj = {};
  for (const [chatId, game] of GAMES.entries()) obj[chatId] = game;
  persist.set("chessGames", obj);
}

function getGame(chatId) {
  ensureLoaded();
  return GAMES.get(chatId) || null;
}

function saveGame(chatId, game) {
  ensureLoaded();
  GAMES.set(chatId, game);
  PLAYERS.set(game.white, chatId);
  PLAYERS.set(game.black, chatId);
  persistGames();
}

function endGame(chatId) {
  ensureLoaded();
  const game = GAMES.get(chatId);
  if (game) {
    PLAYERS.delete(game.white);
    PLAYERS.delete(game.black);
  }
  GAMES.delete(chatId);
  DRAW_OFFERS.delete(chatId);
  persistGames();
}

function isPlayerBusy(jid) {
  ensureLoaded();
  return PLAYERS.has(jid);
}

module.exports = {
  getGame,
  saveGame,
  endGame,
  isPlayerBusy,
  PENDING,
  DRAW_OFFERS,
};
