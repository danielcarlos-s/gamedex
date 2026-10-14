// Cloudflare Worker: proxy da Steam para o gamedex (PLANO 6.1 e 6.2).
// É a única peça de servidor: só aqui existem a API key e o SteamID (secrets). Nunca aparecem em resposta nem em log.
//
// Rotas (GET):
//   /steam/owned            → biblioteca (IPlayerService/GetOwnedGames). Usa os secrets do dono ou, se o cliente
//                             mandar X-Steam-Key + X-Steam-Id, as credenciais DELE (nunca gravadas, nunca em log,
//                             sem cache de borda).
//   /steam/search?term=...  → busca de capa (store.steampowered.com/api/storesearch)
//   /sgdb/search?term=...   → busca de capa no SteamGridDB (2ª fonte). Só funciona se o dono gravou o secret
//                             STEAMGRIDDB_KEY; sem ele responde { items: [], configured: false }.
// Erros: { "error": "<codigo>" } com os códigos da seção 6.4.

/**
 * @typedef {object} Env
 * @property {string} [STEAM_API_KEY] secret
 * @property {string} [STEAM_ID] secret
 * @property {string} [STEAMGRIDDB_KEY] secret (opcional): chave da API do SteamGridDB
 * @property {string} [ALLOWED_ORIGINS] origens permitidas, separadas por vírgula
 */

const OWNED_TTL = 10 * 60; // 10 min
const SEARCH_TTL = 7 * 24 * 60 * 60; // 7 dias
const MAX_TERM = 100;
const MAX_ITEMS = 10; // o app filtra DLC/pacotes e fica com até 5
const SGDB_API = 'https://www.steamgriddb.com/api/v2';
const SGDB_GAMES = 3; // jogos candidatos por busca (1 requisição de capa cada)
const KEY_RE = /^[0-9A-Fa-f]{32}$/;
const ID_RE = /^\d{17}$/;
const COVER = (/** @type {number} */ appid) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${appid}/library_600x900_2x.jpg`;

/**
 * Origens permitidas a partir da var `ALLOWED_ORIGINS` (sem barra final, sem vazios).
 * @param {Env} env
 * @returns {string[]}
 */
function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

/**
 * Cabeçalhos CORS para uma origem JÁ validada (nunca `*`).
 * @param {string} origin
 * @returns {Record<string, string>}
 */
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Steam-Key, X-Steam-Id',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

/**
 * Resposta JSON.
 * @param {unknown} body
 * @param {number} status
 * @param {Record<string, string>} headers
 * @returns {Response}
 */
function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * GET na Steam. Devolve o JSON ou lança `{ code: 'steam_upstream' }`; a mensagem do erro original
 * (que poderia conter a URL com a key) é descartada.
 * @param {string} url
 * @param {number} ttl cache de borda em segundos para respostas 2xx
 * @returns {Promise<any>}
 */
async function steamGet(url, ttl) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '400-599': 0 } },
    });
  } catch {
    throw { code: 'steam_upstream' };
  }
  if (!res.ok) throw { code: 'steam_upstream' };
  try {
    return await res.json();
  } catch {
    throw { code: 'steam_upstream' };
  }
}

/**
 * /steam/owned
 * @param {Request} request
 * @param {Env} env
 * @param {Record<string, string>} headers
 * @returns {Promise<Response>}
 */
async function owned(request, env, headers) {
  const custom = request.headers.get('X-Steam-Key') || request.headers.get('X-Steam-Id');
  let key = env.STEAM_API_KEY;
  let steamId = env.STEAM_ID;
  if (custom) {
    key = (request.headers.get('X-Steam-Key') || '').trim();
    steamId = (request.headers.get('X-Steam-Id') || '').trim();
    if (!KEY_RE.test(key) || !ID_RE.test(steamId)) return json({ error: 'bad_request' }, 400, headers);
  }
  if (!key || !steamId) return json({ error: 'misconfigured' }, 500, headers);
  const url = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?' + new URLSearchParams({
    key,
    steamid: steamId,
    include_appinfo: '1',
    include_played_free_games: '1',
    format: 'json',
  });
  const data = await steamGet(url, custom ? 0 : OWNED_TTL);
  const r = data && data.response;
  // Perfil com "Detalhes do jogo" privado: a Steam responde 200 com `response: {}` (sem game_count).
  if (!r || typeof r.game_count !== 'number') return json({ error: 'profile_private' }, 409, headers);
  const games = (Array.isArray(r.games) ? r.games : []).map((/** @type {any} */ g) => ({
    appid: g.appid,
    name: String(g.name ?? ''),
    playtimeMinutes: g.playtime_forever || 0,
    lastPlayedAt: g.rtime_last_played ? new Date(g.rtime_last_played * 1000).toISOString() : null,
    coverUrl: COVER(g.appid),
  }));
  return json({ count: games.length, fetchedAt: new Date().toISOString(), games }, 200, {
    ...headers,
    'Cache-Control': custom ? 'no-store' : `private, max-age=${OWNED_TTL}`,
  });
}

/**
 * /steam/search
 * @param {URL} url
 * @param {Record<string, string>} headers
 * @returns {Promise<Response>}
 */
async function search(url, headers) {
  const term = (url.searchParams.get('term') || '').trim();
  if (!term || term.length > MAX_TERM) return json({ error: 'bad_request' }, 400, headers);
  const upstream = 'https://store.steampowered.com/api/storesearch/?' + new URLSearchParams({ term, l: 'english', cc: 'US' });
  const data = await steamGet(upstream, SEARCH_TTL);
  const items = (Array.isArray(data?.items) ? data.items : [])
    .filter((/** @type {any} */ i) => Number.isInteger(i?.id))
    .slice(0, MAX_ITEMS)
    .map((/** @type {any} */ i) => ({ appid: i.id, name: String(i.name ?? ''), coverUrl: COVER(i.id) }));
  return json({ items }, 200, { ...headers, 'Cache-Control': `public, max-age=${SEARCH_TTL}` });
}

/**
 * GET na API do SteamGridDB com a chave do dono. Devolve `data` (lista) ou lança `{ code: 'steam_upstream' }`.
 * @param {string} path
 * @param {string} key
 * @returns {Promise<any[]>}
 */
async function sgdbGet(path, key) {
  let res;
  try {
    res = await fetch(SGDB_API + path, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${key}` },
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': SEARCH_TTL, '400-599': 0 } },
    });
  } catch {
    throw { code: 'steam_upstream' };
  }
  if (!res.ok) throw { code: 'steam_upstream' };
  try {
    const body = await res.json();
    return Array.isArray(body?.data) ? body.data : [];
  } catch {
    throw { code: 'steam_upstream' };
  }
}

