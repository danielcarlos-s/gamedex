// Testes do B2: contrato do Worker (6.1, 6.2) com `fetch` da Steam simulado. Rodam em Node e no navegador.
import { test, assert } from '../test-lib.js';
import { handle } from '../../worker/steam-proxy.js';

const KEY = 'FAKEKEY0123456789ABCDEF0123456789';
const SID = '76561190000000000';
const OK = 'https://fulano.github.io';
const env = { STEAM_API_KEY: KEY, STEAM_ID: SID, ALLOWED_ORIGINS: `${OK},http://localhost:8080/` };
const W = 'https://worker.test';

/**
 * Executa `fn` com o fetch global substituído.
 * @param {(url: string) => Response|Promise<Response>} stub
 * @param {() => Promise<void>} fn
 */
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  /** @type {string[]} */ const calls = [];
  globalThis.fetch = /** @type {any} */ ((/** @type {string} */ u) => { calls.push(String(u)); return Promise.resolve(stub(String(u))); });
  try { await fn(); } finally { globalThis.fetch = real; }
  return calls;
}
/**
 * Requisição simulada. Navegadores descartam o cabeçalho `Origin` em `new Request(...)` (forbidden header name),
 * então o teste entrega ao `handle` um objeto com a mesma interface mínima (`method`, `url`, `headers.get`).
 * @param {string} path @param {string} [origin] @param {string} [method]
 * @returns {Request}
 */
const req = (path, origin = OK, method = 'GET') => /** @type {any} */ ({
  method, url: W + path,
  headers: { get: (/** @type {string} */ name) => (name.toLowerCase() === 'origin' && origin ? origin : null) },
});
const jsonRes = (/** @type {unknown} */ b, status = 200) => new Response(JSON.stringify(b), { status });

