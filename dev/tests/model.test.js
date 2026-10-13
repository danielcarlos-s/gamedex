// Testes do B1: normalizeTitle, createGame, validateGame, regras de merge 1–4. Funções puras: rodam em Node e no navegador.
// A regra 5 (splitOwnership) e applyMerge tocam IndexedDB e ficam em db.test.js.
import { test, assert } from '../test-lib.js';
import { normalizeTitle, createGame, validateGame, planMerge, recalcTotals, isStoreId } from '../../js/data/model.js';

const NOW = '2026-10-12T12:00:00.000Z';
const opts = { now: NOW };

/** @param {object} [p] */
const steamGame = (p = {}) => createGame({
  title: 'Hades', status: 'playing', favorite: true, rating: 5, tags: ['indie'], notes: 'minha nota',
  startedAt: '2025-01-02', links: [{ label: 'wiki', url: 'https://x.test' }], coverUrl: 'https://c.test/manual.jpg', coverManual: true,
  ownerships: [{ store: 'steam', storeGameId: '1145360', source: 'api', playtimeMinutes: 100, lastPlayedAt: '2026-01-01T00:00:00.000Z', importedAt: '2026-01-01T00:00:00.000Z' }],
  ...p,
});

test('normalizeTitle: acento, caixa e pontuação', () => {
  assert.equal(normalizeTitle('Pokémon: Edição Ouro!'), 'pokemon edicao ouro');
  assert.equal(normalizeTitle('  Half-Life 2  '), 'half life 2');
  assert.equal(normalizeTitle("Marvel's Spider-Man"), 'marvels spider man');
  assert.equal(normalizeTitle('Tom & Jerry'), 'tom and jerry');
});
test('normalizeTitle: remove ™ ® ©', () => {
  assert.equal(normalizeTitle('Assassin’s Creed® Odyssey™'), 'assassins creed odyssey');
  assert.equal(normalizeTitle('Game©'), 'game');
});
test('normalizeTitle: sufixos de edição', () => {
  const k = 'the witcher 3 wild hunt';
  assert.equal(normalizeTitle('The Witcher 3: Wild Hunt – Game of the Year Edition'), k);
  assert.equal(normalizeTitle('The Witcher 3: Wild Hunt GOTY Edition'), k);
  assert.equal(normalizeTitle('The Witcher 3: Wild Hunt'), k);
  assert.equal(normalizeTitle('Rayman Legends Definitive Edition'), 'rayman legends');
  assert.equal(normalizeTitle('Doom Eternal Deluxe Edition'), 'doom eternal');
  assert.equal(normalizeTitle('Fallout 4 GOTY'), 'fallout 4');
  assert.equal(normalizeTitle('Anno 1800 Complete Edition'), 'anno 1800');
  assert.equal(normalizeTitle('Ultimate Chicken Horse'), 'ultimate chicken horse', 'só remove no fim');
});
test('normalizeTitle: "Remastered" é preservado (outro jogo)', () => {
  assert.equal(normalizeTitle('Resident Evil 4 Remastered'), 'resident evil 4 remastered');
  assert.ok(normalizeTitle('Dark Souls Remastered') !== normalizeTitle('Dark Souls'));
  assert.equal(normalizeTitle('Dark Souls: Remastered Edition'), 'dark souls remastered');
});
test('normalizeTitle: entradas degeneradas', () => {
  assert.equal(normalizeTitle(''), '');
  assert.equal(normalizeTitle('™'), '');
  assert.equal(normalizeTitle(/** @type {any} */ (null)), '');
  assert.equal(normalizeTitle('Edition'), 'edition', 'não esvazia o título');
});

