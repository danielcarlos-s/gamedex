import { t } from '../i18n/index.js';
import { icon } from '../icons.js';
import { esc } from './grid.js';

/**
 * Guias passo a passo abertos em modal (`<dialog>` nativo: foco preso, Esc fecha, foco volta ao botão de origem).
 * Textos nos dicionários (`help.<tópico>.*`); comandos e links são dados, não traduzidos.
 * `steps`: { k: sufixo da chave do texto, cmd?: comando em bloco de código, link?: { url, k: sufixo da chave do rótulo } }
 */
const TOPICS = {
  worker: {
    steps: [
      { k: 's1', link: { url: 'https://dash.cloudflare.com/sign-up', k: 'l1' } },
      { k: 's2', link: { url: 'https://nodejs.org', k: 'l2' } },
      { k: 's3', cmd: 'git clone https://github.com/danielcarlos-s/gamedex.git\ncd gamedex/worker' },
      { k: 's4', cmd: 'ALLOWED_ORIGINS = "https://seu-usuario.github.io,http://localhost:8080"' },
      { k: 's5', cmd: 'npx wrangler login' },
      { k: 's6', cmd: 'npx wrangler deploy' },
      { k: 's7', cmd: 'https://gamedex-steam-proxy.seu-usuario.workers.dev' },
    ],
    notes: ['n1', 'n2'],
  },
  steamid: {
    steps: [
      { k: 's1', link: { url: 'https://steamcommunity.com', k: 'l1' } },
      { k: 's2', cmd: 'https://steamcommunity.com/profiles/76561198000000000' },
      { k: 's3', cmd: 'https://steamcommunity.com/id/seunome' },
      { k: 's4', link: { url: 'https://steamid.io', k: 'l2' } },
      { k: 's5' },
    ],
    notes: ['n1'],
  },
  apikey: {
    steps: [
      { k: 's1', link: { url: 'https://steamcommunity.com/dev/apikey', k: 'l1' } },
      { k: 's2', cmd: 'localhost' },
      { k: 's3' },
      { k: 's4' },
    ],
    notes: ['n1', 'n2'],
  },
};

/** @param {string} topic @returns {string} */
function bodyHtml(topic) {
  const def = /** @type {any} */ (TOPICS)[topic];
  const steps = def.steps.map((/** @type {any} */ s) => `<li>
      <span>${esc(t(`help.${topic}.${s.k}`))}</span>
      ${s.cmd ? `<pre class="help__code"><code>${esc(s.cmd)}</code></pre>` : ''}
      ${s.link ? `<a class="help__link" href="${esc(s.link.url)}" target="_blank" rel="noopener noreferrer">${esc(t(`help.${topic}.${s.link.k}`))}</a>` : ''}
    </li>`).join('');
  const notes = def.notes.map((/** @type {string} */ n) => `<p class="t-label help__note">${esc(t(`help.${topic}.${n}`))}</p>`).join('');
  return `<ol class="help__steps t-body">${steps}</ol>${notes}`;
}

/**
 * Abre o guia `topic` (`worker` | `steamid` | `apikey`) num modal. Devolve o foco a `trigger` ao fechar.
 * @param {'worker'|'steamid'|'apikey'} topic
 * @param {HTMLElement|null} [trigger]
 */
export function openHelp(topic, trigger = null) {
  if (!(/** @type {any} */ (TOPICS))[topic]) return;
  const dlg = document.createElement('dialog');
  dlg.className = 'help';
  dlg.setAttribute('aria-labelledby', 'help-title');
  dlg.innerHTML = `<div class="help__head">
      <h2 class="t-section" id="help-title">${esc(t(`help.${topic}.title`))}</h2>
      <button type="button" class="btn btn--ghost cut-a-6 is-chamfered" data-close aria-label="${esc(t('common.close'))}">${icon('close')}</button>
    </div>
    <div class="help__body stack">${bodyHtml(topic)}</div>
    <div class="row"><button type="button" class="btn btn--primary cut-a-8 is-chamfered" data-close>${esc(t('common.close'))}</button></div>`;
  dlg.addEventListener('click', (e) => {
    const el = /** @type {HTMLElement} */ (e.target);
    if (el === dlg || el.closest('[data-close]')) dlg.close(); // clique no fundo (::backdrop) fecha
  });
  dlg.addEventListener('close', () => { dlg.remove(); trigger?.focus(); });
  document.body.append(dlg);
  dlg.showModal();
}