/**
 * /sgdb/search: até 3 jogos do SteamGridDB, cada um com a 1ª capa retrato (600x900 ou 342x482) estática.
 * Jogo sem capa retrato fica de fora. Sem o secret: 200 com `configured: false` (o app segue só com a Steam).
 * @param {URL} url
 * @param {Env} env
 * @param {Record<string, string>} headers
 * @returns {Promise<Response>}
 */
async function sgdbSearch(url, env, headers) {
  const term = (url.searchParams.get('term') || '').trim();
  if (!term || term.length > MAX_TERM) return json({ error: 'bad_request' }, 400, headers);
  const key = (env.STEAMGRIDDB_KEY || '').trim();
  if (!key) return json({ items: [], configured: false }, 200, headers);
  const games = (await sgdbGet('/search/autocomplete/' + encodeURIComponent(term), key))
    .filter((/** @type {any} */ g) => Number.isInteger(g?.id))
    .slice(0, SGDB_GAMES);
  const grids = await Promise.all(games.map((/** @type {any} */ g) =>
    sgdbGet(`/grids/game/${g.id}?dimensions=600x900,342x482&types=static&nsfw=false&humor=false`, key).catch(() => [])));
  const items = [];
  for (let i = 0; i < games.length; i++) {
    const grid = grids[i].find((/** @type {any} */ x) => typeof x?.url === 'string' && x.url.startsWith('https://'));
    if (grid) items.push({ sgdbId: games[i].id, name: String(games[i].name ?? ''), coverUrl: grid.url });
  }
  return json({ items, configured: true }, 200, { ...headers, 'Cache-Control': `public, max-age=${SEARCH_TTL}` });
}

/**
 * Trata uma requisição. Exportado para teste; em produção o runtime chama `default.fetch`.
 * @param {Request} request
 * @param {Env} env
 * @returns {Promise<Response>}
 */
export async function handle(request, env) {
  const origin = (request.headers.get('Origin') || '').replace(/\/+$/, '');
  if (!origin || !allowedOrigins(env).includes(origin)) return json({ error: 'origin_not_allowed' }, 403, {});
  const headers = corsHeaders(origin);

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (request.method !== 'GET') return json({ error: 'not_found' }, 404, headers);

  const url = new URL(request.url);
  try {
    if (url.pathname === '/steam/owned') return await owned(request, env, headers);
    if (url.pathname === '/steam/search') return await search(url, headers);
    if (url.pathname === '/sgdb/search') return await sgdbSearch(url, env, headers);
    return json({ error: 'not_found' }, 404, headers);
  } catch (err) {
    // Só códigos conhecidos saem; qualquer outra falha vira 500 genérico, sem mensagem (poderia conter a key).
    const code = err && typeof err === 'object' && /** @type {any} */ (err).code === 'steam_upstream' ? 'steam_upstream' : null;
    return code ? json({ error: code }, 502, headers) : json({ error: 'misconfigured' }, 500, headers);
  }
}

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @returns {Promise<Response>}
   */
  fetch: (request, env) => handle(request, env),
};
