// Testes do B4: backup.js (exportar/importar, mesclagem, arquivo vinculado e auto-save). Precisam de `indexedDB`.
// O File System Access API é simulado (handle falso em memória): o IndexedDB falso do Node não clona handles,
// então o armazenamento do handle é trocado via `_internals`.
import { test, assert } from '../test-lib.js';
import * as db from '../../js/data/db.js';
import { createGame, planMerge, applyMerge } from '../../js/data/model.js';
import * as backup from '../../js/data/backup.js';

const { _internals } = backup;
const DEFAULT_DEBOUNCE = _internals.debounceMs;
const NOW = '2026-10-12T12:00:00.000Z';

/** @param {string} title @param {object} [extra] */
const mk = (title, extra = {}) => createGame({
  title, ownerships: [{ store: 'steam', storeGameId: String(title.length * 1000 + 7), source: 'api', playtimeMinutes: 60, lastPlayedAt: '2026-01-01T00:00:00.000Z', importedAt: NOW }], ...extra,
});

/** Amostra variada: pessoal preenchido, 2 lojas, capa manual, acentos. */
function sample() {
  const gs = [
    mk('Hades', { status: 'playing', favorite: true, rating: 5, tags: ['indie', 'roguelike'], notes: 'ótimo\ncom "aspas"', startedAt: '2025-01-02', links: [{ label: 'wiki', url: 'https://x.test' }], coverUrl: 'https://c.test/m.jpg', coverManual: true, achievementsDone: 3, achievementsTotal: 49 }),
    mk('Pokémon Ouro'),
    createGame({ title: 'Doom', ownerships: [{ store: 'steam', storeGameId: '1', playtimeMinutes: 10 }, { store: 'gog', playtimeMinutes: 5, lastPlayedAt: '2026-03-01T00:00:00.000Z' }], developer: 'id', year: 1993, genres: ['FPS'] }),
  ];
  for (let i = 0; i < 40; i++) gs.push(createGame({ title: `Jogo ${i}`, ownerships: [{ store: i % 2 ? 'epic' : 'gog', playtimeMinutes: i }], status: 'finished', rating: i % 6 }));
  return gs;
}
/** @param {any[]} a */
const byId = (a) => [...a].sort((x, y) => (x.id < y.id ? -1 : 1));

/**
 * Handle falso do File System Access API.
 * @param {'granted'|'prompt'|'denied'} [perm]
 */
function fakeHandle(perm = 'granted') {
  /** @type {any} */
  const h = {
    perm, next: 'granted', writes: /** @type {Blob[]} */ ([]),
    async queryPermission() { return h.perm; },
    async requestPermission() { h.perm = h.next; return h.perm; },
    async createWritable() {
      if (h.perm !== 'granted') throw Object.assign(new Error('x'), { name: 'NotAllowedError' });
      let data; return { write: async (/** @type {Blob} */ b) => { data = b; }, close: async () => { h.writes.push(data); } };
    },
  };
  return h;
}

/**
 * Roda `fn` com o FS Access falso instalado e tudo restaurado depois.
 * @param {any} handle
 * @param {(mem: {handle: any}) => Promise<void>} fn
 * @param {{debounceMs?: number, picker?: () => Promise<any>}} [opts]
 */
async function withFs(handle, fn, opts = {}) {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
  const oldStore = _internals.handleStore;
  const mem = { handle: null };
  _internals.handleStore = { get: async () => mem.handle, set: async (h) => { mem.handle = h; } };
  _internals.debounceMs = opts.debounceMs ?? 40;
  Object.defineProperty(globalThis, 'showSaveFilePicker', { value: opts.picker ?? (async () => handle), configurable: true, writable: true });
  try { await fn(mem); } finally {
    await backup.unlinkFile();
    await backup.flushAutoSave();
    _internals.handleStore = oldStore;
    _internals.debounceMs = DEFAULT_DEBOUNCE;
    if (desc) Object.defineProperty(globalThis, 'showSaveFilePicker', desc); else delete (/** @type {any} */ (globalThis)).showSaveFilePicker;
  }
}
const wait = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** Aba em segundo plano ou sem foco estrangula timers (≥1 s): cronometragem estrita só com a aba visível. */
const visible = () => typeof document === 'undefined' || (document.visibilityState === 'visible' && document.hasFocus());
/**
 * Promessa do PRÓXIMO resultado de auto-save (sem depender de relógio); rejeita após `timeoutMs`.
 * @param {number} [timeoutMs]
 * @returns {Promise<any>}
 */
