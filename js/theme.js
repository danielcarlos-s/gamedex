// Tema claro/escuro (DESIGN-SYSTEM seções 2 e 7): atributo `data-theme` no <html>, `applyTheme()` suprime transições
// por um frame (senão a troca congela no meio). A escolha fica em `localStorage` (`portfolio-theme`, para pintar sem
// piscar) e espelhada em `meta.theme` no IndexedDB (é isso que vai no backup).

import { db } from './data-source.js';
import { t, onLangChange } from './i18n/index.js';
import { icon } from './icons.js';

const KEY = 'portfolio-theme';
const THEMES = ['dark', 'light'];

/** @type {Set<(theme: string) => void>} */
const listeners = new Set();

/**
 * @param {unknown} v
 * @returns {v is 'light'|'dark'}
 */
export const isTheme = (v) => THEMES.includes(/** @type {string} */ (v));

/** @returns {'light'|'dark'} tema atual (padrão: escuro) */
export function getTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (isTheme(attr)) return attr;
  try {
    const v = localStorage.getItem(KEY);
    if (isTheme(v)) return v;
  } catch { /* sem localStorage: usa o padrão */ }
  return 'dark';
}

/**
 * Aplica e guarda o tema. `mirror: false` evita regravar em `meta.theme` (usado quando o valor acabou de vir de lá).
 * @param {'light'|'dark'} theme
 * @param {{ mirror?: boolean }} [options]
 */
export function applyTheme(theme, { mirror = true } = {}) {
  if (!isTheme(theme)) return;
  const root = document.documentElement;
  root.classList.add('theme-switching');
  root.setAttribute('data-theme', theme);
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
  try { localStorage.setItem(KEY, theme); } catch { /* sem localStorage */ }
  if (mirror) db.setMeta('theme', theme).catch(() => { /* sem IndexedDB: só localStorage */ });
  listeners.forEach((cb) => cb(theme));
}

/**
 * Liga o botão `[data-theme-toggle]`: um clique alterna; o botão mostra o ícone do tema PARA O QUAL vai trocar.
 * Se o banco tiver um tema (ex.: backup restaurado em outro navegador) e o localStorage estiver vazio, usa o do banco.
 * @param {ParentNode} [root]
 */
export async function initThemeToggle(root = document) {
  const btn = root.querySelector('[data-theme-toggle]');
  if (!btn) return;
  const sync = () => {
    const light = getTheme() === 'light';
    btn.setAttribute('aria-pressed', String(light));
    btn.setAttribute('aria-label', t(light ? 'theme.toDark' : 'theme.toLight'));
    btn.setAttribute('title', t(light ? 'theme.toDark' : 'theme.toLight'));
    btn.innerHTML = icon(light ? 'moon' : 'sun');
  };
  btn.addEventListener('click', () => applyTheme(getTheme() === 'light' ? 'dark' : 'light'));
  listeners.add(sync);
  onLangChange(sync);
  sync();
  try {
    let stored = null;
    try { stored = localStorage.getItem(KEY); } catch { /* ignora */ }
    if (!isTheme(stored)) {
      const saved = await db.getMeta('theme');
      if (isTheme(saved) && saved !== getTheme()) applyTheme(saved, { mirror: false });
    }
  } catch { /* sem IndexedDB */ }
}
