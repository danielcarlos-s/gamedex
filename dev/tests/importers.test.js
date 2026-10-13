// Testes do B3: csv.js, steam.js, covers.js e o cruzamento dos fixtures reais (dev/fixtures/, fora do git).
// Os testes com fixtures se declaram "pulados" no relatório quando os arquivos não existem (ex.: clone público).
import { test, assert } from '../test-lib.js';
import { parseCsv, templateCsv, serializeCsv, CSV_COLUMNS } from '../../js/importers/csv.js';
import { parseSteamCache, fetchOwned } from '../../js/importers/steam.js';
import { searchCover, queueCovers, refineCoverItems } from '../../js/importers/covers.js';
import { planMerge, createGame } from '../../js/data/model.js';

/** @type {string[]} */
const report = (globalThis.__testReport ??= []);

/**
 * Lê um arquivo de dev/fixtures (Node: fs; navegador: fetch). Devolve null se não existir.
 * @param {string} name
 * @returns {Promise<string|null>}
 */
async function fixture(name) {
  const rel = `../fixtures/${name}`;
  try {
    if (typeof process !== 'undefined' && process.versions?.node) {
      const { readFile } = await import(/* @vite-ignore */ 'node:fs/promises');
      return await readFile(new URL(rel, import.meta.url), 'utf8');
    }
    const res = await fetch(new URL(rel, import.meta.url));
    return res.ok ? await res.text() : null;
  } catch {
    return null;
  }
}

/**
 * Executa `fn` com o fetch global substituído.
 * @param {(url: string) => Response|Promise<Response>} stub
 * @param {() => Promise<void>} fn
 * @returns {Promise<string[]>} URLs chamadas
 */
async function withFetch(stub, fn) {
  const real = globalThis.fetch;
  /** @type {string[]} */ const calls = [];
  globalThis.fetch = /** @type {any} */ ((/** @type {string} */ u) => { calls.push(String(u)); return Promise.resolve(stub(String(u))); });
  try { await fn(); } finally { globalThis.fetch = real; }
  return calls;
}
const jsonRes = (/** @type {unknown} */ b, status = 200) => new Response(JSON.stringify(b), { status });

