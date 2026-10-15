// Capas salvas neste navegador (IndexedDB, store `covers`). Sem texto para o usuário.
// A imagem é baixada uma vez, reduzida e guardada; a UI troca o endereço remoto por um `blob:` local.
// Ficam FORA do backup (são refazíveis a partir de `coverUrl`).
import { getAllCovers, putCover, deleteCovers, clearCovers } from './db.js';

const MAX_WIDTH = 400;
const CONCURRENCY = 4;
const FETCH_TIMEOUT_MS = 20000; // a CDN às vezes demora muito: desiste e segue para a próxima

/** @type {Map<string, string>} url original → blob: URL */
const local = new Map();
/** @type {Promise<void>|null} */
let loading = null;

/** Carrega (uma vez) as capas salvas. Nunca lança: sem armazenamento, tudo segue com os endereços remotos. */
export function preloadCovers() {
  loading ??= getAllCovers()
    .then((rows) => { for (const r of rows) if (r?.blob && !local.has(r.url)) local.set(r.url, URL.createObjectURL(r.blob)); })
    .catch(() => {});
  return loading;
}

/** @param {string} url @returns {string} a cópia local da capa, se houver; senão o próprio endereço */
export const localCover = (url) => local.get(url) ?? url;

/** @returns {number} quantas capas estão salvas */
export const savedCount = () => local.size;

/**
 * Reduz a imagem (largura máx. 400 px, WebP). Sem suporte do navegador ou sem ganho, devolve a original.
 * @param {Blob} blob
 * @returns {Promise<Blob>}
 */
export async function shrinkImage(blob) {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') return blob;
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, MAX_WIDTH / bmp.width);
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(bmp.width * k)), Math.max(1, Math.round(bmp.height * k)));
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
    const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.82 });
    return out.size > 0 && out.size < blob.size ? out : blob;
  } catch {
    return blob;
  }
}

/**
 * Baixa e guarda uma capa. `true` = salva; `false` = não deu (sem CORS, 404, não é imagem).
 * Falha do armazenamento (`idb_unavailable`) é repassada.
 * @param {string} url
 * @param {{fetchImpl?: typeof fetch, shrink?: (b: Blob) => Promise<Blob>}} [deps]
 */
export async function saveCover(url, deps = {}) {
  let blob;
  try {
    const res = await (deps.fetchImpl ?? fetch)(url, { mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return false;
    const raw = await res.blob();
    if (!/^image\//.test(raw.type)) return false;
    blob = await (deps.shrink ?? shrinkImage)(raw);
  } catch {
    return false;
  }
  await putCover(url, blob);
  local.set(url, URL.createObjectURL(blob));
  return true;
}

/** @param {{coverUrl: string|null}[]} games @returns {string[]} capas ainda não salvas */
export function pendingCovers(games) {
  return [...new Set(games.map((g) => g.coverUrl).filter((u) => typeof u === 'string' && /^https?:\/\//.test(u) && !local.has(u)))];
}

/**
 * Salva as capas que faltam (4 ao mesmo tempo). Cancelável. Também descarta cópias de capas que nenhum jogo usa mais.
 * @param {{coverUrl: string|null}[]} games
 * @param {{signal?: AbortSignal, onProgress?: (p: {done: number, total: number}) => void, deps?: object}} [opts]
 * @returns {Promise<{saved: number, failed: number, cancelled: boolean}>}
 */
export async function queueSaveCovers(games, opts = {}) {
  await preloadCovers();
  const used = new Set(games.map((g) => g.coverUrl));
  const stale = [...local.keys()].filter((u) => !used.has(u));
  if (stale.length) {
    await deleteCovers(stale);
    for (const u of stale) { URL.revokeObjectURL(local.get(u)); local.delete(u); }
  }
  const todo = pendingCovers(games);
  const res = { saved: 0, failed: 0, cancelled: false };
  let next = 0, done = 0;
  const worker = async () => {
    while (next < todo.length) {
      if (opts.signal?.aborted) { res.cancelled = true; return; }
      const url = todo[next++];
      if (await saveCover(url, opts.deps)) res.saved++; else res.failed++;
      opts.onProgress?.({ done: ++done, total: todo.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  return res;
}

/** Apaga todas as capas salvas. */
export async function clearSavedCovers() {
  await clearCovers();
  for (const u of local.values()) URL.revokeObjectURL(u);
  local.clear();
}
