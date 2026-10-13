// Registro de lojas (o texto traduzido das fixas fica na UI, `storeLabel` em ui/grid.js): as 7 fixas (model.js) + as que o usuário cria em Ajustes (meta `customStores`).
// Sem DOM e sem texto para o usuário além do nome da loja: falhas viram `throw { code }`.
//
// Loja criada: { id: 'c-xxxxxxxx', name, hue }. O `id` nunca muda (renomear só troca `name`), então jogos e backups
// não perdem a ligação. A cor vem de uma paleta fixa de matizes (mesmo brilho e croma das lojas fixas, ver tokens.css).

import { getMeta, setMeta } from './db.js';
import { STORES, isStoreId } from './model.js';

/** Matizes oferecidos para lojas criadas (longe dos das fixas: 25, 55, 130, 165, 250, 305). */
export const CUSTOM_HUES = Object.freeze([10, 85, 105, 195, 215, 280, 340, 355]);
export const MAX_NAME = 30;

/**
 * @typedef {object} CustomStore
 * @property {string} id `c-` + 8 caracteres [a-z0-9]
 * @property {string} name
 * @property {number} hue um de `CUSTOM_HUES`
 */

/** Nomes das lojas fixas (PT/EN, como o usuário digitaria) — uma loja criada não pode usá-los. */
const RESERVED = ['steam', 'epic', 'epicgames', 'gog', 'ubisoft', 'ubisoftconnect', 'ea', 'eaapp', 'amazon', 'amazongames', 'outra', 'outro', 'other'];

/** @type {CustomStore[]} */
let custom = [];
/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Normaliza um nome para comparar/achar: minúsculas, sem acento nem pontuação ("Battle.net" → "battlenet").
 * @param {unknown} s
 * @returns {string}
 */
export function squashName(s) {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** @param {unknown} v @returns {v is CustomStore} */
function validStore(v) {
  const s = /** @type {any} */ (v);
  return !!s && typeof s === 'object' && isStoreId(s.id) && !STORES.includes(s.id)
    && typeof s.name === 'string' && s.name.trim() !== '' && s.name.length <= MAX_NAME && CUSTOM_HUES.includes(s.hue);
}

/**
 * Filtra uma lista vinda de fora (backup/banco): só entradas válidas, sem ids repetidos.
 * @param {unknown} list
 * @returns {CustomStore[]}
 */
export function sanitizeStores(list) {
  const seen = new Set();
  /** @type {CustomStore[]} */ const out = [];
  for (const s of Array.isArray(list) ? list : []) {
    if (!validStore(s) || seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ id: s.id, name: s.name.trim(), hue: s.hue });
  }
  return out;
}

const emit = () => listeners.forEach((cb) => cb());

/** @param {() => void} cb @returns {() => void} desligar */
export function onStoresChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }

/** Carrega as lojas criadas do banco (chamar na partida e depois de importar um backup). Nunca lança. */
export async function loadStores() {
  try { custom = sanitizeStores(await getMeta('customStores')); } catch { custom = []; }
  emit();
}

/** @returns {CustomStore[]} cópia das lojas criadas, na ordem de criação */
export const getCustomStores = () => custom.map((s) => ({ ...s }));

/** @returns {string[]} ids na ordem de exibição: fixas (sem "Outra"), criadas, "Outra" */
export const allStoreIds = () => [...STORES.filter((s) => s !== 'other'), ...custom.map((s) => s.id), 'other'];

/** @param {string} id @returns {CustomStore|undefined} */
export const customStore = (id) => custom.find((s) => s.id === id);

/**
 * Matiz de uma loja criada (null nas fixas, que têm cor própria em tokens.css).
 * @param {string} id
 * @returns {number|null}
 */
export const storeHue = (id) => customStore(id)?.hue ?? null;

/**
 * Acha o id de uma loja criada pelo nome (sem diferenciar maiúsculas/acentos/pontuação) ou pelo próprio id.
 * As lojas fixas são resolvidas pelo CSV (apelidos). Devolve null se não achar.
 * @param {string} text
 * @returns {string|null}
 */