// ---------- CSV ----------
test('csv: cabeçalho canônico, listas com |, números e campos opcionais', () => {
  const { rows, errors } = parseCsv('title,store,storeGameId,status,playtimeMinutes,tags,genres,rating,developer,year,notes,coverUrl\n' +
    'Hades,Steam,1145360,playing,120,indie|roguelike,Action|Indie,5,Supergiant,2020,ótimo,https://x.test/c.jpg\nInside,gog,,,,,,,,,,\n');
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { title: 'Hades', store: 'steam', source: 'csv', row: 2, storeGameId: '1145360', status: 'playing', playtimeMinutes: 120,
    tags: ['indie', 'roguelike'], genres: ['Action', 'Indie'], rating: 5, developer: 'Supergiant', year: 2020, notes: 'ótimo', coverUrl: 'https://x.test/c.jpg' });
  assert.deepEqual(rows[1], { title: 'Inside', store: 'gog', source: 'csv', row: 3 });
});
test('csv: separador ; + BOM + CRLF + cabeçalho PT + valores PT', () => {
  const text = '﻿titulo;loja;status;minutosJogados;generos;nota;ano\r\nJogo A;Ubisoft Connect;Zerado;90;RPG|Aventura;4;2019\r\nJogo B;EA app;Jogando;;;;\r\nJogo C;Epic Games;ABANDONADO;;;;\r\n';
  const { rows, errors } = parseCsv(text);
  assert.deepEqual(errors, []);
  assert.deepEqual(rows.map((r) => [r.store, r.status]), [['ubisoft', 'finished'], ['ea', 'playing'], ['epic', 'dropped']]);
  assert.equal(rows[0].playtimeMinutes, 90);
  assert.equal(rows[0].rating, 4);
  assert.deepEqual(rows[0].genres, ['RPG', 'Aventura']);
});
test('csv: aspas, vírgula/aspas/quebra de linha dentro de campo, linhas em branco e número de linha físico', () => {
  const text = 'title,store,notes\n"Hades, o jogo",steam,"disse ""uau""\nsegunda linha"\n\n,,\nFinal,gog,x\n';
  const { rows, errors } = parseCsv(text);
  assert.deepEqual(errors, []);
  assert.equal(rows[0].title, 'Hades, o jogo');
  assert.equal(rows[0].notes, 'disse "uau"\nsegunda linha');
  assert.equal(rows[0].row, 2);
  assert.equal(rows[1].row, 6, 'a linha física conta a quebra dentro das aspas e as linhas em branco');
});
test('csv: separador ; dentro de aspas não confunde a detecção', () => {
  const { rows } = parseCsv('title,store,notes\nA,gog,"x;y;z;w"\n');
  assert.equal(rows[0].notes, 'x;y;z;w');
});
test('csv: erros por linha com os códigos da seção 6.4', () => {
  const { rows, errors } = parseCsv([
    'title,store,status,playtimeMinutes,rating,year',
    ',gog,,,,',          // 2 sem título
    'A,,,,,',            // 3 sem loja
    'B,xbox,,,,',        // 4 loja inválida
    'C,gog,quase,,,',    // 5 status inválido
    'D,gog,,abc,,',      // 6 número inválido
    'E,gog,,,6,',        // 7 nota inválida
    'F,gog,,,2.5,',      // 8 nota inválida
    'G,gog,,,,19x',      // 9 ano inválido
    'Ok,gog,,,,',        // 10
  ].join('\n'));
  assert.deepEqual(errors, [
    { row: 2, code: 'csv_missing_title' }, { row: 3, code: 'csv_missing_store' }, { row: 4, code: 'csv_invalid_store' },
    { row: 5, code: 'csv_invalid_status' }, { row: 6, code: 'csv_invalid_number' }, { row: 7, code: 'csv_invalid_rating' },
    { row: 8, code: 'csv_invalid_rating' }, { row: 9, code: 'csv_invalid_number' },
  ]);
  assert.deepEqual(rows.map((r) => r.title), ['Ok']);
});
test('csv: arquivo vazio, só cabeçalho, coluna obrigatória ausente', () => {
  assert.deepEqual(parseCsv('').errors, [{ row: 0, code: 'csv_empty' }]);
  assert.deepEqual(parseCsv('﻿  \n\n').errors, [{ row: 0, code: 'csv_empty' }]);
  assert.deepEqual(parseCsv('title,store\n').errors, [{ row: 0, code: 'csv_empty' }]);
  assert.deepEqual(parseCsv('title,store\n,,\n').errors, [{ row: 0, code: 'csv_empty' }]);
  assert.deepEqual(parseCsv('nome,preco\nA,1\n').errors, [{ row: 1, code: 'csv_missing_store' }]);
  assert.deepEqual(parseCsv('loja,x\nsteam,1\n').errors, [{ row: 1, code: 'csv_missing_title' }]);
});
test('csv: aceita cabeçalho com maiúsculas, acento e espaços; último campo sem quebra final', () => {
  const { rows, errors } = parseCsv('Título, Loja ,Minutos Jogados\nA,GOG,15');
  assert.deepEqual(errors, []);
  assert.equal(rows[0].playtimeMinutes, 15);
});
test('csv: templateCsv en/pt são lidos sem erro e as linhas são fictícias', () => {
  for (const lang of /** @type {const} */ (['en', 'pt'])) {
    const text = templateCsv(lang);
    assert.ok(text.startsWith('﻿'));
    const { rows, errors } = parseCsv(text);
    assert.deepEqual(errors, [], lang);
    assert.equal(rows.length, 3, lang);
    assert.deepEqual(rows.map((r) => r.store), ['epic', 'gog', 'ubisoft'], lang);
  }
  assert.ok(templateCsv('pt').includes('titulo;loja'));
  assert.ok(templateCsv('en').includes(CSV_COLUMNS.join(',')));
});
test('csv: serializeCsv → parseCsv é ida e volta (aspas, separador, quebra)', () => {
  const text = serializeCsv([['title', 'store', 'notes'], ['A "x", y', 'gog', 'l1\nl2']]);
  const { rows, errors } = parseCsv(text);
  assert.deepEqual(errors, []);
  assert.equal(rows[0].title, 'A "x", y');
  assert.equal(rows[0].notes, 'l1\nl2');
});

