import { pt } from './pt.js';
import { en } from './en.js';

const STORAGE_KEY = 'portfolio-lang';
const DICTS = { pt, en };
const LOCALES = { pt: 'pt-BR', en: 'en-US' };
const HTML_LANG = { pt: 'pt-BR', en: 'en' };
const IS_LOCAL = ['localhost', '127.0.0.1', ''].includes(location.hostname);

const listeners = new Set();
let lang = detectLang();

function detectLang() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'pt' || saved === 'en') return saved;
  } catch { /* storage indisponível */ }
  return String(navigator.language || '').toLowerCase().startsWith('pt') ? 'pt' : 'en';
}

/** @returns {'pt'|'en'} idioma atual */
export function getLang() { return lang; }

/**
 * Traduz uma chave. Ausente em `en` cai para `pt` (aviso só em localhost).
 * @param {string} key
 * @param {Record<string, string|number>} [params] substitui `{nome}`
 * @returns {string}
 */
export function t(key, params) {
  let str = DICTS[lang][key];
  if (str === undefined) {
    str = pt[key];
    if (IS_LOCAL) console.warn(`[i18n] chave ausente em ${lang}: ${key}`);
  }
  if (str === undefined) return key;
  if (params) str = str.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
  return str;
}

/**
 * Aplica data-i18n (texto) e data-i18n-attr ("attr:chave;attr2:chave2") em um trecho do DOM.
 * @param {ParentNode} [root]
 */
export function applyI18n(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    el.dataset.i18nAttr.split(';').forEach((pair) => {
      const i = pair.indexOf(':');
      if (i > 0) el.setAttribute(pair.slice(0, i).trim(), t(pair.slice(i + 1).trim()));
    });
  });
}

/**
 * Troca o idioma: grava `portfolio-lang`, atualiza <html lang>, re-traduz e avisa os ouvintes.
 * @param {'pt'|'en'} next
 */
export function setLang(next) {
  if (next !== 'pt' && next !== 'en') return;
  lang = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignora */ }
  document.documentElement.lang = HTML_LANG[next];
  applyI18n();
  listeners.forEach((cb) => cb(next));
}

/**
 * @param {(lang: 'pt'|'en') => void} cb
 * @returns {() => void} cancela a inscrição
 */
export function onLangChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Aplica o idioma inicial ao documento (chamar uma vez no bootstrap). */
export function initI18n() {
  document.documentElement.lang = HTML_LANG[lang];
  applyI18n();
}

/** @param {number} n @param {Intl.NumberFormatOptions} [opts] */
export function formatNumber(n, opts) {
  return new Intl.NumberFormat(LOCALES[lang], opts).format(n);
}

/** @param {string|number|Date|null} value ISO/data @param {Intl.DateTimeFormatOptions} [opts] */
export function formatDate(value, opts = { dateStyle: 'medium' }) {
  if (!value) return t('common.none');
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return t('common.none');
  return new Intl.DateTimeFormat(LOCALES[lang], opts).format(d);
}

/** @param {number|null|undefined} minutes tempo jogado em minutos */
export function formatPlaytime(minutes) {
  if (!minutes || minutes < 1) return t('time.none');
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return t('time.m', { m });
  const hs = formatNumber(h);
  return m === 0 || h >= 100 ? t('time.h', { h: hs }) : t('time.hm', { h: hs, m });
}
