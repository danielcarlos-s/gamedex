import { getLang, setLang, onLangChange, t } from './i18n/index.js';

/**
 * Liga o toggle EN | PT: botões `[data-lang]` com aria-pressed e aria-label traduzido.
 * @param {ParentNode} [root]
 */
export function initLangToggle(root = document) {
  const buttons = [...root.querySelectorAll('.lang-toggle [data-lang]')];
  const sync = () => {
    buttons.forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.lang === getLang()));
      b.setAttribute('aria-label', t('lang.name.' + b.dataset.lang));
    });
    root.querySelectorAll('.lang-toggle').forEach((g) => g.setAttribute('aria-label', t('lang.group')));
  };
  buttons.forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  onLangChange(sync);
  sync();
}
