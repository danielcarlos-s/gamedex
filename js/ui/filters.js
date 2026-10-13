import { t, getLang, formatNumber } from '../i18n/index.js';
import { icon } from '../icons.js';
import { normalizeTitle, isStoreId } from '../data/model.js';
import { gameStores, esc, VIEW_MODES } from './grid.js';
import { mountStoreTabs } from './store-tabs.js';

export const STATUS_ORDER = ['backlog', 'playing', 'paused', 'finished', 'completed', 'dropped'];
const SORTS = ['name', 'time', 'last', 'added'];
const DEFAULT_DIR = { name: 'asc', time: 'desc', last: 'desc', added: 'desc' };
const DIMS = ['q', 'store', 'status', 'tags', 'genres', 'fav', 'multi', 'played'];

const VIEW_KEY = 'gamedex-view';
/** Modo de exibição salvo neste navegador (preferência do dispositivo: não vai na URL nem no backup). */
export function readView() {
  try { const v = localStorage.getItem(VIEW_KEY); if (VIEW_MODES.includes(v)) return v; } catch { /* sem localStorage */ }
  return 'grid';
}
function saveView(v) { try { localStorage.setItem(VIEW_KEY, v); } catch { /* sem localStorage */ } }

const list = (v) => (v ? v.split(',').filter(Boolean) : []);

/** Lê o estado dos filtros de URLSearchParams (a parte depois de `#/?`). */
export function parseState(query) {
  const sort = SORTS.includes(query.get('sort')) ? query.get('sort') : 'name';
  const dir = query.get('dir') === 'asc' || query.get('dir') === 'desc' ? query.get('dir') : DEFAULT_DIR[sort];
  const played = query.get('played');
  return {
    q: query.get('q') || '',
    // aba de loja (uma só); links antigos `?stores=a,b` caem na primeira loja válida
    store: [query.get('store'), ...list(query.get('stores'))].find((s) => s && isStoreId(s)) || null,
    status: new Set(list(query.get('status')).filter((s) => STATUS_ORDER.includes(s))),
    tags: new Set(list(query.get('tags'))),
    genres: new Set(list(query.get('genres'))),
    fav: query.get('fav') === '1',
    multi: query.get('multi') === '1',
    played: played === 'yes' || played === 'no' ? played : null,
    sort,
    dir,
    view: readView(),
  };
}

/** Serializa o estado para o hash (`#/` quando está tudo no padrão). */
export function stateToHash(s) {
  const p = new URLSearchParams();
  if (s.q) p.set('q', s.q);
  if (s.store) p.set('store', s.store);
  if (s.status.size) p.set('status', [...s.status].join(','));
  if (s.tags.size) p.set('tags', [...s.tags].join(','));
  if (s.genres.size) p.set('genres', [...s.genres].join(','));
  if (s.fav) p.set('fav', '1');
  if (s.multi) p.set('multi', '1');
  if (s.played) p.set('played', s.played);
  if (s.sort !== 'name') p.set('sort', s.sort);
  if (s.dir !== DEFAULT_DIR[s.sort]) p.set('dir', s.dir);
  const qs = p.toString();
  return qs ? `#/?${qs.replace(/%2C/g, ',')}` : '#/';
}

/** Há algum filtro ativo (ordenação não conta)? */
export function hasActiveFilters(s) {
  return !!(s.q || s.store || s.status.size || s.tags.size || s.genres.size || s.fav || s.multi || s.played);
}

/**
 * Um passe só: devolve os jogos que passam em todos os filtros e, para cada grupo,
 * as contagens "se eu só mexesse neste grupo" (jogos que falham apenas nele contam também).
 */
export function runFilters(games, s) {
  const qKey = normalizeTitle(s.q);
  const result = [];
  const counts = { all: 0, stores: {}, status: {}, tags: {}, genres: {}, fav: 0, multi: 0, played: { yes: 0, no: 0 } };
  for (const g of games) {
    const gs = gameStores(g);
    const pass = {
      q: !qKey || (g.titleKey || normalizeTitle(g.title)).includes(qKey),
      store: !s.store || gs.includes(s.store),
      status: !s.status.size || s.status.has(g.status),
      tags: !s.tags.size || (g.tags || []).some((x) => s.tags.has(x)),
      genres: !s.genres.size || (g.genres || []).some((x) => s.genres.has(x)),
      fav: !s.fav || !!g.favorite,
      multi: !s.multi || gs.length > 1,
      played: !s.played || ((g.playtimeMinutes || 0) > 0) === (s.played === 'yes'),
    };
    let fails = 0;
    let failed = null;
    for (const d of DIMS) if (!pass[d]) { fails++; failed = d; }
    if (fails > 1) continue;
    const ok = (d) => fails === 0 || failed === d;
    if (fails === 0) result.push(g);
    if (ok('store')) counts.all++;
    if (ok('store')) gs.forEach((x) => { counts.stores[x] = (counts.stores[x] || 0) + 1; });
    if (ok('status')) counts.status[g.status] = (counts.status[g.status] || 0) + 1;
    if (ok('tags')) (g.tags || []).forEach((x) => { counts.tags[x] = (counts.tags[x] || 0) + 1; });
    if (ok('genres')) (g.genres || []).forEach((x) => { counts.genres[x] = (counts.genres[x] || 0) + 1; });
    if (ok('fav') && g.favorite) counts.fav++;
    if (ok('multi') && gs.length > 1) counts.multi++;
    if (ok('played')) counts.played[(g.playtimeMinutes || 0) > 0 ? 'yes' : 'no']++;
  }
  return { result, counts };
}

