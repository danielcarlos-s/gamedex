// Backup do gamedex (PLANO seção 5 "Arquivo de backup" e 6.3): exportar/importar JSON e arquivo vinculado
// (File System Access API, só quando o navegador suportar) com auto-save.
// Sem DOM além de `Blob`/`URL`/`<a download>` em `downloadBackup`; sem texto para o usuário: falhas são `throw { code }`.
//
// Formato: { "app": "gamedex", "schemaVersion": 1, "exportedAt": "ISO", "games": [...], "meta": { lastSteamSync } }
// (sem handles, sem workerUrl, sem lastBackupAt). Campos opcionais em `meta` (aditivos, a versão do schema não muda):
// `customStores` (lojas criadas pelo usuário), `theme` ('light'|'dark'), `steamId` (público) e `steamKeyEnc` (chave da Steam API cifrada com senha; só quando o usuário pede).

import { getAllGames, getMeta, setMeta, putGames, replaceGames, onChange } from './db.js';
import { encryptSecret, decryptSecret } from './keycrypt.js';
import { restoreStores, loadStores, sanitizeStores } from './stores.js';
import { SCHEMA_VERSION, STATUSES, validateGame, recalcTotals, normalizeTitle } from './model.js';

/** @typedef {import('./model.js').Game} Game */
/** @typedef {import('./model.js').Ownership} Ownership */

/**
 * @typedef {'unsupported'|'none'|'linked'|'needs-permission'} LinkStatus
 */

/**
 * Resultado de cada auto-save, para a UI mostrar o estado.
 * @typedef {{ok: true, at: string} | {ok: false, code: string}} AutoSaveResult
 */

const APP = 'gamedex';
const HANDLE_KEY = 'linkedFileHandle';
const AUTOSAVE_DEBOUNCE_MS = 2000;

/**
 * Ganchos para teste: o IndexedDB falso do Node não clona `FileSystemFileHandle`, então os testes trocam
 * o armazenamento do handle e encurtam o debounce. Em produção, nunca mexa aqui.
 * @type {{
 *   debounceMs: number,
 *   handleStore: {get: () => Promise<any>, set: (h: any) => Promise<void>}
 * }}
 */
export const _internals = {
  debounceMs: AUTOSAVE_DEBOUNCE_MS,
  handleStore: { get: () => getMeta(HANDLE_KEY), set: (h) => setMeta(HANDLE_KEY, h) },
};

/** @returns {{code: string}} */
const permissionDenied = () => ({ code: 'fs_permission_denied' });

/** @returns {string} */
const nowIso = () => new Date().toISOString();

// ---------------------------------------------------------------- exportar

/**
 * Monta o objeto de backup com todos os jogos, `meta.lastSteamSync` e, se houver, `meta.steamId`.
 * Com `options.includeKey` + `options.password`, inclui a chave Steam cifrada em `meta.steamKeyEnc`.
 * @param {BackupOptions} [options]
 * @returns {Promise<{app: string, schemaVersion: number, exportedAt: string, games: Game[], meta: Record<string, any>}>}
 */
async function buildBackup(options = {}) {
  const [games, lastSteamSync, steamId, steamKey, theme, customStores] = await Promise.all([getAllGames(), getMeta('lastSteamSync'), getMeta('steamId'), getMeta('steamKey'), getMeta('theme'), getMeta('customStores')]);
  /** @type {Record<string, any>} */ const meta = { lastSteamSync };
  if (steamId) meta.steamId = steamId;
  if (theme === 'light' || theme === 'dark') meta.theme = theme;
  const stores = sanitizeStores(customStores);
  if (stores.length) meta.customStores = stores;
  if (options.includeKey && steamKey) meta.steamKeyEnc = await encryptSecret(steamKey, options.password || '');
  return { app: APP, schemaVersion: SCHEMA_VERSION, exportedAt: nowIso(), games, meta };
}

/**
 * @typedef {object} BackupOptions
 * @property {boolean} [includeKey] incluir a chave Steam (exige `password`; lança `bad_request` sem ela)
 * @property {string} [password] senha que cifra a chave
 */

/**
 * Gera o arquivo de backup em memória (não grava `lastBackupAt`; quem entrega o arquivo é que grava).
 * Sem `options`, a chave Steam NUNCA entra (é o caso do auto-save).
 * @param {BackupOptions} [options]
 * @returns {Promise<Blob>} JSON `application/json`
 */
