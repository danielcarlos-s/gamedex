import { t, formatDate } from '../i18n/index.js';
import { icon } from '../icons.js';
import { db } from '../data-source.js';
import { createGame, createOwnership, normalizeTitle, recalcTotals, validateGame, splitOwnership } from '../data/model.js';
import { searchCover } from '../importers/covers.js';
import { WORKER_URL } from '../config.js';
import { esc, bindCoverFallback } from './grid.js';
import { STORE_ORDER, STATUS_ORDER } from './filters.js';

const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
const num = (s) => (String(s).trim() === '' ? null : Number(s));
const isHttpUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };

const field = (id, labelKey, input, errKey, errors) => `
  <div class="field">
    <label class="field__label" for="${id}">${esc(t(labelKey))}</label>
    ${input}
    ${errors[errKey] ? `<p class="field__error" id="${id}-err">${esc(t('err.' + errors[errKey]))}</p>` : ''}
  </div>`;

const attrs = (id, errKey, errors) => `id="${id}"${errors[errKey] ? ` aria-invalid="true" aria-describedby="${id}-err"` : ''}`;

/**
 * Tela de detalhe/edição/cadastro. `id` = 'new' cria um jogo manual.
 * @param {HTMLElement} root
 * @param {string} id
 * @returns {Promise<() => void>} limpeza
 */
