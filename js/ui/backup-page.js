import { t, formatDate } from '../i18n/index.js';
import { icon } from '../icons.js';
import { db } from '../data-source.js';
import { downloadBackup, fsAccessSupported, getLinkStatus, linkFile, unlinkFile, reconnect, onAutoSave } from '../data/backup.js';
import { esc } from './grid.js';
import { mountBackupImport, handoff } from './backup-flow.js';

const DAY = 86400000;

/**
 * Tela #/backup: exportar/importar backup e arquivo vinculado (salvamento automático).
 * Um arquivo de backup escolhido em Importar chega aqui por `handoff.file`.
 * @param {HTMLElement} root
 * @returns {() => void} limpeza
 */
export function mountBackupPage(root) {
  let disposed = false;
  let hasKey = false;
  let withKey = false;
  let lastBackup = null;
  let gamesCount = 0;
  let link = 'unsupported';
  let auto = null;
  let msg = { backup: null, link: null };
  let importing = false;

  async function load(repaint = true) {
    try {
      lastBackup = (await db.getMeta('lastBackupAt')) || null;
      hasKey = !!(await db.getMeta('steamKey'));
      gamesCount = (await db.getAllGames()).length;
    } catch (e) { msg.backup = { error: e?.code || 'idb_unavailable' }; }
    link = fsAccessSupported() ? await getLinkStatus() : 'unsupported';
    if (!disposed && repaint) render();
  }

  const note = (m) => (!m ? '' : m.error
    ? `<p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + m.error))}</p>`
    : `<p class="t-hint" role="status">${esc(m.text)}</p>`);

  function backupAge() {
    if (!lastBackup) return gamesCount ? { stale: true, text: t('settings.backup.never') } : null;
    const days = Math.floor((Date.now() - Date.parse(lastBackup)) / DAY);
    return days > 30 ? { stale: true, text: t('settings.backup.stale', { days }) } : { stale: false, text: t('settings.backup.last', { date: formatDate(lastBackup, { dateStyle: 'medium', timeStyle: 'short' }) }) };
  }

  function linkHtml() {
    if (link === 'unsupported') return '';
    const status = t('settings.link.status.' + link);
    const autoLine = auto ? (auto.ok ? `<p class="t-hint" role="status">${esc(t('settings.link.saved', { time: formatDate(auto.at, { timeStyle: 'short' }) }))}</p>`
      : `<p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + auto.code))}</p>`) : '';
    return `<section class="panel stack">
      <h2 class="t-section">${esc(t('settings.link.title'))}</h2>
      <p class="t-body measure">${esc(t('settings.link.text'))}</p>
      <p class="t-data">${esc(status)}</p>
      ${autoLine}${note(msg.link)}
      <div class="row">
        ${link === 'none' ? `<button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="link">${esc(t('settings.link.link'))}</button>` : ''}
        ${link === 'needs-permission' ? `<button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="reconnect">${esc(t('settings.link.reconnect'))}</button>` : ''}
        ${link !== 'none' ? `<button type="button" class="btn cut-a-8 is-chamfered" data-act="unlink">${esc(t('settings.link.unlink'))}</button>` : ''}
      </div></section>`;
  }

  function render(focusSel) {
    const age = backupAge();
    root.innerHTML = `
      <div class="view-head"><h1 class="t-heading" tabindex="-1">${esc(t('nav.backup'))}</h1></div><hr class="divider">
      <div class="stack">
        <section class="panel stack">
          <h2 class="t-section">${esc(t('settings.backup.title'))}</h2>
          <p class="t-body measure">${esc(t('settings.backup.text'))}</p>
          ${age ? `<p class="${age.stale ? 'warn' : 't-data'}" ${age.stale ? 'role="status"' : ''}>${age.stale ? icon('alert') : ''} ${esc(age.text)}</p>` : ''}
          ${hasKey ? `<div class="stack">
            <label class="choice"><input type="checkbox" id="s-bk-key" ${withKey ? 'checked' : ''}>
              <span><span class="choice__title">${esc(t('settings.backup.key'))}</span><span class="t-body">${esc(t('settings.backup.key.text'))}</span></span></label>
            ${withKey ? `<div class="field"><label class="field__label" for="s-bk-pw">${esc(t('settings.backup.password'))}</label>
              <input id="s-bk-pw" class="input cut-a-6 is-chamfered" type="password" autocomplete="new-password"></div>
            <div class="field"><label class="field__label" for="s-bk-pw2">${esc(t('settings.backup.password2'))}</label>
              <input id="s-bk-pw2" class="input cut-a-6 is-chamfered" type="password" autocomplete="new-password"></div>` : ''}
          </div>` : ''}
          ${note(msg.backup)}
          <div class="row">
            <button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="export">${icon('upload', { className: 'flip' })}<span>${esc(t('settings.backup.export'))}</span></button>
            <input id="s-bk" class="visually-hidden" type="file" accept=".json,application/json">
            <label for="s-bk" class="btn cut-a-8 is-chamfered" tabindex="0" role="button" data-role="file-label">${icon('upload')}<span>${esc(t('settings.backup.import'))}</span></label>
          </div>
          <div data-role="backup-import"></div>
        </section>
        ${linkHtml()}
      </div>`;
    if (focusSel) root.querySelector(focusSel)?.focus();
  }

  async function guard(key, fn) {
    msg[key] = null;
    try { await fn(); } catch (e) { msg[key] = { error: e?.code || 'fs_permission_denied' }; }
    link = fsAccessSupported() ? await getLinkStatus() : 'unsupported';
    if (!disposed) render();
  }

  function startImport(file, input) {
    importing = true;
    const host = root.querySelector('[data-role="backup-import"]');
    mountBackupImport(host, file, { onCancel: () => { host.replaceChildren(); importing = false; if (input) input.value = ''; }, onDone: () => { load(false); } });
    host.querySelector('button')?.focus();
  }

  root.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'export') {
      guard('backup', async () => {
        /** @type {{includeKey?: boolean, password?: string}} */ const opts = {};
        if (withKey && hasKey) {
          const pw = root.querySelector('#s-bk-pw')?.value || '';
          if (pw.length < 8) throw { code: 'password_short' };
          if (pw !== root.querySelector('#s-bk-pw2')?.value) throw { code: 'password_mismatch' };
          Object.assign(opts, { includeKey: true, password: pw });
        }
        await downloadBackup(opts); lastBackup = (await db.getMeta('lastBackupAt')) || lastBackup; msg.backup = { text: t('settings.backup.exported') }; });
    } else if (a === 'link') guard('link', async () => { await linkFile(); });
    else if (a === 'reconnect') guard('link', async () => { await reconnect(); });
    else if (a === 'unlink') guard('link', async () => { await unlinkFile(); auto = null; });
  });

  root.addEventListener('change', (e) => {
    if (e.target.id === 's-bk-key') { withKey = e.target.checked; render(withKey ? '#s-bk-pw' : '#s-bk-key'); return; }
    if (e.target.id !== 's-bk' || !e.target.files[0]) return;
    startImport(e.target.files[0], e.target);
  });
  root.addEventListener('keydown', (e) => {
    const l = e.target.closest?.('[data-role="file-label"]');
    if (l && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); root.querySelector('#s-bk').click(); }
  });

  const offAuto = fsAccessSupported() ? onAutoSave((r) => { auto = r; if (!disposed && !importing) load(); }) : () => {};
  render();
  if (handoff.file) { const f = handoff.file; handoff.file = null; startImport(f, null); }
  load(false).then(() => { if (!disposed && !importing) render(); });
  return () => { disposed = true; offAuto(); };
}