/** Ordena in-place segundo o estado; datas ausentes ficam sempre no fim. */
export function sortGames(arr, s) {
  const mul = s.dir === 'asc' ? 1 : -1;
  const collator = new Intl.Collator(getLang() === 'pt' ? 'pt-BR' : 'en-US', { sensitivity: 'base', numeric: true });
  const byName = (a, b) => collator.compare(a.title, b.title);
  if (s.sort === 'name') return arr.sort((a, b) => mul * byName(a, b));
  const key = { time: (g) => g.playtimeMinutes || 0, last: (g) => g.lastPlayedAt, added: (g) => g.createdAt }[s.sort];
  return arr.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (!x && !y) return byName(a, b);
    if (!x) return 1;
    if (!y) return -1;
    return (x < y ? -1 : x > y ? 1 : 0) * mul || byName(a, b);
  });
}

const chipBtn = (attr, value, label) =>
  `<button class="chip-btn cut-a-4 is-chamfered" type="button" aria-pressed="false" ${attr}="${esc(value)}"><span>${esc(label)}</span><span class="chip-btn__count" data-count></span></button>`;

const group = (labelKey, inner) =>
  `<div class="fgroup"><p class="t-label">${esc(t(labelKey))}</p><div class="row">${inner}</div></div>`;

const SORT_OPTIONS = SORTS.flatMap((k) => ['asc', 'desc'].map((d) => `${k}:${d}`));

/**
 * Monta o painel de filtros em `root`: busca + botão "Filtros", abas de loja, filtros avançados (fechados),
 * e a barra de resultados (contagem, limpar, ordenação). `onChange(state)` é chamado a cada mudança do usuário.
 * Devolve `{ update(state, counts, shown, total), destroy() }`; update atualiza estados/contagens sem recriar controles.
 * @param {HTMLElement} root
 * @param {any[]} games
 * @param {any} state
 * @param {(s: any) => void} onChange
 * @param {{ panelId: string }} opts id da grade controlada pelas abas
 */