export function customStoreFromText(text) {
  const raw = String(text ?? '').trim();
  const byId = custom.find((s) => s.id === raw);
  if (byId) return byId.id;
  const k = squashName(raw);
  return k ? (custom.find((s) => squashName(s.name) === k)?.id ?? null) : null;
}

/**
 * Valida um nome para criar/renomear. Lança `store_name_required`, `store_name_long` ou `store_name_taken`.
 * @param {string} name
 * @param {string} [selfId] loja sendo renomeada (pode manter o próprio nome)
 * @returns {string} o nome aparado
 */
function checkName(name, selfId) {
  const n = String(name ?? '').trim().replace(/\s+/g, ' ');
  if (!n || !squashName(n)) throw { code: 'store_name_required' };
  if (n.length > MAX_NAME) throw { code: 'store_name_long' };
  const k = squashName(n);
  if (RESERVED.includes(k) || custom.some((s) => s.id !== selfId && squashName(s.name) === k)) throw { code: 'store_name_taken' };
  return n;
}

const newId = () => {
  const a = new Uint8Array(8);
  crypto.getRandomValues(a);
  return 'c-' + [...a].map((b) => (b % 36).toString(36)).join('');
};

/** @param {CustomStore[]} list */
async function persist(list) {
  await setMeta('customStores', list.length ? list : null);
  custom = list;
  emit();
}

/**
 * Cria uma loja. Lança `store_name_*` ou `bad_request` (matiz fora da paleta).
 * @param {string} name
 * @param {number} hue
 * @returns {Promise<CustomStore>}
 */
export async function createStore(name, hue) {
  if (!CUSTOM_HUES.includes(hue)) throw { code: 'bad_request' };
  const store = { id: newId(), name: checkName(name), hue };
  await persist([...custom, store]);
  return { ...store };
}

/**
 * Renomeia e/ou troca a cor de uma loja criada (o `id` não muda). Lança `not_found`, `store_name_*`, `bad_request`.
 * @param {string} id
 * @param {{ name?: string, hue?: number }} changes
 * @returns {Promise<CustomStore>}
 */
export async function updateStore(id, changes) {
  const cur = customStore(id);
  if (!cur) throw { code: 'not_found' };
  if (changes.hue !== undefined && !CUSTOM_HUES.includes(changes.hue)) throw { code: 'bad_request' };
  const next = { ...cur, name: changes.name !== undefined ? checkName(changes.name, id) : cur.name, hue: changes.hue ?? cur.hue };
  await persist(custom.map((s) => (s.id === id ? next : s)));
  return { ...next };
}

/**
 * Exclui uma loja criada, só se nenhum jogo a usar. Lança `not_found` ou `store_in_use`.
 * @param {string} id
 * @param {{ ownerships?: { store: string }[] }[]} games todos os jogos (para conferir o uso)
 * @returns {Promise<void>}
 */
export async function deleteStore(id, games) {
  if (!customStore(id)) throw { code: 'not_found' };
  if (games.some((g) => (g.ownerships || []).some((o) => o.store === id))) throw { code: 'store_in_use' };
  await persist(custom.filter((s) => s.id !== id));
}

/**
 * Usado pelo backup: grava a lista como está (`replace`) ou junta só as lojas que ainda não existem (`merge`).
 * @param {unknown} incoming lista vinda do arquivo (é validada)
 * @param {'replace'|'merge'} mode
 * @returns {Promise<void>}
 */
export async function restoreStores(incoming, mode) {
  const list = sanitizeStores(incoming);
  if (mode === 'replace') { await persist(list); return; }
  const have = new Set(custom.map((s) => s.id));
  const extra = list.filter((s) => !have.has(s.id) && !custom.some((c) => squashName(c.name) === squashName(s.name)));
  if (extra.length) await persist([...custom, ...extra]);
}
