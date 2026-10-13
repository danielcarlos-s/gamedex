// Modelo de dados do gamedex: schema, normalização de título, validação e regras de merge (PLANO seção 5).
// Sem DOM e sem texto para o usuário: erros são sempre códigos `{ code }` (seção 6.4); a UI traduz.

import { getGame, putGames } from './db.js';

/**
 * @typedef {'steam'|'epic'|'gog'|'ubisoft'|'ea'|'amazon'|'other'} Store
 * @typedef {'backlog'|'playing'|'paused'|'finished'|'completed'|'dropped'} Status
 * @typedef {'api'|'csv'|'manual'|'backup'} Source
 */

/**
 * @typedef {object} Ownership
 * @property {Store} store
 * @property {string|null} storeGameId appid Steam; em CSV, opcional
 * @property {Source} source
 * @property {number|null} playtimeMinutes
 * @property {string|null} lastPlayedAt ISO
 * @property {string} importedAt ISO
 */

/**
 * @typedef {object} Game
 * @property {string} id
 * @property {string} title
 * @property {string} titleKey `normalizeTitle(title)`
 * @property {Ownership[]} ownerships ≥1
 * @property {Status} status
 * @property {boolean} favorite
 * @property {number|null} rating inteiro 0–5
 * @property {string[]} tags
 * @property {string[]} genres
 * @property {string|null} developer
 * @property {number|null} year
 * @property {string|null} startedAt `YYYY-MM-DD`
 * @property {string|null} finishedAt `YYYY-MM-DD`
 * @property {{label: string, url: string}[]} links
 * @property {number|null} achievementsDone
 * @property {number|null} achievementsTotal
 * @property {string|null} coverUrl
 * @property {number|null} coverAppId
 * @property {boolean} coverManual true = o usuário escolheu a capa; a busca automática nunca sobrescreve
 * @property {number} playtimeMinutes soma das ownerships (ver `recalcTotals`)
 * @property {string|null} lastPlayedAt o mais recente das ownerships
 * @property {string} notes
 * @property {string} createdAt ISO
 * @property {string} updatedAt ISO
 */

/**
 * Saída de todo importador, entrada do `planMerge`.
 * `source` e `row` são extensões opcionais: `source` vira a origem da ownership (padrão `csv`);
 * `row` é o número da linha reportado em `errors` (padrão: posição no array, base 1).
 * @typedef {object} IncomingGame
 * @property {string} title
 * @property {Store} store
 * @property {string|number} [storeGameId]
 * @property {number} [playtimeMinutes]
 * @property {string|null} [lastPlayedAt]
 * @property {Status} [status]
 * @property {string[]} [tags]
 * @property {string[]} [genres]
 * @property {number|null} [rating]
 * @property {string} [notes]
 * @property {string|null} [coverUrl]
 * @property {number|null} [coverAppId]
 * @property {string|null} [developer]
 * @property {number|null} [year]
 * @property {number|null} [achievementsDone]
 * @property {number|null} [achievementsTotal]
 * @property {Source} [source]
 * @property {number} [row]
 */

/**
 * @typedef {object} MergeError
 * @property {number} [row]
 * @property {string} code código da seção 6.4
 */

/**
 * @typedef {object} MergePlan
 * @property {Game[]} toCreate jogos novos (estado final)
 * @property {{before: Game, after: Game}[]} toUpdate jogos existentes que mudaram
 * @property {number} mergedCount linhas que viraram uma ownership extra de um Game já existente (= `counts.merged`)
 * @property {MergeError[]} errors
 * @property {{new: number, updated: number, merged: number, invalid: number}} counts
 *   Resultado por linha recebida, disjunto (a soma é o total de linhas):
 *   `new` criou Game; `updated` casou uma ownership existente (regra 1 ou ownership da mesma loja da regra 2),
 *   mesmo que nada tenha mudado; `merged` acrescentou uma ownership a um Game por `titleKey` (regra 2);
 *   `invalid` foi para `errors`.
 */

export const SCHEMA_VERSION = 1;
/** @type {readonly Store[]} */
export const STORES = Object.freeze(['steam', 'epic', 'gog', 'ubisoft', 'ea', 'amazon', 'other']);