test('createGame: padrões, titleKey e totais', () => {
  const g = createGame({ title: ' Café™ ', ownerships: [
    { store: 'steam', playtimeMinutes: 60, lastPlayedAt: '2026-02-01T00:00:00.000Z' },
    { store: 'gog', playtimeMinutes: 30, lastPlayedAt: '2026-05-01T00:00:00.000Z' },
  ] });
  assert.equal(g.title, 'Café™');
  assert.equal(g.titleKey, 'cafe');
  assert.equal(g.status, 'backlog');
  assert.equal(g.playtimeMinutes, 90);
  assert.equal(g.lastPlayedAt, '2026-05-01T00:00:00.000Z');
  assert.ok(typeof g.id === 'string' && g.id.length > 8);
  assert.equal(g.coverManual, false);
  assert.equal(g.rating, null);
});
test('recalcTotals: ownership sem tempo conta 0', () => {
  const g = createGame({ title: 'A', ownerships: [{ store: 'epic' }, { store: 'gog', playtimeMinutes: 5 }] });
  recalcTotals(g);
  assert.equal(g.playtimeMinutes, 5);
  assert.equal(g.lastPlayedAt, null);
});

test('validateGame: jogo válido', () => {
  assert.deepEqual(validateGame(steamGame()), { ok: true, errors: [] });
});
test('validateGame: códigos de erro', () => {
  const g = createGame({ title: '  ', ownerships: [] });
  g.rating = 6;
  const r = validateGame(g);
  assert.equal(r.ok, false);
  const codes = r.errors.map((e) => `${e.field}:${e.code}`);
  assert.ok(codes.includes('title:title_required'), codes.join());
  assert.ok(codes.includes('rating:rating_range'), codes.join());
  assert.ok(codes.includes('ownerships:csv_missing_store'), codes.join());
});
test('validateGame: rating não inteiro, loja e status inválidos, números negativos', () => {
  const g = steamGame();
  g.rating = 2.5; g.status = /** @type {any} */ ('x'); g.ownerships[0].store = /** @type {any} */ ('nope'); g.year = -1;
  const codes = validateGame(g).errors.map((e) => e.code).sort();
  assert.deepEqual(codes, ['csv_invalid_number', 'csv_invalid_status', 'csv_invalid_store', 'rating_range']);
});
test('validateGame: rating 0, 5 e null são válidos', () => {
  for (const r of [0, 5, null]) { const g = steamGame(); g.rating = r; assert.ok(validateGame(g).ok, String(r)); }
});

