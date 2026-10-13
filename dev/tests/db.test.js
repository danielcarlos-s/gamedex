// Testes do B1 que tocam IndexedDB: db.js, applyMerge e splitOwnership (regra 5). Precisam de `indexedDB`.
import { test, assert } from '../test-lib.js';
import * as db from '../../js/data/db.js';
import { createGame, planMerge, applyMerge, splitOwnership } from '../../js/data/model.js';

/** @param {string} title @param {string[]} stores */
const mk = (title, stores) => createGame({ title, ownerships: stores.map((s, i) => ({ store: /** @type {any} */ (s), storeGameId: `${s}${i}`, playtimeMinutes: 10 * (i + 1), lastPlayedAt: `2026-0${i + 1}-01T00:00:00.000Z` })) });

test('db: put/get/getAll/delete/clear', async () => {
  await db.clearGames();
  const a = mk('A', ['steam']); const b = mk('B', ['gog']);
  await db.putGame(a);
  await db.putGames([b]);
  assert.deepEqual(await db.getGame(a.id), a);
  assert.equal((await db.getAllGames()).length, 2);
  assert.equal(await db.getGame('nao-existe'), null);
  await db.deleteGame(a.id);
  assert.equal(await db.getGame(a.id), null);
  await db.putGames([]);
  await db.clearGames();
  assert.equal((await db.getAllGames()).length, 0);
});
test('db: meta key/value e clearGames preserva meta', async () => {
  assert.equal(await db.getMeta('nada'), null);
  await db.setMeta('lastSteamSync', '2026-10-12T00:00:00.000Z');
  await db.clearGames();
  assert.equal(await db.getMeta('lastSteamSync'), '2026-10-12T00:00:00.000Z');
});
test('db: onChange dispara após escritas, cancela e isola ouvinte com erro', async () => {
  /** @type {any[]} */ const seen = [];
  const off = db.onChange((e) => seen.push(e));
  const offBad = db.onChange(() => { throw new Error('boom'); });
  const g = mk('C', ['epic']);
  const origError = console.error; console.error = () => {};
  try {
    await db.putGame(g); await db.deleteGame(g.id); await db.clearGames(); await db.setMeta('k', 1);
  } finally { console.error = origError; }
  assert.deepEqual(seen.map((e) => e.type), ['games', 'games', 'games', 'meta']);
  assert.deepEqual(seen.map((e) => e.op), ['put', 'delete', 'clear', undefined]);
  assert.deepEqual(seen[0].ids, [g.id]);
  assert.equal(seen[3].key, 'k');
  off(); offBad();
  await db.putGame(g);
  assert.equal(seen.length, 4);
  await db.clearGames();
});
test('db: replaceGames troca tudo numa transação e avisa com op replace', async () => {
  await db.clearGames();
  await db.putGames([mk('Velho1', ['steam']), mk('Velho2', ['gog'])]);
  /** @type {any[]} */ const seen = [];
  const off = db.onChange((e) => seen.push(e));
  const novo = mk('Novo', ['epic']);
  await db.replaceGames([novo]);
  off();
  assert.deepEqual((await db.getAllGames()).map((g) => g.id), [novo.id]);
  assert.deepEqual(seen.map((e) => [e.type, e.op]), [['games', 'replace']]);
  await db.clearGames();
});
test('db: leitura devolve cópia (mutar o retorno não altera o banco)', async () => {
  const a = mk('D', ['steam']);
  await db.putGame(a);
  const read = /** @type {any} */ (await db.getGame(a.id));
  read.title = 'mutado';
  assert.equal((/** @type {any} */ (await db.getGame(a.id))).title, 'D');
  await db.clearGames();
});
test('applyMerge: grava toCreate + toUpdate em lote; planMerge não grava', async () => {
  await db.clearGames();
  const existing = mk('Hades', ['steam']);
  await db.putGame(existing);
  const plan = planMerge(await db.getAllGames(), [
    { title: 'Hades', store: 'gog', playtimeMinutes: 5 },
    { title: 'Celeste', store: 'gog' },
    { title: '', store: 'gog' },
  ]);
  assert.equal((await db.getAllGames()).length, 1, 'planMerge não grava');
  const res = await applyMerge(plan);
  assert.deepEqual(res, { created: 1, updated: 1 });
  const all = await db.getAllGames();
  assert.equal(all.length, 2);
  assert.equal(all.find((g) => g.id === existing.id)?.ownerships.length, 2);
  await db.clearGames();
});
test('regra 5: splitOwnership move a loja para um Game novo e recalcula totais', async () => {
  await db.clearGames();
  const g = createGame({ title: 'Doom', status: 'finished', rating: 4, notes: 'n', tags: ['fps'], ownerships: [
    { store: 'steam', storeGameId: '1', playtimeMinutes: 60, lastPlayedAt: '2026-03-01T00:00:00.000Z' },
    { store: 'gog', playtimeMinutes: 30, lastPlayedAt: '2026-01-01T00:00:00.000Z' },
  ] });
  await db.putGame(g);
  const created = await splitOwnership(g.id, 'gog');
  assert.ok(created.id !== g.id);
  assert.deepEqual(created.ownerships.map((o) => o.store), ['gog']);
  assert.equal(created.status, 'backlog');
  assert.equal(created.rating, null);
  assert.equal(created.playtimeMinutes, 30);
  const orig = /** @type {any} */ (await db.getGame(g.id));
  assert.deepEqual(orig.ownerships.map((/** @type {any} */ o) => o.store), ['steam']);
  assert.equal(orig.playtimeMinutes, 60);
  assert.equal(orig.status, 'finished');
  assert.deepEqual(await db.getGame(created.id), created);
  await db.clearGames();
});
test('regra 5: splitOwnership erros', async () => {
  await db.clearGames();
  const g = mk('Solo', ['steam']);
  await db.putGame(g);
  await assert.rejectsCode(() => splitOwnership(g.id, 'steam'), 'bad_request');
  await assert.rejectsCode(() => splitOwnership(g.id, 'gog'), 'not_found');
  await assert.rejectsCode(() => splitOwnership('nope', 'steam'), 'not_found');
  await db.clearGames();
});