/**
 * `id` de loja válido: uma das fixas ou uma loja criada pelo usuário (`c-` + 8 caracteres [a-z0-9], ver data/stores.js).
 * Só confere o FORMATO; quem sabe quais lojas criadas existem é o registro (stores.js).
 * @param {unknown} id
 * @returns {boolean}
 */
export const isStoreId = (id) => (typeof id === 'string') && (STORES.includes(/** @type {any} */ (id)) || /^c-[a-z0-9]{8}$/.test(id));
/** @type {readonly Status[]} */
export const STATUSES = Object.freeze(['backlog', 'playing', 'paused', 'finished', 'completed', 'dropped']);
/** @type {readonly Source[]} */
export const SOURCES = Object.freeze(['api', 'csv', 'manual', 'backup']);

// Sufixos de edição removidos só no FIM do título. "remastered" NÃO entra: é outro jogo.
const EDITION_SUFFIX = /\s(?:game of the year|goty|complete|definitive|deluxe|ultimate|enhanced|edition)$/;

/**
 * Chave de comparação de títulos: minúsculo, sem acento, sem ™®©, sem pontuação,
 * sem sufixos de edição (goty, game of the year, complete, definitive, deluxe, ultimate, enhanced, edition).
 * "Remastered" é preservado.
 * @param {string} s
 * @returns {string} string vazia se não sobrar nada comparável
 */
