// Mini runner de asserts compartilhado por dev/test.html (navegador) e dev/test-node.mjs (Node).

/** @type {{name: string, fn: () => (void|Promise<void>)}[]} */
const tests = [];

/**
 * Registra um teste.
 * @param {string} name
 * @param {() => (void|Promise<void>)} fn
 */
export function test(name, fn) { tests.push({ name, fn }); }

/** @param {unknown} a @param {unknown} b @returns {boolean} */
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same(/** @type {any} */ (a)[k], /** @type {any} */ (b)[k]));
}

export const assert = {
  /** @param {unknown} v @param {string} [msg] */
  ok(v, msg = 'esperava valor verdadeiro') { if (!v) throw new Error(msg); },
  /** @param {unknown} a @param {unknown} b @param {string} [msg] */
  equal(a, b, msg = '') { if (a !== b) throw new Error(`${msg} esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`.trim()); },
  /** @param {unknown} a @param {unknown} b @param {string} [msg] */
  deepEqual(a, b, msg = '') { if (!same(a, b)) throw new Error(`${msg} esperava ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`.trim()); },
  /** @param {() => Promise<unknown>} fn @param {string} code */
  async rejectsCode(fn, code) {
    try { await fn(); } catch (e) { if (/** @type {any} */ (e)?.code === code) return; throw new Error(`esperava {code:'${code}'}, veio ${JSON.stringify(e)}`); }
    throw new Error(`esperava rejeição com {code:'${code}'}`);
  },
};

/**
 * Executa todos os testes registrados.
 * @returns {Promise<{name: string, ok: boolean, error?: string}[]>}
 */
export async function runAll() {
  const results = [];
  for (const { name, fn } of tests) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: /** @type {any} */ (e)?.message ?? String(e) }); }
  }
  return results;
}
