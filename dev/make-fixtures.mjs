// Gera os fixtures REAIS do Daniel em dev/fixtures/ (que está no .gitignore — nunca vão ao repositório) e o
// samples/template.csv. Uso (na pasta gamedex/):
//   node dev/make-fixtures.mjs <pasta-dashboard-antigo>
// <pasta-dashboard-antigo> deve conter dados/steam-biblioteca-2026-06-03.json e importar_gog.js.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, serializeCsv, templateCsv, CSV_COLUMNS } from '../js/importers/csv.js';
import { parseSteamCache } from '../js/importers/steam.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('uso: node dev/make-fixtures.mjs <pasta-dashboard-antigo>'); process.exit(2); }

await mkdir(join(root, 'dev', 'fixtures'), { recursive: true });
await mkdir(join(root, 'samples'), { recursive: true });

// Steam: cópia do backup antigo (só steam_cache; sem credenciais).
const steamText = await readFile(join(src, 'dados', 'steam-biblioteca-2026-06-03.json'), 'utf8');
parseSteamCache(steamText); // falha cedo se o formato não for o esperado
await writeFile(join(root, 'dev', 'fixtures', 'steam-daniel.json'), steamText);

// GOG: títulos de importar_gog.js → CSV com store gog.
const gogJs = await readFile(join(src, 'importar_gog.js'), 'utf8');
const titles = [...gogJs.matchAll(/\{\s*title:\s*("(?:[^"\\]|\\.)*")\s*\}/g)].map((m) => JSON.parse(m[1]));
const gog = serializeCsv([CSV_COLUMNS, ...titles.map((t) => [t, 'gog'])]);
await writeFile(join(root, 'dev', 'fixtures', 'gog-daniel.csv'), gog);
const check = parseCsv(gog);

// Template público (linhas fictícias), sem BOM para ficar legível no repositório.
await writeFile(join(root, 'samples', 'template.csv'), templateCsv('en').replace(/^﻿/, ''));

console.log(`steam-daniel.json copiado; gog-daniel.csv: ${titles.length} títulos, ${check.rows.length} linhas válidas, ${check.errors.length} erros; samples/template.csv gerado.`);