function nextAutoSave(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error('auto-save não aconteceu')); }, timeoutMs);
    const off = backup.onAutoSave((r) => { clearTimeout(timer); off(); resolve(r); });
  });
}

test('backup: o debounce do auto-save é de 2 s', () => { assert.equal(DEFAULT_DEBOUNCE, 2000); });

test('backup: formato do arquivo (app, schemaVersion, exportedAt, games, meta.lastSteamSync) sem handles nem workerUrl', async () => {
  await db.clearGames();
  await db.putGames(sample());
  await db.setMeta('lastSteamSync', '2026-10-01T00:00:00.000Z');
  await db.setMeta('workerUrl', 'https://w.test');
  await db.setMeta('lastBackupAt', '2026-10-02T00:00:00.000Z');
  const blob = await backup.exportBackup();
  assert.equal(blob.type, 'application/json');
  const data = JSON.parse(await blob.text());
  assert.deepEqual(Object.keys(data).sort(), ['app', 'exportedAt', 'games', 'meta', 'schemaVersion']);
  assert.equal(data.app, 'gamedex');
  assert.equal(data.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(data.exportedAt)));
  assert.equal(data.games.length, 43);
  assert.deepEqual(data.meta, { lastSteamSync: '2026-10-01T00:00:00.000Z' });
  await db.clearGames();
});

test('backup: exportar → clearGames → importar (substituir) restaura idêntico (deep-equal)', async () => {
  await db.clearGames();
  const original = sample();
  await db.putGames(original);
  const before = byId(await db.getAllGames());
  const blob = await backup.exportBackup();
  await db.clearGames();
  assert.equal((await db.getAllGames()).length, 0);
  const res = await backup.importBackup(blob, 'replace');
  assert.deepEqual(res, { mode: 'replace', created: 43, updated: 0, merged: 0, steam: { id: false, key: 'none' } });
  assert.deepEqual(byId(await db.getAllGames()), before);
  await db.clearGames();
});

test('backup: substituir troca o que existia e restaura lastSteamSync', async () => {
  await db.clearGames();
  await db.putGames(sample());
  const blob = await backup.exportBackup();
  await db.clearGames();
  const other = mk('Outro Jogo');
  await db.putGame(other);
  await backup.importBackup(blob, 'replace');
  assert.equal(await db.getGame(other.id), null, 'o jogo antigo saiu');
  assert.equal((await db.getAllGames()).length, 43);
  await db.clearGames();
});

test('backup: arquivos inválidos → códigos e NADA é gravado', async () => {
  await db.clearGames();
  const keep = mk('Fica');
  await db.putGame(keep);
  const ok = JSON.parse(await (await backup.exportBackup()).text());
  const bad = (/** @type {(d: any) => void} */ f) => { const d = structuredClone(ok); f(d); return JSON.stringify(d); };
  const cases = /** @type {[string, string][]} */ ([
    ['não é JSON', '{ quebrado'],
    ['outro app', bad((d) => { d.app = 'outro'; })],
    ['sem games', bad((d) => { delete d.games; })],
    ['array solto', '[]'],
    ['sem schemaVersion', bad((d) => { delete d.schemaVersion; })],
    ['jogo sem título', bad((d) => { d.games[0].title = ''; })],
    ['rating fora da faixa', bad((d) => { d.games[0].rating = 9; })],
    ['id repetido', bad((d) => { d.games.push(structuredClone(d.games[0])); })],
  ]);
  for (const [name, text] of cases) {
    for (const mode of /** @type {const} */ (['replace', 'merge'])) await assert.rejectsCode(() => backup.importBackup(text, mode), 'backup_invalid').catch((e) => { throw new Error(`${name}/${mode}: ${e.message}`); });
  }
  await assert.rejectsCode(() => backup.importBackup(bad((d) => { d.schemaVersion = 2; }), 'replace'), 'backup_version');
  await assert.rejectsCode(() => backup.importBackup(JSON.stringify(ok), /** @type {any} */ ('apagar')), 'bad_request');
  assert.deepEqual((await db.getAllGames()).map((g) => g.id), [keep.id], 'banco intacto');
  await db.clearGames();
});

