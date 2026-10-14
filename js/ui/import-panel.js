import { t, getLang, formatNumber, formatDate } from '../i18n/index.js';
import { icon } from '../icons.js';
import { db } from '../data-source.js';
import { planMerge, applyMerge } from '../data/model.js';
import { fetchOwned, parseSteamCache } from '../importers/steam.js';
import { parseCsv, templateCsv } from '../importers/csv.js';
import { queueCovers } from '../importers/covers.js';
import { queueDetails, gamesToComplete } from '../importers/details.js';
import { WORKER_URL } from '../config.js';
import { esc, storeLabel, storeChip, bindCoverFallback } from './grid.js';
import { allStoreIds, customStoreFromText } from '../data/stores.js';
import { handoff } from './backup-flow.js';

const MAX_ERRORS_SHOWN = 100;

/**
 * Tela #/import. Fluxo: escolher fonte → preview do planMerge (nada grava) → confirmar → (opcional) buscar capas.
 * @param {HTMLElement} root
 * @param {URLSearchParams} [query] `csv=1` leva direto ao envio de arquivo; `store=<id>` pré-seleciona a loja
 * @returns {() => void} limpeza
 */
export function mountImport(root, query) {
  let phase = 'idle'; // idle | working | preview | applying | done
  let error = null;
  let pending = null; // { plan, parseErrors, source, steam }
  let doneInfo = null;
  let steamReady = false; // Worker + SteamID + chave preenchidos
  let lastSync = null;
  let defaultStore = allStoreIds().includes(query?.get('store')) ? query.get('store') : ''; // loja usada nas linhas do CSV sem loja (ou em todas, se o CSV não tiver a coluna)
  let covers = { missing: 0, running: false, done: 0, total: 0, result: null, error: null, choice: null };
  let abort = null;
  let info = { missing: 0, running: false, done: 0, total: 0, result: null, error: null };
  let abortInfo = null;
  let disposed = false;
  bindCoverFallback(root); // opção de capa sem imagem some da lista de escolha

  const stat = (key, n) => `<div class="stat"><span class="stat__n">${esc(formatNumber(n))}</span><span class="t-label">${esc(t('import.stat.' + key))}</span></div>`;

  async function workerUrl() {
    let url = '';
    try { url = (await db.getMeta('workerUrl')) || ''; } catch { /* usa o padrão */ }
    return url || WORKER_URL;
  }

  async function steamCreds() {
    try {
      const [key, steamId] = [await db.getMeta('steamKey'), await db.getMeta('steamId')];
      return key && steamId ? { key, steamId } : null;
    } catch { return null; }
  }

  // ---------- views ----------
  function idleHtml() {
    return `
      <section class="panel stack">
        <h2 class="t-section">${esc(t('import.steam.title'))}</h2>
        <p class="t-body measure">${esc(t('import.steam.text'))}</p>
        <p class="t-body">${lastSync ? esc(t('import.steam.last', { date: formatDate(lastSync, { dateStyle: 'medium', timeStyle: 'short' }) })) : esc(t('import.steam.never'))}</p>
        <p class="t-data">${steamReady ? icon('check') : ''} ${esc(t(steamReady ? 'connect.status.ok' : 'connect.status.pending.short'))}</p>
        <div class="row">${steamReady
          ? `<button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="steam">${esc(t('import.steam.button'))}</button>`
          : `<a class="btn btn--primary cut-a-8 is-chamfered" href="#/settings">${esc(t('import.open.settings'))}</a>`}</div>
      </section>
      ${coversHtml()}
      ${detailsHtml()}
      <section class="panel stack">
        <h2 class="t-section">${esc(t('import.file.title'))}</h2>
        <p class="t-body measure">${esc(t('import.file.text'))}</p>
        <div class="field"><label class="field__label" for="imp-store">${esc(t('import.store.label'))}</label>
          <select id="imp-store" class="input cut-a-6 is-chamfered">
            <option value="">${esc(t('import.store.none'))}</option>
            ${allStoreIds().map((id) => `<option value="${esc(id)}" ${id === defaultStore ? 'selected' : ''}>${esc(storeLabel(id))}</option>`).join('')}
          </select>
          <p class="t-hint measure">${esc(t('import.store.hint'))}</p></div>
        <div class="row">
          <input id="imp-file" class="visually-hidden" type="file" accept=".csv,.json,text/csv,application/json">
          <label for="imp-file" class="btn cut-a-8 is-chamfered" data-role="file-label" tabindex="0" role="button">${icon('upload')}<span>${esc(t('import.file.button'))}</span></label>
        </div>
      </section>
      <section class="panel stack">
        <h2 class="t-section">${esc(t('import.template.title'))}</h2>
        <p class="t-body measure">${esc(t('import.template.text'))}</p>
        <div class="row">
          <button type="button" class="btn cut-a-8 is-chamfered" data-act="template" data-lang="pt">${esc(t('import.template.pt'))}</button>
          <button type="button" class="btn cut-a-8 is-chamfered" data-act="template" data-lang="en">${esc(t('import.template.en'))}</button>
        </div>
      </section>`;
  }

  function previewHtml() {
    const { plan, parseErrors } = pending;
    const errs = [...parseErrors, ...plan.errors];
    const c = plan.counts;
    const invalid = c.invalid + parseErrors.length;
    const nothing = c.new + c.updated + c.merged === 0;
    const shown = errs.slice(0, MAX_ERRORS_SHOWN);
    return `<section class="panel panel--live stack">
      <h2 class="t-section">${esc(t('import.preview.title'))}</h2>
      <p class="t-body measure">${esc(t('import.preview.text'))}</p>
      <div class="stats">${stat('new', c.new)}${stat('updated', c.updated)}${stat('merged', c.merged)}${stat('invalid', invalid)}</div>
      ${pending.byStore?.size ? `<div class="stack"><h3 class="t-label">${esc(t('import.preview.stores'))}</h3>
        <div class="row">${[...pending.byStore].map(([id, n]) => `<span class="row">${storeChip(id)}<span class="t-data">${esc(formatNumber(n))}</span></span>`).join('')}</div></div>` : ''}
      ${nothing ? `<p class="t-body" role="status">${esc(t('import.preview.nothing'))}</p>` : ''}
      ${errs.length ? `<div class="stack"><h3 class="t-label">${esc(t('import.errors.title'))}</h3>
        <ul class="errlist">${shown.map((e) => `<li><span class="t-data">${e.row != null ? esc(t('import.errors.row', { row: e.row })) : '—'}</span> ${esc(t('err.' + e.code))}</li>`).join('')}</ul>
        ${errs.length > shown.length ? `<p class="t-body">${esc(t('import.errors.more', { n: formatNumber(errs.length - shown.length) }))}</p>` : ''}</div>` : ''}
      ${error ? `<p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + error))}</p>` : ''}
      <div class="row">
        <button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="confirm" ${nothing || phase === 'applying' ? 'disabled' : ''}>${esc(t('import.confirm'))}</button>
        <button type="button" class="btn btn--ghost cut-a-8 is-chamfered" data-act="cancel">${esc(t('common.cancel'))}</button>
      </div></section>`;
  }

  function coversHtml() {
    const c = covers;
    if (c.running) {
      const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      return `<section class="panel stack" aria-live="polite">
        <h2 class="t-section">${esc(t('import.covers.title'))}</h2>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${c.total}" aria-valuenow="${c.done}" aria-label="${esc(t('import.covers.title'))}"><span style="width:${pct}%"></span></div>
        <p class="t-data">${esc(t('import.covers.progress', { done: formatNumber(c.done), total: formatNumber(c.total) }))}</p>
        ${c.choice ? `<div class="panel confirm" role="group" aria-labelledby="cv-t">
          <h3 class="state__title" id="cv-t">${esc(t('import.covers.ambiguous', { title: c.choice.game.title }))}</h3>
          <div class="cover-results">${c.choice.items.map((it, i) => `<button type="button" class="cover-pick cut-a-6 is-chamfered" data-act="cover-choose" data-i="${i}" aria-label="${esc(t('game.cover.pick', { name: it.name }))}"><img src="${esc(it.coverUrl)}" alt="" ${it.appid ? `data-appid="${esc(it.appid)}"` : ''} loading="lazy"><span>${esc(it.name)}</span></button>`).join('')}</div>
          <div class="row"><button type="button" class="btn cut-a-8 is-chamfered" data-act="cover-skip">${esc(t('import.covers.skip'))}</button></div></div>` : ''}
        <div class="row"><button type="button" class="btn cut-a-8 is-chamfered" data-act="cover-cancel">${esc(t('import.covers.cancel'))}</button></div>
      </section>`;
    }
    if (c.result) {
      const r = c.result;
      return `<section class="panel stack" role="status"><h2 class="t-section">${esc(t('import.covers.title'))}</h2>
        <p class="t-body">${esc(t(r.cancelled ? 'import.covers.result.cancelled' : 'import.covers.result', { updated: formatNumber(r.updated.length), skipped: formatNumber(r.skipped), notFound: formatNumber(r.notFound), failed: formatNumber(r.failed) }))}</p>
        ${c.error ? `<p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + c.error))}</p>` : ''}
        ${c.missing ? `<p class="t-body measure">${esc(t('import.covers.remaining', { n: formatNumber(c.missing) }))}</p>
        <div class="row"><button type="button" class="btn cut-a-8 is-chamfered" data-act="cover-start">${esc(t('import.covers.retry'))}</button></div>` : ''}</section>`;
    }
    if (c.error) return `<section class="panel stack"><p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + c.error))}</p></section>`;
    if (!c.missing) return '';
    return `<section class="panel stack">
      <h2 class="t-section">${esc(t('import.covers.title'))}</h2>
      <p class="t-body measure">${esc(t('import.covers.text', { n: formatNumber(c.missing) }))}</p>
      <div class="row"><button type="button" class="btn cut-a-8 is-chamfered" data-act="cover-start">${esc(t('import.covers.start'))}</button></div></section>`;
  }

  function detailsHtml() {
    const d = info;
    if (d.running) {
      const pct = d.total ? Math.round((d.done / d.total) * 100) : 0;
      return `<section class="panel stack" aria-live="polite">
        <h2 class="t-section">${esc(t('import.details.title'))}</h2>
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="${d.total}" aria-valuenow="${d.done}" aria-label="${esc(t('import.details.title'))}"><span style="width:${pct}%"></span></div>
        <p class="t-data">${esc(t('import.details.progress', { done: formatNumber(d.done), total: formatNumber(d.total) }))}</p>
        <div class="row"><button type="button" class="btn cut-a-8 is-chamfered" data-act="details-cancel">${esc(t('import.covers.cancel'))}</button></div>
      </section>`;
    }
    if (d.result) {
      const r = d.result;
      return `<section class="panel stack" role="status"><h2 class="t-section">${esc(t('import.details.title'))}</h2>
        <p class="t-body">${esc(t(r.cancelled ? 'import.details.result.cancelled' : 'import.details.result', { updated: formatNumber(r.updated), notFound: formatNumber(r.notFound), failed: formatNumber(r.failed) }))}</p>
        ${d.error ? `<p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + d.error))}</p>` : ''}
        ${d.missing ? `<p class="t-body measure">${esc(t('import.details.remaining', { n: formatNumber(d.missing) }))}</p>
        <div class="row"><button type="button" class="btn cut-a-8 is-chamfered" data-act="details-start">${esc(t('import.details.retry'))}</button></div>` : ''}</section>`;
    }
    if (d.error) return `<section class="panel stack"><p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + d.error))}</p></section>`;
    if (!d.missing) return '';
    return `<section class="panel stack">
      <h2 class="t-section">${esc(t('import.details.title'))}</h2>
      <p class="t-body measure">${esc(t('import.details.text', { n: formatNumber(d.missing) }))}</p>
      <div class="row"><button type="button" class="btn cut-a-8 is-chamfered" data-act="details-start">${esc(t('import.details.start'))}</button></div></section>`;
  }

  function doneHtml() {
    const c = doneInfo;
    return `<section class="panel panel--live stack" role="status">
        <h2 class="state__title">${icon('check')} ${esc(t('import.done.title'))}</h2>
        <div class="stats">${stat('new', c.new)}${stat('updated', c.updated)}${stat('merged', c.merged)}</div>
        <div class="row"><a class="btn btn--primary cut-a-8 is-chamfered" href="#/">${esc(t('import.go.library'))}</a>
        <button type="button" class="btn btn--ghost cut-a-8 is-chamfered" data-act="again">${esc(t('import.again'))}</button></div>
      </section>${coversHtml()}${detailsHtml()}`;
  }

  function render(focusSel) {
    const head = `<div class="view-head"><h1 class="t-heading" tabindex="-1">${esc(t('import.title'))}</h1></div><hr class="divider">`;
    let body;
    if (phase === 'working' || phase === 'applying' && !pending) body = `<div class="state panel panel--live" role="status"><div class="loader"></div><span class="t-label">${esc(t('state.loading'))}</span></div>`;
    else if (phase === 'preview' || phase === 'applying') body = previewHtml();
    else if (phase === 'done') body = doneHtml();
    else body = (error ? `<div class="panel state--error stack" role="alert"><span class="row">${icon('alert')}<strong>${esc(t('state.error.title'))}</strong></span><p class="t-body">${esc(t('err.' + error))}</p>${(error === 'misconfigured' || error === 'steam_no_credentials' || error === 'worker_not_configured') ? `<a class="btn cut-a-8 is-chamfered" href="#/settings">${esc(t('import.open.settings'))}</a>` : ''}</div>` : '') + idleHtml();
    root.innerHTML = `${head}<div class="stack">${body}</div>`;
    if (focusSel) root.querySelector(focusSel)?.focus();
  }

  function reset() { phase = 'idle'; error = null; pending = null; render(); }

  // ---------- fluxo ----------
  async function buildPreview(incoming, parseErrors, source, steam = false) {
    const existing = await db.getAllGames();
    /** @type {Map<string, number>} linhas válidas por loja (o preview mostra de onde vem cada uma) */
    const byStore = new Map();
    for (const r of incoming) byStore.set(r.store, (byStore.get(r.store) || 0) + 1);
    pending = { plan: planMerge(existing, incoming, { source }), parseErrors, source, steam, byStore };
    phase = 'preview';
  }

  async function syncSteam() {
    error = null; phase = 'working'; render();
    try {
      const url = await workerUrl();
      if (!url) throw { code: 'worker_not_configured' };
      const creds = await steamCreds();
      let incoming;
      try { incoming = await fetchOwned(url, creds); }
      catch (e) { throw !creds && e?.code === 'misconfigured' ? { code: 'steam_no_credentials' } : e; }
      await buildPreview(incoming, [], 'api', true);
    } catch (e) { phase = 'idle'; error = e?.code || 'network'; }
    if (!disposed) render(error ? null : '[data-act="confirm"]');
  }

  async function onFile(file) {
    error = null; phase = 'working'; render();
    try {
      const text = (await file.text()).replace(/^﻿/, '');
      const head = text.trimStart()[0];
      if (head === '{' || head === '[') {
        let json;
        try { json = JSON.parse(text); } catch { throw { code: 'backup_invalid' }; }
        if (json?.app === 'gamedex') { handoff.file = file; location.hash = '#/backup'; return; }
        if (json?.steam_cache) { await buildPreview(parseSteamCache(json), [], 'backup'); }
        else throw { code: 'backup_invalid' };
      } else {
        const { rows, errors } = parseCsv(text, { defaultStore: defaultStore || undefined, resolveStore: customStoreFromText });
        if (!rows.length && errors.length) throw { code: errors[0].code };
        await buildPreview(rows, errors, 'csv');
      }
    } catch (e) { phase = 'idle'; error = e?.code || 'backup_invalid'; }
    if (!disposed) render();
  }

  async function confirm() {
    phase = 'applying'; error = null; render();
    try {
      const { plan, steam } = pending;
      await applyMerge(plan);
      if (steam) await db.setMeta('lastSteamSync', new Date().toISOString());
      doneInfo = { new: plan.counts.new, updated: plan.counts.updated, merged: plan.counts.merged };
      pending = null;
      phase = 'done';
      covers = { missing: await countMissingCovers(), running: false, done: 0, total: 0, result: null, error: null, choice: null };
    } catch (e) { phase = 'preview'; error = e?.code || 'idb_unavailable'; }
    if (!disposed) render(phase === 'done' ? 'h1' : null);
  }

  const needsCover = (g) => !g.coverUrl && !g.coverManual;
  async function countMissingCovers() {
    if (!(await workerUrl())) return 0;
    return (await db.getAllGames()).filter(needsCover).length;
  }

  async function countMissingDetails() {
    if (!(await workerUrl())) return 0;
    return gamesToComplete(await db.getAllGames(), !!(await steamCreds())).length;
  }

  async function startDetails() {
    const url = await workerUrl();
    const creds = await steamCreds();
    const games = gamesToComplete(await db.getAllGames(), !!creds);
    abortInfo = new AbortController();
    info = { ...info, running: true, done: 0, total: games.length, result: null, error: null };
    render('[data-act="details-cancel"]');
    try {
      info.result = await queueDetails(games, {
        workerUrl: url, lang: getLang(), creds, signal: abortInfo.signal,
        onProgress: (p) => { info.done = p.done; info.total = p.total; if (!disposed) render('[data-act="details-cancel"]'); },
      });
    } catch (e) {
      info.error = e?.code || 'network';
      info.result = { updated: 0, unchanged: 0, notFound: 0, failed: 0, cancelled: true };
    }
    info.running = false; abortInfo = null;
    info.missing = await countMissingDetails().catch(() => 0);
    if (!disposed) render();
  }

  async function startCovers() {
    const url = await workerUrl();
    const games = (await db.getAllGames()).filter(needsCover);
    abort = new AbortController();
    covers = { ...covers, running: true, done: 0, total: games.length, result: null, error: null, choice: null };
    render('[data-act="cover-cancel"]');
    try {
      covers.result = await queueCovers(games, {
        workerUrl: url,
        sgdb: true,
        sgdbKey: (await db.getMeta('sgdbKey').catch(() => null)) || undefined,
        signal: abort.signal,
        onProgress: (p) => { covers.done = p.done; covers.total = p.total; if (!disposed) render(covers.choice ? null : '[data-act="cover-cancel"]'); },
        onAmbiguous: (game, items) => new Promise((resolve) => {
          covers.choice = { game, items, resolve };
          if (!disposed) render('[data-act="cover-choose"]');
        }),
      });
    } catch (e) {
      covers.error = e?.code || 'network';
      covers.result = { updated: [], skipped: 0, notFound: 0, failed: 0, cancelled: true };
    }
    covers.running = false; covers.choice = null; abort = null;
    covers.missing = await countMissingCovers().catch(() => 0);
    if (!disposed) render();
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const a = b.dataset.act;
    if (a === 'steam') syncSteam();
    else if (a === 'confirm') confirm();
    else if (a === 'cancel') reset();
    else if (a === 'again') reset();
    else if (a === 'template') {
      const lang = b.dataset.lang || getLang();
      const blob = new Blob(['﻿', templateCsv(lang)], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a2 = document.createElement('a');
      a2.href = url; a2.download = `gamedex-template-${lang}.csv`;
      document.body.append(a2); a2.click(); a2.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    else if (a === 'cover-start') startCovers();
    else if (a === 'details-start') startDetails();
    else if (a === 'details-cancel') abortInfo?.abort();
    else if (a === 'cover-cancel') abort?.abort();
    else if (a === 'cover-choose') { const ch = covers.choice; covers.choice = null; ch.resolve(ch.items[Number(b.dataset.i)]); render('[data-act="cover-cancel"]'); }
    else if (a === 'cover-skip') { const ch = covers.choice; covers.choice = null; ch.resolve(null); render('[data-act="cover-cancel"]'); }
  });
  root.addEventListener('change', (e) => {
    if (e.target.id === 'imp-store') { defaultStore = e.target.value; return; }
    if (e.target.id === 'imp-file' && e.target.files[0]) onFile(e.target.files[0]);
  });
  // o rótulo-botão do arquivo é focável: Enter/Espaço abrem o seletor
  root.addEventListener('keydown', (e) => {
    const l = e.target.closest?.('[data-role="file-label"]');
    if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); root.querySelector('#imp-file').click(); }
  });

  Promise.all([db.getMeta('lastSteamSync'), workerUrl(), steamCreds()]).then(([v, url, creds]) => {
    lastSync = v || null; steamReady = !!(url && creds);
    if (!disposed && phase === 'idle') render(csvFocus ? '[data-role="file-label"]' : null);
  }).catch(() => {});
  countMissingDetails().then((n) => { info.missing = n; if (!disposed && phase === 'idle' && !info.running) render(); }).catch(() => {});
  countMissingCovers().then((n) => { covers.missing = n; if (!disposed && phase === 'idle' && !covers.running) render(); }).catch(() => {});
  const csvFocus = query?.get('csv') === '1';
  render(csvFocus ? '[data-role="file-label"]' : null);
  return () => { disposed = true; abort?.abort(); abortInfo?.abort(); covers.choice?.resolve(null); };
}
