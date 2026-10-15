// Wrapper do IndexedDB (PLANO 6.3). Sem DOM e sem texto para o usuário.
// Falhas viram `throw { code: 'idb_unavailable' }` (modo privado, banco bloqueado, cota estourada).

/** @typedef {import('./model.js').Game} Game */

/**
 * Evento entregue aos ouvintes de `onChange`, depois que a transação foi confirmada.
 * `type: 'games'` = mudou algum jogo; `type: 'meta'` = mudou uma chave de meta. Quem grava meta dentro de um
 * ouvinte (ex.: `lastBackupAt` no auto-save) deve reagir SÓ a `'games'`, senão entra em laço.
 * @typedef {object} ChangeEvent
 * @property {'games'|'meta'} type
 * @property {'put'|'delete'|'clear'|'replace'} [op] só em `games`
 * @property {string[]} [ids] ids dos jogos gravados/apagados (`games`)
 * @property {string} [key] chave de meta (`meta`)
 */

const DB_NAME = 'gamedex';
const DB_VERSION = 2;
const GAMES = 'games';
const META = 'meta';
const COVERS = 'covers'; // capas salvas neste navegador: { url, blob }, chave = url da capa

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;
/** @type {Set<(e: ChangeEvent) => void>} */
const listeners = new Set();

/** @returns {{code: string}} */
/** @param {any} [cause] erro original do navegador (vai para o console e para `detail`, para diagnóstico) */
const unavailable = (cause) => {
  if (cause) console.error('[gamedex] IndexedDB:', cause?.name || '', cause?.message || cause);
  return { code: 'idb_unavailable', detail: cause?.name || null };
};

/**
 * Abre (uma vez) o banco e cria o schema v1: `games` (keyPath `id`, índice `titleKey`) e `meta` (chave externa).
 * @returns {Promise<IDBDatabase>}
 */
function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(unavailable());
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      return reject(unavailable(e));
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(GAMES)) {
        db.createObjectStore(GAMES, { keyPath: 'id' }).createIndex('titleKey', 'titleKey', { unique: false });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(COVERS)) db.createObjectStore(COVERS, { keyPath: 'url' });
      req.transaction?.objectStore(META).put(1, 'schemaVersion');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => { db.close(); dbPromise = null; };
      resolve(db);
    };
    req.onerror = () => reject(unavailable(req.error));
    req.onblocked = () => reject(unavailable());
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

/**
 * Executa `work` numa transação e resolve com o resultado do request devolvido, após o commit.
 * @template T
 * @param {string[]} stores
 * @param {IDBTransactionMode} mode
 * @param {(tx: IDBTransaction) => IDBRequest<T>|undefined} work
 * @returns {Promise<T|undefined>}
 */
async function run(stores, mode, work) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    /** @type {T|undefined} */
    let result;
    let tx;
    try {
      tx = db.transaction(stores, mode);
      const req = work(tx);
      if (req) req.onsuccess = () => { result = req.result; };
    } catch (e) {
      return reject(unavailable(e));
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(unavailable(tx.error));
    tx.onabort = () => reject(unavailable(tx.error));
  });
}

/**
 * Avisa os ouvintes; um ouvinte com erro não impede os demais.
 * @param {ChangeEvent} event
 */
function emit(event) {
  for (const cb of [...listeners]) {
    try {
      cb(event);
    } catch (err) {
      console.error('[gamedex] erro em ouvinte de onChange', err);
    }
  }
}

/**
 * Registra um ouvinte chamado após qualquer escrita confirmada (jogos e meta).
 * @param {(e: ChangeEvent) => void} cb
 * @returns {() => void} função que cancela o registro
 */