test('backup: aceita File/Blob e BOM', async () => {
  await db.clearGames();
  await db.putGame(mk('A1'));
  const text = await (await backup.exportBackup()).text();
  await db.clearGames();
  await backup.importBackup(new Blob(['﻿' + text]), 'replace');
  assert.equal((await db.getAllGames()).length, 1);
  await db.clearGames();
});

test('backup/mesclar: regras da seção 5 — id/loja+id atualiza, titleKey junta, resto é novo; pessoal só preenche vazio', () => {
  const dbHades = mk('Hades', { notes: 'minha nota', rating: null, status: 'backlog' });
  const dbDoom = createGame({ title: 'Doom', status: 'finished', rating: 4, ownerships: [{ store: 'steam', storeGameId: '1', playtimeMinutes: 100, lastPlayedAt: '2026-05-01T00:00:00.000Z' }] });
  const existing = [dbHades, dbDoom];

  const fHades = structuredClone(dbHades);
  fHades.notes = 'nota do arquivo'; fHades.rating = 5; fHades.status = 'completed'; fHades.favorite = true; fHades.tags = ['x'];
  fHades.ownerships.push({ store: 'gog', storeGameId: null, source: 'csv', playtimeMinutes: 7, lastPlayedAt: null, importedAt: NOW });
  const fDoom = createGame({ title: 'DOOM (GOTY)', status: 'dropped', rating: 1, notes: 'arquivo', ownerships: [{ store: 'steam', storeGameId: '1', playtimeMinutes: 50, lastPlayedAt: '2026-02-01T00:00:00.000Z' }] });
  const fDoomEdition = createGame({ title: 'Doom Deluxe Edition', ownerships: [{ store: 'epic', playtimeMinutes: 3 }] });
  const fNew = mk('Jogo Novo');

  const plan = backup_plan(existing, [fHades, fDoom, fDoomEdition, fNew]);
  assert.deepEqual(plan.counts, { new: 1, updated: 2, merged: 1 });
  assert.equal(plan.toCreate.length, 1);
  assert.equal(plan.toCreate[0].title, 'Jogo Novo');

  const h = plan.toUpdate.find((u) => u.after.id === dbHades.id)?.after;
  assert.ok(h, 'Hades mudou');
  assert.equal(h.notes, 'minha nota', 'campo preenchido no banco não é sobrescrito');
  assert.equal(h.rating, 5, 'vazio no banco → preenche');
  assert.equal(h.status, 'completed', 'backlog conta como vazio');
  assert.equal(h.favorite, true);
  assert.deepEqual(h.tags, ['x']);
  assert.equal(h.ownerships.length, 2);
  assert.equal(h.ownerships[1].source, 'backup');

  const d = plan.toUpdate.find((u) => u.after.id === dbDoom.id)?.after;
  assert.ok(d);
  assert.equal(d.status, 'finished'); assert.equal(d.rating, 4); assert.equal(d.notes, 'arquivo', 'notas vazias no banco → preenche');
  assert.equal(d.ownerships.find((o) => o.store === 'steam')?.playtimeMinutes, 100, 'fica o MAIOR tempo');
  assert.equal(d.ownerships.find((o) => o.store === 'steam')?.lastPlayedAt, '2026-05-01T00:00:00.000Z');
  assert.ok(d.ownerships.some((o) => o.store === 'epic'), 'edição junta pelo titleKey');
  assert.equal(d.playtimeMinutes, 103);
  // não muta as entradas
  assert.equal(dbHades.ownerships.length, 1);
});