export function buildPanel(root, games, state, onChange, { panelId }) {
  const tagSet = new Set();
  const genreSet = new Set();
  games.forEach((g) => { (g.tags || []).forEach((x) => tagSet.add(x)); (g.genres || []).forEach((x) => genreSet.add(x)); });
  const tags = [...tagSet].sort((a, b) => a.localeCompare(b));
  const genres = [...genreSet].sort((a, b) => a.localeCompare(b));

  const moreOpen = false; // sempre fechado ao carregar; o contador do botão mostra se há filtros ativos
  root.innerHTML = `
    <div class="filters">
      <div class="filters__top">
        <div class="field filters__search">
          <label class="field__label" for="f-q">${esc(t('filters.search'))}</label>
          <div class="search">
            ${icon('search')}
            <input id="f-q" class="input cut-a-6 is-chamfered" type="search" autocomplete="off" placeholder="${esc(t('filters.search.placeholder'))}" value="${esc(state.q)}">
          </div>
        </div>
        <button class="btn cut-a-8 is-chamfered" type="button" data-role="adv" aria-expanded="false" aria-controls="f-adv">
          ${icon('settings', { className: 'adv-icon' })}<span class="adv-label">${esc(t('filters.advanced'))}</span><span class="chip-btn__count" data-role="adv-count" hidden></span>${icon('chevron', { className: 'more-icon' })}
        </button>
      </div>
      <div data-role="tabs-slot"></div>
      <div id="f-adv" class="stack" hidden>
      ${group('filters.status', STATUS_ORDER.map((s) => chipBtn('data-status', s, t('status.' + s))).join(''))}
      <div class="fgroup">
        <p class="t-label">${esc(t('filters.show'))}</p>
        <div class="row">
          ${chipBtn('data-flag', 'fav', t('filters.favorite'))}
          ${chipBtn('data-flag', 'multi', t('filters.multi'))}
          ${chipBtn('data-played', 'yes', t('filters.played'))}
          ${chipBtn('data-played', 'no', t('filters.unplayed'))}
        </div>
      </div>
      ${tags.length || genres.length ? `
      <div class="fgroup">
        <button class="btn btn--ghost cut-a-8 is-chamfered" type="button" data-role="more" aria-expanded="${moreOpen}" aria-controls="f-more">
          <span>${esc(t('filters.more'))}</span>${icon('chevron', { className: 'more-icon' })}
        </button>
        <div id="f-more" class="stack" ${moreOpen ? '' : 'hidden'}>
          ${genres.length ? group('filters.genres', genres.map((x) => chipBtn('data-genre', x, x)).join('')) : ''}
          ${tags.length ? group('filters.tags', tags.map((x) => chipBtn('data-tag', x, x)).join('')) : ''}
        </div>
      </div>` : ''}
      </div>
      <div class="filters__foot">
        <div class="row">
          <p class="t-data" data-role="results" aria-live="polite"></p>
          <button class="btn btn--ghost cut-a-8 is-chamfered" type="button" data-role="clear">${esc(t('filters.clear'))}</button>
        </div>
        <div class="row">
          <div class="seg-toggle" role="group" aria-label="${esc(t('view.label'))}">${VIEW_MODES.map((m) => `<button type="button" class="cut-a-6 is-chamfered" data-view="${m}" aria-pressed="false" aria-label="${esc(t('view.' + m))}" title="${esc(t('view.' + m))}">${icon(m === 'grid' ? 'view-grid' : m === 'large' ? 'library' : 'view-list')}</button>`).join('')}</div>
          <label class="t-label" for="f-sort">${esc(t('filters.sort'))}</label>
          <select id="f-sort" class="input cut-a-6 is-chamfered">${SORT_OPTIONS.map((o) => `<option value="${o}">${esc(t('sort.opt.' + o.replace(':', '.')))}</option>`).join('')}</select>
        </div>
      </div>
    </div>`;

  const $ = (sel) => root.querySelector(sel);
  const q = $('#f-q');
  const sortEl = $('#f-sort');
  const more = $('[data-role="more"]');
  const adv = $('[data-role="adv"]');
  const tabs = mountStoreTabs($('[data-role="tabs-slot"]'), state, onChange, { panelId });

  let timer;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = q.value.trim(); onChange(state); }, 150);
  });
  sortEl.addEventListener('change', () => {
    [state.sort, state.dir] = sortEl.value.split(':');
    onChange(state);
  });
  adv.addEventListener('click', () => {
    const open = adv.getAttribute('aria-expanded') !== 'true';
    adv.setAttribute('aria-expanded', String(open));
    $('#f-adv').hidden = !open;
  });
  more?.addEventListener('click', () => {
    const open = more.getAttribute('aria-expanded') !== 'true';
    more.setAttribute('aria-expanded', String(open));
    $('#f-more').hidden = !open;
  });
  $('[data-role="clear"]').addEventListener('click', () => {
    Object.assign(state, { q: '', store: null, fav: false, multi: false, played: null });
    ['status', 'tags', 'genres'].forEach((k) => state[k].clear());
    q.value = '';
    onChange(state);
  });

  const toggleSet = (set, v) => { if (set.has(v)) set.delete(v); else set.add(v); };
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    state.view = b.dataset.view;
    saveView(state.view);
    onChange(state);
  }));
  $('#f-adv').addEventListener('click', (e) => {
    const b = e.target.closest('.chip-btn');
    if (!b) return;
    const d = b.dataset;
    if (d.status) toggleSet(state.status, d.status);
    else if (d.genre) toggleSet(state.genres, d.genre);
    else if (d.tag) toggleSet(state.tags, d.tag);
    else if (d.flag) state[d.flag] = !state[d.flag];
    else if (d.played) state.played = state.played === d.played ? null : d.played;
    onChange(state);
  });

  const setChip = (sel, pressed, n) => {
    const b = $(sel);
    if (!b) return;
    b.setAttribute('aria-pressed', String(pressed));
    b.querySelector('[data-count]').textContent = formatNumber(n || 0);
  };

  function update(s, counts, shown, total) {
    if (document.activeElement !== q) q.value = s.q;
    sortEl.value = `${s.sort}:${s.dir}`;
    tabs.update(s, counts);
    root.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === s.view)));
    const cssq = (v) => CSS.escape(v);
    STATUS_ORDER.forEach((x) => setChip(`[data-status="${x}"]`, s.status.has(x), counts.status[x]));
    genres.forEach((x) => setChip(`[data-genre="${cssq(x)}"]`, s.genres.has(x), counts.genres[x]));
    tags.forEach((x) => setChip(`[data-tag="${cssq(x)}"]`, s.tags.has(x), counts.tags[x]));
    setChip('[data-flag="fav"]', s.fav, counts.fav);
    setChip('[data-flag="multi"]', s.multi, counts.multi);
    setChip('[data-played="yes"]', s.played === 'yes', counts.played.yes);
    setChip('[data-played="no"]', s.played === 'no', counts.played.no);
    const active = s.status.size + s.tags.size + s.genres.size + (s.fav ? 1 : 0) + (s.multi ? 1 : 0) + (s.played ? 1 : 0);
    const badge = $('[data-role="adv-count"]');
    badge.hidden = active === 0;
    badge.textContent = formatNumber(active);
    $('[data-role="results"]').textContent = t('library.results', { n: formatNumber(shown), total: formatNumber(total) });
    $('[data-role="clear"]').hidden = !hasActiveFilters(s);
  }
  return { update, destroy: () => { clearTimeout(timer); tabs.destroy(); } };
}
