/**
 * Menu "disclosure": um botão abre/fecha um painel de links. Fecha com Esc (devolve o foco ao botão), clique fora,
 * escolha de um item, troca de rota ou Tab para fora. Setas ↑/↓ navegam pelos itens (↓ no botão abre e foca o 1º).
 * Markup: `[data-menu]` > `[data-menu-btn]` + `.menu__panel`. Devolve a função de limpeza.
 * @param {Element|null} root
 * @returns {() => void}
 */
export function initDisclosure(root) {
  if (!root) return () => {};
  const btn = /** @type {HTMLButtonElement} */ (root.querySelector('[data-menu-btn]'));
  const panel = /** @type {HTMLElement} */ (root.querySelector('.menu__panel'));
  const items = () => /** @type {HTMLElement[]} */ ([...panel.querySelectorAll('a, button')]);

  const set = (open, focusBtn = false) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open && focusBtn) btn.focus();
  };
  const onKey = (/** @type {KeyboardEvent} */ e) => {
    if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); set(false, true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const list = items();
    if (panel.hidden) {
      if (document.activeElement !== btn) return;
      e.preventDefault(); set(true); list[e.key === 'ArrowUp' ? list.length - 1 : 0]?.focus();
      return;
    }
    const i = list.indexOf(/** @type {HTMLElement} */ (document.activeElement));
    e.preventDefault();
    if (i === -1) list[e.key === 'ArrowUp' ? list.length - 1 : 0]?.focus();
    else list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length].focus();
  };
  const onDocClick = (/** @type {MouseEvent} */ e) => { if (!root.contains(/** @type {Node} */ (e.target))) set(false); };
  const onHash = () => set(false);
  btn.addEventListener('click', () => set(panel.hidden));
  root.addEventListener('keydown', onKey);
  panel.addEventListener('click', (e) => { if (/** @type {HTMLElement} */ (e.target).closest('a')) set(false); });
  root.addEventListener('focusout', (e) => { if (!root.contains(/** @type {Node|null} */ (e.relatedTarget)) && e.relatedTarget) set(false); });
  document.addEventListener('click', onDocClick);
  window.addEventListener('hashchange', onHash);
  return () => { document.removeEventListener('click', onDocClick); window.removeEventListener('hashchange', onHash); };
}

/** Menu da engrenagem do cabeçalho (Importar, Backup, Ajustes). */
export function initNavMenu() {
  initDisclosure(document.querySelector('[data-menu]'));
}
