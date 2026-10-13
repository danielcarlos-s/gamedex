import { t, formatPlaytime, formatDate } from '../i18n/index.js';
import { icon } from '../icons.js';
import { STORES } from '../data/model.js';
import { allStoreIds, customStore } from '../data/stores.js';

/** Escapa texto para HTML/atributos. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Nome da loja para mostrar: fixa → texto traduzido; criada pelo usuário → o nome dela; id criado que o registro
 * não conhece (ex.: backup sem a definição) → "Outra".
 * @param {string} id
 * @returns {string}
 */
export function storeLabel(id) {
  const c = customStore(id);
  if (c) return c.name;
  return STORES.includes(/** @type {any} */ (id)) ? t('store.' + id) : t('store.other');
}

/** Lojas distintas do jogo, na ordem de exibição (fixas, criadas, "Outra"); ids desconhecidos vão no fim. */
export function gameStores(game) {
  const set = new Set((game.ownerships || []).map((o) => o.store));
  const ordered = allStoreIds().filter((s) => set.has(s));
  return [...ordered, ...[...set].filter((s) => !ordered.includes(s))];
}

export function storeChip(store) {
  const c = customStore(store);
  if (c) return `<span class="chip chip--store chip--custom cut-a-4" style="--h:${c.hue}">${esc(c.name)}</span>`;
  const known = STORES.includes(/** @type {any} */ (store)) ? store : 'other';
  return `<span class="chip chip--store chip--${known} cut-a-4">${esc(storeLabel(store))}</span>`;
}

export function statusChip(status) {
  return `<span class="chip ${status === 'playing' ? 'chip--playing' : ''} cut-a-4">${esc(t('status.' + status))}</span>`;
}

function coverHtml(game) {
  if (!game.coverUrl) return `<div class="cover-ph">${esc(game.title)}</div>`;
  return `<img src="${esc(game.coverUrl)}" alt="" data-title="${esc(game.title)}" loading="lazy" decoding="async" ${game.coverAppId ? `data-appid="${esc(game.coverAppId)}"` : ''}>`;
}

function cardHtml(g) {
  const fav = g.favorite ? `<span class="card__fav">${icon('heart', { filled: true })}<span class="visually-hidden">${esc(t('common.favorite'))}</span></span>` : '';
  return `<article class="card" data-id="${esc(g.id)}">
    <div class="card__cover">${coverHtml(g)}${fav}</div>
    <div class="card__body">
      <h3 class="card__title">${esc(g.title)}</h3>
      <div class="card__meta">${gameStores(g).map(storeChip).join('')}${statusChip(g.status)}</div>
      <p class="t-data">${esc(formatPlaytime(g.playtimeMinutes))}</p>
    </div>
    <a class="card__link" href="#/game/${encodeURIComponent(g.id)}" aria-label="${esc(g.title)}"></a>
  </article>`;
}

function rowHtml(g) {
  const fav = g.favorite ? `<span class="lrow__fav">${icon('heart', { filled: true })}<span class="visually-hidden">${esc(t('common.favorite'))}</span></span>` : '';
  const last = g.lastPlayedAt ? formatDate(g.lastPlayedAt) : '';
  return `<li class="lrow" data-id="${esc(g.id)}">
    <div class="lrow__cover">${coverHtml(g)}</div>
    <h3 class="lrow__title">${esc(g.title)}${fav}</h3>
    <div class="lrow__chips">${gameStores(g).map(storeChip).join('')}${statusChip(g.status)}</div>
    <p class="lrow__time t-data">${esc(formatPlaytime(g.playtimeMinutes))}</p>
    <p class="lrow__last t-hint">${last ? `<span class="visually-hidden">${esc(t('list.last'))}: </span>${esc(last)}` : ''}</p>
    <a class="lrow__link" href="#/game/${encodeURIComponent(g.id)}" aria-label="${esc(g.title)}"></a>
  </li>`;
}

export const VIEW_MODES = ['grid', 'large', 'list'];

/**
 * Cria o container da coleção no modo pedido e o preenche (um único innerHTML — 1.000 itens em poucos ms).
 * `grid` = cards padrão, `large` = cards maiores (menos por linha), `list` = uma linha por jogo.
 * @param {object[]} games
 * @param {'grid'|'large'|'list'} [mode]
 * @returns {HTMLElement}
 */
export function renderGrid(games, mode = 'grid') {
  const list = mode === 'list';
  const el = document.createElement(list ? 'ul' : 'div');
  el.className = list ? 'list' : mode === 'large' ? 'grid grid--large' : 'grid';
  el.innerHTML = games.map(list ? rowHtml : cardHtml).join('');
  return el;
}

/** Fallback de capa (6.2): library_600x900_2x → header.jpg → placeholder. Ligar uma vez por container. */
export function bindCoverFallback(container) {
  container.addEventListener('error', (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const appid = img.dataset.appid;
    if (appid && !img.dataset.triedHeader && /library_600x900/.test(img.src)) {
      img.dataset.triedHeader = '1';
      img.src = `https://cdn.cloudflare.steamstatic.com/steam/apps/${encodeURIComponent(appid)}/header.jpg`;
      return;
    }
    const title = img.dataset.title ?? img.closest('.card, .lrow')?.querySelector('.card__title, .lrow__title')?.textContent ?? '';
    const ph = document.createElement('div');
    ph.className = 'cover-ph';
    ph.textContent = title;
    img.replaceWith(ph);
  }, true);
}
