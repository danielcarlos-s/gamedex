import { initI18n, applyI18n, onLangChange, t, formatPlaytime, formatNumber } from '../js/i18n/index.js';
import { initLangToggle } from '../js/lang-toggle.js';
import { icon, iconNames } from '../js/icons.js';

const STORES = ['steam', 'epic', 'gog', 'ubisoft', 'ea', 'amazon', 'other'];
const STATUSES = ['backlog', 'playing', 'paused', 'finished', 'completed', 'dropped'];

const storeChip = (s) => `<span class="chip chip--store chip--${s} cut-a-4" data-i18n="store.${s}"></span>`;
const statusChip = (s) => `<span class="chip ${s === 'playing' ? 'chip--playing' : ''} cut-a-4" data-i18n="status.${s}"></span>`;

const card = (titleKey, stores, status, minutes, cover) => `
  <article class="card">
    <div class="card__cover">${cover ? '' : `<div class="cover-ph" data-i18n="${titleKey}"></div>`}</div>
    <div class="card__body">
      <h3 class="card__title" data-i18n="${titleKey}"></h3>
      <div class="card__meta">${stores.map(storeChip).join('')}${statusChip(status)}</div>
      <p class="t-data" data-role="time" data-min="${minutes}"></p>
    </div>
    <a class="card__link" href="#" aria-label="" data-i18n-attr="aria-label:${titleKey}"></a>
  </article>`;

const section = (titleKey, body) =>
  `<section class="stack"><h2 class="t-section" data-i18n="${titleKey}"></h2><hr class="divider">${body}</section>`;

const stars = (n) => `<span class="stars" role="img" data-rating="${n}">${[1, 2, 3, 4, 5]
  .map((i) => icon('star', { filled: i <= n, className: i <= n ? '' : 'is-off' })).join('')}</span>`;

