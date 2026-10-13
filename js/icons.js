// Ícones SVG inline (nunca glifo/emoji). Cada entrada é o miolo de um viewBox 24x24.
const PATHS = {
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5 21 21"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  star: '<path d="m12 3 2.7 5.8 6.3.8-4.6 4.4 1.2 6.3L12 17.2 6.4 20.3l1.2-6.3L3 9.6l6.3-.8Z"/>',
  heart: '<path d="M12 20.5 4.2 12.8a4.6 4.6 0 0 1 6.5-6.5L12 7.6l1.3-1.3a4.6 4.6 0 0 1 6.5 6.5Z"/>',
  library: '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v4h16v-4"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  alert: '<path d="M12 3 2.5 20h19Z"/><path d="M12 10v5M12 17.5v.5"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.2.9-1.2 1.8M12 17v.5"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
};

const FILLED = new Set(['star', 'heart']);

/**
 * Devolve o markup de um ícone SVG inline (decorativo: aria-hidden).
 * @param {string} name chave de PATHS
 * @param {{filled?: boolean, size?: number, className?: string}} [opts]
 * @returns {string}
 */
export function icon(name, opts = {}) {
  const body = PATHS[name];
  if (!body) return '';
  const filled = opts.filled ?? false;
  const cls = ['icon', filled && FILLED.has(name) ? 'icon--fill' : '', opts.className || ''].filter(Boolean).join(' ');
  const size = opts.size ? ` width="${opts.size}" height="${opts.size}"` : '';
  return `<svg class="${cls}"${size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">${body}</svg>`;
}

export const iconNames = Object.keys(PATHS);
