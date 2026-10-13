import { t, formatNumber } from '../i18n/index.js';
import { icon } from '../icons.js';
import { STORES } from '../data/model.js';
import { allStoreIds, customStore, onStoresChange, createStore, CUSTOM_HUES, MAX_NAME } from '../data/stores.js';
import { esc, storeLabel } from './grid.js';

const dotAttrs = (id) => {
  const c = customStore(id);
  if (c) return { cls: 'chip--custom', style: ` style="--h:${c.hue}"` };
  return { cls: STORES.includes(/** @type {any} */ (id)) ? `chip--${id}` : 'chip--other', style: '' };
};

/**
 * Abas de loja da biblioteca: "Todos os jogos" + uma por loja (fixas e criadas), sempre visíveis, seleção única
 * (`state.store`, null = todas). Padrão ARIA de abas com ativação automática: setas, Home/End, tabindex móvel.
 * O botão "+ Nova loja" fica fora do tablist e abre um formulário inline.
 * @param {HTMLElement} slot onde montar
 * @param {{ store: string|null }} state
 * @param {(state: any) => void} onChange chamado quando a aba muda ou a lista de lojas muda
 * @param {{ panelId: string }} opts id do painel (a grade) controlado pelas abas
 * @returns {{ update: (state: any, counts: any) => void, destroy: () => void }}
 */
export function mountStoreTabs(slot, state, onChange, { panelId }) {
  slot.innerHTML = `
    <div class="store-strip">
      <div class="tabs" role="tablist" aria-label="${esc(t('tabs.label'))}" data-role="tablist"></div>
      <button class="btn btn--ghost cut-a-8 is-chamfered" type="button" data-role="new-store" aria-expanded="false" aria-controls="ns-form">${icon('plus')}<span>${esc(t('tabs.new'))}</span></button>
    </div>
    <form class="panel stack" id="ns-form" data-role="new-form" hidden novalidate>
      <div class="field"><label class="field__label" for="ns-name">${esc(t('settings.stores.name'))}</label>
        <input id="ns-name" class="input cut-a-6 is-chamfered" type="text" maxlength="${MAX_NAME}" autocomplete="off"></div>
      <div class="swatches" role="radiogroup" aria-label="${esc(t('settings.stores.color'))}">${CUSTOM_HUES.map((h, i) => `<button type="button" class="swatch cut-a-4 is-chamfered" role="radio" aria-checked="${i === 0}" data-hue="${h}" style="--h:${h}" aria-label="${esc(t('settings.stores.colorn', { n: i + 1 }))}"></button>`).join('')}</div>
      <p class="t-hint form-error" role="alert" data-role="ns-error" hidden></p>
      <div class="row">
        <button type="submit" class="btn btn--primary cut-a-8 is-chamfered">${icon('plus')}<span>${esc(t('settings.stores.create'))}</span></button>
        <button type="button" class="btn cut-a-8 is-chamfered" data-role="ns-cancel">${esc(t('common.cancel'))}</button>
      </div>
    </form>`;

  const $ = (sel) => /** @type {HTMLElement} */ (slot.querySelector(sel));
  const list = $('[data-role="tablist"]');
  const newBtn = $('[data-role="new-store"]');
  const form = /** @type {HTMLFormElement} */ ($('[data-role="new-form"]'));
  const nameInput = /** @type {HTMLInputElement} */ ($('#ns-name'));
  const errEl = $('[data-role="ns-error"]');
  let hue = CUSTOM_HUES[0];
  let sig = '';

  const tabEls = () => [...list.querySelectorAll('[role="tab"]')];
  const tabValue = (el) => el.dataset.store || null;

  function build(ids) {
    const mk = (id, label, dot) => `<button class="tab cut-a-6 is-chamfered" type="button" role="tab" id="tab-${id ?? 'all'}" ${id ? `data-store="${esc(id)}"` : ''} aria-selected="false" aria-controls="${panelId}" tabindex="-1">${dot}<span class="tab__label">${esc(label)}</span><span class="tab__count" data-count></span></button>`;
    list.innerHTML = mk(null, t('tabs.all'), '') + ids.map((id) => {
      const d = dotAttrs(id);
      return mk(id, storeLabel(id), `<i class="tab__dot ${d.cls}"${d.style} aria-hidden="true"></i>`);
    }).join('');
  }

  function update(s, counts) {
    const ids = allStoreIds();
    const nextSig = ids.map((id) => `${id}:${storeLabel(id)}:${customStore(id)?.hue ?? ''}`).join('|');
    if (nextSig !== sig) { sig = nextSig; build(ids); }
    const active = s.store || null;
    tabEls().forEach((el) => {
      const v = tabValue(el);
      const on = v === active;
      el.setAttribute('aria-selected', String(on));
      el.tabIndex = on ? 0 : -1;
      const n = v ? (counts.stores[v] || 0) : counts.all;
      el.querySelector('[data-count]').textContent = formatNumber(n);
      el.classList.toggle('is-empty', n === 0);
    });
    document.getElementById(panelId)?.setAttribute('aria-labelledby', `tab-${active ?? 'all'}`);
    const cur = list.querySelector('[aria-selected="true"]');
    if (cur && list.dataset.scrolled !== String(active)) {
      list.dataset.scrolled = String(active);
      cur.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    }
  }

  function select(el) {
    state.store = tabValue(el);
    onChange(state);
    list.querySelector(`#${CSS.escape(el.id)}`)?.focus();
  }

  list.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target).closest('[role="tab"]');
    if (el) select(el);
  });
  list.addEventListener('keydown', (e) => {
    const tabs = tabEls();
    const i = tabs.indexOf(/** @type {Element} */ (document.activeElement));
    if (i < 0) return;
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabs.length - 1;
    if (n < 0) return;
    e.preventDefault();
    select(tabs[n]);
  });

  // ---- nova loja (inline)
  const showError = (code) => {
    errEl.hidden = !code;
    errEl.textContent = code ? t('err.' + code) : '';
  };
  const closeForm = (focusBtn) => {
    form.hidden = true;
    newBtn.setAttribute('aria-expanded', 'false');
    showError(null);
    if (focusBtn) newBtn.focus();
  };
  newBtn.addEventListener('click', () => {
    if (!form.hidden) { closeForm(true); return; }
    form.hidden = false;
    newBtn.setAttribute('aria-expanded', 'true');
    nameInput.value = '';
    nameInput.focus();
  });
  $('[data-role="ns-cancel"]').addEventListener('click', () => closeForm(true));
  form.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeForm(true); } });
  form.querySelector('.swatches').addEventListener('click', (e) => {
    const b = /** @type {HTMLElement} */ (e.target).closest('.swatch');
    if (!b) return;
    hue = Number(b.dataset.hue);
    form.querySelectorAll('.swatch').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const s = await createStore(nameInput.value, hue);
      closeForm(false);
      state.store = s.id;
      onChange(state);
      document.getElementById(`tab-${s.id}`)?.focus();
    } catch (err) {
      showError(/** @type {any} */ (err)?.code || 'idb_unavailable');
      nameInput.focus();
    }
  });

  // loja criada/renomeada/excluída (inclusive em outra tela ou por backup): refaz as abas
  const off = onStoresChange(() => onChange(state));
  return { update, destroy: off };
}
