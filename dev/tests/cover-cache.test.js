// Capas salvas no navegador (cover-cache.js): download simulado, fila, limpeza de capas sem uso. Precisa de `indexedDB`.
import { test, assert } from '../test-lib.js';
import * as db from '../../js/data/db.js';
import { saveCover, queueSaveCovers, pendingCovers, localCover, clearSavedCovers, preloadCovers } from '../../js/data/cover-cache.js';

globalThis.URL.createObjectURL ??= () => 'blob:fake';
globalThis.URL.revokeObjectURL ??= () => {};

const img = (n = 10) => new Blob([new Uint8Array(n)], { type: 'image/jpeg' });
const fetchOk = async () => ({ ok: true, blob: async () => img() });
const noShrink = async (b) => b;
const deps = { fetchImpl: fetchOk, shrink: noShrink };

test('capas salvas: baixa, guarda no banco e passa a servir a cópia local', async () => {
  await clearSavedCovers();
  const url = 'https://exemplo.test/a.jpg';
  assert.equal(localCover(url), url);
  assert.equal(await saveCover(url, deps), true);
  assert.ok(localCover(url) !== url);
  assert.equal((await db.getAllCovers()).length, 1);
});

test('capas salvas: falha de rede, 404 ou resposta que não é imagem não gravam nada', async () => {
  await clearSavedCovers();
  assert.equal(await saveCover('https://x.test/1', { fetchImpl: async () => { throw new TypeError('cors'); }, shrink: noShrink }), false);
  assert.equal(await saveCover('https://x.test/2', { fetchImpl: async () => ({ ok: false }), shrink: noShrink }), false);
  assert.equal(await saveCover('https://x.test/3', { fetchImpl: async () => ({ ok: true, blob: async () => new Blob(['<html>'], { type: 'text/html' }) }), shrink: noShrink }), false);
  assert.equal((await db.getAllCovers()).length, 0);
});

test('capas salvas: fila salva só o que falta, conta falhas e descarta capas sem uso', async () => {
  await clearSavedCovers();
  await preloadCovers();
  await saveCover('https://x.test/velha.jpg', deps);
  const games = [{ coverUrl: 'https://x.test/1.jpg' }, { coverUrl: 'https://x.test/1.jpg' }, { coverUrl: 'https://x.test/2.jpg' }, { coverUrl: 'https://x.test/ruim.jpg' }, { coverUrl: null }, { coverUrl: 'data:image/png;base64,AAAA' }];
  assert.equal(pendingCovers(games).length, 3);
  const seen = [];
  const res = await queueSaveCovers(games, {
    onProgress: (p) => seen.push(p.done),
    deps: { fetchImpl: async (u) => (u.includes('ruim') ? { ok: false } : { ok: true, blob: async () => img() }), shrink: noShrink },
  });
  assert.deepEqual({ saved: res.saved, failed: res.failed, cancelled: res.cancelled }, { saved: 2, failed: 1, cancelled: false });
  assert.equal(seen.length, 3);
  const urls = (await db.getAllCovers()).map((c) => c.url).sort();
  assert.deepEqual(urls, ['https://x.test/1.jpg', 'https://x.test/2.jpg']); // a "velha" foi descartada
});

test('capas salvas: cancelar para a fila', async () => {
  await clearSavedCovers();
  const ac = new AbortController();
  ac.abort();
  const res = await queueSaveCovers([{ coverUrl: 'https://x.test/9.jpg' }], { signal: ac.signal, deps });
  assert.equal(res.cancelled, true);
  assert.equal(res.saved, 0);
});

test('capas salvas: banco v2 mantém jogos e meta (clearGames não apaga capas)', async () => {
  await clearSavedCovers();
  await saveCover('https://x.test/k.jpg', deps);
  await db.clearGames();
  assert.equal((await db.getAllCovers()).length, 1);
  await clearSavedCovers();
  assert.equal((await db.getAllCovers()).length, 0);
});