// ---------- Steam ----------
test('steam: parseSteamCache converte tempo, último jogo e conquistas (só quando vierem)', () => {
  const rows = parseSteamCache({ steam_cache: { games: [
    { appid: 570, name: 'Dota 2', playtime_forever: 100, rtime_last_played: 1700000000, _achiev_done: 3, _achiev_total: 10 },
    { appid: 10, name: 'CS', playtime_forever: 0, rtime_last_played: 0 },
  ] } });
  assert.deepEqual(rows[0], { title: 'Dota 2', store: 'steam', storeGameId: '570', playtimeMinutes: 100, lastPlayedAt: '2023-11-14T22:13:20.000Z',
    coverUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/570/library_600x900_2x.jpg', coverAppId: 570, source: 'backup', row: 1,
    achievementsDone: 3, achievementsTotal: 10 });
  assert.equal(rows[1].lastPlayedAt, null);
  assert.equal('achievementsDone' in rows[1], false);
});
test('steam: parseSteamCache aceita texto JSON e rejeita formato desconhecido com backup_invalid', async () => {
  assert.equal(parseSteamCache('{"games":[{"appid":1,"name":"A"}]}').length, 1);
  for (const bad of ['{', '{}', '[]', '{"steam_cache":{}}', 'null']) {
    try { parseSteamCache(bad); } catch (e) { assert.equal(/** @type {any} */ (e).code, 'backup_invalid', bad); continue; }
    throw new Error('devia lançar: ' + bad);
  }
});
test('steam: fetchOwned converte a resposta do Worker em IncomingGame', async () => {
  const calls = await withFetch(() => jsonRes({ count: 1, fetchedAt: 'x', games: [
    { appid: 570, name: 'Dota 2', playtimeMinutes: 5, lastPlayedAt: '2024-01-01T00:00:00.000Z', coverUrl: 'https://c.test/570.jpg' },
  ] }), async () => {
    const rows = await fetchOwned('https://w.test/');
    assert.deepEqual(rows, [{ title: 'Dota 2', store: 'steam', storeGameId: '570', playtimeMinutes: 5, lastPlayedAt: '2024-01-01T00:00:00.000Z',
      coverUrl: 'https://c.test/570.jpg', coverAppId: 570, source: 'api', row: 1 }]);
  });
  assert.deepEqual(calls, ['https://w.test/steam/owned']);
});
test('steam: fetchOwned traduz erros em { code }', async () => {
  await withFetch(() => jsonRes({ error: 'profile_private' }, 409), () => assert.rejectsCode(() => fetchOwned('https://w.test'), 'profile_private'));
  await withFetch(() => jsonRes({ error: 'origin_not_allowed' }, 403), () => assert.rejectsCode(() => fetchOwned('https://w.test'), 'origin_not_allowed'));
  await withFetch(() => jsonRes({ error: 'inventado' }, 500), () => assert.rejectsCode(() => fetchOwned('https://w.test'), 'steam_upstream'));
  await withFetch(() => new Response('<html>', { status: 200 }), () => assert.rejectsCode(() => fetchOwned('https://w.test'), 'steam_upstream'));
  await withFetch(() => { throw new TypeError('Failed to fetch'); }, () => assert.rejectsCode(() => fetchOwned('https://w.test'), 'network'));
  await assert.rejectsCode(() => fetchOwned(''), 'bad_request');
  await assert.rejectsCode(() => fetchOwned('javascript:alert(1)'), 'bad_request');
});

// ---------- Capas ----------
const item = (/** @type {number} */ appid, /** @type {string} */ name) => ({ appid, name, coverUrl: `https://c.test/${appid}.jpg` });
const mk = (/** @type {string} */ title, /** @type {object} */ extra = {}) => createGame({ title, ownerships: [{ store: 'gog' }], ...extra });

