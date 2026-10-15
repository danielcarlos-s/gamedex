// Busca de capas (PLANO 6.2/6.3): título → appid na busca pública da Steam (via Worker) → CDN da Steam.
// Sem DOM e sem texto para o usuário: falhas viram `throw { code }` (seção 6.4).

import { normalizeTitle } from '../data/model.js';
import { putGames } from '../data/db.js';
import { steamCoverUrl, workerEndpoint } from './steam.js';

/** @typedef {import('../data/model.js').Game} Game */

/**
 * @typedef {object} CoverItem
 * @property {number|null} appid appid da Steam (null quando a capa vem do SteamGridDB)
 * @property {string} name
 * @property {string} coverUrl
 * @property {'steam'|'sgdb'} [source] padrão `steam`
 */

/**
 * @typedef {object} CoverProgress
 * @property {number} done jogos já processados
 * @property {number} total jogos na fila
 * @property {Game} game o jogo que acabou de ser processado
 * @property {'updated'|'ambiguous-resolved'|'skipped'|'not_found'|'failed'} result
 */

/**
 * @typedef {object} QueueCoversOptions
 * @property {string} workerUrl URL do Worker (obrigatória)
 * @property {(p: CoverProgress) => void} [onProgress]
 * @property {(game: Game, items: CoverItem[]) => Promise<CoverItem|null>|CoverItem|null} [onAmbiguous]
 *   chamado quando o 1º resultado não tem o mesmo título; devolve o item escolhido ou `null` para pular
 * @property {AbortSignal} [signal] cancela a fila (o que já foi decidido é salvo)
 * @property {number} [delayMs] intervalo entre requisições de cada fila (padrão 300)
 * @property {number} [concurrency] quantos jogos buscar ao mesmo tempo (padrão 1; o app usa 4)
 * @property {boolean} [collectAmbiguous] sem `onAmbiguous`, guarda as dúvidas em `result.ambiguous` em vez de pular
 * @property {string} [sgdbKey] chave do SteamGridDB do usuário (vai no cabeçalho; sem ela vale o secret do Worker, se houver)
 * @property {boolean} [sgdb] se a Steam não achar o jogo (ou o título não bater), tenta também o SteamGridDB (padrão false)
 * @property {boolean} [force] também refaz jogos que já têm `coverUrl` (nunca os com `coverManual`)
 * @property {(updated: Game[]) => Promise<void>} [save] grava os jogos alterados (padrão: `db.putGames`)
 */

/**
 * @typedef {object} QueueCoversResult
 * @property {Game[]} updated jogos que ganharam capa (cópias já gravadas por `save`)
 * @property {{game: Game, items: CoverItem[]}[]} ambiguous dúvidas guardadas (só com `collectAmbiguous`)
 * @property {number} skipped sem busca: `coverManual`, já com capa, ou ambíguo recusado
 * @property {number} notFound a busca não achou nada
 * @property {number} failed a busca falhou (rede/Steam)
 * @property {boolean} cancelled
 */

/** Falhas seguidas que interrompem a fila (Worker fora do ar, origem errada, etc.). */
const MAX_CONSECUTIVE_FAILURES = 3;
/** Quantos jogos atualizados acumulam antes de gravar (um cancelamento perde no máximo isto). */
const SAVE_EVERY = 20;
const MAX_TERM = 100;

/** Palavras que marcam DLC/pacote/extra (a busca da Steam não diferencia DLC do jogo: tudo vem como `app`). */
const NOISE = new Set(['dlc', 'pack', 'packs', 'season', 'pass', 'soundtrack', 'ost', 'artbook', 'bundle', 'upgrade', 'kit', 'skin', 'skins', 'cosmetic', 'cosmetics', 'demo', 'playtest', 'beta']);
const MAX_ITEMS = 5;

/**
 * Deixa o jogo principal no topo e esconde DLC/pacotes. Ordem: nome igual ao buscado → começa com o buscado (o mais
 * curto primeiro, que é o mais próximo do título: "Jogo — Remastered" antes de "Jogo — Trilha extra") → outros sem
 * palavra de ruído → ruído. Uma palavra de ruído só conta se NÃO estiver no título buscado (quem busca
 * "Mad Max Season Pass" a quer). O ruído só é descartado se sobrar ao menos um resultado limpo; senão tudo é mantido.
 * @param {string} title título buscado
 * @param {CoverItem[]} items
 * @param {{max?: number, dropNoise?: boolean}} [opts] `dropNoise: false` mantém DLC/pacotes (no fim da lista)
 * @returns {CoverItem[]} até 5 itens (ou `opts.max`)
 */
