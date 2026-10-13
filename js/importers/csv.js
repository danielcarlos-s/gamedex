// Importador de CSV (PLANO 6.5): parser próprio, template baixável e conversão para IncomingGame.
// Sem DOM e sem texto para o usuário: erros são `{ row, code }` (seção 6.4). `row` é a linha física do arquivo
// onde o registro começa (cabeçalho = 1, primeiro jogo = 2), a mesma que o usuário vê na planilha.

import { isStoreId, STATUSES, normalizeTitle } from '../data/model.js';

/** @typedef {import('../data/model.js').IncomingGame} IncomingGame */

/** Cabeçalho canônico (inglês), na ordem do template. */
export const CSV_COLUMNS = Object.freeze([
  'title', 'store', 'storeGameId', 'status', 'playtimeMinutes', 'tags', 'genres', 'rating', 'developer', 'year', 'notes', 'coverUrl',
]);

/** Cabeçalho do template em português, na mesma ordem de `CSV_COLUMNS`. */
const COLUMNS_PT = Object.freeze([
  'titulo', 'loja', 'idLoja', 'status', 'minutosJogados', 'tags', 'generos', 'nota', 'desenvolvedora', 'ano', 'notas', 'urlCapa',
]);

/**
 * Chave de comparação para cabeçalhos e valores: minúsculo, sem acento, só letras e números.
 * @param {string} s
 * @returns {string}
 */
const squash = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** @type {Record<string, string>} apelido de cabeçalho (já "squashed") → coluna canônica */
const HEADER_ALIASES = {};
for (const [col, names] of Object.entries({
  title: ['title', 'titulo', 'nome', 'name', 'jogo', 'game'],
  store: ['store', 'loja', 'plataforma', 'platform'],
  storeGameId: ['storegameid', 'idloja', 'idjogo', 'appid', 'gameid'],
  status: ['status', 'situacao', 'estado'],
  playtimeMinutes: ['playtimeminutes', 'minutosjogados', 'minutos', 'tempojogado', 'playtime'],
  tags: ['tags', 'etiquetas'],
  genres: ['genres', 'generos', 'genero', 'genre'],
  rating: ['rating', 'nota', 'avaliacao'],
  developer: ['developer', 'desenvolvedora', 'desenvolvedor', 'dev'],
  year: ['year', 'ano'],
  notes: ['notes', 'notas', 'observacoes', 'anotacoes'],
  coverUrl: ['coverurl', 'urlcapa', 'capa', 'cover'],
})) for (const n of names) HEADER_ALIASES[n] = col;

/** @type {Record<string, string>} valor de loja (squashed, PT ou EN) → Store */
const STORE_ALIASES = {
  steam: 'steam',
  epic: 'epic', epicgames: 'epic', epicgamesstore: 'epic', egs: 'epic',
  gog: 'gog', goggalaxy: 'gog', gogcom: 'gog',
  ubisoft: 'ubisoft', ubisoftconnect: 'ubisoft', uplay: 'ubisoft',
  ea: 'ea', eaapp: 'ea', origin: 'ea', eaorigin: 'ea', eaplay: 'ea',
  amazon: 'amazon', amazongames: 'amazon', primegaming: 'amazon', amazonprimegaming: 'amazon',
  other: 'other', outro: 'other', outra: 'other', outros: 'other', outras: 'other',
};

/** @type {Record<string, string>} valor de status (squashed, PT ou EN) → Status */
const STATUS_ALIASES = {
  backlog: 'backlog', pendente: 'backlog', fila: 'backlog', nafila: 'backlog', parajogar: 'backlog',
  playing: 'playing', jogando: 'playing', emandamento: 'playing',
  paused: 'paused', pausado: 'paused', pausa: 'paused',
  finished: 'finished', zerado: 'finished', terminado: 'finished', concluido: 'finished',
  completed: 'completed', completo: 'completed', platinado: 'completed', '100': 'completed',
  dropped: 'dropped', abandonado: 'dropped', largado: 'dropped',
};

/**
 * Detecta o separador (`,` ou `;`) pela primeira linha, ignorando o que está entre aspas. Empate → vírgula.
 * @param {string} text texto já sem BOM
 * @returns {',' | ';'}
 */
function detectDelimiter(text) {
  let commas = 0;
  let semis = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted) {
      if (ch === '\n' || ch === '\r') break;
      if (ch === ',') commas++;
      else if (ch === ';') semis++;
    }
  }
  return semis > commas ? ';' : ',';
}

