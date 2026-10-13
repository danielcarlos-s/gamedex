// Busca de capas (PLANO 6.2/6.3): título → appid na busca pública da Steam (via Worker) → CDN da Steam.
// Sem DOM e sem texto para o usuário: falhas viram `throw { code }` (seção 6.4).

import { normalizeTitle } from '../data/model.js';
import { putGames } from '../data/db.js';
import { steamCoverUrl, workerEndpoint } from './steam.js';

/** @typedef {import('../data/model.js').Game} Game */

/**
 * @typedef {object} CoverItem
 * @property {number} appid
 * @property {string} name
 * @property {string} coverUrl
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
 * @property {number} [delayMs] intervalo entre requisições (padrão 300)
 * @property {boolean} [force] também refaz jogos que já têm `coverUrl` (nunca os com `coverManual`)
 * @property {(updated: Game[]) => Promise<void>} [save] grava os jogos alterados (padrão: `db.putGames`)
 */

/**
 * @typedef {object} QueueCoversResult
 * @property {Game[]} updated jogos que ganharam capa (cópias já gravadas por `save`)
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

/**
 * Busca capas candidatas para um título (`GET {workerUrl}/steam/search?term=`). Até 5 itens.
 * Lança `{ code }`: o código do Worker, `network`, `bad_request` (URL inválida ou termo vazio),
 * `steam_upstream` para resposta ilegível.
 * @param {string} title
 * @param {string} workerUrl
 * @param {AbortSignal} [signal]
 * @returns {Promise<CoverItem[]>}
 */
export async function searchCover(title, workerUrl, signal) {
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
  const { workerUrl, onProgress, onAmbiguous, signal, delayMs = 300, force = false, save = putGames } = options;
  /** @type {QueueCoversResult} */
  const result = { updated: [], skipped: 0, notFound: 0, failed: 0, cancelled: false };
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

  try {
    for (const game of queue) {
      if (signal?.aborted) { result.cancelled = true; break; }

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
        if (signal?.aborted) { result.cancelled = true; break; }
        requested = true;
        try {
          const items = await searchCover(copy.title, workerUrl, signal);
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
          } else {
            result.skipped++;
          }
          if (pick) {
            copy.coverUrl = pick.coverUrl;
            copy.coverAppId = pick.appid;
            if (outcome === 'ambiguous-resolved') copy.coverManual = true;
            copy.updatedAt = new Date().toISOString();
            result.updated.push(copy); unsaved.push(copy);
          }
        } catch (err) {
          if (/** @type {any} */ (err)?.name === 'AbortError') { result.cancelled = true; break; }
          result.failed++; outcome = 'failed';
          if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) throw { code: /** @type {any} */ (err)?.code ?? 'network' };
        }
      }

      done++;
      if (unsaved.length >= SAVE_EVERY) await flush();
      onProgress?.({ done, total, game, result: outcome });
    }
  } finally {
    await flush();
  }
  return result;
}
