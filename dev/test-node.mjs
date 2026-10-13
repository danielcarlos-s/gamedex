// Roda os testes sem navegador: `node dev/test-node.mjs`.
// Testes de IndexedDB só rodam se existir `indexedDB` global (ex.: importar 'fake-indexeddb/auto' antes, via `node --import`).
import { runAll } from './test-lib.js';
import './tests/model.test.js';
import './tests/worker.test.js';
import './tests/importers.test.js';
import './tests/filters.test.js';

if (globalThis.indexedDB) { await import('./tests/db.test.js'); await import('./tests/backup.test.js'); }
else console.log('(sem indexedDB: testes de db.js e backup.js pulados)');

const results = await runAll();
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? '\n       ' + r.error : ''}`);
for (const l of globalThis.__testReport ?? []) console.log('  » ' + l);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passaram`);
process.exit(failed ? 1 : 0);