export async function exportBackup(options = {}) {
  return new Blob([JSON.stringify(await buildBackup(options), null, 1)], { type: 'application/json' });
}

/**
 * Baixa o backup como `gamedex-backup-AAAA-MM-DD.json` e grava `lastBackupAt`.
 * @param {BackupOptions} [options]
 * @returns {Promise<void>}
 */
export async function downloadBackup(options = {}) {
  const blob = await exportBackup(options);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `gamedex-backup-${nowIso().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  await setMeta('lastBackupAt', nowIso());
}

// ---------------------------------------------------------------- importar

/**
 * Lê e valida um arquivo de backup. Nada é gravado aqui.
 * Lança `backup_invalid` (JSON ilegível, não é do gamedex, jogo inválido) ou `backup_version` (versão mais nova).
 * @param {Blob|string} file
 * @returns {Promise<{games: Game[], lastSteamSync: string|null, steamId: string|null, steamKeyEnc: any, theme: 'light'|'dark'|null, customStores: any}>}
 */
async function readBackup(file) {
  let data;
  try {
    const text = typeof file === 'string' ? file : await file.text();
    data = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw { code: 'backup_invalid' };
  }
  if (!data || typeof data !== 'object' || data.app !== APP || !Array.isArray(data.games)) throw { code: 'backup_invalid' };
  if (!Number.isInteger(data.schemaVersion) || data.schemaVersion < 1) throw { code: 'backup_invalid' };
  if (data.schemaVersion > SCHEMA_VERSION) throw { code: 'backup_version' };
  const ids = new Set();
  for (const g of data.games) {
    if (!g || typeof g.id !== 'string' || !g.id || ids.has(g.id) || !validateGame(g).ok) throw { code: 'backup_invalid' };
    ids.add(g.id);
  }
  const sync = data.meta?.lastSteamSync;
  const sid = data.meta?.steamId;
  const keyEnc = data.meta?.steamKeyEnc;
  return {
    games: data.games,
    lastSteamSync: typeof sync === 'string' ? sync : null,
    steamId: typeof sid === 'string' && /^\d{17}$/.test(sid) ? sid : null,
    steamKeyEnc: keyEnc && typeof keyEnc === 'object' ? keyEnc : null,
    theme: data.meta?.theme === 'light' || data.meta?.theme === 'dark' ? data.meta.theme : null,
    customStores: data.meta?.customStores,
  };
}

/**
 * O arquivo traz uma chave Steam cifrada? Só olha o JSON (a UI usa para pedir a senha). Nunca lança.
 * @param {Blob|string} file
 * @returns {Promise<boolean>}
 */
export async function backupHasKey(file) {
  try {
    const text = typeof file === 'string' ? file : await file.text();
    const k = JSON.parse(text.replace(/^\uFEFF/, ''))?.meta?.steamKeyEnc;
    return !!k && typeof k === 'object';
  } catch {
    return false;
  }
}

/**
 * @param {string|null|undefined} a ISO
 * @param {string|null|undefined} b ISO
 * @returns {string|null} o mais recente
 */
const latest = (a, b) => (a && b ? (Date.parse(a) >= Date.parse(b) ? a : b) : a || b || null);

/**
 * Junta um jogo do arquivo (`b`) num jogo existente (`target`, mutado).
 * Ownerships: a da mesma loja é atualizada com o MAIOR tempo e o último jogo mais recente (o arquivo pode ser
 * mais velho que o banco); as que não existem entram com `source: 'backup'`.
 * Campos pessoais do arquivo só preenchem o que está vazio no banco (`backlog`, `false`, `null`, `''`, `[]`).
 * @param {Game} target
 * @param {Game} b
 */
function mergeBackupGame(target, b) {
  for (const bo of b.ownerships) {
    const own = target.ownerships.find((o) => o.store === bo.store
      && (o.storeGameId === bo.storeGameId || o.storeGameId == null || bo.storeGameId == null));
    if (own) {
      if (own.storeGameId == null) own.storeGameId = bo.storeGameId;
      if (bo.playtimeMinutes != null && bo.playtimeMinutes > (own.playtimeMinutes ?? 0)) own.playtimeMinutes = bo.playtimeMinutes;
      own.lastPlayedAt = latest(own.lastPlayedAt, bo.lastPlayedAt);
    } else {
      target.ownerships.push({ ...structuredClone(bo), source: 'backup' });
    }
  }
  if (target.status === 'backlog' && STATUSES.includes(b.status)) target.status = b.status;
  if (!target.favorite && b.favorite) target.favorite = true;
  for (const f of /** @type {const} */ (['rating', 'developer', 'year', 'startedAt', 'finishedAt', 'achievementsDone', 'achievementsTotal'])) {
    if (target[f] == null && b[f] != null) /** @type {any} */ (target)[f] = b[f];
  }
  for (const f of /** @type {const} */ (['tags', 'genres', 'links'])) {
    if (target[f].length === 0 && b[f]?.length) /** @type {any} */ (target)[f] = structuredClone(b[f]);
  }
  if (!target.notes && b.notes) target.notes = b.notes;
  if (!target.coverManual && target.coverUrl == null && b.coverUrl) {
    target.coverUrl = b.coverUrl;
    target.coverAppId = target.coverAppId ?? b.coverAppId ?? null;
    target.coverManual = !!b.coverManual;
  }
  recalcTotals(target);
}

/**
 * Planeja a mesclagem de um backup com os jogos existentes, SEM gravar e sem mutar os argumentos.
 * Casamento (como no PLANO, seção 5): mesmo `id` ou mesma loja + `storeGameId` → atualiza (`updated`);
 * senão mesmo `titleKey` → junta ao existente (`merged`); senão entra como jogo novo (`created`).
 * `toUpdate` só traz jogos que realmente mudaram.
 * @param {Game[]} existing
 * @param {Game[]} fileGames
 * @param {string} [now] ISO, para `updatedAt`
 * @returns {{toCreate: Game[], toUpdate: {before: Game, after: Game}[], counts: {new: number, updated: number, merged: number}}}
 */
export function planBackupMerge(existing, fileGames, now = nowIso()) {
  /** @type {Map<string, Game>} */ const originals = new Map(existing.map((g) => [g.id, g]));
  /** @type {Map<string, {game: Game, created: boolean}>} */ const work = new Map();
  /** @type {Map<string, string>} */ const byStore = new Map();
  /** @type {Map<string, string>} */ const byTitle = new Map();
  const index = (/** @type {Game} */ g) => {
    const tk = g.titleKey || normalizeTitle(g.title);
    if (tk && !byTitle.has(tk)) byTitle.set(tk, g.id);
    for (const o of g.ownerships) if (o.storeGameId) byStore.set(`${o.store}\u0000${o.storeGameId}`, g.id);
  };
  existing.forEach(index);
  const counts = { new: 0, updated: 0, merged: 0 };

  for (const raw of fileGames) {
    const b = structuredClone(raw);
    let id = originals.has(b.id) || work.has(b.id) ? b.id : undefined;
    let kind = 'updated';
    if (!id) {
      for (const o of b.ownerships) {
        if (o.storeGameId) id = byStore.get(`${o.store}\u0000${o.storeGameId}`);
        if (id) break;
      }
    }
    if (!id) {
      id = byTitle.get(b.titleKey || normalizeTitle(b.title));
      kind = 'merged';
    }
    if (!id) {
      work.set(b.id, { game: b, created: true });
      index(b);
      counts.new++;
      continue;
    }
    let entry = work.get(id);
    if (!entry) {
      entry = { game: structuredClone(/** @type {Game} */ (originals.get(id))), created: false };
      work.set(id, entry);
    }
    mergeBackupGame(entry.game, b);
    index(entry.game);
    counts[/** @type {'updated'|'merged'} */ (kind)]++;
  }

  /** @type {Game[]} */ const toCreate = [];
  /** @type {{before: Game, after: Game}[]} */ const toUpdate = [];
  for (const [id, { game, created }] of work) {
    if (created) toCreate.push(game);
    else if (JSON.stringify(game) !== JSON.stringify(originals.get(id))) {
      game.updatedAt = now;
      toUpdate.push({ before: /** @type {Game} */ (originals.get(id)), after: game });
    }
  }
  return { toCreate, toUpdate, counts };
}

/**
 * Importa um backup.
 * - `'replace'`: apaga os jogos atuais e grava os do arquivo, numa transação só (se falhar, nada muda).
 *   Quem chama deve pedir confirmação antes.
 * - `'merge'`: mescla pelas regras da seção 5 (ver `planBackupMerge`), ownerships novas com `source: 'backup'`.
 * Valida o arquivo inteiro antes de gravar qualquer coisa. Lança `{ code }`: `backup_invalid`, `backup_version`,
 * `bad_request` (modo desconhecido), `idb_unavailable`, `backup_password` (senha errada; nada é gravado).
 * Tema do arquivo (`result.theme`, a UI aplica): restaurado em `replace`; em `merge` só se não houver um local.
 * SteamID do arquivo: restaurado sempre (em `merge`, só se não houver um local). Chave Steam: só com `options.password`
 * correta (em `merge`, só se não houver uma local); sem senha o resto é importado e `steam.key` = `'skipped'`.
 * @param {Blob|string} file
 * @param {'replace'|'merge'} mode
 * @param {{password?: string}} [options]
 * @returns {Promise<{mode: 'replace'|'merge', created: number, updated: number, merged: number, steam: {id: boolean, key: 'none'|'restored'|'skipped'}, theme: 'light'|'dark'|null}>}
 */
export async function importBackup(file, mode, options = {}) {
  if (mode !== 'replace' && mode !== 'merge') throw { code: 'bad_request' };
  const { games, lastSteamSync, steamId, steamKeyEnc, theme, customStores } = await readBackup(file);
  const plainKey = steamKeyEnc && options.password ? await decryptSecret(steamKeyEnc, options.password) : null;
  const steam = async () => {
    /** @type {{id: boolean, key: 'none'|'restored'|'skipped'}} */ const r = { id: false, key: steamKeyEnc ? 'skipped' : 'none' };
    if (steamId && (mode === 'replace' || !(await getMeta('steamId')))) { await setMeta('steamId', steamId); r.id = true; }
    if (plainKey && (mode === 'replace' || !(await getMeta('steamKey')))) { await setMeta('steamKey', plainKey); r.key = 'restored'; }
    return r;
  };
  /** @returns {Promise<'light'|'dark'|null>} o tema restaurado (ou null) */
  const restoreTheme = async () => {
    if (!theme || (mode === 'merge' && (await getMeta('theme')))) return null;
    await setMeta('theme', theme);
    return theme;
  };

  // lojas criadas primeiro: os jogos importados podem usar o id delas
  await loadStores();
  await restoreStores(customStores, mode);
  if (mode === 'replace') {
    await replaceGames(games);
    if (lastSteamSync) await setMeta('lastSteamSync', lastSteamSync);
    return { mode, created: games.length, updated: 0, merged: 0, steam: await steam(), theme: await restoreTheme() };
  }

  const plan = planBackupMerge(await getAllGames(), games);
  await putGames([...plan.toCreate, ...plan.toUpdate.map((u) => u.after)]);
  const current = await getMeta('lastSteamSync');
  if (lastSteamSync && latest(current, lastSteamSync) !== current) await setMeta('lastSteamSync', lastSteamSync);
  return { mode, created: plan.counts.new, updated: plan.counts.updated, merged: plan.counts.merged, steam: await steam(), theme: await restoreTheme() };
}

// ---------------------------------------------------------------- arquivo vinculado

/**
 * O navegador oferece o File System Access API (Chrome/Edge)? Detecção por recurso.
 * @returns {boolean}
 */
export function fsAccessSupported() {
  return typeof globalThis !== 'undefined' && typeof (/** @type {any} */ (globalThis).showSaveFilePicker) === 'function';
}

/**
 * Situação do arquivo vinculado. Nunca lança: sem suporte → `unsupported` (sem tocar no banco);
 * erro de leitura do banco → `none`.
 * @returns {Promise<LinkStatus>}
 */
export async function getLinkStatus() {
  if (!fsAccessSupported()) return 'unsupported';
  let handle;
  try {
    handle = await _internals.handleStore.get();
  } catch {
    return 'none';
  }
  if (!handle) return 'none';
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted' ? 'linked' : 'needs-permission';
  } catch {
    return 'needs-permission';
  }
}

/**
 * Grava o backup completo no arquivo vinculado e atualiza `lastBackupAt`.
 * @param {any} handle FileSystemFileHandle com permissão de escrita
 * @returns {Promise<string>} o `lastBackupAt` gravado
 */
async function writeToHandle(handle) {
  const blob = await exportBackup();
  try {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    throw permissionDenied();
  }
  const at = nowIso();
  await setMeta('lastBackupAt', at);
  return at;
}

/**
 * Pede ao usuário onde salvar o arquivo vinculado (`showSaveFilePicker`; exige gesto do usuário, como um clique),
 * guarda o handle e grava o primeiro backup. Devolve `false` se o usuário cancelar o seletor.
 * Lança `{ code: 'fs_permission_denied' }` se não houver suporte ou a permissão/gravação falhar.
 * @returns {Promise<boolean>} true = vinculado
 */
export async function linkFile() {
  if (!fsAccessSupported()) throw permissionDenied();
  let handle;
  try {
    handle = await /** @type {any} */ (globalThis).showSaveFilePicker({
      suggestedName: 'gamedex-backup.json',
      types: [{ description: 'gamedex (JSON)', accept: { 'application/json': ['.json'] } }],
    });
  } catch (err) {
    if (/** @type {any} */ (err)?.name === 'AbortError') return false;
    throw permissionDenied();
  }
  await writeToHandle(handle);
  await _internals.handleStore.set(handle);
  return true;
}

/**
 * Desvincula o arquivo (o arquivo no disco continua lá) e cancela um auto-save pendente.
 * @returns {Promise<void>}
 */
export async function unlinkFile() {
  clearTimeout(timer);
  timer = undefined;
  await _internals.handleStore.set(null);
}

/**
 * Pede de volta a permissão de escrita do arquivo vinculado (o navegador a revoga ao reabrir) e grava um
 * backup agora. EXIGE gesto do usuário (clique). Lança `{ code: 'fs_permission_denied' }` se negada ou sem
 * suporte e `{ code: 'not_found' }` se não houver arquivo vinculado.
 * @returns {Promise<LinkStatus>} `linked`
 */
export async function reconnect() {
  if (!fsAccessSupported()) throw permissionDenied();
  const handle = await _internals.handleStore.get();
  if (!handle) throw { code: 'not_found' };
  let state;
  try {
    state = await handle.requestPermission({ mode: 'readwrite' });
  } catch {
    throw permissionDenied();
  }
  if (state !== 'granted') throw permissionDenied();
  await writeToHandle(handle);
  return 'linked';
}

// ---------------------------------------------------------------- auto-save

/** @type {ReturnType<typeof setTimeout>|undefined} */
let timer;
/** Encadeia gravações para nunca haver dois `createWritable` ao mesmo tempo. @type {Promise<void>} */
let writing = Promise.resolve();
/** @type {Set<(r: AutoSaveResult) => void>} */
const autoSaveListeners = new Set();

/**
 * Avisa quando um auto-save termina (ok ou com código de erro). Útil para a UI mostrar "salvo às …" ou
 * "reconectar".
 * @param {(r: AutoSaveResult) => void} cb
 * @returns {() => void} cancela o registro
 */
export function onAutoSave(cb) {
  autoSaveListeners.add(cb);
  return () => autoSaveListeners.delete(cb);
}

/** @param {AutoSaveResult} result */
function notify(result) {
  for (const cb of [...autoSaveListeners]) {
    try { cb(result); } catch (err) { console.error('[gamedex] erro em ouvinte de onAutoSave', err); }
  }
}

/** Executa um auto-save agora: só grava se o arquivo estiver `linked`; senão fica quieto (a UI vê o status). */
function runAutoSave() {
  writing = writing.then(async () => {
    try {
      if ((await getLinkStatus()) !== 'linked') return;
      const handle = await _internals.handleStore.get();
      notify({ ok: true, at: await writeToHandle(handle) });
    } catch (err) {
      notify({ ok: false, code: /** @type {any} */ (err)?.code ?? 'fs_permission_denied' });
    }
  });
}

// Reage SÓ a mudanças em jogos: gravar `lastBackupAt` (meta) não pode disparar outro auto-save (laço).
onChange((e) => {
  if (e.type !== 'games' || !fsAccessSupported()) return;
  clearTimeout(timer);
  timer = setTimeout(runAutoSave, _internals.debounceMs);
});

/**
 * Espera as gravações do auto-save em andamento terminarem (para testes e para "salvar antes de sair").
 * @returns {Promise<void>}
 */
export function flushAutoSave() {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
    runAutoSave();
  }
  return writing;
}
