import { t, formatNumber } from '../i18n/index.js';
import { icon } from '../icons.js';
import { importBackup, backupHasKey } from '../data/backup.js';
import { esc } from './grid.js';

/**
 * Painel de importação de backup: escolher Mesclar ou Substituir e confirmar. Nada é gravado antes do clique.
 * "Substituir" exige uma segunda confirmação in-page (sem confirm()).
 * @param {HTMLElement} host
 * @param {File} file
 * @param {{ onDone?: (r: object) => void, onCancel?: () => void }} [hooks]
 */
export function mountBackupImport(host, file, hooks = {}) {
  let mode = 'merge';
  let armed = false;
  let busy = false;
  let error = null;
  let result = null;
  let hasKey = false;
  let password = '';
  backupHasKey(file).then((v) => { hasKey = v; if (!result) render(); });

  function render(focusSel) {
    if (result) {
      host.innerHTML = `<div class="panel panel--live stack" role="status">
        <h2 class="state__title">${esc(t('backup.done.title'))}</h2>
        <p class="t-body">${esc(t('backup.done.text', { created: formatNumber(result.created), updated: formatNumber(result.updated), merged: formatNumber(result.merged) }))}</p>
        ${result.steam?.key === 'restored' ? `<p class="t-label">${esc(t('backup.done.key'))}</p>` : result.steam?.key === 'skipped' ? `<p class="t-label">${esc(t('backup.done.keyskipped'))}</p>` : ''}
        <div class="row"><a class="btn btn--primary cut-a-8 is-chamfered" href="#/">${esc(t('import.go.library'))}</a></div></div>`;
      return;
    }
    host.innerHTML = `<div class="panel panel--live stack">
      <h2 class="t-section">${esc(t('backup.title'))}</h2>
      <p class="t-data">${esc(file.name)}</p>
      ${error ? `<p class="field__error" role="alert">${icon('alert')} ${esc(t('err.' + error))}</p>` : ''}
      ${hasKey ? `<div class="field"><label class="field__label" for="bk-pw">${esc(t('backup.password'))}</label>
        <input id="bk-pw" class="input cut-a-6 is-chamfered" type="password" autocomplete="off" value="${esc(password)}">
        <p class="t-label">${esc(t('backup.password.text'))}</p></div>` : ''}
      <div class="stack" role="radiogroup" aria-label="${esc(t('backup.mode'))}">
        ${['merge', 'replace'].map((m) => `<label class="choice"><input type="radio" name="bk-mode" value="${m}" ${m === mode ? 'checked' : ''}>
          <span><span class="choice__title">${esc(t('backup.mode.' + m))}</span><span class="t-body">${esc(t('backup.mode.' + m + '.text'))}</span></span></label>`).join('')}
      </div>
      ${armed ? `<div class="panel confirm" role="alertdialog" aria-labelledby="bk-t" aria-describedby="bk-d">
        <h3 class="state__title" id="bk-t">${esc(t('backup.replace.title'))}</h3>
        <p class="t-body" id="bk-d">${esc(t('backup.replace.text'))}</p>
        <div class="row">
          <button type="button" class="btn cut-a-8 is-chamfered" data-act="disarm" id="bk-cancel">${esc(t('common.cancel'))}</button>
          <button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="run" ${busy ? 'disabled' : ''}>${esc(t('backup.replace.confirm'))}</button>
        </div></div>` : `<div class="row">
          <button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-act="${mode === 'replace' ? 'arm' : 'run'}" ${busy ? 'disabled' : ''}>${esc(t('backup.confirm'))}</button>
          <button type="button" class="btn btn--ghost cut-a-8 is-chamfered" data-act="cancel">${esc(t('common.cancel'))}</button></div>`}
    </div>`;
    if (focusSel) host.querySelector(focusSel)?.focus();
  }

  async function run() {
    busy = true; error = null; render();
    try {
      result = await importBackup(file, mode, { password });
      hooks.onDone?.(result);
    } catch (e) {
      error = e?.code || 'backup_invalid';
      armed = false;
    }
    busy = false;
    render();
  }

  host.onclick = (e) => {
    const b = e.target.closest('[data-act]');
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'arm') { armed = true; render('#bk-cancel'); }
    else if (act === 'disarm') { armed = false; render('[data-act="arm"]'); }
    else if (act === 'run') run();
    else if (act === 'cancel') hooks.onCancel?.();
  };
  host.oninput = (e) => { if (e.target.id === 'bk-pw') password = e.target.value; };
  host.onchange = (e) => {
    if (e.target.name === 'bk-mode') { mode = e.target.value; render(`input[value="${mode}"]`); }
  };
  render();
}