export function refineCoverItems(title, items, opts = {}) {
  const key = normalizeTitle(title);
  const words = (/** @type {string} */ s) => normalizeTitle(s).split(' ').filter(Boolean);
  const wanted = new Set(words(title));
  const noisy = (/** @type {CoverItem} */ i) => words(i.name).some((w) => NOISE.has(w) && !wanted.has(w));
  const rank = (/** @type {CoverItem} */ i) => {
    const k = normalizeTitle(i.name);
    if (k === key) return 0;
    if (noisy(i)) return 3;
    return key && (k.startsWith(key + ' ')) ? 1 : 2;
  };
  const ordered = items.map((item, idx) => ({ item, idx, r: rank(item), len: normalizeTitle(item.name).length }))
    .sort((a, b) => a.r - b.r || (a.r === 1 ? a.len - b.len : 0) || a.idx - b.idx);
  const clean = opts.dropNoise === false ? ordered : ordered.filter((o) => o.r < 3);
  return (clean.length ? clean : ordered).slice(0, opts.max ?? MAX_ITEMS).map((o) => o.item);
}

/**
 * Busca capas candidatas para um título (`GET {workerUrl}/steam/search?term=`). Até 5 itens, já sem DLC/pacotes
 * quando houver o jogo principal (`refineCoverItems`).
 * Lança `{ code }`: o código do Worker, `network`, `bad_request` (URL inválida ou termo vazio),
 * `steam_upstream` para resposta ilegível.
 * @param {string} title
 * @param {string} workerUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<CoverItem[]>}
 */
export async function searchCover(title, workerUrl, signal) {
  const term = String(title ?? '').trim().slice(0, MAX_TERM).trim();
  return refineCoverItems(term, await searchSteamRaw(title, workerUrl, signal));
}

/**
 * Resultados da busca da Steam sem filtrar nem ordenar (até 10). Mesmos erros de `searchCover`.
 * @param {string} title
 * @param {string} workerUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<CoverItem[]>}
 */
async function searchSteamRaw(title, workerUrl, signal) {
  const term = String(title ?? '').trim().slice(0, MAX_TERM).trim();
  if (!term) throw { code: 'bad_request' };
  const url = workerEndpoint(workerUrl, '/steam/search') + '?' + new URLSearchParams({ term });
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  } catch (err) {
    if (/** @type {any} */ (err)?.name === 'AbortError') throw err;
    throw { code: 'network' };
  }
  /** @type {any} */
  let body = null;
  try { body = await res.json(); } catch { /* tratado abaixo */ }
  if (!res.ok) throw { code: typeof body?.error === 'string' ? body.error : 'steam_upstream' };
  if (!body || !Array.isArray(body.items)) throw { code: 'steam_upstream' };
  return body.items.map((/** @type {any} */ i) => ({ appid: i.appid, name: String(i.name ?? ''), coverUrl: i.coverUrl ?? steamCoverUrl(i.appid) }));
}

/** @param {string} [key] */
const sgdbHeaders = (key) => ({ Accept: 'application/json', ...(key ? { 'X-Sgdb-Key': key } : {}) });

/**
 * Busca capas no SteamGridDB (`GET {workerUrl}/sgdb/search?term=`). Devolve `null` se o Worker não tem a chave
 * (`configured: false`) e `[]` em qualquer falha: o SteamGridDB é só a 2ª fonte e nunca atrapalha a Steam.
 * @param {string} title
 * @param {string} workerUrl
 * @param {AbortSignal} [signal]
 * @param {string} [key] chave do SteamGridDB do usuário
 * @returns {Promise<CoverItem[]|null>}
 */