test('covers: searchCover chama /steam/search, corta o termo em 100 e traduz erros', async () => {
  const calls = await withFetch(() => jsonRes({ items: [item(1, 'A')] }), async () => {
    const r = await searchCover('A'.repeat(150) + '  ', 'https://w.test', undefined);
    assert.equal(r.length, 1);
  });
  assert.equal(new URL(calls[0]).searchParams.get('term'), 'A'.repeat(100));
  await withFetch(() => jsonRes({ error: 'steam_upstream' }, 502), () => assert.rejectsCode(() => searchCover('x', 'https://w.test'), 'steam_upstream'));
  await assert.rejectsCode(() => searchCover('  ', 'https://w.test'), 'bad_request');
});
test('covers: título igual aceita sozinho; diferente chama onAmbiguous; coverManual nunca é tocado', async () => {
  const exact = mk('The Witcher 3: Wild Hunt');
  const fuzzy = mk('Hades');
  const manual = mk('Celeste', { coverManual: true, coverUrl: 'https://c.test/mine.jpg' });
  const skipped = mk('Inside', { coverUrl: 'https://c.test/has.jpg' });
  const saved = [];
  /** @type {string[]} */ const asked = [];
  const calls = await withFetch((u) => {
    const term = new URL(u).searchParams.get('term');
    if (term === 'The Witcher 3: Wild Hunt') return jsonRes({ items: [item(292030, 'The Witcher 3: Wild Hunt - Game of the Year Edition')] });
    return jsonRes({ items: [item(1145350, 'Hades II'), item(1145360, 'Hades Reloaded')] });
  }, async () => {
    const res = await queueCovers([exact, fuzzy, manual, skipped], {
      workerUrl: 'https://w.test', delayMs: 0, save: async (g) => { saved.push(...g); },
      onAmbiguous: (game, items) => { asked.push(game.title); return items[1]; },
    });
    assert.equal(res.updated.length, 2);
    assert.equal(res.skipped, 2);
    assert.equal(res.cancelled, false);
    const byTitle = Object.fromEntries(res.updated.map((g) => [g.title, g]));
    assert.equal(byTitle['The Witcher 3: Wild Hunt'].coverAppId, 292030);
    assert.equal(byTitle['The Witcher 3: Wild Hunt'].coverManual, false);
    assert.equal(byTitle.Hades.coverAppId, 1145360);
    assert.equal(byTitle.Hades.coverManual, true, 'escolha do usuário vira manual');
  });
  assert.equal(calls.length, 2, 'manual e já-com-capa não geram requisição');
  assert.deepEqual(asked, ['Hades']);
  assert.equal(saved.length, 2);
  assert.equal(manual.coverUrl, 'https://c.test/mine.jpg');
  assert.equal(exact.coverUrl, null, 'não muta a entrada');
});
test('covers: sem onAmbiguous o jogo duvidoso é pulado; busca vazia conta notFound; coverAppId dispensa requisição', async () => {
  const a = mk('Hades'); const b = mk('Zzz Jogo Inexistente'); const c = mk('Qualquer', { coverAppId: 42 });
  const calls = await withFetch((u) => jsonRes({ items: new URL(u).searchParams.get('term') === 'Hades' ? [item(2, 'Outra Coisa')] : [] }), async () => {
    const res = await queueCovers([a, b, c], { workerUrl: 'https://w.test', delayMs: 0, save: async () => {} });
    assert.equal(res.updated.length, 1);
    assert.equal(res.updated[0].coverUrl, 'https://cdn.cloudflare.steamstatic.com/steam/apps/42/library_600x900_2x.jpg');
    assert.equal(res.skipped, 1);
    assert.equal(res.notFound, 1);
  });
  assert.equal(calls.length, 2);
});
test('covers: uma requisição por vez, com intervalo entre elas', async () => {
  const games = [mk('A1'), mk('B2'), mk('C3')];
  let inFlight = 0; let maxInFlight = 0; const stamps = [];
  await withFetch(() => { inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); stamps.push(Date.now()); return new Promise((r) => setTimeout(() => { inFlight--; r(jsonRes({ items: [] })); }, 5)); }, async () => {
    await queueCovers(games, { workerUrl: 'https://w.test', delayMs: 40, save: async () => {} });
  });
  assert.equal(maxInFlight, 1);
  assert.ok(stamps[1] - stamps[0] >= 35 && stamps[2] - stamps[1] >= 35, `intervalos ${stamps[1] - stamps[0]}/${stamps[2] - stamps[1]}`);
});
test('covers: cancelável por AbortSignal; o que já foi decidido é salvo', async () => {
  const games = Array.from({ length: 6 }, (_, i) => mk(`Jogo ${i}`));
  const ctrl = new AbortController();
  /** @type {any[]} */ const saved = [];
  let n = 0;
  await withFetch((u) => {
    const term = /** @type {string} */ (new URL(u).searchParams.get('term'));
    if (++n === 3) ctrl.abort();
    return jsonRes({ items: [item(100 + n, term)] });
  }, async () => {
    const res = await queueCovers(games, { workerUrl: 'https://w.test', delayMs: 0, signal: ctrl.signal, save: async (g) => { saved.push(...g); } });
    assert.equal(res.cancelled, true);
    assert.ok(res.updated.length >= 2 && res.updated.length < 6, String(res.updated.length));
    assert.equal(saved.length, res.updated.length);
  });
  assert.ok(n < 6);
});
test('covers: onProgress reporta done/total', async () => {
  const games = [mk('A1'), mk('B2', { coverManual: true })];
  /** @type {any[]} */ const seen = [];
  await withFetch(() => jsonRes({ items: [] }), async () => {
    await queueCovers(games, { workerUrl: 'https://w.test', delayMs: 0, save: async () => {}, onProgress: (p) => seen.push([p.done, p.total, p.result]) });
  });
  assert.deepEqual(seen, [[2, 2, 'not_found']]);
});
test('covers: 3 falhas seguidas interrompem com { code } e salvam o pendente', async () => {
  const games = Array.from({ length: 5 }, (_, i) => mk(`Jogo ${i}`, i === 0 ? { coverAppId: 7 } : {}));
  /** @type {any[]} */ const saved = [];
  await withFetch(() => jsonRes({ error: 'origin_not_allowed' }, 403), async () => {
    await assert.rejectsCode(() => queueCovers(games, { workerUrl: 'https://w.test', delayMs: 0, save: async (g) => { saved.push(...g); } }), 'origin_not_allowed');
  });
  assert.equal(saved.length, 1, 'a capa do coverAppId foi salva antes do erro');
});