/** @param {any[]} a @param {any[]} b */
function backup_plan(a, b) { return backup.planBackupMerge(a, b, NOW); }

test('backup/mesclar: importar o mesmo backup de novo não altera nada (idempotente)', async () => {
  await db.clearGames();
  await db.putGames(sample());
  const blob = await backup.exportBackup();
  const before = byId(await db.getAllGames());
  const res = await backup.importBackup(blob, 'merge');
  assert.deepEqual(res, { mode: 'merge', created: 0, updated: 43, merged: 0, steam: { id: false, key: 'none' } });
  assert.deepEqual(byId(await db.getAllGames()), before);
  await db.clearGames();
});

test('backup/mesclar: importBackup grava novos e atualizados e mantém o lastSteamSync mais recente', async () => {
  await db.clearGames();
  const a = mk('Aaa'); const b = mk('Bbb', { notes: '' });
  await db.putGames([a, b]);
  await db.setMeta('lastSteamSync', '2026-10-05T00:00:00.000Z');
  const file = { app: 'gamedex', schemaVersion: 1, exportedAt: NOW, meta: { lastSteamSync: '2026-10-01T00:00:00.000Z' },
    games: [{ ...b, notes: 'do arquivo' }, mk('Cccccc')] };
  const res = await backup.importBackup(JSON.stringify(file), 'merge');
  assert.deepEqual(res, { mode: 'merge', created: 1, updated: 1, merged: 0, steam: { id: false, key: 'none' } });
  assert.equal((await db.getAllGames()).length, 3);
  assert.equal((/** @type {any} */ (await db.getGame(b.id))).notes, 'do arquivo');
  assert.equal(await db.getMeta('lastSteamSync'), '2026-10-05T00:00:00.000Z');
  file.meta.lastSteamSync = '2026-10-09T00:00:00.000Z';
  await backup.importBackup(JSON.stringify(file), 'merge');
  assert.equal(await db.getMeta('lastSteamSync'), '2026-10-09T00:00:00.000Z');
  await db.clearGames();
});

test('backup: fsAccessSupported() false → getLinkStatus() = unsupported, sem erro; linkFile/reconnect dão fs_permission_denied', async () => {
  const desc = Object.getOwnPropertyDescriptor(globalThis, 'showSaveFilePicker');
  Object.defineProperty(globalThis, 'showSaveFilePicker', { value: undefined, configurable: true, writable: true });
  try {
    assert.equal(backup.fsAccessSupported(), false);
    assert.equal(await backup.getLinkStatus(), 'unsupported');
    await assert.rejectsCode(() => backup.linkFile(), 'fs_permission_denied');
    await assert.rejectsCode(() => backup.reconnect(), 'fs_permission_denied');
    await db.clearGames();
    await db.putGame(mk('Sem FS'));
    await wait(80); // auto-save não faz nada (nem erro) sem suporte
    await backup.flushAutoSave();
  } finally {
    if (desc) Object.defineProperty(globalThis, 'showSaveFilePicker', desc); else delete (/** @type {any} */ (globalThis)).showSaveFilePicker;
  }
  await db.clearGames();
});

test('backup: vincular → status linked, 1º backup gravado e lastBackupAt atualizado', async () => {
  const handle = fakeHandle();
  await withFs(handle, async () => {
    assert.equal(backup.fsAccessSupported(), true);
    assert.equal(await backup.getLinkStatus(), 'none');
    await db.clearGames();
    await db.putGame(mk('Vinculado'));
    assert.equal(await backup.linkFile(), true);
    assert.equal(await backup.getLinkStatus(), 'linked');
    const data = JSON.parse(await handle.writes.at(-1).text());
    assert.equal(data.games.length, 1);
    assert.ok(Date.parse(await db.getMeta('lastBackupAt')) > 0);
    await backup.unlinkFile();
    assert.equal(await backup.getLinkStatus(), 'none');
  });
  await db.clearGames();
});