export function onChange(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Todos os jogos, sem ordem garantida.
 * @returns {Promise<Game[]>}
 */
export async function getAllGames() {
  return (await run([GAMES], 'readonly', (tx) => tx.objectStore(GAMES).getAll())) ?? [];
}

/**
 * @param {string} id
 * @returns {Promise<Game|null>} null se não existir
 */
export async function getGame(id) {
  return (await run([GAMES], 'readonly', (tx) => tx.objectStore(GAMES).get(id))) ?? null;
}

/**
 * Grava (insere ou substitui) um jogo. Não altera `updatedAt`: quem edita é que carimba.
 * @param {Game} game
 * @returns {Promise<void>}
 */
export async function putGame(game) {
  await run([GAMES], 'readwrite', (tx) => tx.objectStore(GAMES).put(game));
  emit({ type: 'games', op: 'put', ids: [game.id] });
}

/**
 * Grava vários jogos numa única transação (tudo ou nada).
 * @param {Game[]} games
 * @returns {Promise<void>}
 */
export async function putGames(games) {
  if (games.length === 0) return;
  await run([GAMES], 'readwrite', (tx) => {
    const store = tx.objectStore(GAMES);
    for (const g of games) store.put(g);
    return undefined;
  });
  emit({ type: 'games', op: 'put', ids: games.map((g) => g.id) });
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
export async function deleteGame(id) {
  await run([GAMES], 'readwrite', (tx) => tx.objectStore(GAMES).delete(id));
  emit({ type: 'games', op: 'delete', ids: [id] });
}

/**
 * Apaga todos os jogos (meta é preservado).
 * @returns {Promise<void>}
 */
export async function clearGames() {
  await run([GAMES], 'readwrite', (tx) => tx.objectStore(GAMES).clear());
  emit({ type: 'games', op: 'clear' });
}

/**
 * Substitui TODOS os jogos pelos recebidos numa única transação (tudo ou nada): usado pelo "importar e substituir".
 * @param {Game[]} games
 * @returns {Promise<void>}
 */
export async function replaceGames(games) {
  await run([GAMES], 'readwrite', (tx) => {
    const store = tx.objectStore(GAMES);
    store.clear();
    for (const g of games) store.put(g);
    return undefined;
  });
  emit({ type: 'games', op: 'replace', ids: games.map((g) => g.id) });
}

/**
 * @param {string} key `schemaVersion`, `lastSteamSync`, `lastBackupAt`, `workerUrl`, `linkedFileHandle`
 * @returns {Promise<any>} o valor, ou null se não existir
 */
export async function getMeta(key) {
  return (await run([META], 'readonly', (tx) => tx.objectStore(META).get(key))) ?? null;
}

/**
 * Grava um valor de meta (aceita qualquer coisa clonável, inclusive FileSystemFileHandle).
 * @param {string} key
 * @param {any} value
 * @returns {Promise<void>}
 */
export async function setMeta(key, value) {
  await run([META], 'readwrite', (tx) => tx.objectStore(META).put(value, key));
  emit({ type: 'meta', key });
}

// ---------------------------------------------------------------- capas salvas (ficam fora do backup)

/** @returns {Promise<{url: string, blob: Blob}[]>} */
export async function getAllCovers() {
  return (await run([COVERS], 'readonly', (tx) => tx.objectStore(COVERS).getAll())) ?? [];
}

/**
 * @param {string} url endereço original da capa (chave)
 * @param {Blob} blob imagem já reduzida
 * @returns {Promise<void>}
 */
export async function putCover(url, blob) {
  await run([COVERS], 'readwrite', (tx) => tx.objectStore(COVERS).put({ url, blob }));
}

/**
 * @param {string[]} urls
 * @returns {Promise<void>}
 */
export async function deleteCovers(urls) {
  if (!urls.length) return;
  await run([COVERS], 'readwrite', (tx) => { const st = tx.objectStore(COVERS); for (const u of urls) st.delete(u); return undefined; });
}

/** @returns {Promise<void>} */
export async function clearCovers() {
  await run([COVERS], 'readwrite', (tx) => tx.objectStore(COVERS).clear());
}