/**
 * Parser CSV (RFC 4180): aspas, `""` como aspas literais, quebras de linha dentro de aspas, CRLF/LF/CR.
 * @param {string} text texto já sem BOM
 * @param {string} delimiter
 * @returns {{cells: string[], line: number}[]} registros com a linha física onde começam (base 1)
 */
function parseRecords(text, delimiter) {
  /** @type {{cells: string[], line: number}[]} */
  const records = [];
  /** @type {string[]} */
  let cells = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let startLine = 1;
  let pending = false; // há conteúdo no registro corrente (inclusive uma célula vazia entre separadores)

  const endCell = () => { cells.push(cell); cell = ''; };
  const endRecord = () => {
    endCell();
    records.push({ cells, line: startLine });
    cells = [];
    pending = false;
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') { quoted = true; pending = true; continue; }
    if (ch === delimiter) { endCell(); pending = true; continue; }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      if (pending || cell !== '') endRecord();
      line++;
      startLine = line;
      continue;
    }
    cell += ch;
    pending = true;
  }
  if (pending || cell !== '') endRecord();
  return records;
}

/**
 * Converte um número da planilha: vazio → `undefined`; senão inteiro ≥ 0 (aceita "12", "12.0", "12,0").
 * @param {string} raw
 * @returns {number|undefined|null} `null` = inválido
 */
function parseCount(raw) {
  if (raw === '') return undefined;
  if (!/^\d+([.,]0+)?$/.test(raw)) return null;
  return parseInt(raw, 10);
}

/**
 * Lista separada por `|` (sem itens vazios, sem repetidos).
 * @param {string} raw
 * @returns {string[]|undefined}
 */
function parseList(raw) {
  const items = [...new Set(raw.split('|').map((s) => s.trim()).filter(Boolean))];
  return items.length ? items : undefined;
}

/**
 * Lê um CSV de jogos. Detecta `,`/`;`, aspas, BOM UTF-8 e CRLF. Aceita cabeçalho em PT ou EN e valores de
 * loja/status em PT ou EN, sem diferenciar maiúsculas/acentos. Obrigatório: `title`. A loja vem da coluna `store`
 * (por linha, então um arquivo pode trazer várias lojas) ou, para linhas sem loja / arquivo sem a coluna, de
 * `options.defaultStore`. `options.resolveStore(texto)` resolve nomes de lojas criadas pelo usuário.
 * Linhas inválidas vão para `errors` e não entram em `rows`; linhas totalmente vazias são ignoradas.
 * Erros de arquivo: `csv_empty` (sem nenhuma linha de dados) e `csv_missing_title`/`csv_missing_store`
 * na linha 1 quando a COLUNA obrigatória não existe no cabeçalho.
 * @param {string} text
 * @param {{ defaultStore?: string, resolveStore?: (text: string) => string|null }} [options]
 * @returns {{rows: IncomingGame[], errors: {row: number, code: string}[]}}
 */