export async function mountGameForm(root, id) {
  const isNew = id === 'new';
  let draft;
  let disposed = false;
  let errors = {};
  let message = '';
  let confirmDelete = false;
  let cover = { open: false, loading: false, items: null, error: null };

  root.innerHTML = `<div class="state panel panel--live" role="status"><div class="loader"></div><span class="t-label">${esc(t('state.loading'))}</span></div>`;
  try {
    if (isNew) draft = createGame({ ownerships: [{ store: 'other', source: 'manual' }] });
    else draft = await db.getGame(id);
  } catch (e) {
    root.innerHTML = errorView(e?.code || 'idb_unavailable');
    return () => {};
  }
  if (disposed) return () => {};
  if (!draft) {
    root.innerHTML = `<div class="view-head"><h1 class="t-heading" tabindex="-1">${esc(t('game.notfound.title'))}</h1></div><hr class="divider">
      <p class="t-body measure">${esc(t('game.notfound.text'))}</p>
      <p><a class="btn cut-a-8 is-chamfered" href="#/">${icon('back')}<span>${esc(t('common.back'))}</span></a></p>`;
    return () => {};
  }

  function errorView(code) {
    return `<div class="state panel" role="alert"><span class="row">${icon('alert')}<span class="state__title">${esc(t('state.error.title'))}</span></span>
      <p class="t-body">${esc(t('err.' + code))}</p></div>`;
  }

  // ---- leitura do formulário para o rascunho ----
  const $ = (sel) => root.querySelector(sel);
  function sync() {
    if (!$('#g-title')) return;
    draft.title = $('#g-title').value;
    draft.status = $('#g-status').value;
    draft.developer = $('#g-developer').value.trim() || null;
    draft.year = num($('#g-year').value);
    draft.startedAt = $('#g-started').value || null;
    draft.finishedAt = $('#g-finished').value || null;
    draft.genres = csv($('#g-genres').value);
    draft.tags = csv($('#g-tags').value);
    draft.achievementsDone = num($('#g-achdone').value);
    draft.achievementsTotal = num($('#g-achtotal').value);
    draft.notes = $('#g-notes').value;
    draft.links = [...root.querySelectorAll('[data-link]')].map((row) => ({
      label: row.querySelector('[data-f="label"]').value.trim(),
      url: row.querySelector('[data-f="url"]').value.trim(),
    }));
    root.querySelectorAll('[data-own]').forEach((row, i) => {
      const o = draft.ownerships[i];
      if (!o) return;
      o.store = row.querySelector('[data-f="store"]').value;
      o.playtimeMinutes = num(row.querySelector('[data-f="playtime"]').value);
      o.storeGameId = row.querySelector('[data-f="sid"]').value.trim() || null;
    });
  }

  // ---- validação ----
  function validate() {
    errors = {};
    draft.titleKey = normalizeTitle(draft.title);
    const res = validateGame(draft);
    res.errors.forEach((e) => {
      const m = e.field.match(/^ownerships\[(\d+)\]\.(\w+)/);
      if (m) errors[`own.${m[1]}.${m[2] === 'playtimeMinutes' ? 'playtime' : m[2]}`] = e.code;
      else errors[e.field] = e.code;
    });
    draft.links = draft.links.filter((l) => l.label || l.url);
    draft.links.forEach((l, i) => { if (!isHttpUrl(l.url)) errors[`link.${i}`] = 'invalid_url'; });
    const seen = new Set();
    draft.ownerships.forEach((o, i) => { if (seen.has(o.store)) errors[`own.${i}.store`] = 'duplicate_store'; seen.add(o.store); });
    if (draft.startedAt && draft.finishedAt && draft.finishedAt < draft.startedAt) errors.finishedAt = 'date_order';
    return Object.keys(errors).length === 0;
  }

  // ---- render ----
  function ratingHtml() {
    const cur = draft.rating || 0;
    const tabbable = cur || 1;
    return `<div class="rating" role="radiogroup" aria-label="${esc(t('game.field.rating'))}">${[1, 2, 3, 4, 5].map((n) => `
      <button type="button" class="rating__star is-chamfered cut-a-6" role="radio" aria-checked="${cur === n}" tabindex="${n === tabbable ? 0 : -1}"
        data-action="rate" data-value="${n}" aria-label="${esc(t('rating.label', { n }))}">${icon('star', { filled: n <= cur })}</button>`).join('')}
      <button type="button" class="btn btn--ghost cut-a-8 is-chamfered" data-action="rate" data-value="0" ${cur ? '' : 'disabled'}>${esc(t('game.rating.clear'))}</button></div>
      ${errors.rating ? `<p class="field__error">${esc(t('err.' + errors.rating))}</p>` : ''}`;
  }

  function coverHtml() {
    const img = draft.coverUrl
      ? `<img src="${esc(draft.coverUrl)}" alt="" data-title="${esc(draft.title)}" ${draft.coverAppId ? `data-appid="${esc(draft.coverAppId)}"` : ''}>`
      : `<div class="cover-ph">${esc(draft.title || t('game.new'))}</div>`;
    let panel = '';
    if (cover.open) {
      panel = `<div class="cover-results" role="group" aria-label="${esc(t('game.cover.results'))}">`;
      if (cover.loading) panel += `<div class="loader"></div><p class="t-label" role="status">${esc(t('game.cover.searching'))}</p>`;
      else if (cover.error) panel += `<p class="field__error" role="alert">${esc(t('err.' + cover.error))}</p>`;
      else if (!cover.items.length) panel += `<p class="t-body" role="status">${esc(t('game.cover.none'))}</p>`;
      else panel += cover.items.map((it, i) => `<button type="button" class="cover-pick cut-a-6 is-chamfered" data-action="cover-pick" data-i="${i}" aria-label="${esc(t('game.cover.pick', { name: it.name }))}">
          <img src="${esc(it.coverUrl)}" alt="" loading="lazy"><span>${esc(it.name)}</span></button>`).join('');
      panel += '</div>';
    }
    return `<div class="detail__cover cut-b-24">${img}</div>
      <div class="stack">
        <button type="button" class="btn cut-a-8 is-chamfered" data-action="cover-search">${icon('search')}<span>${esc(t('game.cover.search'))}</span></button>
        ${panel}
        <div class="field"><label class="field__label" for="g-coverurl">${esc(t('game.cover.url'))}</label>
          <input ${attrs('g-coverurl', 'coverUrl', errors)} class="input cut-a-6 is-chamfered" type="url" inputmode="url" value="">
          ${errors.coverUrl ? `<p class="field__error" id="g-coverurl-err">${esc(t('err.' + errors.coverUrl))}</p>` : ''}</div>
        <div class="row">
          <button type="button" class="btn cut-a-8 is-chamfered" data-action="cover-apply">${esc(t('game.cover.apply'))}</button>
          ${draft.coverUrl ? `<button type="button" class="btn btn--ghost cut-a-8 is-chamfered" data-action="cover-remove">${esc(t('game.cover.remove'))}</button>` : ''}
        </div>
      </div>`;
  }

  function ownershipsHtml() {
    const multi = draft.ownerships.length > 1;
    const distinct = new Set(draft.ownerships.map((o) => o.store)).size > 1;
    return draft.ownerships.map((o, i) => `
      <div class="own" data-own="${i}">
        <div class="field"><label class="field__label" for="own-${i}-store">${esc(t('game.store.select'))}</label>
          <select ${attrs(`own-${i}-store`, `own.${i}.store`, errors)} class="input cut-a-6 is-chamfered" data-f="store">
            ${STORE_ORDER.map((s) => `<option value="${s}" ${s === o.store ? 'selected' : ''}>${esc(t('store.' + s))}</option>`).join('')}</select>
          ${errors[`own.${i}.store`] ? `<p class="field__error" id="own-${i}-store-err">${esc(t('err.' + errors[`own.${i}.store`]))}</p>` : ''}</div>
        <div class="field"><label class="field__label" for="own-${i}-play">${esc(t('game.store.playtime'))}</label>
          <input ${attrs(`own-${i}-play`, `own.${i}.playtime`, errors)} class="input cut-a-6 is-chamfered" data-f="playtime" type="number" min="0" step="1" inputmode="numeric" value="${o.playtimeMinutes ?? ''}">
          ${errors[`own.${i}.playtime`] ? `<p class="field__error" id="own-${i}-play-err">${esc(t('err.' + errors[`own.${i}.playtime`]))}</p>` : ''}</div>
        <div class="field"><label class="field__label" for="own-${i}-sid">${esc(t('game.store.id'))}</label>
          <input id="own-${i}-sid" class="input cut-a-6 is-chamfered" data-f="sid" type="text" value="${esc(o.storeGameId ?? '')}"></div>
        <p class="t-body own__last"><span class="t-label">${esc(t('game.store.lastplayed'))}</span> ${esc(formatDate(o.lastPlayedAt))}</p>
        <div class="row">
          ${distinct ? `<button type="button" class="btn cut-a-8 is-chamfered" data-action="split" data-store="${esc(o.store)}">${esc(t('game.store.split'))}</button>` : ''}
          ${multi ? `<button type="button" class="btn btn--ghost cut-a-8 is-chamfered" data-action="own-remove" data-i="${i}">${icon('trash')}<span>${esc(t('game.store.remove'))}</span></button>` : ''}
        </div>
      </div>`).join('');
  }

  function linksHtml() {
    return draft.links.map((l, i) => `
      <div class="linkrow" data-link="${i}">
        <div class="field"><label class="field__label" for="link-${i}-label">${esc(t('game.link.label'))}</label>
          <input id="link-${i}-label" class="input cut-a-6 is-chamfered" data-f="label" type="text" value="${esc(l.label)}"></div>
        <div class="field"><label class="field__label" for="link-${i}-url">${esc(t('game.link.url'))}</label>
          <input ${attrs(`link-${i}-url`, `link.${i}`, errors)} class="input cut-a-6 is-chamfered" data-f="url" type="url" inputmode="url" value="${esc(l.url)}">
          ${errors[`link.${i}`] ? `<p class="field__error" id="link-${i}-url-err">${esc(t('err.' + errors[`link.${i}`]))}</p>` : ''}</div>
        <button type="button" class="btn btn--icon cut-a-6 is-chamfered" data-action="link-remove" data-i="${i}" aria-label="${esc(t('game.link.remove'))}">${icon('trash')}</button>
      </div>`).join('');
  }

  function render(focusSel) {
    const hasErr = Object.keys(errors).length > 0;
    root.innerHTML = `
      <div class="view-head">
        <h1 class="t-heading" tabindex="-1">${esc(isNew ? t('game.new') : (draft.title || t('game.title')))}</h1>
        <a class="btn btn--ghost cut-a-8 is-chamfered" href="#/">${icon('back')}<span>${esc(t('common.back'))}</span></a>
      </div>
      <hr class="divider">
      <div class="status-line" role="status" aria-live="polite">${hasErr ? `<p class="field__error">${esc(t('game.errors.summary'))}</p>` : message ? `<p class="t-label">${esc(message)}</p>` : ''}</div>
      <form class="detail" novalidate>
        <div class="detail__side">${coverHtml()}</div>
        <div class="detail__main stack">
          ${field('g-title', 'game.field.title', `<input ${attrs('g-title', 'title', errors)} class="input cut-a-6 is-chamfered" type="text" required value="${esc(draft.title)}">`, 'title', errors)}
          <div class="fgrid">
            ${field('g-status', 'game.field.status', `<select id="g-status" class="input cut-a-6 is-chamfered">${STATUS_ORDER.map((s) => `<option value="${s}" ${s === draft.status ? 'selected' : ''}>${esc(t('status.' + s))}</option>`).join('')}</select>`, 'status', errors)}
            <div class="field"><span class="field__label">${esc(t('common.favorite'))}</span>
              <button type="button" class="btn cut-a-6 is-chamfered" data-action="fav" aria-pressed="${!!draft.favorite}" aria-label="${esc(t('common.favorite'))}">${icon('heart', { filled: !!draft.favorite })}<span>${esc(t(draft.favorite ? 'game.fav.on' : 'game.fav.off'))}</span></button></div>
          </div>
          <div class="field"><span class="field__label" id="g-rating-l">${esc(t('game.field.rating'))}</span>${ratingHtml()}</div>
          <div class="fgrid">
            ${field('g-developer', 'game.field.developer', `<input id="g-developer" class="input cut-a-6 is-chamfered" type="text" value="${esc(draft.developer ?? '')}">`, 'developer', errors)}
            ${field('g-year', 'game.field.year', `<input ${attrs('g-year', 'year', errors)} class="input cut-a-6 is-chamfered" type="number" min="0" step="1" inputmode="numeric" value="${draft.year ?? ''}">`, 'year', errors)}
            ${field('g-started', 'game.field.started', `<input id="g-started" class="input cut-a-6 is-chamfered" type="date" value="${esc(draft.startedAt ?? '')}">`, 'startedAt', errors)}
            ${field('g-finished', 'game.field.finished', `<input ${attrs('g-finished', 'finishedAt', errors)} class="input cut-a-6 is-chamfered" type="date" value="${esc(draft.finishedAt ?? '')}">`, 'finishedAt', errors)}
            ${field('g-achdone', 'game.field.achdone', `<input ${attrs('g-achdone', 'achievementsDone', errors)} class="input cut-a-6 is-chamfered" type="number" min="0" step="1" inputmode="numeric" value="${draft.achievementsDone ?? ''}">`, 'achievementsDone', errors)}
            ${field('g-achtotal', 'game.field.achtotal', `<input ${attrs('g-achtotal', 'achievementsTotal', errors)} class="input cut-a-6 is-chamfered" type="number" min="0" step="1" inputmode="numeric" value="${draft.achievementsTotal ?? ''}">`, 'achievementsTotal', errors)}
          </div>
          ${field('g-genres', 'game.field.genres', `<input id="g-genres" class="input cut-a-6 is-chamfered" type="text" value="${esc(draft.genres.join(', '))}">`, 'genres', errors)}
          ${field('g-tags', 'game.field.tags', `<input id="g-tags" class="input cut-a-6 is-chamfered" type="text" value="${esc(draft.tags.join(', '))}">`, 'tags', errors)}

          <h2 class="t-section">${esc(t('game.stores'))}</h2><hr class="divider">
          ${errors.ownerships ? `<p class="field__error">${esc(t('err.' + errors.ownerships))}</p>` : ''}
          <div class="stack">${ownershipsHtml()}</div>
          <div><button type="button" class="btn cut-a-8 is-chamfered" data-action="own-add">${icon('plus')}<span>${esc(t('game.store.add'))}</span></button></div>

          <h2 class="t-section">${esc(t('game.links'))}</h2><hr class="divider">
          <div class="stack">${linksHtml()}</div>
          <div><button type="button" class="btn cut-a-8 is-chamfered" data-action="link-add">${icon('plus')}<span>${esc(t('game.link.add'))}</span></button></div>

          ${field('g-notes', 'game.field.notes', `<textarea id="g-notes" class="input input--area cut-a-6 is-chamfered measure" rows="6">${esc(draft.notes)}</textarea>`, 'notes', errors)}

          <div class="row detail__actions">
            <button type="submit" class="btn btn--primary cut-a-8 is-chamfered">${esc(t('game.save'))}</button>
            ${isNew ? '' : `<button type="button" class="btn cut-a-8 is-chamfered" data-action="delete">${icon('trash')}<span>${esc(t('game.delete'))}</span></button>`}
          </div>
          ${confirmDelete ? `<div class="panel panel--live confirm" role="alertdialog" aria-labelledby="del-t" aria-describedby="del-d">
            <h2 class="state__title" id="del-t">${esc(t('game.delete.title'))}</h2>
            <p class="t-body" id="del-d">${esc(t('game.delete.text', { title: draft.title }))}</p>
            <div class="row">
              <button type="button" class="btn cut-a-8 is-chamfered" data-action="delete-cancel" id="del-cancel">${esc(t('common.cancel'))}</button>
              <button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-action="delete-confirm">${esc(t('game.delete.confirm'))}</button>
            </div></div>` : ''}
        </div>
      </form>`;
    if (focusSel) root.querySelector(focusSel)?.focus();
  }

  // ---- ações ----
  async function save() {
    sync();
    message = '';
    if (!validate()) { render(); root.querySelector('[aria-invalid="true"]')?.focus(); return false; }
    draft.updatedAt = new Date().toISOString();
    recalcTotals(draft);
    try {
      await db.putGame(draft);
    } catch (e) {
      errors = {};
      message = t('err.' + (e?.code || 'idb_unavailable'));
      render();
      return false;
    }
    if (isNew) { location.hash = `#/game/${encodeURIComponent(draft.id)}`; return true; }
    message = t('game.saved');
    render();
    return true;
  }

  async function workerUrl() {
    let url = '';
    try { url = (await db.getMeta('workerUrl')) || ''; } catch { /* usa o padrão */ }
    return url || WORKER_URL;
  }

  async function searchCovers() {
    sync();
    cover = { open: true, loading: true, items: null, error: null };
    render('[data-action="cover-search"]');
    try {
      const url = await workerUrl();
      if (!url) throw { code: 'misconfigured' };
      cover.items = await searchCover(draft.title, url);
    } catch (e) {
      cover.error = e?.code || 'network';
    }
    cover.loading = false;
    if (!disposed) render('[data-action="cover-search"]');
  }

  const actions = {
    fav: () => { sync(); draft.favorite = !draft.favorite; render('[data-action="fav"]'); },
    rate: (b) => { sync(); draft.rating = Number(b.dataset.value) || null; render(`[data-action="rate"][data-value="${draft.rating || 1}"]`); },
    'link-add': () => { sync(); draft.links.push({ label: '', url: '' }); render(`#link-${draft.links.length - 1}-label`); },
    'link-remove': (b) => { sync(); draft.links.splice(Number(b.dataset.i), 1); render('[data-action="link-add"]'); },
    'own-add': () => {
      sync();
      const free = STORE_ORDER.find((s) => !draft.ownerships.some((o) => o.store === s)) || 'other';
      draft.ownerships.push(createOwnership({ store: free, source: 'manual' }));
      render(`#own-${draft.ownerships.length - 1}-store`);
    },
    'own-remove': (b) => { sync(); draft.ownerships.splice(Number(b.dataset.i), 1); render('[data-action="own-add"]'); },
    split: async (b) => {
      if (isNew) return;
      if (!(await save())) return;
      try {
        const created = await splitOwnership(draft.id, b.dataset.store);
        draft = await db.getGame(draft.id);
        message = t('game.store.split.done');
        render('h1');
        root.querySelector('.status-line').insertAdjacentHTML('beforeend', `<p><a class="btn cut-a-8 is-chamfered" href="#/game/${encodeURIComponent(created.id)}">${esc(created.title)}</a></p>`);
      } catch (e) {
        errors = {};
        message = t('err.' + (e?.code || 'idb_unavailable'));
        render();
      }
    },
    'cover-search': searchCovers,
    'cover-pick': (b) => {
      sync();
      const it = cover.items[Number(b.dataset.i)];
      Object.assign(draft, { coverUrl: it.coverUrl, coverAppId: it.appid ?? null, coverManual: true });
      cover = { open: false, loading: false, items: null, error: null };
      render('[data-action="cover-search"]');
    },
    'cover-apply': () => {
      sync();
      const v = $('#g-coverurl').value.trim();
      delete errors.coverUrl;
      if (!isHttpUrl(v)) { errors.coverUrl = 'invalid_url'; render('#g-coverurl'); $('#g-coverurl').value = v; return; }
      Object.assign(draft, { coverUrl: v, coverAppId: null, coverManual: true });
      render('[data-action="cover-search"]');
    },
    'cover-remove': () => { sync(); Object.assign(draft, { coverUrl: null, coverAppId: null, coverManual: true }); render('[data-action="cover-search"]'); },
    delete: () => { sync(); confirmDelete = true; render('#del-cancel'); },
    'delete-cancel': () => { confirmDelete = false; render('[data-action="delete"]'); },
    'delete-confirm': async () => {
      try { await db.deleteGame(draft.id); location.hash = '#/'; } catch (e) { confirmDelete = false; message = t('err.' + (e?.code || 'idb_unavailable')); render(); }
    },
  };

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && !b.disabled) actions[b.dataset.action]?.(b);
  });
  // trocar a loja de uma posse muda quais ações aparecem (separar/remover)
  root.addEventListener('change', (e) => {
    if (e.target.matches?.('[data-own] [data-f="store"]')) { const id = e.target.id; sync(); render(`#${id}`); }
  });
  root.addEventListener('submit', (e) => { e.preventDefault(); save(); });
  // radiogroup da nota: setas movem e escolhem; Home/End vão aos extremos
  root.addEventListener('keydown', (e) => {
    const star = e.target.closest?.('.rating__star');
    if (!star) return;
    const cur = Number(star.dataset.value);
    const next = { ArrowRight: cur + 1, ArrowUp: cur + 1, ArrowLeft: cur - 1, ArrowDown: cur - 1, Home: 1, End: 5 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    sync();
    draft.rating = Math.min(5, Math.max(1, next));
    render(`[data-action="rate"][data-value="${draft.rating}"]`);
  });
  bindCoverFallback(root);

  render();
  return () => { disposed = true; };
}