export async function searchSgdb(title, workerUrl, signal, key) {
  const term = String(title ?? '').trim().slice(0, MAX_TERM).trim();
  if (!term) return [];
  /** @param {string} q @returns {Promise<CoverItem[]|null>} */
  const ask = async (q) => {
    const res = await fetch(workerEndpoint(workerUrl, '/sgdb/search') + '?' + new URLSearchParams({ term: q }), { headers: sgdbHeaders(key), signal });
    const body = await res.json();
    if (!res.ok || !body) return [];
    if (body.configured === false) return null;
    if (!Array.isArray(body.items)) return [];
    return body.items
      .filter((/** @type {any} */ i) => typeof i?.coverUrl === 'string' && /^https:\/\//.test(i.coverUrl))
      .map((/** @type {any} */ i) => ({ appid: null, name: String(i.name ?? ''), coverUrl: i.coverUrl, source: /** @type {'sgdb'} */ ('sgdb') }));
  };
  try {
    let items = await ask(term);
    // o autocomplete do SteamGridDB não acha "Jogo™: Game of the Year Edition": tenta de novo só com o título-base
    const plain = normalizeTitle(term);
    if (items && items.length === 0 && plain && plain !== term.toLowerCase()) items = await ask(plain);
    return items ? items.slice(0, MAX_ITEMS + 3) : null;
  } catch (err) {
    if (/** @type {any} */ (err)?.name === 'AbortError') throw err;
    return [];
  }
}

/**
 * O Worker tem a chave do SteamGridDB? (`on`/`off`; `unknown` se a consulta falhar).
 * @param {string} workerUrl
 * @param {string} [key] chave do SteamGridDB do usuário
 * @returns {Promise<'on'|'off'|'unknown'>}
 */
export async function sgdbStatus(workerUrl, key) {
  try {
    const res = await fetch(workerEndpoint(workerUrl, '/sgdb/search') + '?' + new URLSearchParams({ term: 'a' }), { headers: sgdbHeaders(key) });
    const body = await res.json();
    if (!res.ok) return 'unknown';
    return body?.configured === false ? 'off' : 'on';
  } catch { return 'unknown'; }
}

/**
 * Steam primeiro; se a Steam não achar o título exato, junta os resultados do SteamGridDB (itens da Steam antes, sem
 * repetir nome igual). Falha da Steam só propaga se o SteamGridDB também não trouxer nada.
 * @param {string} title
 * @param {string} workerUrl
 * @param {AbortSignal} [signal]
 * @param {string} [sgdbKey]
 * @returns {Promise<CoverItem[]>}
 */
export async function searchCoverAll(title, workerUrl, signal, sgdbKey) {
  /** @type {CoverItem[]} */ let steam = [];
  /** @type {any} */ let steamErr = null;
  try { steam = await searchCover(title, workerUrl, signal); } catch (err) {
    if (/** @type {any} */ (err)?.name === 'AbortError') throw err;
    steamErr = err;
  }
  const exact = steam.length > 0 && normalizeTitle(steam[0].name) === normalizeTitle(title);
  const other = exact ? [] : (await searchSgdb(title, workerUrl, signal, sgdbKey)) ?? [];
  if (steamErr && !other.length) throw steamErr;
  const seen = new Set(steam.map((i) => normalizeTitle(i.name)));
  // mesma régua para as duas fontes: nome igual ao buscado primeiro; no empate, a Steam (vem antes na lista)
  return refineCoverItems(title, [...steam, ...other.filter((i) => !seen.has(normalizeTitle(i.name)))]);
}

/**
 * Termos alternativos para "buscar outras": o título inteiro, o título-base (sem edição/pontuação) e a parte antes de
 * ":", " - " ou " – " (o nome da franquia). Sem repetir.
 * @param {string} title
 * @returns {string[]}
 */
export function alternateTerms(title) {
  const full = String(title ?? '').replace(/[™®©]/g, '').trim();
  const head = full.split(/\s*(?::| [-–—] )\s*/)[0].trim();
  const terms = [full, normalizeTitle(full), head, normalizeTitle(head)].filter((x) => x && x.length >= 2);
  return [...new Set(terms)];
}

/**
 * Mais capas candidatas, sem repetir as já mostradas (`exclude`). Junta Steam (até 10 por termo) e SteamGridDB, tentando
 * o título inteiro e a franquia; mantém DLC/pacotes (no fim) porque quem pediu "outras" já viu as melhores. Até 5 itens.
 * Falha da Steam só propaga se nada mais vier.
 * @param {string} title
 * @param {string} workerUrl
 * @param {{exclude?: CoverItem[], signal?: AbortSignal, sgdbKey?: string}} [opts]
 * @returns {Promise<CoverItem[]>}
 */
export async function searchCoverMore(title, workerUrl, opts = {}) {
  const { exclude = [], signal, sgdbKey } = opts;
  const seenUrl = new Set(exclude.map((i) => i.coverUrl));
  const seenName = new Set(exclude.map((i) => normalizeTitle(i.name)));
  /** @type {CoverItem[]} */ const found = [];
  /** @type {any} */ let err = null;
  for (const term of alternateTerms(title).slice(0, 3)) {
    try { found.push(...(await searchSteamRaw(term, workerUrl, signal))); } catch (e) {
      if (/** @type {any} */ (e)?.name === 'AbortError') throw e;
      err = e;
    }
    found.push(...((await searchSgdb(term, workerUrl, signal, sgdbKey)) ?? []));
  }
  const fresh = found.filter((i) => {
    if (seenUrl.has(i.coverUrl)) return false;
    seenUrl.add(i.coverUrl);
    const k = normalizeTitle(i.name);
    if (i.source !== 'sgdb' && seenName.has(k)) return false; // mesma obra da Steam já mostrada
    return true;
  });
  if (err && !fresh.length) throw err;
  return refineCoverItems(title, fresh, { max: MAX_ITEMS, dropNoise: false });
}

/**
 * Espera `ms`, acordando antes se o sinal abortar.
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done);
  });
}

/**
 * Procura capas para uma lista de jogos, UMA requisição por vez, com intervalo (padrão 300 ms) e cancelável.
 * - Nunca toca jogo com `coverManual`; por padrão ignora quem já tem `coverUrl` (use `force` para refazer).
 * - Jogo com `coverAppId` e sem `coverUrl` ganha a capa do CDN sem requisição.
 * - Aceita sozinho só se o 1º resultado tiver `normalizeTitle` igual ao do jogo; senão chama `onAmbiguous`
 *   (sem `onAmbiguous`, o jogo é pulado). Capa escolhida pelo usuário em `onAmbiguous` vira `coverManual: true`.
 * - Não muta os jogos recebidos: grava e devolve cópias.
 * - `done` do progresso conta jogos processados, inclusive os pulados.
 * Lança `{ code }` após 3 falhas seguidas de busca (o que já foi decidido é gravado antes).
 * @param {Game[]} games
 * @param {QueueCoversOptions} options
 * @returns {Promise<QueueCoversResult>}
 */
export async function queueCovers(games, options) {
  const { workerUrl, onProgress, onAmbiguous, signal, delayMs = 300, concurrency = 1, collectAmbiguous = false, force = false, sgdb = false, sgdbKey, save = putGames } = options;
  /** @type {QueueCoversResult} */
  const result = { updated: [], ambiguous: [], skipped: 0, notFound: 0, failed: 0, cancelled: false };
  /** @type {Game[]} */
  let unsaved = [];
  let consecutiveFailures = 0;
  let requested = false;

  const flush = async () => {
    if (unsaved.length === 0) return;
    const batch = unsaved;
    unsaved = [];
    await save(batch);
  };

  const queue = games.filter((g) => !g.coverManual);
  result.skipped += games.length - queue.length;
  const total = games.length;
  let done = games.length - queue.length;

  /** @type {any} */
  let fatal = null;
  /** Processa um jogo; várias filas podem rodar ao mesmo tempo (JS é single-thread: os contadores não correm risco). */
  const processOne = async (/** @type {Game} */ game) => {
    /** @type {CoverProgress['result']} */
    let outcome = 'skipped';
    const copy = structuredClone(game);

    if (copy.coverUrl && !force) {
      result.skipped++;
    } else if (copy.coverAppId != null && !copy.coverUrl) {
      copy.coverUrl = steamCoverUrl(copy.coverAppId);
      copy.updatedAt = new Date().toISOString();
      result.updated.push(copy); unsaved.push(copy);
      outcome = 'updated';
    } else {
      if (requested) await sleep(delayMs, signal);
      if (signal?.aborted) { result.cancelled = true; return; }
      requested = true;
      try {
        const items = sgdb ? await searchCoverAll(copy.title, workerUrl, signal, sgdbKey) : await searchCover(copy.title, workerUrl, signal);
        consecutiveFailures = 0;
        /** @type {CoverItem|null} */
        let pick = null;
        if (items.length === 0) {
          result.notFound++; outcome = 'not_found';
        } else if (normalizeTitle(items[0].name) === (copy.titleKey || normalizeTitle(copy.title))) {
          pick = items[0];
          outcome = 'updated';
        } else if (onAmbiguous) {
          pick = (await onAmbiguous(game, items)) ?? null;
          outcome = pick ? 'ambiguous-resolved' : 'skipped';
          if (!pick) result.skipped++;
        } else if (collectAmbiguous) {
          result.ambiguous.push({ game, items });
        } else {
          result.skipped++;
        }
        if (pick) {
          copy.coverUrl = pick.coverUrl;
          copy.coverAppId = pick.appid ?? null;
          if (outcome === 'ambiguous-resolved') copy.coverManual = true;
          copy.updatedAt = new Date().toISOString();
          result.updated.push(copy); unsaved.push(copy);
        }
      } catch (err) {
        if (/** @type {any} */ (err)?.name === 'AbortError') { result.cancelled = true; return; }
        result.failed++; outcome = 'failed';
        if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) { fatal = { code: /** @type {any} */ (err)?.code ?? 'network' }; return; }
      }
    }

    done++;
    if (unsaved.length >= SAVE_EVERY) await flush();
    onProgress?.({ done, total, game, result: outcome });
  };

  try {
    const iter = queue[Symbol.iterator]();
    const lane = async () => {
      for (const game of iter) {
        if (fatal) return;
        if (signal?.aborted) { result.cancelled = true; return; }
        await processOne(game);
        if (result.cancelled) return;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length || 1)) }, lane));
    if (fatal) throw fatal;
  } finally {
    await flush();
  }
  return result;
}