test('merge regra 3: sem match → Game novo, status do dado ou backlog', () => {
  const p = planMerge([], [
    { title: 'Celeste', store: 'steam', storeGameId: 504230, playtimeMinutes: 10, status: 'finished' },
    { title: 'Inside', store: 'gog' },
  ], opts);
  assert.equal(p.toCreate.length, 2);
  assert.equal(p.toCreate[0].status, 'finished');
  assert.equal(p.toCreate[1].status, 'backlog');
  assert.equal(p.toCreate[0].ownerships[0].storeGameId, '504230');
  assert.equal(p.toCreate[0].coverAppId, 504230, 'appid Steam vira coverAppId');
  assert.deepEqual(p.counts, { new: 2, updated: 0, merged: 0, invalid: 0 });
});
test('merge regra 1: mesma loja + storeGameId atualiza ownership e preserva campos pessoais', () => {
  const g = steamGame();
  const before = structuredClone(g);
  const p = planMerge([g], [{
    title: 'HADES (renomeado)', store: 'steam', storeGameId: '1145360', playtimeMinutes: 250,
    lastPlayedAt: '2026-09-01T00:00:00.000Z', achievementsDone: 12, achievementsTotal: 49, coverUrl: 'https://c.test/auto.jpg',
    status: 'dropped', rating: 1, tags: ['x'], notes: 'sobrescrever?',
  }], opts);
  assert.deepEqual(g, before, 'não muta a entrada');
  assert.equal(p.toCreate.length, 0);
  assert.equal(p.toUpdate.length, 1);
  assert.deepEqual(p.counts, { new: 0, updated: 1, merged: 0, invalid: 0 });
  const a = p.toUpdate[0].after;
  assert.equal(a.id, g.id);
  assert.equal(a.ownerships[0].playtimeMinutes, 250);
  assert.equal(a.ownerships[0].lastPlayedAt, '2026-09-01T00:00:00.000Z');
  assert.equal(a.playtimeMinutes, 250);
  assert.equal(a.achievementsDone, 12);
  assert.equal(a.achievementsTotal, 49);
  // pessoais intactos
  assert.equal(a.status, 'playing'); assert.equal(a.favorite, true); assert.equal(a.rating, 5);
  assert.deepEqual(a.tags, ['indie']); assert.equal(a.notes, 'minha nota'); assert.equal(a.startedAt, '2025-01-02');
  assert.deepEqual(a.links, g.links);
  assert.equal(a.coverUrl, 'https://c.test/manual.jpg'); assert.equal(a.title, 'Hades');
  assert.equal(a.updatedAt, NOW);
});
test('merge regra 1: reimportar dado idêntico não gera toUpdate', () => {
  const g = steamGame();
  const p = planMerge([g], [{ title: 'Hades', store: 'steam', storeGameId: '1145360', playtimeMinutes: 100, lastPlayedAt: '2026-01-01T00:00:00.000Z' }], opts);
  assert.equal(p.toUpdate.length, 0);
  assert.equal(p.counts.updated, 1);
});
test('merge regra 1: dado ausente na linha não zera o que existe', () => {
  const g = steamGame();
  const p = planMerge([g], [{ title: 'Hades', store: 'steam', storeGameId: '1145360' }], opts);
  assert.equal(p.toUpdate.length, 0);
});
test('merge regra 2: mesmo titleKey de outra loja → 2ª ownership no mesmo Game', () => {
  const g = steamGame();
  const p = planMerge([g], [{ title: 'Hades™ GOTY Edition', store: 'gog', playtimeMinutes: 30 }], opts);
  assert.equal(p.toCreate.length, 0);
  assert.equal(p.toUpdate.length, 1);
  assert.equal(p.mergedCount, 1);
  assert.deepEqual(p.counts, { new: 0, updated: 0, merged: 1, invalid: 0 });
  const a = p.toUpdate[0].after;
  assert.deepEqual(a.ownerships.map((o) => o.store), ['steam', 'gog']);
  assert.equal(a.playtimeMinutes, 130);
  assert.equal(a.status, 'playing');
});
test('merge regra 2: ownership da mesma loja sem storeGameId é atualizada (CSV reimportado é idempotente)', () => {
  const g = createGame({ title: 'Inside', ownerships: [{ store: 'gog', source: 'csv', playtimeMinutes: 10, importedAt: '2026-01-01T00:00:00.000Z' }] });
  const p = planMerge([g], [{ title: 'Inside', store: 'gog', playtimeMinutes: 99, storeGameId: 'abc' }], opts);
  assert.equal(p.toUpdate[0].after.ownerships.length, 1);
  assert.equal(p.toUpdate[0].after.ownerships[0].playtimeMinutes, 99);
  assert.equal(p.toUpdate[0].after.ownerships[0].storeGameId, 'abc');
  assert.deepEqual(p.counts, { new: 0, updated: 1, merged: 0, invalid: 0 });
  // e depois o id vira a chave da regra 1
  const p2 = planMerge([p.toUpdate[0].after], [{ title: 'Outro nome', store: 'gog', storeGameId: 'abc', playtimeMinutes: 5 }], opts);
  assert.equal(p2.toUpdate[0].after.ownerships[0].playtimeMinutes, 5);
  assert.equal(p2.toCreate.length, 0);
});
test('merge regra 2: mesma loja, outro storeGameId e mesmo título → posse adicional (não sobrescreve)', () => {
  const g = steamGame();
  const p = planMerge([g], [{ title: 'Hades', store: 'steam', storeGameId: '999', playtimeMinutes: 1 }], opts);
  assert.equal(p.toUpdate[0].after.ownerships.length, 2);
  assert.equal(p.counts.merged, 1);
});
test('merge: linhas do mesmo lote se enxergam (steam + gog do mesmo jogo = 1 Game)', () => {
  const p = planMerge([], [
    { title: 'Celeste', store: 'steam', storeGameId: '504230', playtimeMinutes: 60 },
    { title: 'CELESTE', store: 'gog', playtimeMinutes: 5 },
    { title: 'Inside', store: 'gog' },
  ], opts);
  assert.equal(p.toCreate.length, 2);
  assert.equal(p.toCreate[0].ownerships.length, 2);
  assert.equal(p.toCreate[0].playtimeMinutes, 65);
  assert.deepEqual(p.counts, { new: 2, updated: 0, merged: 1, invalid: 0 });
});
test('merge: jogo existente com remastered NÃO casa com o original', () => {
  const g = createGame({ title: 'Dark Souls', ownerships: [{ store: 'steam', storeGameId: '1' }] });
  const p = planMerge([g], [{ title: 'Dark Souls Remastered', store: 'gog' }], opts);
  assert.equal(p.toCreate.length, 1);
  assert.equal(p.toUpdate.length, 0);
});
test('merge: metadados só preenchem vazios; capa manual é respeitada', () => {
  const g = steamGame({ developer: null, year: 2020, genres: [] });
  const p = planMerge([g], [{ title: 'Hades', store: 'epic', developer: 'Supergiant', year: 1999, genres: ['Roguelike'], coverUrl: 'https://c.test/new.jpg', coverAppId: 1 }], opts);
  const a = p.toUpdate[0].after;
  assert.equal(a.developer, 'Supergiant');
  assert.equal(a.year, 2020);
  assert.deepEqual(a.genres, ['Roguelike']);
  assert.equal(a.coverUrl, 'https://c.test/manual.jpg');
  assert.equal(a.coverAppId, null);
});
test('merge regra 4: linhas inválidas vão para errors com a linha, nada é planejado', () => {
  const p = planMerge([], [
    { title: '', store: 'steam' },
    { title: 'A', store: /** @type {any} */ ('') },
    { title: 'B', store: /** @type {any} */ ('xbox') },
    { title: 'C', store: 'gog', status: /** @type {any} */ ('x') },
    { title: 'D', store: 'gog', rating: 9 },
    { title: 'E', store: 'gog', playtimeMinutes: -5 },
    { title: 'Ok', store: 'gog' },
    { title: '™', store: 'gog' },
  ], opts);
  assert.deepEqual(p.errors, [
    { row: 1, code: 'title_required' }, { row: 2, code: 'csv_missing_store' }, { row: 3, code: 'csv_invalid_store' },
    { row: 4, code: 'csv_invalid_status' }, { row: 5, code: 'rating_range' }, { row: 6, code: 'csv_invalid_number' },
    { row: 8, code: 'title_required' },
  ]);
  assert.equal(p.toCreate.length, 1);
  assert.deepEqual(p.counts, { new: 1, updated: 0, merged: 0, invalid: 7 });
});
test('merge: usa `row` da linha quando presente', () => {
  const p = planMerge([], [{ title: '', store: 'gog', row: 42 }], opts);
  assert.deepEqual(p.errors, [{ row: 42, code: 'title_required' }]);
});
test('merge: source da linha > options.source > csv', () => {
  const p = planMerge([], [
    { title: 'A', store: 'steam', storeGameId: '1', source: 'api' },
    { title: 'B', store: 'gog' },
  ], opts);
  assert.equal(p.toCreate[0].ownerships[0].source, 'api');
  assert.equal(p.toCreate[1].ownerships[0].source, 'csv');
  assert.equal(planMerge([], [{ title: 'B', store: 'gog' }], { ...opts, source: 'backup' }).toCreate[0].ownerships[0].source, 'backup');
});

test('model: isStoreId aceita as fixas e o formato de loja criada; recusa o resto', () => {
  for (const ok of ['steam', 'other', 'c-abcd1234', 'c-0a1b2c3d']) assert.ok(isStoreId(ok), ok);
  for (const bad of ['', 'xbox', 'c-abc', 'c-ABCD1234', 'c-abcd12345', null, undefined, 5]) assert.ok(!isStoreId(bad), String(bad));
  assert.equal(validateGame(createGame({ title: 'X', ownerships: [{ store: 'c-abcd1234' }] })).ok, true);
  assert.equal(validateGame(createGame({ title: 'X', ownerships: [{ store: 'xbox' }] })).ok, false);
});