test('worker: origem não permitida ou ausente → 403 origin_not_allowed, sem CORS e sem chamar a Steam', async () => {
  const calls = await withFetch(() => jsonRes({}), async () => {
    for (const o of ['https://evil.test', '']) {
      const r = await handle(req('/steam/owned', o), env);
      assert.equal(r.status, 403);
      assert.deepEqual(await r.json(), { error: 'origin_not_allowed' });
      assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
    }
    assert.equal((await handle(req('/steam/search?term=a', 'https://evil.test', 'OPTIONS'), env)).status, 403);
  });
  assert.equal(calls.length, 0);
});
test('worker: OPTIONS de origem permitida → 204 com CORS da origem (nunca *); barra final em ALLOWED_ORIGINS é ignorada', async () => {
  for (const o of [OK, 'http://localhost:8080']) {
    const r = await handle(req('/steam/owned', o, 'OPTIONS'), env);
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), o);
    assert.ok(/GET/.test(r.headers.get('Access-Control-Allow-Methods') ?? ''));
  }
});
test('worker: /steam/owned → 200 no formato do contrato, sem steamId nem key na resposta', async () => {
  const calls = await withFetch(() => jsonRes({ response: { game_count: 2, games: [
    { appid: 570, name: 'Dota 2', playtime_forever: 123, rtime_last_played: 1700000000 },
    { appid: 10, name: 'Counter-Strike', playtime_forever: 0, rtime_last_played: 0 },
  ] } }), async () => {
    const r = await handle(req('/steam/owned'), env);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), OK);
    const text = await r.text();
    assert.ok(!text.includes(KEY) && !text.includes(SID), 'vazou key/steamId');
    const b = JSON.parse(text);
    assert.equal(b.count, 2);
    assert.ok(!Number.isNaN(Date.parse(b.fetchedAt)));
    assert.deepEqual(b.games[0], { appid: 570, name: 'Dota 2', playtimeMinutes: 123, lastPlayedAt: '2023-11-14T22:13:20.000Z', coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/570/library_600x900_2x.jpg' });
    assert.equal(b.games[1].lastPlayedAt, null);
    assert.deepEqual(Object.keys(b).sort(), ['count', 'fetchedAt', 'games']);
  });
  assert.ok(calls[0].includes('GetOwnedGames/v1') && calls[0].includes('include_appinfo=1') && calls[0].includes('include_played_free_games=1'));
});
test('worker: /steam/owned com 0 jogos públicos → 200 vazio; perfil privado ({response:{}}) → 409', async () => {
  await withFetch(() => jsonRes({ response: { game_count: 0 } }), async () => {
    const r = await handle(req('/steam/owned'), env);
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).games, []);
  });
  await withFetch(() => jsonRes({ response: {} }), async () => {
    const r = await handle(req('/steam/owned'), env);
    assert.equal(r.status, 409);
    assert.deepEqual(await r.json(), { error: 'profile_private' });
  });
});
test('worker: Steam fora do ar/401/JSON inválido → 502 steam_upstream, key nunca vaza', async () => {
  const cases = [
    () => jsonRes({}, 403),
    () => { throw new TypeError(`falha em https://api.steampowered.com/?key=${KEY}`); },
    () => new Response('<html>', { status: 200 }),
  ];
  for (const c of cases) {
    await withFetch(c, async () => {
      const r = await handle(req('/steam/owned'), env);
      assert.equal(r.status, 502);
      const text = await r.text();
      assert.equal(text, '{"error":"steam_upstream"}');
      assert.ok(!text.includes(KEY));
    });
  }
});
test('worker: sem secrets → 500 misconfigured', async () => {
  const r = await handle(req('/steam/owned'), { ALLOWED_ORIGINS: OK });
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'misconfigured' });
});
test('worker: /steam/search → 200 com até 10 itens no formato do contrato', async () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ type: 'app', id: 292030 + i, name: `Jogo ${i}`, tiny_image: 'x' }));
  const calls = await withFetch(() => jsonRes({ total: 12, items }), async () => {
    const r = await handle(req('/steam/search?term=' + encodeURIComponent('The Witcher 3')), env);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), OK);
    const b = await r.json();
    assert.equal(b.items.length, 10);
    assert.deepEqual(b.items[0], { appid: 292030, name: 'Jogo 0', coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/292030/library_600x900_2x.jpg' });
  });
  assert.ok(calls[0].startsWith('https://store.steampowered.com/api/storesearch/?'));
  assert.ok(calls[0].includes('term=The+Witcher+3') && calls[0].includes('l=english') && calls[0].includes('cc=US'));
  assert.ok(!calls[0].includes(KEY), 'search não usa a key');
});
test('worker: /steam/search termo vazio ou >100 → 400 bad_request; upstream ruim → 502', async () => {
  const calls = await withFetch(() => jsonRes({}, 500), async () => {
    for (const p of ['/steam/search', '/steam/search?term=', '/steam/search?term=%20%20', '/steam/search?term=' + 'a'.repeat(101)]) {
      const r = await handle(req(p), env);
      assert.equal(r.status, 400, p);
      assert.deepEqual(await r.json(), { error: 'bad_request' });
    }
    assert.equal((await handle(req('/steam/search?term=' + 'a'.repeat(100)), env)).status, 502);
  });
  assert.equal(calls.length, 1, 'inválidos não chamam a Steam');
});
test('worker: rota desconhecida e método não-GET → 404 not_found (com CORS)', async () => {
  for (const r of [await handle(req('/outra'), env), await handle(req('/steam/owned', OK, 'POST'), env)]) {
    assert.equal(r.status, 404);
    assert.deepEqual(await r.json(), { error: 'not_found' });
    assert.equal(r.headers.get('Access-Control-Allow-Origin'), OK);
  }
});