test('backup: cancelar o seletor devolve false e não vincula', async () => {
  await withFs(null, async () => {
    assert.equal(await backup.linkFile(), false);
    assert.equal(await backup.getLinkStatus(), 'none');
  }, { picker: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
});

test('backup: auto-save grava depois da edição, com debounce, e gravar lastBackupAt não gera laço', async () => {
  const handle = fakeHandle();
  await withFs(handle, async () => {
    await db.clearGames();
    await backup.linkFile();
    const base = handle.writes.length;
    /** @type {any[]} */ const results = [];
    const off = backup.onAutoSave((r) => results.push(r));
    // três edições seguidas viram UMA gravação
    const saved = nextAutoSave();
    await db.putGame(mk('E1')); await db.putGame(mk('E2')); await db.putGame(mk('E3'));
    assert.equal(handle.writes.length, base, 'ainda não gravou (debounce)');
    await saved;
    assert.equal(handle.writes.length, base + 1, 'uma gravação só');
    assert.equal(JSON.parse(await handle.writes.at(-1).text()).games.length, 3);
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, true);
    await wait(250); // se lastBackupAt re-disparasse, haveria nova gravação
    assert.equal(handle.writes.length, base + 1, 'sem laço');
    await db.setMeta('workerUrl', 'x'); // meta sozinho não dispara
    await wait(150);
    assert.equal(handle.writes.length, base + 1);
    const afterDelete = nextAutoSave();
    await db.deleteGame((await db.getAllGames())[0].id);
    await afterDelete;
    assert.equal(handle.writes.length, base + 2, 'exclusão também grava');
    off();
  });
  await db.clearGames();
});

test('backup: com o debounce padrão, grava em ≤ 2 s após a edição', async () => {
  const handle = fakeHandle();
  await withFs(handle, async () => {
    await db.clearGames();
    await backup.linkFile();
    _internals.debounceMs = DEFAULT_DEBOUNCE;
    const base = handle.writes.length;
    const saved = nextAutoSave();
    const t0 = Date.now();
    await db.putGame(mk('Relógio'));
    await saved;
    const dt = Date.now() - t0;
    assert.equal(handle.writes.length, base + 1);
    assert.ok(dt >= 1900, `gravou cedo demais: ${dt} ms`);
    if (visible()) assert.ok(dt <= 2300, `gravou em ${dt} ms`); // em segundo plano o navegador atrasa timers
  });
  await db.clearGames();
});

test('backup: permissão expirada → needs-permission, auto-save fica quieto; reconnect volta e grava', async () => {
  const handle = fakeHandle();
  await withFs(handle, async () => {
    await db.clearGames();
    await backup.linkFile();
    handle.perm = 'prompt'; // navegador reaberto
    assert.equal(await backup.getLinkStatus(), 'needs-permission');
    const base = handle.writes.length;
    await db.putGame(mk('Offline'));
    await wait(150);
    assert.equal(handle.writes.length, base, 'não grava sem permissão');
    assert.equal(await backup.reconnect(), 'linked');
    assert.equal(handle.writes.length, base + 1);
    assert.equal(JSON.parse(await handle.writes.at(-1).text()).games.length, 1);
    // negada
    handle.perm = 'prompt'; handle.next = 'denied';
    await assert.rejectsCode(() => backup.reconnect(), 'fs_permission_denied');
    assert.equal(await backup.getLinkStatus(), 'needs-permission');
  });
  await db.clearGames();
});

test('backup: reconnect sem arquivo vinculado → not_found; falha de escrita no auto-save é reportada por onAutoSave', async () => {
  const handle = fakeHandle();
  await withFs(handle, async () => {
    await assert.rejectsCode(() => backup.reconnect(), 'not_found');
    await backup.linkFile();
    /** @type {any[]} */ const results = [];
    const off = backup.onAutoSave((r) => results.push(r));
    handle.createWritable = async () => { throw new Error('disco cheio'); };
    const failed = nextAutoSave();
    await db.putGame(mk('Falha'));
    await failed;
    assert.deepEqual(results, [{ ok: false, code: 'fs_permission_denied' }]);
    off();
  });
  await db.clearGames();
});

test('backup: applyMerge + exportar guardam o merge de importadores (integração com model.js)', async () => {
  await db.clearGames();
  await applyMerge(planMerge([], [{ title: 'Celeste', store: 'steam', storeGameId: '504230', playtimeMinutes: 60 }, { title: 'Celeste', store: 'gog' }]));
  const before = byId(await db.getAllGames());
  assert.equal(before.length, 1);
  const blob = await backup.exportBackup();
  await db.clearGames();
  await backup.importBackup(blob, 'replace');
  assert.deepEqual(byId(await db.getAllGames()), before);
  await db.clearGames();
});

test('backup/chave: sem opções a chave Steam nunca entra; o SteamID entra', async () => {
  await db.clearGames();
  await db.setMeta('steamId', '76561198000000001');
  await db.setMeta('steamKey', 'ABCDEF0123456789ABCDEF0123456789');
  const text = await (await backup.exportBackup()).text();
  assert.ok(!text.includes('ABCDEF0123456789') && !text.includes('steamKeyEnc'), 'chave vazou');
  assert.equal(JSON.parse(text).meta.steamId, '76561198000000001');
  assert.equal(await backup.backupHasKey(text), false);
  await db.setMeta('steamId', null); await db.setMeta('steamKey', null);
});

test('backup/chave: cifrada com senha, vai e volta; senha errada não grava nada; sem senha importa sem a chave', async () => {
  const KEY = 'ABCDEF0123456789ABCDEF0123456789';
  await db.clearGames();
  await db.putGames(sample());
  await db.setMeta('steamId', '76561198000000001');
  await db.setMeta('steamKey', KEY);
  const text = await (await backup.exportBackup({ includeKey: true, password: 'senha-forte-123' })).text();
  assert.ok(!text.includes(KEY), 'chave em texto puro no arquivo');
  assert.equal(await backup.backupHasKey(text), true);
  await assert.rejectsCode(() => backup.exportBackup({ includeKey: true, password: '' }), 'bad_request');

  // PC novo: banco vazio, senha errada → nada é gravado
  await db.clearGames(); await db.setMeta('steamId', null); await db.setMeta('steamKey', null);
  await assert.rejectsCode(() => backup.importBackup(text, 'replace', { password: 'errada' }), 'backup_password');
  assert.equal((await db.getAllGames()).length, 0);
  assert.equal(await db.getMeta('steamKey'), null);

  // sem senha: jogos e SteamID voltam, a chave não
  let res = await backup.importBackup(text, 'replace');
  assert.equal(res.steam.key, 'skipped');
  assert.equal(await db.getMeta('steamId'), '76561198000000001');
  assert.equal(await db.getMeta('steamKey'), null);

  // senha certa: chave restaurada
  res = await backup.importBackup(text, 'replace', { password: 'senha-forte-123' });
  assert.deepEqual(res.steam, { id: true, key: 'restored' });
  assert.equal(await db.getMeta('steamKey'), KEY);

  // mesclar não sobrescreve a chave local
  await db.setMeta('steamKey', 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
  res = await backup.importBackup(text, 'merge', { password: 'senha-forte-123' });
  assert.equal(res.steam.key, 'skipped');
  assert.equal(await db.getMeta('steamKey'), 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF');
  await db.clearGames(); await db.setMeta('steamId', null); await db.setMeta('steamKey', null);
});
