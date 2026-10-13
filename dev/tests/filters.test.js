// Filtros da biblioteca: aba de loja (seleção única), contagens por aba e compatibilidade com links antigos.
import { test, assert } from '../test-lib.js';
import { createGame } from '../../js/data/model.js';
// filters.js depende de i18n/DOM: estes testes rodam só no navegador (dev/test.html); no Node viram no-op.
const mod = globalThis.document ? await import('../../js/ui/filters.js') : null;

const g = (title, ...stores) => createGame({ title, ownerships: stores.map((store) => ({ store })) });
const games = [g('A', 'steam'), g('B', 'gog'), g('C', 'steam', 'gog'), g('D', 'epic')];
const q = (s) => new URLSearchParams(s);

test('filtros: loja é uma só (?store=) e links antigos ?stores=a,b usam a primeira válida', () => {
  if (!mod) return;
  const { parseState, stateToHash, hasActiveFilters } = mod;
  assert.equal(parseState(q('store=gog')).store, 'gog');
  assert.equal(parseState(q('stores=xbox,epic,gog')).store, 'epic');
  assert.equal(parseState(q('store=xbox')).store, null);
  assert.equal(parseState(q('')).store, null);
  const s = parseState(q('store=c-abcd1234&sort=time'));
  assert.equal(s.store, 'c-abcd1234');
  assert.equal(stateToHash(s), '#/?store=c-abcd1234&sort=time');
  assert.equal(stateToHash(parseState(q(''))), '#/');
  assert.ok(hasActiveFilters(parseState(q('store=gog'))));
});

test('filtros: aba filtra pela loja; contagens das abas ignoram a própria aba e "Todos" soma os demais filtros', () => {
  if (!mod) return;
  const { parseState, runFilters } = mod;
  const all = runFilters(games, parseState(q('')));
  assert.equal(all.result.length, 4);
  assert.equal(all.counts.all, 4);
  assert.deepEqual([all.counts.stores.steam, all.counts.stores.gog, all.counts.stores.epic], [2, 2, 1]);

  const gog = runFilters(games, parseState(q('store=gog')));
  assert.deepEqual(gog.result.map((x) => x.title).sort(), ['B', 'C']);
  assert.equal(gog.counts.all, 4, 'Todos não some quando uma aba está ativa');
  assert.equal(gog.counts.stores.steam, 2, 'outras abas seguem mostrando o seu total');

  // com outro filtro ativo (jogos em mais de uma loja), as abas refletem esse filtro
  const multi = runFilters(games, parseState(q('multi=1&store=epic')));
  assert.equal(multi.result.length, 0);
  assert.equal(multi.counts.all, 1);
  assert.deepEqual([multi.counts.stores.steam, multi.counts.stores.gog, multi.counts.stores.epic || 0], [1, 1, 0]);
});
