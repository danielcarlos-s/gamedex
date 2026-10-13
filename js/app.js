import { initI18n, applyI18n, onLangChange, t } from './i18n/index.js';
import { initLangToggle } from './lang-toggle.js';
import { initThemeToggle } from './theme.js';
import { loadStores } from './data/stores.js';
import { icon } from './icons.js';
import { mountLibrary } from './ui/library.js';
import { mountGameForm } from './ui/game-form.js';
import { mountImport } from './ui/import-panel.js';
import { mountSettings } from './ui/settings.js';

const view = document.getElementById('view');
const navLinks = [...document.querySelectorAll('[data-route]')];

/** Rota atual a partir do hash: `#/game/abc?q=x` → { name, params, query }. */
export function getRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = qi === -1 ? raw : raw.slice(0, qi);
  const query = new URLSearchParams(qi === -1 ? '' : raw.slice(qi + 1));
  const game = path.match(/^\/game\/([^/]+)$/);
  if (path === '/' || path === '') return { name: 'library', params: {}, query };
  if (game) {
    let id = game[1];
    try { id = decodeURIComponent(id); } catch { /* mantém cru */ }
    return { name: 'game', params: { id }, query };
  }
  if (path === '/import') return { name: 'import', params: {}, query };
  if (path === '/settings') return { name: 'settings', params: {}, query };
  return { name: 'notfound', params: {}, query };
}

const TITLES = {
  library: 'library.title', game: 'game.title', import: 'import.title',
  settings: 'settings.title', notfound: 'notfound.title',
};

function el(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html.trim();
  return tpl.content.firstElementChild;
}

const head = (key) =>
  `<div class="view-head"><h1 class="t-heading" tabindex="-1" data-i18n="${key}"></h1></div>`;

function renderLibrary(_params, query) {
  const root = el('<div class="view"></div>');
  disposeView = mountLibrary(root, query);
  return root;
}

function renderGame({ id }, query) {
  const root = el('<div class="view"></div>');
  const mounted = mountGameForm(root, id, { store: query?.get('store') });
  disposeView = () => mounted.then((dispose) => dispose());
  return root;
}

function renderImport() {
  const root = el('<div class="view view--narrow"></div>');
  disposeView = mountImport(root);
  return root;
}

function renderSettings() {
  const root = el('<div class="view view--narrow"></div>');
  disposeView = mountSettings(root);
  return root;
}

const renderNotFound = () => el(`<div class="view view--narrow">
  ${head('notfound.title')}<hr class="divider">
  <p class="t-body measure" data-i18n="notfound.text"></p>
  <p><a class="btn cut-a-8 is-chamfered" href="#/">${icon('back')}<span data-i18n="common.back"></span></a></p></div>`);

const RENDERERS = {
  library: renderLibrary, game: renderGame, import: renderImport,
  settings: renderSettings, notfound: renderNotFound,
};

let lastKey = null;
let disposeView = null;

function render({ moveFocus = false } = {}) {
  const route = getRoute();
  const key = route.name + (route.params.id || '');
  disposeView?.();
  disposeView = null;
  view.replaceChildren(RENDERERS[route.name](route.params, route.query));
  applyI18n(view);

  navLinks.forEach((a) => {
    if (a.dataset.route === route.name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  document.title = `${t(TITLES[route.name])} — Gamedex`;

  if (moveFocus && key !== lastKey) {
    window.scrollTo(0, 0);
    view.querySelector('h1')?.focus({ preventScroll: true });
  }
  lastKey = key;
}

initI18n();
initLangToggle();
initThemeToggle();
onLangChange(() => render());
window.addEventListener('hashchange', () => render({ moveFocus: true }));
await loadStores(); // lojas criadas pelo usuário precisam estar prontas antes da primeira tela
render();