// ---------- Fixtures reais do Daniel ----------
test('fixtures: steam_cache real → 268 IncomingGame com tempo e conquistas', async () => {
  const text = await fixture('steam-daniel.json');
  if (text === null) { report.push('PULADO fixtures: dev/fixtures/steam-daniel.json ausente (rode node dev/make-fixtures.mjs <pasta>)'); return; }
  const rows = parseSteamCache(text);
  assert.equal(rows.length, 268);
  assert.ok(rows.every((r) => r.title && r.storeGameId && typeof r.playtimeMinutes === 'number'), 'título, appid e tempo em todos');
  const withAch = rows.filter((r) => r.achievementsTotal != null).length;
  assert.ok(withAch > 0);
  assert.ok(rows.some((r) => r.playtimeMinutes > 0 && r.lastPlayedAt));
  report.push(`steam-daniel.json: ${rows.length} jogos; ${withAch} com conquistas; ${rows.filter((r) => r.playtimeMinutes > 0).length} com tempo jogado`);
});
test('fixtures: gog-daniel.csv → todas as linhas, 0 erros', async () => {
  const text = await fixture('gog-daniel.csv');
  if (text === null) { report.push('PULADO fixtures: dev/fixtures/gog-daniel.csv ausente'); return; }
  const { rows, errors } = parseCsv(text);
  assert.deepEqual(errors, []);
  assert.equal(rows.length, 112, 'o importar_gog.js tem 112 títulos (o plano diz 113: contagem errada de 1)');
  assert.ok(rows.every((r) => r.store === 'gog'));
  report.push(`gog-daniel.csv: ${rows.length} linhas, 0 erros`);
});
test('fixtures: planMerge(steam, gog) mescla os títulos em comum (contagem no relatório)', async () => {
  const s = await fixture('steam-daniel.json');
  const g = await fixture('gog-daniel.csv');
  if (s === null || g === null) { report.push('PULADO fixtures: cruzamento steam×gog'); return; }
  const steam = parseSteamCache(s);
  const gog = parseCsv(g).rows;
  const first = planMerge([], steam, { now: '2026-10-12T00:00:00.000Z' });
  assert.equal(first.errors.length, 0);
  const second = planMerge(first.toCreate, gog, { now: '2026-10-12T00:00:00.000Z' });
  assert.equal(second.errors.length, 0);
  assert.equal(second.counts.new + second.counts.merged + second.counts.updated, gog.length);
  assert.equal(second.mergedCount, second.counts.merged);
  const common = second.toUpdate.map((u) => u.after.title).sort();
  assert.equal(common.length, second.toUpdate.length);
  // o mesmo resultado num lote só (steam + gog juntos)
  const batch = planMerge([], [...steam, ...gog], { now: '2026-10-12T00:00:00.000Z' });
  assert.equal(batch.counts.merged, first.counts.merged + second.counts.merged, 'lote único e dois passos concordam');
  assert.equal(batch.toCreate.length, first.toCreate.length + second.counts.new);
  assert.ok(batch.toCreate.every((x) => x.ownerships.length >= 1));
  report.push(`steam sozinho: ${steam.length} linhas → ${first.toCreate.length} cards (${first.counts.merged} linhas com o mesmo titleKey de outro jogo da Steam viraram posse extra)`);
  report.push(`merge steam×gog: ${second.counts.merged} títulos em comum mesclados (1 card, 2 selos); ${second.counts.updated} atualizados; ${second.counts.new} jogos só na GOG; total ${batch.toCreate.length} cards`);
  report.push(`títulos mesclados: ${common.join(' | ')}`);
  // reimportar o mesmo CSV depois de aplicado é idempotente
  const again = planMerge(batch.toCreate, gog, { now: '2026-10-13T00:00:00.000Z' });
  assert.equal(again.toCreate.length, 0);
  assert.equal(again.toUpdate.length, 0, 'reimportar o mesmo CSV não altera nada');
});