const reqH = (path, hdrs) => /** @type {any} */ ({
  method: 'GET', url: W + path,
  headers: { get: (/** @type {string} */ n) => (n.toLowerCase() === 'origin' ? OK : hdrs[n] ?? hdrs[n.toLowerCase()] ?? null) },
});
test('worker: credenciais do usuário (X-Steam-Key/Id) substituem os secrets, sem cache e sem vazar', async () => {
  const UKEY = 'ABCDEF0123456789ABCDEF0123456789';
  const USID = '76561198000000001';
  const calls = await withFetch(() => jsonRes({ response: { game_count: 0, games: [] } }), async () => {
    const r = await handle(reqH('/steam/owned', { 'X-Steam-Key': UKEY, 'X-Steam-Id': USID }), { ALLOWED_ORIGINS: OK });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('Cache-Control'), 'no-store');
    const text = await r.text();
    assert.ok(!text.includes(UKEY) && !text.includes(USID), 'vazou credencial do usuário');
  });
  assert.ok(calls[0].includes('key=' + UKEY) && calls[0].includes('steamid=' + USID));
  assert.ok(!calls[0].includes(KEY));
});
test('worker: credenciais do usuário malformadas ou incompletas → 400 bad_request, sem chamar a Steam', async () => {
  const calls = await withFetch(() => jsonRes({}), async () => {
    for (const h of [{ 'X-Steam-Key': 'curta', 'X-Steam-Id': SID }, { 'X-Steam-Key': KEY }, { 'X-Steam-Id': SID }]) {
      const r = await handle(reqH('/steam/owned', h), env);
      assert.equal(r.status, 400);
      assert.deepEqual(await r.json(), { error: 'bad_request' });
    }
  });
  assert.equal(calls.length, 0);
});
test('worker: preflight permite os cabeçalhos X-Steam-Key e X-Steam-Id', async () => {
  const r = await handle(req('/steam/owned', OK, 'OPTIONS'), env);
  const h = r.headers.get('Access-Control-Allow-Headers') || '';
  assert.ok(h.includes('X-Steam-Key') && h.includes('X-Steam-Id'));
});

test('worker: /sgdb/search sem o secret → 200 configured:false e nenhuma chamada externa', async () => {
  const calls = await withFetch(() => jsonRes({}), async () => {
    const r = await handle(req('/sgdb/search?term=Hades'), env);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { items: [], configured: false });
    assert.equal((await handle(req('/sgdb/search?term='), env)).status, 400);
  });
  assert.equal(calls.length, 0);
});
test('worker: /sgdb/search com o secret → até 3 jogos com a 1ª capa https; chave só no cabeçalho', async () => {
  const KEY2 = 'SGDBSECRET';
  const seen = [];
  const calls = await withFetch((u) => {
    if (u.includes('/search/autocomplete/')) return jsonRes({ success: true, data: [1, 2, 3, 4].map((id) => ({ id, name: `Jogo ${id}` })) });
    const id = Number(u.match(/\/grids\/game\/(\d+)/)[1]);
    return id === 2 ? jsonRes({ data: [] }) : jsonRes({ data: [{ url: `https://cdn2.steamgriddb.com/grid/${id}.png` }] });
  }, async () => {
    const r = await handle(req('/sgdb/search?term=' + encodeURIComponent('Jogo X')), { ...env, STEAMGRIDDB_KEY: KEY2 });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.configured, true);
    assert.deepEqual(b.items.map((i) => i.sgdbId), [1, 3]);
    assert.equal(b.items[0].coverUrl, 'https://cdn2.steamgriddb.com/grid/1.png');
    seen.push(JSON.stringify(b));
  });
  assert.equal(calls.length, 4, '1 busca + 3 grids');
  assert.ok(calls.every((u) => !u.includes(KEY2)) && !seen[0].includes(KEY2));
});

test('worker: /sgdb/search aceita a chave do usuário no cabeçalho X-Sgdb-Key (sem secret), valida o formato e não faz cache público', async () => {
  const MINE = 'abcdef0123456789abcdef0123456789';
  const r0 = (/** @type {string|null} */ k) => /** @type {any} */ ({ method: 'GET', url: W + '/sgdb/search?term=Hades', headers: { get: (/** @type {string} */ n) => n.toLowerCase() === 'origin' ? OK : n.toLowerCase() === 'x-sgdb-key' ? k : null } });
  /** @type {string[]} */ const auth = [];
  const calls = await withFetch(() => jsonRes({ data: [] }), async () => {
    const real = globalThis.fetch;
    globalThis.fetch = /** @type {any} */ ((/** @type {string} */ u, /** @type {any} */ o) => { auth.push(o?.headers?.Authorization); return real(u, o); });
    try {
      const r = await handle(r0(MINE), env);
      assert.equal(r.status, 200);
      assert.equal(r.headers.get('Cache-Control'), 'no-store');
      assert.equal((await r.json()).configured, true);
      assert.equal((await handle(r0('curto'), env)).status, 400);
      assert.equal((await (await handle(r0(null), env)).json()).configured, false, 'sem cabeçalho e sem secret');
    } finally { globalThis.fetch = real; }
  });
  assert.ok(auth.every((a) => a === 'Bearer ' + MINE), 'a chave do usuário vai ao SteamGridDB');
  assert.ok(calls.every((u) => !u.includes(MINE)));
});
