// Importador Steam (PLANO 6.1/6.3): biblioteca via Worker ou do arquivo `steam_cache` do backup antigo.
// Sem DOM e sem texto para o usuário: falhas viram `throw { code }` (seção 6.4).

/** @typedef {import('../data/model.js').IncomingGame} IncomingGame */

/** Códigos que o Worker devolve em `{ error }`; qualquer outro vira `steam_upstream`. */
const WORKER_CODES = ['origin_not_allowed', 'not_found', 'profile_private', 'steam_upstream', 'misconfigured', 'bad_request'];

/**
 * Capa retrato da Steam. O `<img>` cai para `header.jpg` se 404 (responsabilidade da UI, PLANO 6.2).
 * @param {number|string} appid
 * @returns {string}
 */
export function steamCoverUrl(appid) {
  return `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`;
}

/**
 * Junta a URL do Worker com um caminho, sem barras duplicadas.
 * @param {string} workerUrl
 * @param {string} path começa com `/`
 * @returns {string}
 */
export function workerEndpoint(workerUrl, path) {
  const base = String(workerUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw { code: 'bad_request' };
  return base + path;
}

/**
 * Converte timestamp Unix (segundos) em ISO; 0/ausente → null.
 * @param {unknown} seconds
 * @returns {string|null}
 */
function unixToIso(seconds) {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

/**
 * Lê a biblioteca da conta via Worker (`GET {workerUrl}/steam/owned`).
 * Lança `{ code }`: o código do Worker (`origin_not_allowed`, `profile_private`, …), `network` se o fetch
 * falhar, `bad_request` se a URL do Worker for inválida, `steam_upstream` para resposta ilegível.
 * Com `creds` ({ key, steamId }) o Worker usa a chave do próprio usuário (enviada só nesta requisição).
 * @param {string} workerUrl
 * @param {{ key?: string, steamId?: string }|null} [creds]
 * @returns {Promise<IncomingGame[]>}
 */
export async function fetchOwned(workerUrl, creds = null) {
  const url = workerEndpoint(workerUrl, '/steam/owned');
  const headers = { Accept: 'application/json' };
  if (creds && (creds.key || creds.steamId)) {
    headers['X-Steam-Key'] = String(creds.key ?? '').trim();
    headers['X-Steam-Id'] = String(creds.steamId ?? '').trim();
  }
  let res;
  try {
    res = await fetch(url, { headers });
  } catch {
    throw { code: 'network' };
  }
  /** @type {any} */
  let body = null;
  try {
    body = await res.json();
  } catch { /* corpo ilegível tratado abaixo */ }
  if (!res.ok) {
    const code = typeof body?.error === 'string' && WORKER_CODES.includes(body.error) ? body.error : 'steam_upstream';
    throw { code };
  }
  if (!body || !Array.isArray(body.games)) throw { code: 'steam_upstream' };
  return body.games.map((/** @type {any} */ g, /** @type {number} */ i) => {
    /** @type {IncomingGame} */
    const game = {
      title: String(g.name ?? ''),
      store: 'steam',
      storeGameId: String(g.appid),
      playtimeMinutes: Number.isFinite(g.playtimeMinutes) ? g.playtimeMinutes : 0,
      lastPlayedAt: g.lastPlayedAt ?? null,
      coverUrl: g.coverUrl ?? steamCoverUrl(g.appid),
      coverAppId: Number.isInteger(g.appid) ? g.appid : null,
      source: 'api',
      row: i + 1,
    };
    return game;
  });
}

/**
 * Lê o formato do backup antigo: `{ steam_cache: { games: [{ appid, name, playtime_forever, rtime_last_played,
 * _achiev_done, _achiev_total }] } }` (também aceita `{ games: [...] }` solto). Aceita objeto ou texto JSON.
 * Lança `{ code: 'backup_invalid' }` se o formato não for reconhecido.
 * @param {object|string} json
 * @returns {IncomingGame[]}
 */
export function parseSteamCache(json) {
  /** @type {any} */
  let data = json;
  if (typeof json === 'string') {
    try {
      data = JSON.parse(json.replace(/^﻿/, ''));
    } catch {
      throw { code: 'backup_invalid' };
    }
  }
  const games = data?.steam_cache?.games ?? data?.games;
  if (!Array.isArray(games)) throw { code: 'backup_invalid' };
  return games.map((/** @type {any} */ g, /** @type {number} */ i) => {
    /** @type {IncomingGame} */
    const game = {
      title: String(g?.name ?? ''),
      store: 'steam',
      storeGameId: g?.appid == null ? undefined : String(g.appid),
      playtimeMinutes: Number.isFinite(g?.playtime_forever) ? g.playtime_forever : 0,
      lastPlayedAt: unixToIso(g?.rtime_last_played),
      coverUrl: g?.appid == null ? undefined : steamCoverUrl(g.appid),
      coverAppId: Number.isInteger(g?.appid) ? g.appid : null,
      source: 'backup',
      row: i + 1,
    };
    if (Number.isFinite(g?._achiev_done)) game.achievementsDone = g._achiev_done;
    if (Number.isFinite(g?._achiev_total)) game.achievementsTotal = g._achiev_total;
    return game;
  });
}