test('steam: fetchOwned envia as credenciais do usuário só em cabeçalhos', async () => {
  /** @type {any} */ let seen = null;
  const real = globalThis.fetch;
  globalThis.fetch = /** @type {any} */ ((/** @type {string} */ u, /** @type {any} */ init) => { seen = { u, init }; return Promise.resolve(jsonRes({ count: 0, fetchedAt: 'x', games: [] })); });
  try {
    await fetchOwned('https://w.test', { key: ' K '.repeat(1), steamId: '765' });
    assert.equal(seen.init.headers['X-Steam-Key'], 'K');
    assert.equal(seen.init.headers['X-Steam-Id'], '765');
    assert.ok(!seen.u.includes('K') || !seen.u.includes('key'), 'credencial na URL');
    await fetchOwned('https://w.test');
    assert.ok(!('X-Steam-Key' in seen.init.headers));
  } finally { globalThis.fetch = real; }
});

test('covers: refineCoverItems põe o jogo principal no topo e esconde DLC/pacotes', () => {
  const it = (appid, name) => ({ appid, name, coverUrl: 'x' + appid });
  const bf = [it(2, 'Season 5 Battlefield Pro - Battlefield™ 6 and REDSEC'), it(3, 'Lead the Way Pack - Battlefield™ 6'), it(1, 'Battlefield™ 6'), it(4, 'Battlefield 6 Soundtrack'), it(5, 'Battlefield V')];
  assert.deepEqual(refineCoverItems('Battlefield 6', bf).map((i) => i.appid), [1, 5]);
  // só ruído: mantém tudo, na ordem original (não deixa a lista vazia)
  assert.deepEqual(refineCoverItems('Algo', [it(7, 'Algo Pack'), it(8, 'Algo Skins')]).map((i) => i.appid), [7, 8]);
  // palavra de ruído presente no título buscado não conta como ruído
  assert.deepEqual(refineCoverItems('Mad Max Season Pass', [it(9, 'Mad Max'), it(10, 'Mad Max Season Pass')]).map((i) => i.appid), [10, 9]);
  // sem falso positivo em palavra parecida (kitchen, passage); limite de 5
  assert.deepEqual(refineCoverItems('Cook', [it(11, 'Kitchen Simulator'), it(12, 'Cook Passage')]).map((i) => i.appid), [12, 11]);
  assert.equal(refineCoverItems('Jogo', Array.from({ length: 9 }, (_, n) => it(n, 'Jogo ' + n))).length, 5);
});
test('covers: searchCover aplica o filtro (principal vence os pacotes)', async () => {
  const items = [{ appid: 2, name: 'Season 5 Pro - Battlefield 6', coverUrl: 'b' }, { appid: 1, name: 'Battlefield 6', coverUrl: 'a' }];
  await withFetch(() => jsonRes({ items }), async () => {
    const r = await searchCover('Battlefield 6', 'https://w.test');
    assert.deepEqual(r.map((i) => i.appid), [1]);
  });
});