export function parseCsv(text, options = {}) {
  const defaultStore = options.defaultStore && isStoreId(options.defaultStore) ? options.defaultStore : undefined;
  /** @type {IncomingGame[]} */ const rows = [];
  /** @type {{row: number, code: string}[]} */ const errors = [];
  const clean = String(text ?? '').replace(/^﻿/, '');
  const records = parseRecords(clean, detectDelimiter(clean));
  if (records.length === 0 || records.every((r) => r.cells.every((c) => c.trim() === ''))) {
    return { rows, errors: [{ row: 0, code: 'csv_empty' }] };
  }

  const [header, ...data] = records;
  /** @type {Map<string, number>} coluna canônica → índice (a primeira ocorrência vence) */
  const col = new Map();
  header.cells.forEach((h, i) => {
    const canon = HEADER_ALIASES[squash(h)];
    if (canon && !col.has(canon)) col.set(canon, i);
  });
  if (!col.has('title')) errors.push({ row: header.line, code: 'csv_missing_title' });
  if (!col.has('store') && !defaultStore) errors.push({ row: header.line, code: 'csv_missing_store' });
  if (errors.length) return { rows, errors };

  const dataRecords = data.filter((r) => r.cells.some((c) => c.trim() !== ''));
  if (dataRecords.length === 0) return { rows, errors: [{ row: 0, code: 'csv_empty' }] };

  for (const rec of dataRecords) {
    const get = (/** @type {string} */ name) => {
      const i = col.get(name);
      return i === undefined ? '' : (rec.cells[i] ?? '').trim();
    };
    const row = rec.line;
    const fail = (/** @type {string} */ code) => { errors.push({ row, code }); };

    const title = get('title');
    if (!title || normalizeTitle(title) === '') { fail('csv_missing_title'); continue; }

    const storeRaw = get('store');
    /** @type {string|null|undefined} */
    let store;
    if (!storeRaw) {
      if (!defaultStore) { fail('csv_missing_store'); continue; }
      store = defaultStore;
    } else {
      store = STORE_ALIASES[squash(storeRaw)] ?? options.resolveStore?.(storeRaw) ?? null;
      if (!store || !isStoreId(store)) { fail('csv_invalid_store'); continue; }
    }

    const statusRaw = get('status');
    let status;
    if (statusRaw) {
      status = STATUS_ALIASES[squash(statusRaw)];
      if (!status || !STATUSES.includes(/** @type {any} */ (status))) { fail('csv_invalid_status'); continue; }
    }

    const playtime = parseCount(get('playtimeMinutes'));
    if (playtime === null) { fail('csv_invalid_number'); continue; }
    const year = parseCount(get('year'));
    if (year === null) { fail('csv_invalid_number'); continue; }

    const ratingRaw = get('rating');
    let rating;
    if (ratingRaw) {
      if (!/^[0-5]$/.test(ratingRaw)) { fail('csv_invalid_rating'); continue; }
      rating = Number(ratingRaw);
    }

    /** @type {IncomingGame} */
    const game = { title, store: /** @type {any} */ (store), source: 'csv', row };
    const storeGameId = get('storeGameId');
    if (storeGameId) game.storeGameId = storeGameId;
    if (status) game.status = /** @type {any} */ (status);
    if (playtime !== undefined) game.playtimeMinutes = playtime;
    const tags = parseList(get('tags'));
    if (tags) game.tags = tags;
    const genres = parseList(get('genres'));
    if (genres) game.genres = genres;
    if (rating !== undefined) game.rating = rating;
    const developer = get('developer');
    if (developer) game.developer = developer;
    if (year !== undefined) game.year = year;
    // notas preservam espaços internos e quebras de linha; só as pontas são aparadas (feito em `get`)
    const notes = get('notes');
    if (notes) game.notes = notes;
    const coverUrl = get('coverUrl');
    if (coverUrl) game.coverUrl = coverUrl;
    rows.push(game);
  }
  return { rows, errors };
}

/**
 * Serializa um valor de célula (aspas só quando necessário).
 * @param {string|number|null|undefined} v
 * @param {string} delimiter
 * @returns {string}
 */
function cell(v, delimiter) {
  const s = v == null ? '' : String(v);
  return s.includes(delimiter) || /["\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serializa linhas (arrays de células) em CSV com CRLF.
 * @param {(string|number|null|undefined)[][]} lines
 * @param {',' | ';'} delimiter
 * @returns {string}
 */
export function serializeCsv(lines, delimiter = ',') {
  return lines.map((l) => l.map((v) => cell(v, delimiter)).join(delimiter)).join('\r\n') + '\r\n';
}

/**
 * Template baixável. `en`: cabeçalho canônico, separador `,`. `pt`: cabeçalho e valores em português,
 * separador `;` (abre direto no Excel em português). Começa com BOM UTF-8 para o Excel reconhecer acentos.
 * Exemplos FICTÍCIOS; `parseCsv` lê os dois sem erro.
 * @param {'pt'|'en'} [lang]
 * @returns {string}
 */
export function templateCsv(lang = 'en') {
  if (lang === 'pt') {
    return '﻿' + serializeCsv([
      COLUMNS_PT,
      ['Jogo de Exemplo Um', 'Epic Games', '', 'Jogando', 120, 'cooperativo|indie', 'Aventura|RPG', 4, 'Estúdio Fictício', 2021, 'Exemplo fictício: apague estas linhas.', ''],
      ['Jogo de Exemplo Dois', 'GOG', '', 'Zerado', 900, '', 'Estratégia', 5, '', 2018, '', ''],
      ['Jogo de Exemplo Três', 'Ubisoft Connect', '', 'Backlog', '', 'a-jogar', '', '', '', '', '', ''],
    ], ';');
  }
  return '﻿' + serializeCsv([
    CSV_COLUMNS,
    ['Example Quest One', 'epic', '', 'playing', 120, 'co-op|indie', 'Adventure|RPG', 4, 'Fictional Studio', 2021, 'Fictional sample: delete these rows.', ''],
    ['Example Quest Two', 'gog', '', 'finished', 900, '', 'Strategy', 5, '', 2018, '', ''],
    ['Example Quest Three', 'ubisoft', '', 'backlog', '', 'to-play', '', '', '', '', '', ''],
  ], ',');
}
