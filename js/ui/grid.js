import { t, formatPlaytime } from '../i18n/index.js';
import { icon } from '../icons.js';

const STORE_ORDER = ['steam', 'epic', 'gog', 'ubisoft', 'ea', 'amazon', 'other'];

/** Escapa texto para HTML/atributos. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** Lojas distintas do jogo, na ordem canônica. */
export function gameStores(game) {
  const set = new Set((game.ownerships || []).map((o) => o.store));
  return STORE_ORDER.filter((s) => set.has(s));
}

export function storeChip(store) {
  return `<span class="chip chip--store chip--${store} cut-a-4">${esc(t('store.' + store))}</span>`;
}

export function statusChip(status) {
  return `<span class="chip ${status === 'playing' ? 'chip--playing' : ''} cut-a-4">${esc(t('status.' + status))}</span>`;
}

function coverHtml(game) {
  if (!game.coverUrl) return `<div class="cover-ph">${esc(game.title)}</div>`;
  return `<img src="${esc(game.coverUrl)}" alt="" loading="lazy" decoding="async" ${game.coverAppId ? `data-appid="${esc(game.coverAppId)}"` : ''}>`;
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

/**
 * Renderiza a grade de cards em `container` (um único innerHTML — 1.000 cards em poucos ms).
 * @param {HTMLElement} container
 * @param {object[]} games
 */
export function renderGrid(container, games) {
  container.innerHTML = games.map(cardHtml).join('');
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
    const title = img.dataset.title ?? img.closest('.card')?.querySelector('.card__title')?.textContent ?? '';
    const ph = document.createElement('div');
    ph.className = 'cover-ph';
    ph.textContent = title;
    img.replaceWith(ph);
  }, true);
}
