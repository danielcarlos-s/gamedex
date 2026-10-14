// Completa os jogos da Steam com o que a API de biblioteca não traz: gêneros, desenvolvedora, ano e conquistas.
// Sem DOM e sem texto para o usuário: falhas viram `throw { code }` (seção 6.4). Só preenche campo VAZIO.

import { putGames } from '../data/db.js';
import { workerEndpoint } from './steam.js';

/** @typedef {import('../data/model.js').Game} Game */

/**
 * @typedef {object} DetailsOptions
 * @property {string} workerUrl
 * @property {'pt'|'en'} [lang] idioma dos gêneros (padrão `en`)
 * @property {{ key: string, steamId: string }|null} [creds] credenciais Steam do usuário; sem elas as conquistas são puladas
 * @property {(p: { done: number, total: number, game: Game }) => void} [onProgress]
 * @property {AbortSignal} [signal]
 * @property {number} [delayMs] intervalo entre jogos (padrão 1500: a loja da Steam limita ~200 consultas / 5 min)
 * @property {(updated: Game[]) => Promise<void>} [save]
 */

const MAX_CONSECUTIVE_FAILURES = 3;
const SAVE_EVERY = 10;

/**
 * appid Steam do jogo (a primeira posse da Steam com `storeGameId` numérico).
 * @param {Game} g
 * @returns {number|null}
 */
export function steamAppId(g) {
  const o = (g.ownerships || []).find((x) => x.store === 'steam' && /^\d+$/.test(String(x.storeGameId ?? '')));
  return o ? Number(o.storeGameId) : null;
}

/**
 * O que ainda falta neste jogo da Steam.
 * @param {Game} g
 * @param {boolean} withAchievements
 * @returns {{ store: boolean, achievements: boolean }}
 */
export function missingData(g, withAchievements) {
  return {
    store: !(g.genres && g.genres.length) || !g.developer || g.year == null,
    achievements: withAchievements && g.achievementsTotal == null,
  };
}

/**
 * Jogos da Steam que têm algo para completar.
 * @param {Game[]} games
 * @param {boolean} withAchievements
 * @returns {Game[]}
 */
export function gamesToComplete(games, withAchievements) {
  return games.filter((g) => steamAppId(g) != null && (() => { const m = missingData(g, withAchievements); return m.store || m.achievements; })());
}

/**
 * GET no Worker com tradução de erros.
 * @param {string} workerUrl
 * @param {string} path
 * @param {Record<string, string>} params
 * @param {Record<string, string>} headers
 * @param {AbortSignal} [signal]
 * @returns {Promise<any>}
 */
async function get(workerUrl, path, params, headers, signal) {
  let res;
  try {
    res = await fetch(workerEndpoint(workerUrl, path) + '?' + new URLSearchParams(params), { headers: { Accept: 'application/json', ...headers }, signal });
  } catch (err) {
    if (/** @type {any} */ (err)?.name === 'AbortError') throw err;
    throw { code: 'network' };
  }
  /** @type {any} */
  let body = null;
  try { body = await res.json(); } catch { /* tratado abaixo */ }
  if (!res.ok) throw { code: typeof body?.error === 'string' ? body.error : 'steam_upstream' };
  if (!body || typeof body !== 'object') throw { code: 'steam_upstream' };
  return body;
}

/**
 * @param {number} appid
 * @param {string} workerUrl
 * @param {'pt'|'en'} [lang]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ found: boolean, genres: string[], developer: string|null, year: number|null }>}
 */
export async function fetchStoreDetails(appid, workerUrl, lang = 'en', signal) {
  const b = await get(workerUrl, '/steam/details', { appid: String(appid), lang }, {}, signal);
  return { found: !!b.found, genres: Array.isArray(b.genres) ? b.genres.map(String) : [], developer: typeof b.developer === 'string' ? b.developer : null, year: Number.isInteger(b.year) ? b.year : null };
}

