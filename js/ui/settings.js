import { t } from '../i18n/index.js';
import { icon } from '../icons.js';
import { db } from '../data-source.js';
import { openHelp } from './help-modal.js';
import { CUSTOM_HUES, MAX_NAME, getCustomStores, createStore, updateStore, deleteStore } from '../data/stores.js';
import { esc } from './grid.js';
import { fetchOwned } from '../importers/steam.js';
import { sgdbStatus } from '../importers/covers.js';

const isHttpUrl = (u) => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } };
const SGDB_CMD = 'npx wrangler secret put STEAMGRIDDB_KEY';
/** Código de erro do teste → chave i18n (o resto usa `err.<código>`). */
const TEST_ERR = { network: 'connect.err.worker', not_found: 'connect.err.worker', steam_upstream: 'connect.err.key', bad_request: 'connect.err.key' };

/**
 * Tela #/settings: "Conectar Steam" (Worker, SteamID e chave, com estado e teste) e lojas criadas pelo usuário.
 * Backup e arquivo vinculado ficam em #/backup.
 * @param {HTMLElement} root
 * @returns {() => void} limpeza
 */
export function mountSettings(root) {
  let disposed = false;
  let workerUrl = '';
  let steamId = '';
  let hasKey = false;
  let storeCounts = {};
  let newHue = CUSTOM_HUES[0];
  /** @type {Record<string, number>} matiz escolhido por loja, ainda não salvo */
  const rowHue = {};
  /** @type {Record<string, string>} nomes digitados e ainda não salvos (chave `new` ou id da loja) */
  const nameDraft = {};
  /** @type {Record<string, string>} campos da conexão digitados e ainda não salvos */
  const connDraft = {};
  let msg = { stores: null, connect: null, test: null };
  let testing = false;
  /** @type {'on'|'off'|'unknown'|null} */
  let sgdb = null;

  async function load(repaint = true) {
    try {
      workerUrl = (await db.getMeta('workerUrl')) || '';
      steamId = (await db.getMeta('steamId')) || '';
      hasKey = !!(await db.getMeta('steamKey'));
      const all = await db.getAllGames();
      storeCounts = {};
      for (const g of all) for (const s of new Set((g.ownerships || []).map((o) => o.store))) storeCounts[s] = (storeCounts[s] || 0) + 1;
    } catch (e) { msg.connect = { error: e?.code || 'idb_unavailable' }; }
    if (!disposed && repaint) render();
  }

  const note = (m) => (!m ? '' : m.error
    ? `<p class="field__error" role="alert">${icon('alert')} ${esc(m.raw ? t(m.error) : t('err.' + m.error))}</p>`
    : `<p class="t-hint" role="status">${esc(m.text)}</p>`);

  // ---------- Conectar Steam ----------
  const stepState = (ok) => `<span class="t-data">${ok ? icon('check') : ''} ${esc(t(ok ? 'connect.state.ok' : 'connect.state.todo'))}</span>`;

  function connectHtml() {
    const steps = [workerUrl, steamId, hasKey];
    const done = steps.filter(Boolean).length;
    const val = (k, v) => esc(connDraft[k] ?? v);
    const sgdbLine = sgdb ? `<p class="t-data">${esc(t('connect.sgdb.' + sgdb))}</p>` : '';
    return `<form class="panel panel--live stack" data-role="connect" novalidate autocomplete="off">
      <div class="row"><h2 class="t-section">${esc(t('connect.title'))}</h2>
        <span class="chip cut-a-4 ${done === 3 ? 'chip--ok' : ''}" role="status">${esc(done === 3 ? t('connect.status.ok') : t('connect.status.pending', { n: done }))}</span></div>
      <p class="t-body measure">${esc(t('connect.text'))}</p>

      <div class="field"><label class="field__label" for="s-worker">${esc(t('connect.s1'))} ${stepState(!!workerUrl)}</label>
        <button type="button" class="btn btn--ghost cut-a-6 is-chamfered help-btn" data-help="worker">${icon('help')}<span>${esc(t('help.open.worker'))}</span></button>
        <input id="s-worker" class="input cut-a-6 is-chamfered" type="url" inputmode="url" autocomplete="off" spellcheck="false" value="${val('worker', workerUrl)}" placeholder="${esc(t('settings.worker.placeholder'))}"></div>
      <div class="field"><label class="field__label" for="s-steamid">${esc(t('connect.s2'))} ${stepState(!!steamId)}</label>
        <button type="button" class="btn btn--ghost cut-a-6 is-chamfered help-btn" data-help="steamid">${icon('help')}<span>${esc(t('help.open.steamid'))}</span></button>
        <input id="s-steamid" class="input cut-a-6 is-chamfered" type="text" inputmode="numeric" autocomplete="off" maxlength="17" value="${val('id', steamId)}"></div>
      <div class="field"><label class="field__label" for="s-steamkey">${esc(t('connect.s3'))} ${stepState(hasKey)}</label>
        <button type="button" class="btn btn--ghost cut-a-6 is-chamfered help-btn" data-help="apikey">${icon('help')}<span>${esc(t('help.open.apikey'))}</span></button>
        <input id="s-steamkey" class="input cut-a-6 is-chamfered" type="password" autocomplete="off" spellcheck="false" maxlength="32"
          placeholder="${esc(hasKey ? t('settings.steam.keyset') : '')}"></div>
      <p class="t-hint measure">${esc(t('connect.hint'))}</p>
      ${note(msg.connect)}
      <div class="row">
        <button type="submit" class="btn btn--primary cut-a-8 is-chamfered">${esc(t('common.save'))}</button>
        <button type="button" class="btn cut-a-8 is-chamfered" data-act="test" ${testing || done < 3 ? 'disabled' : ''}>${esc(t(testing ? 'connect.testing' : 'connect.test.btn'))}</button>
        <button type="button" class="btn btn--ghost cut-a-8 is-chamfered" data-act="connect-clear">${esc(t('connect.clear'))}</button>
      </div>
      <div aria-live="polite">${note(msg.test)}</div>

      <div class="stack">
        <h3 class="t-label">${esc(t('connect.sgdb.title'))}</h3>
        <p class="t-body measure">${esc(t('connect.sgdb.text'))}</p>
        <div class="row"><code class="t-data">${esc(SGDB_CMD)}</code>
          <button type="button" class="btn btn--ghost cut-a-6 is-chamfered" data-act="copy-cmd">${esc(t('connect.sgdb.copy'))}</button></div>
        ${sgdbLine}
      </div>
    </form>`;
  }

  function captureConn() {
    for (const [k, sel] of [['worker', '#s-worker'], ['id', '#s-steamid']]) {
      const el = root.querySelector(sel);
      if (el) connDraft[k] = el.value;
    }
  }

  async function saveConnect() {
    const url = root.querySelector('#s-worker').value.trim();
    const id = root.querySelector('#s-steamid').value.trim();
    const key = root.querySelector('#s-steamkey').value.trim();
    const bad = (url && !isHttpUrl(url)) ? 'invalid_url'
      : (id && !/^\d{17}$/.test(id)) ? 'steam_id_invalid'
      : (key && !/^[0-9a-f]{32}$/i.test(key)) ? 'steam_key_invalid'
      : (key && !id) ? 'steam_id_required'
      : (id && !key && !hasKey) ? 'steam_key_required' : null;
    msg.test = null;
    if (bad) { msg.connect = { error: bad }; captureConn(); return render(bad === 'invalid_url' ? '#s-worker' : '#s-steamid'); }
    try {
      await db.setMeta('workerUrl', url || null);
      if (id) await db.setMeta('steamId', id);
      if (key) await db.setMeta('steamKey', key);
      msg.connect = { text: t('settings.steam.saved') };
      delete connDraft.worker; delete connDraft.id;
    } catch (err) { msg.connect = { error: err?.code || 'idb_unavailable' }; }
    await load(false);
    render('[data-role="connect"] button[type="submit"]');
  }

  async function testConnect() {
    testing = true; msg.test = null; captureConn(); render('[data-act="test"]');
    try {
      const [key, id] = [await db.getMeta('steamKey'), await db.getMeta('steamId')];
      const games = await fetchOwned(workerUrl, { key, steamId: id });
      msg.test = { text: t('connect.test.ok', { n: games.length }) };
      sgdb = await sgdbStatus(workerUrl);
    } catch (e) {
      const code = e?.code || 'network';
      msg.test = TEST_ERR[code] ? { error: TEST_ERR[code], raw: true } : { error: code };
    }
    testing = false;
    if (!disposed) render('[data-act="test"]');
  }

  // ---------- Lojas ----------
  const swatches = (scope, cur) => `<div class="swatches" role="radiogroup" aria-label="${esc(t('settings.stores.color'))}">${CUSTOM_HUES.map((h, i) => `<button type="button" class="swatch cut-a-4 is-chamfered" role="radio" aria-checked="${h === cur}" data-act="swatch" data-scope="${esc(scope)}" data-hue="${h}" style="--h:${h}" aria-label="${esc(t('settings.stores.colorn', { n: i + 1 }))}"></button>`).join('')}</div>`;

  function storesHtml() {
    const rows = getCustomStores().map((s) => {
      const n = storeCounts[s.id] || 0;
      const hue = rowHue[s.id] ?? s.hue;
      return `<div class="store-row stack" data-store-row="${esc(s.id)}">
        <div class="row"><span class="chip chip--store chip--custom cut-a-4" style="--h:${hue}">${esc(nameDraft[s.id] ?? s.name)}</span>
          <span class="t-hint">${esc(t(n === 1 ? 'settings.stores.count.one' : 'settings.stores.count', { n }))}</span></div>
        <div class="field"><label class="field__label" for="st-${esc(s.id)}">${esc(t('settings.stores.name'))}</label>
          <input id="st-${esc(s.id)}" class="input cut-a-6 is-chamfered" type="text" maxlength="${MAX_NAME}" autocomplete="off" data-store-name="${esc(s.id)}" value="${esc(nameDraft[s.id] ?? s.name)}"></div>
        ${swatches(s.id, hue)}
        <div class="row">
          <button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="store-save" data-id="${esc(s.id)}">${esc(t('common.save'))}</button>
          <button type="button" class="btn cut-a-8 is-chamfered" data-act="store-delete" data-id="${esc(s.id)}" ${n ? `disabled title="${esc(t('settings.stores.inuse'))}"` : ''}>${icon('trash')}<span>${esc(t('settings.stores.delete'))}</span></button>
        </div>
        ${n ? `<p class="t-hint">${esc(t('settings.stores.inuse'))}</p>` : ''}
      </div>`;
    }).join('');
    return `<section class="panel stack" data-role="stores">
      <h2 class="t-section">${esc(t('settings.stores.title'))}</h2>
      <p class="t-body measure">${esc(t('settings.stores.text'))}</p>
      ${rows}
      <div class="stack">
        <h3 class="t-label">${esc(t('settings.stores.new'))}</h3>
        <div class="field"><label class="field__label" for="st-new">${esc(t('settings.stores.name'))}</label>
          <input id="st-new" class="input cut-a-6 is-chamfered" type="text" maxlength="${MAX_NAME}" autocomplete="off" data-store-name="new" value="${esc(nameDraft.new ?? '')}"></div>
        ${swatches('new', newHue)}
        ${note(msg.stores)}
        <div class="row"><button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="store-create">${icon('plus')}<span>${esc(t('settings.stores.create'))}</span></button></div>
      </div></section>`;
  }

  /** Guarda o que foi digitado antes de redesenhar (trocar cor não pode apagar o nome em edição). */
  function captureNames() {
    root.querySelectorAll('[data-store-name]').forEach((el) => { nameDraft[el.dataset.storeName] = el.value; });
  }

  async function storeAction(a, b) {
    captureNames(); captureConn();
    msg.stores = null;
    try {
      if (a === 'swatch') {
        const h = Number(b.dataset.hue);
        if (b.dataset.scope === 'new') newHue = h; else rowHue[b.dataset.scope] = h;
        render(`[data-act="swatch"][data-scope="${b.dataset.scope}"][data-hue="${h}"]`);
        return;
      }
      if (a === 'store-create') {
        const s = await createStore(nameDraft.new ?? '', newHue);
        nameDraft.new = '';
        msg.stores = { text: t('settings.stores.created', { name: s.name }) };
      } else if (a === 'store-save') {
        const id = b.dataset.id;
        const s = await updateStore(id, { name: nameDraft[id], hue: rowHue[id] });
        delete nameDraft[id]; delete rowHue[id];
        msg.stores = { text: t('settings.stores.saved', { name: s.name }) };
      } else if (a === 'store-delete') {
        const id = b.dataset.id;
        await deleteStore(id, await db.getAllGames());
        delete nameDraft[id]; delete rowHue[id];
        msg.stores = { text: t('settings.stores.deleted') };
      }
    } catch (e) { msg.stores = { error: e?.code || 'idb_unavailable' }; }
    await load(false);
    render(msg.stores?.error ? '#st-new' : null);
  }

  function render(focusSel) {
    root.innerHTML = `
      <div class="view-head"><h1 class="t-heading" tabindex="-1">${esc(t('settings.title'))}</h1></div><hr class="divider">
      <div class="stack">
        ${connectHtml()}
        ${storesHtml()}
      </div>`;
    if (focusSel) root.querySelector(focusSel)?.focus();
  }

  root.addEventListener('submit', (e) => { e.preventDefault(); saveConnect(); });

  root.addEventListener('click', (e) => {
    const h = e.target.closest('[data-help]');
    if (h) { openHelp(h.dataset.help, h); return; }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'swatch' || a === 'store-create' || a === 'store-save' || a === 'store-delete') { storeAction(a, b); return; }
    if (a === 'test') testConnect();
    else if (a === 'copy-cmd') {
      navigator.clipboard?.writeText(SGDB_CMD).then(() => { b.textContent = t('connect.sgdb.copied'); }).catch(() => {});
    } else if (a === 'connect-clear') {
      Promise.all([db.setMeta('steamKey', null), db.setMeta('steamId', null), db.setMeta('workerUrl', null)])
        .then(() => { workerUrl = ''; steamId = ''; hasKey = false; sgdb = null; delete connDraft.worker; delete connDraft.id; msg.test = null; msg.connect = { text: t('connect.cleared') }; render('#s-worker'); })
        .catch((err) => { msg.connect = { error: err?.code || 'idb_unavailable' }; render(); });
    }
  });

  render();
  load();
  return () => { disposed = true; };
}
