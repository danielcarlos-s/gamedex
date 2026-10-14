import { t, applyI18n } from '../i18n/index.js';
import { icon } from '../icons.js';
import { db } from '../data-source.js';
import { renderGrid, bindCoverFallback, esc, storeLabel } from './grid.js';
import { allStoreIds, customStore, deleteStore } from '../data/stores.js';
import { initDisclosure } from '../menu.js';
import { parseState, stateToHash, runFilters, sortGames, buildPanel } from './filters.js';

const shell = () => `
  <div class="view-head">
    <h1 class="t-heading" tabindex="-1" data-i18n="library.title"></h1>
    <div class="menu" data-menu>
      <button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-menu-btn aria-expanded="false" aria-controls="add-menu" aria-haspopup="true">${icon('plus')}<span>${esc(t('library.add.menu'))}</span>${icon('chevron')}</button>
      <div id="add-menu" class="menu__panel menu__panel--add panel" hidden>
        <a class="menu__item menu__item--two" href="#/game/new" data-role="add">${icon('plus')}<span><span class="menu__title">${esc(t('library.add.manual'))}</span><span class="t-hint">${esc(t('library.add.manual.hint'))}</span></span></a>
        <a class="menu__item menu__item--two" href="#/import?csv=1" data-role="add-csv">${icon('upload')}<span><span class="menu__title">${esc(t('library.add.csv'))}</span><span class="t-hint">${esc(t('library.add.csv.hint'))}</span></span></a>
      </div>
    </div>
  </div>
  <section class="panel panel--live" data-role="filters" aria-label="" data-i18n-attr="aria-label:filters.title" hidden></section>
  <section id="lib-panel" role="tabpanel" data-role="body"></section>`;

const loadingHtml = () => `<div class="state panel panel--live" role="status"><div class="loader"></div><span class="t-label">${esc(t('state.loading'))}</span></div>`;

const emptyHtml = () => `<div class="state panel panel--live" role="status">
  <h2 class="state__title">${esc(t('state.empty.title'))}</h2>
  <p class="t-body measure">${esc(t('state.empty.text'))}</p>
  <a class="btn btn--primary cut-a-8 is-chamfered" href="#/import">${esc(t('state.empty.cta'))}</a></div>`;

const noResultsHtml = () => `<div class="state panel" role="status">
  <h2 class="state__title">${esc(t('library.noresults.title'))}</h2>
  <p class="t-body measure">${esc(t('library.noresults.text'))}</p>
  <button class="btn btn--primary cut-a-8 is-chamfered" type="button" data-role="clear-all">${esc(t('filters.clear'))}</button></div>`;

/** Aba de uma loja sem nenhum jogo (e sem outros filtros): caminhos para encher a loja ou, se for criada pelo usuário, excluí-la. */
const emptyStoreHtml = (id, confirming) => {
  const q = encodeURIComponent(id);
  const name = storeLabel(id);
  const del = !customStore(id) ? '' : confirming
    ? `<div class="panel confirm" role="group" aria-labelledby="es-del"><p class="t-body" id="es-del">${esc(t('library.emptystore.confirm', { name }))}</p>
        <div class="row"><button class="btn btn--primary cut-a-8 is-chamfered" type="button" data-role="store-delete-yes">${icon('trash')}<span>${esc(t('library.emptystore.delete.yes'))}</span></button>
        <button class="btn btn--ghost cut-a-8 is-chamfered" type="button" data-role="store-delete-no">${esc(t('common.cancel'))}</button></div></div>`
    : `<button class="btn btn--ghost cut-a-8 is-chamfered" type="button" data-role="store-delete">${icon('trash')}<span>${esc(t('library.emptystore.delete'))}</span></button>`;
  return `<div class="state panel" role="status">
  <h2 class="state__title">${esc(t('library.emptystore.title', { name }))}</h2>
  <p class="t-body measure">${esc(t('library.emptystore.text'))}</p>
  <div class="row">
    <a class="btn btn--primary cut-a-8 is-chamfered" href="#/import?csv=1&store=${q}">${icon('upload')}<span>${esc(t('library.add.csv'))}</span></a>
    <a class="btn cut-a-8 is-chamfered" href="#/game/new?store=${q}">${icon('plus')}<span>${esc(t('library.add.manual'))}</span></a>
    ${confirming ? '' : del}
  </div>
  ${confirming ? del : ''}</div>`;
};

