// 1.000 jogos FICTÍCIOS em memória, com a mesma assinatura do js/data/db.js (contrato 6.3).
// Uso: import * as db from '../dev/mock-data.js' até o B1 ficar pronto.

const STORES = ['steam', 'epic', 'gog', 'ubisoft', 'ea', 'amazon', 'other'];
const STATUSES = ['backlog', 'playing', 'paused', 'finished', 'completed', 'dropped'];
const A = ['Crimson', 'Silent', 'Neon', 'Hollow', 'Iron', 'Lost', 'Ember', 'Frozen', 'Rogue', 'Astral', 'Obsidian', 'Wild', 'Rusty', 'Velvet', 'Cosmic'];
const B = ['Harbor', 'Citadel', 'Orbit', 'Garden', 'Circuit', 'Kingdom', 'Frontier', 'Echo', 'Tide', 'Vault', 'Relic', 'Horizon', 'Forge', 'Signal', 'Reverie'];
const C = ['', '', '', ' II', ' Origins', ' Legacy', ' Reborn', ' Tactics', ' Chronicles'];
const TAGS = ['coop', 'indie', 'roguelike', 'cozy', 'souls-like', 'story', 'retro'];
const GENRES = ['RPG', 'Ação', 'Estratégia', 'Aventura', 'Puzzle', 'Simulação', 'Plataforma'];

let seed = 20261012;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

export function normalizeTitle(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[™®©]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function makeGame(i) {
  const title = `${pick(A)} ${pick(B)}${pick(C)}`;
  const nStores = rnd() < 0.15 ? 2 : 1;
  const ownerships = [];
  while (ownerships.length < nStores) {
    const store = pick(STORES);
    if (ownerships.some((o) => o.store === store)) continue;
    const played = rnd() < 0.6;
    ownerships.push({
      store, storeGameId: store === 'steam' ? String(100000 + i) : null, source: 'manual',
      playtimeMinutes: played ? Math.floor(rnd() * 6000) : 0,
      lastPlayedAt: played ? new Date(Date.now() - rnd() * 4e10).toISOString() : null,
      importedAt: new Date().toISOString(),
    });
  }
  const now = new Date(Date.now() - rnd() * 1e10).toISOString();
  return {
    id: `mock-${i}`, title, titleKey: normalizeTitle(title), ownerships,
    status: pick(STATUSES), favorite: rnd() < 0.08, rating: rnd() < 0.3 ? 1 + Math.floor(rnd() * 5) : null,
    tags: rnd() < 0.5 ? [pick(TAGS)] : [], genres: [pick(GENRES)], developer: null, year: 2000 + Math.floor(rnd() * 26),
    startedAt: null, finishedAt: null, links: [], achievementsDone: null, achievementsTotal: null,
    coverUrl: null, coverAppId: null, coverManual: false,
    playtimeMinutes: ownerships.reduce((s, o) => s + (o.playtimeMinutes || 0), 0),
    lastPlayedAt: ownerships.map((o) => o.lastPlayedAt).filter(Boolean).sort().pop() || null,
    notes: '', createdAt: now, updatedAt: now,
  };
}

const games = new Map(Array.from({ length: 1000 }, (_, i) => makeGame(i)).map((g) => [g.id, g]));
const meta = new Map();
const listeners = new Set();
const emit = (ev = { type: 'games' }) => listeners.forEach((cb) => cb(ev));
const clone = (v) => structuredClone(v);

/** @returns {Promise<object[]>} */
export async function getAllGames() { return [...games.values()].map(clone); }
/** @param {string} id */
export async function getGame(id) { return games.has(id) ? clone(games.get(id)) : undefined; }
/** @param {object} game */
export async function putGame(game) { games.set(game.id, clone(game)); emit(); }
/** @param {object[]} list */
export async function putGames(list) { list.forEach((g) => games.set(g.id, clone(g))); emit(); }
/** @param {string} id */
export async function deleteGame(id) { games.delete(id); emit(); }
/** @param {object[]} list */
export async function replaceGames(list) { games.clear(); list.forEach((g) => games.set(g.id, clone(g))); emit(); }
export async function clearGames() { games.clear(); emit(); }
/** @param {string} key */
export async function getMeta(key) { return meta.get(key); }
/** @param {string} key @param {*} value */
export async function setMeta(key, value) { meta.set(key, value); emit({ type: 'meta', key }); }
/** @param {() => void} cb @returns {() => void} */
export function onChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