const html = `
  <div class="view-head"><h1 class="t-heading" data-i18n="ks.title"></h1></div>
  <p class="t-body measure" data-i18n="ks.intro"></p>

  ${section('ks.buttons', `<div class="row">
    <button class="btn cut-a-8 is-chamfered" type="button" data-i18n="ks.btn.default"></button>
    <button class="btn btn--primary cut-a-8 is-chamfered" type="button" data-i18n="ks.btn.primary"></button>
    <button class="btn btn--ghost cut-a-8 is-chamfered" type="button" data-i18n="ks.btn.ghost"></button>
    <button class="btn cut-a-8 is-chamfered" type="button" disabled data-i18n="ks.btn.disabled"></button>
    <button class="btn btn--icon cut-a-6 is-chamfered" type="button" aria-label="" data-i18n-attr="aria-label:common.search">${icon('search')}</button>
    <button class="btn btn--icon cut-a-6 is-chamfered" type="button" aria-label="" data-i18n-attr="aria-label:common.delete">${icon('trash')}</button>
    <button class="btn btn--icon cut-a-6 is-chamfered" type="button" aria-label="" data-i18n-attr="aria-label:common.close">${icon('close')}</button>
  </div>`)}

  ${section('ks.chips', `<div class="row">${STORES.map(storeChip).join('')}</div><div class="row">${STATUSES.map(statusChip).join('')}</div>`)}

  ${section('ks.filters', `<div class="row" data-role="filters">${STORES.map((s) =>
    `<button class="chip-btn cut-a-4 is-chamfered" type="button" aria-pressed="false" data-store="${s}"><span data-i18n="store.${s}"></span><span class="chip-btn__count" data-count></span></button>`).join('')}</div>`)}

  ${section('ks.inputs', `<div class="stack ks-grid">
    <div class="field"><label class="field__label" for="ks-a" data-i18n="ks.field.label"></label>
      <input id="ks-a" class="input cut-a-6 is-chamfered" type="text" data-i18n-attr="value:ks.field.value"></div>
    <div class="field"><label class="field__label" for="ks-b" data-i18n="ks.field.label"></label>
      <input id="ks-b" class="input cut-a-6 is-chamfered" type="text" aria-invalid="true" aria-describedby="ks-b-err" placeholder="">
      <p class="field__error" id="ks-b-err" data-i18n="ks.field.error"></p></div>
    <div class="field"><label class="field__label" for="ks-c" data-i18n="common.search"></label>
      <input id="ks-c" class="input cut-a-6 is-chamfered" type="search" data-i18n-attr="placeholder:filters.search.placeholder"></div>
  </div>`)}

  ${section('ks.card', `<div class="grid ks-grid">
    ${card('ks.card.title.short', ['steam', 'gog'], 'playing', 4510, false)}
    ${card('ks.card.title.long', ['epic'], 'backlog', 0, false)}
  </div>`)}

  ${section('ks.states', `<div class="stack">
    <div class="state panel panel--live" role="status"><div class="loader"></div><span class="t-label" data-i18n="state.loading"></span></div>
    <div class="state panel" role="alert"><span class="row">${icon('alert')}<span class="state__title" data-i18n="state.error.title"></span></span>
      <p class="t-body" data-i18n="err.profile_private"></p>
      <button class="btn cut-a-8 is-chamfered" type="button" data-i18n="state.retry"></button></div>
    <div class="state panel panel--live"><span class="state__title" data-i18n="state.empty.title"></span>
      <p class="t-body" data-i18n="state.empty.text"></p>
      <a class="btn btn--primary cut-a-8 is-chamfered" href="#" data-i18n="state.empty.cta"></a></div>
    <div class="state panel" role="status"><span class="row">${icon('check')}<span class="state__title" data-i18n="state.success.title"></span></span>
      <p class="t-body" data-i18n="state.success.text"></p></div>
  </div>`)}

  ${section('ks.rating', `<div class="row">${stars(0)}${stars(3)}${stars(5)}
    <button class="btn btn--icon cut-a-6 is-chamfered" type="button" id="ks-fav" aria-pressed="false" aria-label="" data-i18n-attr="aria-label:common.favorite">${icon('heart')}</button></div>`)}

  ${section('ks.icons', `<div class="ks-icons">${iconNames.map((n) => icon(n)).join('')}</div>`)}

  ${section('ks.cuts', `<div class="row">
    <div class="ks-cut cut-a-4"></div><div class="ks-cut cut-a-6"></div><div class="ks-cut cut-a-8"></div>
    <div class="ks-cut ks-cut--b cut-b-24"></div></div>
    <p class="t-body" data-i18n="ks.cut.a"></p><p class="t-body" data-i18n="ks.cut.b"></p>`)}

  ${section('ks.type', `<div class="stack">
    <p class="t-heading" data-i18n="ks.type.heading"></p>
    <p class="t-section" data-i18n="ks.type.section"></p>
    <p class="t-label" data-i18n="ks.type.label"></p>
    <p class="t-body measure" data-i18n="ks.type.body"></p>
    <p class="t-data" data-i18n="ks.type.data"></p>
    <div class="panel panel--live"><span class="t-section" data-i18n="ks.panel"></span></div>
  </div>`)}
`;

const root = document.getElementById('ks');
root.innerHTML = html;

root.querySelector('#ks-fav').addEventListener('click', (e) => {
  const b = e.currentTarget;
  b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true'));
});
root.querySelectorAll('[data-role="filters"] .chip-btn').forEach((b, i) => {
  b.querySelector('[data-count]').textContent = formatNumber((i + 1) * 37);
  b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
});

function dynamic() {
  root.querySelectorAll('[data-role="time"]').forEach((p) => { p.textContent = formatPlaytime(Number(p.dataset.min)); });
  root.querySelectorAll('.stars').forEach((s) => s.setAttribute('aria-label', t('rating.label', { n: s.dataset.rating })));
  root.querySelectorAll('input[data-i18n-attr*="value"]').forEach((i) => { i.value = t('ks.field.value'); });
}

initI18n();
initLangToggle();
applyI18n(root);
dynamic();
onLangChange(dynamic);
const setTitle = () => { document.title = `${t('ks.title')} — Gamedex`; };
setTitle();
onLangChange(setTitle);