const errorHtml = (code) => `<div class="state panel" role="alert">
  <span class="row">${icon('alert')}<span class="state__title">${esc(t('state.error.title'))}</span></span>
  <p class="t-body">${esc(t('err.' + code))}</p>
  <button class="btn cut-a-8 is-chamfered" type="button" data-role="retry">${esc(t('state.retry'))}</button></div>`;

/**
 * Monta a biblioteca: título, busca/filtros, abas de loja, barra de resultados e grade, tudo em `root`.
 * Os filtros vivem no hash (`#/?store=gog&q=...`) e são gravados com replaceState (sem re-render da rota).
 * @param {HTMLElement} root
 * @param {URLSearchParams} query
 * @returns {() => void} limpeza
 */
export function mountLibrary(root, query) {
  root.innerHTML = shell();
  applyI18n(root);
  const filtersRoot = root.querySelector('[data-role="filters"]');
  const body = root.querySelector('[data-role="body"]');
  const addLink = root.querySelector('[data-role="add"]');
  const addCsv = root.querySelector('[data-role="add-csv"]');
  const offMenu = initDisclosure(root.querySelector('[data-menu]'));
  bindCoverFallback(body);
  const state = parseState(query);
  let disposed = false;
  let seq = 0;
  let games = [];
  let panel = null;
  let confirmingDelete = false;

  function paint() {
    // aba de uma loja que deixou de existir (excluída) volta para "Todos"
    if (state.store && !allStoreIds().includes(state.store)) state.store = null;
    const { result, counts } = runFilters(games, state);
    sortGames(result, state);
    // com UMA loja filtrada, "Adicionar jogo" já abre o formulário nessa loja
    addLink.href = state.store ? `#/game/new?store=${encodeURIComponent(state.store)}` : '#/game/new';
    addCsv.href = state.store ? `#/import?csv=1&store=${encodeURIComponent(state.store)}` : '#/import?csv=1';
    panel?.update(state, counts, result.length, games.length);
    if (!games.length) { body.innerHTML = emptyHtml(); return; }
    const onlyStore = state.store && !state.q && !state.status.size && !state.tags.size && !state.genres.size && !state.fav && !state.multi && !state.played;
    if (!result.length && onlyStore) {
      body.innerHTML = emptyStoreHtml(state.store, confirmingDelete);
      const q = (r) => body.querySelector(`[data-role="${r}"]`);
      q('store-delete')?.addEventListener('click', () => { confirmingDelete = true; paint(); body.querySelector('[data-role="store-delete-no"]')?.focus(); });
      q('store-delete-no')?.addEventListener('click', () => { confirmingDelete = false; paint(); body.querySelector('[data-role="store-delete"]')?.focus(); });
      q('store-delete-yes')?.addEventListener('click', async () => {
        const id = state.store;
        confirmingDelete = false;
        try { await deleteStore(id, games); } catch { paint(); return; }
        state.store = null;
        onChange();
      });
      return;
    }
    confirmingDelete = false;
    if (!result.length) {
      body.innerHTML = noResultsHtml();
      body.querySelector('[data-role="clear-all"]').addEventListener('click', () => filtersRoot.querySelector('[data-role="clear"]').click());
      return;
    }
    const t0 = performance.now();
    const grid = renderGrid(result, state.view);
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
    panel?.destroy();
    panel = games.length ? buildPanel(filtersRoot, games, state, onChange, { panelId: 'lib-panel' }) : null;
    paint();
  }

  const off = db.onChange((ev) => { if (!ev || ev.type === 'games') load(); });
  load();
  return () => { disposed = true; off(); offMenu(); panel?.destroy(); };
}