export function normalizeTitle(s) {
  if (typeof s !== 'string') return '';
  let k = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  k = k.replace(/[™®©℠]/g, '')
    .replace(/&/g, ' and ')
    .replace(/['’`´]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  for (;;) {
    const shorter = k.replace(EDITION_SUFFIX, '');
    if (shorter === k || !shorter) break;
    k = shorter;
  }
  return k;
}

/** @returns {string} */
function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'g-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * @param {unknown} v
 * @returns {string|null} string não vazia ou null
 */
function idOrNull(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Cria uma Ownership completa a partir de um parcial.
 * @param {Partial<Ownership> & {store: Store}} partial
 * @returns {Ownership}
 */
export function createOwnership(partial) {
  return {
    store: partial.store,
    storeGameId: idOrNull(partial.storeGameId),
    source: partial.source ?? 'manual',
    playtimeMinutes: partial.playtimeMinutes ?? null,
    lastPlayedAt: partial.lastPlayedAt ?? null,
    importedAt: partial.importedAt ?? new Date().toISOString(),
  };
}

/**
 * Cria um Game completo (todos os campos, valores padrão, `titleKey` e totais calculados).
 * Não valida (use `validateGame`) e não grava (use `db.putGame`).
 * @param {Partial<Game>} [partial]
 * @returns {Game}
 */
export function createGame(partial = {}) {
  const now = new Date().toISOString();
  /** @type {Game} */
  const game = {
    id: partial.id ?? newId(),
    title: typeof partial.title === 'string' ? partial.title.trim() : '',
    titleKey: '',
    ownerships: (partial.ownerships ?? []).map(createOwnership),
    status: partial.status ?? 'backlog',
    favorite: !!partial.favorite,
    rating: partial.rating ?? null,
    tags: [...(partial.tags ?? [])],
    genres: [...(partial.genres ?? [])],
    developer: partial.developer ?? null,
    year: partial.year ?? null,
    startedAt: partial.startedAt ?? null,
    finishedAt: partial.finishedAt ?? null,
    links: (partial.links ?? []).map((l) => ({ label: l.label, url: l.url })),
    achievementsDone: partial.achievementsDone ?? null,
    achievementsTotal: partial.achievementsTotal ?? null,
    coverUrl: partial.coverUrl ?? null,
    coverAppId: partial.coverAppId ?? null,
    coverManual: !!partial.coverManual,
    playtimeMinutes: 0,
    lastPlayedAt: null,
    notes: partial.notes ?? '',
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
  game.titleKey = normalizeTitle(game.title);
  return recalcTotals(game);
}

/**
 * Recalcula `playtimeMinutes` (soma das ownerships) e `lastPlayedAt` (o mais recente).
 * Muta o jogo recebido e o devolve.
 * @param {Game} game
 * @returns {Game}
 */
export function recalcTotals(game) {
  let total = 0;
  let last = null;
  for (const o of game.ownerships) {
    total += o.playtimeMinutes || 0;
    if (o.lastPlayedAt && (!last || Date.parse(o.lastPlayedAt) > Date.parse(last))) last = o.lastPlayedAt;
  }
  game.playtimeMinutes = total;
  game.lastPlayedAt = last;
  return game;
}

/** @param {unknown} v @returns {boolean} número finito ≥ 0 (null/undefined passam: campo opcional) */
function okOptionalNumber(v) {
  return v === null || v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
}

/** @param {unknown} v @returns {boolean} */
function okRating(v) {
  return v === null || v === undefined || (Number.isInteger(v) && /** @type {number} */ (v) >= 0 && /** @type {number} */ (v) <= 5);
}

/**
 * Valida um Game. Só devolve códigos; nunca texto.
 * `field` aponta o campo (ex.: `title`, `rating`, `ownerships[1].store`).
 * @param {Game} g
 * @returns {{ok: boolean, errors: {field: string, code: string}[]}}
 */
export function validateGame(g) {
  /** @type {{field: string, code: string}[]} */
  const errors = [];
  if (!g || typeof g.title !== 'string' || g.title.trim() === '') errors.push({ field: 'title', code: 'title_required' });
  if (!Array.isArray(g?.ownerships) || g.ownerships.length < 1) {
    errors.push({ field: 'ownerships', code: 'csv_missing_store' });
  } else {
    g.ownerships.forEach((o, i) => {
      if (!isStoreId(o?.store)) errors.push({ field: `ownerships[${i}].store`, code: 'csv_invalid_store' });
      if (!okOptionalNumber(o?.playtimeMinutes)) errors.push({ field: `ownerships[${i}].playtimeMinutes`, code: 'csv_invalid_number' });
    });
  }
  if (g && !STATUSES.includes(g.status)) errors.push({ field: 'status', code: 'csv_invalid_status' });
  if (g && !okRating(g.rating)) errors.push({ field: 'rating', code: 'rating_range' });
  for (const f of /** @type {const} */ (['year', 'achievementsDone', 'achievementsTotal'])) {
    if (g && !okOptionalNumber(g[f])) errors.push({ field: f, code: 'csv_invalid_number' });
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Valida uma linha de entrada do merge.
 * @param {IncomingGame} inc
 * @returns {string|null} código do erro ou null se válida
 */
function validateIncoming(inc) {
  if (!inc || typeof inc.title !== 'string' || normalizeTitle(inc.title) === '') return 'title_required';
  if (inc.store === undefined || inc.store === null || inc.store === '') return 'csv_missing_store';
  if (!isStoreId(inc.store)) return 'csv_invalid_store';
  if (inc.status !== undefined && inc.status !== null && !STATUSES.includes(inc.status)) return 'csv_invalid_status';
  if (!okRating(inc.rating)) return 'rating_range';
  for (const f of /** @type {const} */ (['playtimeMinutes', 'year', 'achievementsDone', 'achievementsTotal'])) {
    if (!okOptionalNumber(inc[f])) return 'csv_invalid_number';
  }
  return null;
}

/**
 * Chave do índice "mesma loja + mesmo storeGameId".
 * @param {string} store @param {string} id @returns {string}
 */
const storeKey = (store, id) => `${store}\u0000${id}`;

/**
 * Impressão digital de um jogo ignorando carimbos de tempo, para detectar mudança real.
 * @param {Game} g @returns {string}
 */
const fingerprint = (g) => JSON.stringify(g, (k, v) => (k === 'updatedAt' || k === 'importedAt' ? undefined : v));

/**
 * Atualiza uma ownership existente com os dados voláteis da linha recebida (tempo, último jogo).
 * Só sobrescreve com valor presente: dado ausente na linha não zera o que já havia.
 * @param {Ownership} own @param {IncomingGame} inc @param {string} sid @param {Source|undefined} source só troca a origem se informada @param {string} now
 */
function refreshOwnership(own, inc, sid, source, now) {
  if (inc.playtimeMinutes != null) own.playtimeMinutes = inc.playtimeMinutes;
  if (inc.lastPlayedAt != null) own.lastPlayedAt = inc.lastPlayedAt;
  if (own.storeGameId == null && sid) own.storeGameId = sid;
  if (source) own.source = source;
  own.importedAt = now;
}

/**
 * Preenche metadados NÃO pessoais do Game com a linha recebida.
 * Conquistas da Steam sempre atualizam (dado de API); o resto só preenche o que está vazio.
 * Nunca toca status, favorite, rating, tags, notes, datas, links nem capa manual.
 * @param {Game} game @param {IncomingGame} inc
 */
function fillMetadata(game, inc) {
  if (game.developer == null && inc.developer) game.developer = inc.developer;
  if (game.year == null && inc.year != null) game.year = inc.year;
  if (game.genres.length === 0 && inc.genres?.length) game.genres = [...inc.genres];
  if (!game.coverManual) {
    if (game.coverUrl == null && inc.coverUrl) game.coverUrl = inc.coverUrl;
    if (game.coverAppId == null && inc.coverAppId != null) game.coverAppId = inc.coverAppId;
  }
  const hasAch = inc.achievementsDone != null || inc.achievementsTotal != null;
  if (hasAch && (inc.store === 'steam' || (game.achievementsDone == null && game.achievementsTotal == null))) {
    if (inc.achievementsDone != null) game.achievementsDone = inc.achievementsDone;
    if (inc.achievementsTotal != null) game.achievementsTotal = inc.achievementsTotal;
  }
}

/**
 * Planeja o merge de linhas importadas com os jogos existentes, SEM gravar e SEM mutar os argumentos.
 *
 * Regras (PLANO seção 5):
 * 1. mesma loja + mesmo `storeGameId` → atualiza a ownership; nunca sobrescreve campos pessoais;
 * 2. senão, mesmo `titleKey` → acrescenta a ownership ao Game existente (1 card, vários selos).
 *    Se já existir ownership da mesma loja sem `storeGameId` (ou a linha vier sem id), atualiza essa;
 * 3. senão → Game novo, `status` da linha ou `backlog`;
 * 4. linha inválida → `errors`, não grava.
 * Linhas do mesmo lote se enxergam (duas linhas do mesmo jogo em lojas diferentes viram 1 Game).
 *
 * @param {Game[]} existingGames
 * @param {IncomingGame[]} incoming
 * @param {{source?: Source, now?: string}} [options] `source` padrão das linhas sem `source`; sem nenhum dos dois,
 *   ownerships novas nascem `csv` e as existentes mantêm a origem
 * @returns {MergePlan}
 */
export function planMerge(existingGames, incoming, options = {}) {
  const now = options.now ?? new Date().toISOString();

  /** @type {Map<string, Game>} id → jogo original (intocado) */
  const originals = new Map(existingGames.map((g) => [g.id, g]));
  /** @type {Map<string, {game: Game, created: boolean}>} id → cópia de trabalho, criada ao primeiro toque */
  const work = new Map();
  /** @type {Map<string, string>} */ const byStore = new Map();
  /** @type {Map<string, string>} */ const byTitle = new Map();

  const index = (/** @type {Game} */ g) => {
    const tk = g.titleKey || normalizeTitle(g.title);
    if (tk && !byTitle.has(tk)) byTitle.set(tk, g.id);
    for (const o of g.ownerships) if (o.storeGameId) byStore.set(storeKey(o.store, o.storeGameId), g.id);
  };
  existingGames.forEach(index);

  const edit = (/** @type {string} */ id) => {
    let entry = work.get(id);
    if (!entry) {
      entry = { game: structuredClone(/** @type {Game} */ (originals.get(id))), created: false };
      work.set(id, entry);
    }
    return entry;
  };

  /** @type {MergePlan['counts']} */
  const counts = { new: 0, updated: 0, merged: 0, invalid: 0 };
  /** @type {MergeError[]} */
  const errors = [];

  incoming.forEach((inc, i) => {
    const row = inc?.row ?? i + 1;
    const code = validateIncoming(inc);
    if (code) {
      errors.push({ row, code });
      counts.invalid++;
      return;
    }
    const sid = idOrNull(inc.storeGameId);
    const source = inc.source ?? options.source;
    const sameStoreId = sid ? byStore.get(storeKey(inc.store, sid)) : undefined;

    if (sameStoreId) { // regra 1
      const { game } = edit(sameStoreId);
      const own = /** @type {Ownership} */ (game.ownerships.find((o) => o.store === inc.store && o.storeGameId === sid));
      refreshOwnership(own, inc, sid, source, now);
      fillMetadata(game, inc);
      recalcTotals(game);
      counts.updated++;
      return;
    }

    const tk = normalizeTitle(inc.title);
    const gid = byTitle.get(tk);
    if (gid) { // regra 2
      const entry = edit(gid);
      const game = entry.game;
      // mesma loja sem id no Game, ou linha sem id: é a mesma posse reimportada
      const own = game.ownerships.find((o) => o.store === inc.store && (o.storeGameId == null || sid == null));
      if (own) {
        refreshOwnership(own, inc, sid ?? '', source, now);
        counts.updated++;
      } else {
        game.ownerships.push(createOwnership({
          store: inc.store, storeGameId: sid, source: source ?? 'csv',
          playtimeMinutes: inc.playtimeMinutes ?? null, lastPlayedAt: inc.lastPlayedAt ?? null, importedAt: now,
        }));
        counts.merged++;
      }
      if (sid) byStore.set(storeKey(inc.store, sid), gid);
      fillMetadata(game, inc);
      recalcTotals(game);
      return;
    }

    // regra 3
    const game = createGame({
      title: inc.title,
      ownerships: [{
        store: inc.store, storeGameId: sid, source: source ?? 'csv',
        playtimeMinutes: inc.playtimeMinutes ?? null, lastPlayedAt: inc.lastPlayedAt ?? null, importedAt: now,
      }],
      status: inc.status ?? 'backlog',
      tags: inc.tags, genres: inc.genres, rating: inc.rating ?? null, notes: inc.notes,
      developer: inc.developer ?? null, year: inc.year ?? null,
      coverUrl: inc.coverUrl ?? null,
      coverAppId: inc.coverAppId ?? (inc.store === 'steam' && sid && /^\d+$/.test(sid) ? Number(sid) : null),
      achievementsDone: inc.achievementsDone ?? null, achievementsTotal: inc.achievementsTotal ?? null,
      createdAt: now, updatedAt: now,
    });
    work.set(game.id, { game, created: true });
    index(game);
    counts.new++;
  });

  /** @type {Game[]} */ const toCreate = [];
  /** @type {{before: Game, after: Game}[]} */ const toUpdate = [];
  for (const [id, { game, created }] of work) {
    if (created) {
      toCreate.push(game);
    } else if (fingerprint(game) !== fingerprint(/** @type {Game} */ (originals.get(id)))) {
      game.updatedAt = now;
      toUpdate.push({ before: /** @type {Game} */ (originals.get(id)), after: game });
    }
  }

  return { toCreate, toUpdate, mergedCount: counts.merged, errors, counts };
}

/**
 * Grava o plano em lote (uma transação). Chame só depois de o usuário confirmar o preview.
 * @param {MergePlan} plan
 * @returns {Promise<{created: number, updated: number}>}
 */
export async function applyMerge(plan) {
  const games = [...plan.toCreate, ...plan.toUpdate.map((u) => u.after)];
  await putGames(games);
  return { created: plan.toCreate.length, updated: plan.toUpdate.length };
}

/**
 * "Separar loja": move todas as ownerships de `store` do jogo para um Game novo (corrige merge errado).
 * O novo Game herda título e metadados, nasce como `backlog` e sem dados pessoais.
 * Lança `{ code: 'not_found' }` se o jogo ou a loja não existirem e `{ code: 'bad_request' }` se
 * o jogo só tiver essa loja (não há o que separar).
 * @param {string} gameId
 * @param {Store} store
 * @returns {Promise<Game>} o Game novo (já gravado)
 */
export async function splitOwnership(gameId, store) {
  const game = await getGame(gameId);
  if (!game || !game.ownerships.some((o) => o.store === store)) throw { code: 'not_found' };
  const moved = game.ownerships.filter((o) => o.store === store);
  const kept = game.ownerships.filter((o) => o.store !== store);
  if (kept.length === 0) throw { code: 'bad_request' };

  const now = new Date().toISOString();
  const split = createGame({
    title: game.title,
    ownerships: moved,
    genres: game.genres,
    developer: game.developer,
    year: game.year,
    coverUrl: game.coverUrl,
    coverAppId: game.coverAppId,
    coverManual: game.coverManual,
    createdAt: now,
    updatedAt: now,
  });
  game.ownerships = kept;
  game.updatedAt = now;
  recalcTotals(game);
  await putGames([game, split]);
  return split;
}
