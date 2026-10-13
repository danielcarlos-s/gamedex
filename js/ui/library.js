import { t, applyI18n, formatNumber } from '../i18n/index.js';
import { icon } from '../icons.js';
import { db } from '../data-source.js';
import { renderGrid, bindCoverFallback, esc } from './grid.js';
import { parseState, stateToHash, runFilters, sortGames, buildPanel } from './filters.js';

const shell = () => `
  <div class="view-head">
    <h1 class="t-heading" tabindex="-1" data-i18n="library.title"></h1>
    <div class="row">
      <p class="t-data" data-role="count"></p>
      <a class="btn btn--primary cut-a-8 is-chamfered" href="#/game/new" data-role="add">${icon('plus')}<span>${esc(t('library.add'))}</span></a>
    </div>
  </div>
  <hr class="divider">
  <section data-role="body" aria-label="" data-i18n-attr="aria-label:library.grid"></section>`;

const loadingHtml = () => `<div class="state panel panel--live" role="status"><div class="loader"></div><span class="t-label">${esc(t('state.loading'))}</span></div>`;

const emptyHtml = () => `<div class="state panel panel--live" role="status">
  <h2 class="state__title">${esc(t('state.empty.title'))}</h2>
  <p class="t-body measure">${esc(t('state.empty.text'))}</p>
  <a class="btn btn--primary cut-a-8 is-chamfered" href="#/import">${esc(t('state.empty.cta'))}</a></div>`;

const noResultsHtml = () => `<div class="state panel" role="status">
  <h2 class="state__title">${esc(t('library.noresults.title'))}</h2>
  <p class="t-body measure">${esc(t('library.noresults.text'))}</p>
  <button class="btn btn--primary cut-a-8 is-chamfered" type="button" data-role="clear-all">${esc(t('filters.clear'))}</button></div>`;

const errorHtml = (code) => `<div class="state panel" role="alert">
  <span class="row">${icon('alert')}<span class="state__title">${esc(t('state.error.title'))}</span></span>
  <p class="t-body">${esc(t('err.' + code))}</p>
  <button class="btn cut-a-8 is-chamfered" type="button" data-role="retry">${esc(t('state.retry'))}</button></div>`;

/**
 * Monta a biblioteca: `root` recebe título + grade; `filtersRoot` recebe o painel de filtros.
 * Os filtros vivem no hash (`#/?stores=gog&q=...`) e são gravados com replaceState (sem re-render da rota).
 * @param {HTMLElement} root
 * @param {HTMLElement} filtersRoot
 * @param {URLSearchParams} query
 * @returns {() => void} limpeza
 */
export function mountLibrary(root, filtersRoot, query) {
  root.innerHTML = shell();
  applyI18n(root);
  const countEl = root.querySelector('[data-role="count"]');
  const body = root.querySelector('[data-role="body"]');
  const addLink = root.querySelector('[data-role="add"]');
  bindCoverFallback(body);
  const state = parseState(query);
  let disposed = false;
  let seq = 0;
  let games = [];
  let update = null;

  const countText = (n) => (n === 1 ? t('library.count.one') : t('library.count', { n: formatNumber(n) }));

  function paint() {
    const { result, counts } = runFilters(games, state);
    sortGames(result, state);
    countEl.textContent = countText(games.length);
    // com UMA loja filtrada, "Adicionar jogo" já abre o formulário nessa loja
    addLink.href = state.stores.size === 1 ? `#/game/new?store=${encodeURIComponent([...state.stores][0])}` : '#/game/new';
    update?.(state, counts, result.length, games.length);
    if (!games.length) { body.innerHTML = emptyHtml(); return; }
    if (!result.length) {
      body.innerHTML = noResultsHtml();
      body.querySelector('[data-role="clear-all"]').addEventListener('click', () => filtersRoot.querySelector('[data-role="clear"]').click());
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'grid';
    const t0 = performance.now();
    renderGrid(grid, result);
    grid.dataset.renderMs = String(Math.round(performance.now() - t0));
    body.replaceChildren(grid);
  }

  function onChange() {
    history.replaceState(null, '', stateToHash(state));
    paint();
  }

  async function load() {
    const mine = ++seq;
    body.innerHTML = loadingHtml();
    try {
      games = await db.getAllGames();
    } catch (e) {
      if (disposed || mine !== seq) return;
      body.innerHTML = errorHtml(e?.code || 'idb_unavailable');
      body.querySelector('[data-role="retry"]').addEventListener('click', load);
      return;
    }
    if (disposed || mine !== seq) return;
    filtersRoot.hidden = !games.length;
    if (games.length) update = buildPanel(filtersRoot, games, state, onChange);
    paint();
  }

  const off = db.onChange((ev) => { if (!ev || ev.type === 'games') load(); });
  load();
  return () => { disposed = true; off(); filtersRoot.replaceChildren(); };
}
