/**
 * Menu da engrenagem (Importar, Ajustes): botão que abre/fecha um painel de links (padrão "disclosure").
 * Fecha com Esc (devolve o foco ao botão), clique fora, escolha de um item ou troca de rota; Tab para fora também fecha.
 */
export function initNavMenu() {
  const root = document.querySelector('[data-menu]');
  if (!root) return;
  const btn = /** @type {HTMLButtonElement} */ (root.querySelector('[data-menu-btn]'));
  const panel = /** @type {HTMLElement} */ (root.querySelector('.menu__panel'));

  const set = (open, focusBtn = false) => {
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (!open && focusBtn) btn.focus();
  };
  btn.addEventListener('click', () => set(panel.hidden));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { e.stopPropagation(); set(false, true); }
    if (e.key === 'ArrowDown' && panel.hidden && document.activeElement === btn) { e.preventDefault(); set(true); panel.querySelector('a')?.focus(); }
  });
  panel.addEventListener('click', (e) => { if (/** @type {HTMLElement} */ (e.target).closest('a')) set(false); });
  document.addEventListener('click', (e) => { if (!root.contains(/** @type {Node} */ (e.target))) set(false); });
  root.addEventListener('focusout', (e) => { if (!root.contains(/** @type {Node|null} */ (e.relatedTarget)) && e.relatedTarget) set(false); });
  window.addEventListener('hashchange', () => set(false));
}
