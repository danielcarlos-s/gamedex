// Cifra/decifra a chave da Steam API para o arquivo de backup (senha → PBKDF2-SHA256 → AES-GCM, via Web Crypto).
// Sem DOM e sem texto para o usuário: falhas viram `throw { code }`.
//
// Envelope: { v: 1, kdf: 'PBKDF2-SHA256', iter, salt, iv, ct } (salt/iv/ct em base64).

const ITER = 600_000;
const enc = new TextEncoder();

/** @param {Uint8Array} u8 @returns {string} */
const toB64 = (u8) => btoa(String.fromCharCode(...u8));
/** @param {string} s @returns {Uint8Array} */
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * @param {string} password
 * @param {Uint8Array} salt
 * @param {number} iter
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(password, salt, iter) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/**
 * Cifra um texto com a senha. Lança `bad_request` se a senha for vazia.
 * @param {string} plain
 * @param {string} password
 * @returns {Promise<{v: 1, kdf: string, iter: number, salt: string, iv: string, ct: string}>}
 */
export async function encryptSecret(plain, password) {
  if (!password) throw { code: 'bad_request' };
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, ITER);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plain)));
  return { v: 1, kdf: 'PBKDF2-SHA256', iter: ITER, salt: toB64(salt), iv: toB64(iv), ct: toB64(ct) };
}

/**
 * Decifra um envelope. Lança `backup_password` se a senha estiver errada ou o envelope for inválido/adulterado.
 * @param {any} env
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function decryptSecret(env, password) {
  try {
    if (!env || env.v !== 1 || env.kdf !== 'PBKDF2-SHA256' || !Number.isInteger(env.iter) || env.iter < 1 || env.iter > 5_000_000) throw 0;
    const key = await deriveKey(password, fromB64(env.salt), env.iter);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(env.iv) }, key, fromB64(env.ct));
    return new TextDecoder().decode(buf);
  } catch {
    throw { code: 'backup_password' };
  }
}