/**
 * @param {number} appid
 * @param {string} workerUrl
 * @param {{ key: string, steamId: string }} creds
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ done: number, total: number }>}
 */
export async function fetchAchievements(appid, workerUrl, creds, signal) {
  const b = await get(workerUrl, '/steam/achievements', { appid: String(appid) }, { 'X-Steam-Key': creds.key, 'X-Steam-Id': creds.steamId }, signal);
  return { done: Number.isInteger(b.done) ? b.done : 0, total: Number.isInteger(b.total) ? b.total : 0 };
}

/**
 * Aplica os dados achados SÓ nos campos vazios. Devolve cópia alterada ou null se nada mudou.
 * @param {Game} game
 * @param {{ genres?: string[], developer?: string|null, year?: number|null, achievements?: { done: number, total: number }|null }} found
 * @returns {Game|null}
 */
export function fillEmpty(game, found) {
  const copy = structuredClone(game);
  let changed = false;
  if (found.genres?.length && !(copy.genres && copy.genres.length)) { copy.genres = found.genres; changed = true; }
  if (found.developer && !copy.developer) { copy.developer = found.developer; changed = true; }
  if (found.year != null && copy.year == null) { copy.year = found.year; changed = true; }
  if (found.achievements && copy.achievementsTotal == null) {
    copy.achievementsDone = found.achievements.done;
    copy.achievementsTotal = found.achievements.total;
    changed = true;
  }
  if (changed) copy.updatedAt = new Date().toISOString();
  return changed ? copy : null;
}

/**
 * Completa uma lista de jogos da Steam, UM por vez, com intervalo, cancelável. Não muta os recebidos: grava cópias.
 * Lança `{ code }` após 3 falhas seguidas (o que já foi feito é gravado antes).
 * @param {Game[]} games já filtrados (`gamesToComplete`)
 * @param {DetailsOptions} options
 * @returns {Promise<{ updated: number, unchanged: number, notFound: number, failed: number, cancelled: boolean }>}
 */
export async function queueDetails(games, options) {
  const { workerUrl, lang = 'en', creds = null, onProgress, signal, delayMs = 1500, save = putGames } = options;
  const result = { updated: 0, unchanged: 0, notFound: 0, failed: 0, cancelled: false };
  /** @type {Game[]} */
  let unsaved = [];
  let failures = 0;
  const flush = async () => { if (unsaved.length) { const b = unsaved; unsaved = []; await save(b); } };
  let done = 0;
  try {
    for (const game of games) {
      if (signal?.aborted) { result.cancelled = true; break; }
      const appid = /** @type {number} */ (steamAppId(game));
      const need = missingData(game, !!creds);
      /** @type {Parameters<typeof fillEmpty>[1]} */
      const found = {};
      let calls = 0;
      let missing = false;
      try {
        if (need.store) {
          calls++;
          const d = await fetchStoreDetails(appid, workerUrl, lang, signal);
          if (!d.found) { result.notFound++; missing = true; } else Object.assign(found, d);
        }
        if (need.achievements && creds) { calls++; found.achievements = await fetchAchievements(appid, workerUrl, creds, signal); }
        failures = 0;
        const next = fillEmpty(game, found);
        if (next) { result.updated++; unsaved.push(next); } else if (!missing) result.unchanged++;
      } catch (err) {
        if (/** @type {any} */ (err)?.name === 'AbortError') { result.cancelled = true; break; }
        result.failed++;
        if (++failures >= MAX_CONSECUTIVE_FAILURES) throw { code: /** @type {any} */ (err)?.code ?? 'network' };
      }
      done++;
      if (unsaved.length >= SAVE_EVERY) await flush();
      onProgress?.({ done, total: games.length, game });
      if (calls && done < games.length && delayMs > 0) await new Promise((r) => { const t = setTimeout(r, delayMs); signal?.addEventListener('abort', () => { clearTimeout(t); r(undefined); }, { once: true }); });
    }
  } finally {
    await flush();
  }
  return result;
}
