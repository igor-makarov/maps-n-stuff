#!/usr/bin/env node
/**
 * Build/validation step (`npm run build`, also used as the Cloudflare build
 * command): checks that the Workers site is complete and internally consistent
 * *without* contacting the network or needing Cloudflare credentials.
 *
 *   - wrangler.jsonc parses (JSONC comments stripped) and has main + assets
 *   - every asset referenced by public/index.html exists
 *   - all ES modules parse (node --check) and import the contracted helpers
 *   - public/data/{records,sources,overlays}.json parse and pass the D4 schema
 *   - the worker exposes default.fetch and an allowlist
 */
import { readFile, access, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';
import { readCatalogue, shardPath } from './catalogue.mjs';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const notes = [];

const fail = (message) => problems.push(message);
const abs = (...parts) => path.join(root, ...parts);

/** Strip // and /* *\/ comments plus trailing commas from JSONC. */
export function parseJsonc(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === '\n') {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i += 1;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && next === '/') {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
}

async function checkWrangler() {
  const raw = await readFile(abs('wrangler.jsonc'), 'utf8');
  const config = parseJsonc(raw);
  if (!config.main) fail('wrangler.jsonc: missing "main"');
  if (!config.assets?.directory) fail('wrangler.jsonc: missing assets.directory');
  if (config.assets && !config.assets.binding) notes.push('wrangler.jsonc: assets.binding not set (worker cannot read data files)');
  if (!config.compatibility_date) fail('wrangler.jsonc: missing compatibility_date');
  const mainPath = abs(config.main);
  await access(mainPath).catch(() => fail(`wrangler.jsonc: main "${config.main}" does not exist`));
  await access(abs(config.assets.directory)).catch(() => fail(`wrangler.jsonc: assets.directory "${config.assets.directory}" does not exist`));
  notes.push(`wrangler.jsonc: name=${config.name} assets=${config.assets.directory} main=${config.main}`);
  return config;
}

async function checkHtmlAssets() {
  const html = await readFile(abs('public/index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map((m) => m[1]);
  const modules = [...html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)].map((m) => m[1]);
  if (modules.length === 0) fail('public/index.html: no module script found');
  for (const ref of new Set([...refs, ...modules])) {
    if (ref.endsWith('/') || ref.startsWith('/api/')) continue;
    await access(abs('public', ref.replace(/^\//, ''))).catch(() => fail(`public/index.html references missing asset ${ref}`));
  }
  for (const id of ['place-search', 'place-input', 'place-suggestions', 'result-list', 'results-state', 'map', 'detail', 'detail-body', 'scrim', 'year-from', 'year-to', 'overlay-select', 'text-filter', 'compare-panel', 'compare-list', 'compare-view', 'compare-view-body']) {
    if (!html.includes(`id="${id}"`)) fail(`public/index.html: missing element #${id} (contracted UI hook)`);
  }
  notes.push(`public/index.html: ${new Set(refs).size} asset references, all present`);
}

async function checkModules() {
  const modules = ['public/app/main.js', 'public/app/store.js', 'public/app/dom.js', 'public/app/records.js', 'public/app/map.js', 'public/app/search.js', 'public/app/results.js', 'public/app/detail.js', 'public/app/compare.js', 'public/app/history.js', 'public/app/georeference.js', 'public/app/collections.js', 'src/browser/cog.js', 'src/worker/catalogue.js', 'src/worker/data.js', 'src/worker/georeference.js', 'src/worker/raster.js', 'src/worker/index.js'];
  for (const file of modules) {
    try {
      await run(process.execPath, ['--check', abs(file)]);
    } catch (err) {
      fail(`${file}: syntax error – ${String(err.stderr || err.message).split('\n')[0]}`);
    }
  }
  const worker = await readFile(abs('src/worker/index.js'), 'utf8');
  if (!/export default/.test(worker)) fail('src/worker/index.js: no default export');
  // Workers module format: every *named* export of the entry module is treated
  // as an extra service entrypoint. A non-function export (e.g. `export const
  // VERSION = '1'`) makes `wrangler dev`/deploy fail with
  //   "Incorrect type for map entry 'VERSION': … not of type 'function or
  //   ExportedHandler'"
  // Pure helpers therefore belong in src/worker/allowlist.js (or another module).
  for (const match of worker.matchAll(/^\s*export\s+(?!default\b)(.{0,40})/gm)) {
    fail(
      `src/worker/index.js: named export "${match[1].trim()}" is not allowed in the Workers entry module – ` +
        'move helpers to src/worker/allowlist.js (workerd treats named exports as service entrypoints)',
    );
  }
  for (const endpoint of ['/api/health', '/api/records', '/api/layers', '/api/sources', '/api/search/places', '/api/fetch']) {
    if (!worker.includes(endpoint)) fail(`src/worker/index.js: endpoint ${endpoint} missing`);
  }
  const main = await readFile(abs('public/app/main.js'), 'utf8');
  for (const moduleName of ['map.js', 'search.js', 'results.js', 'detail.js', 'compare.js', 'history.js', 'georeference.js', 'collections.js']) {
    if (!main.includes(moduleName)) fail(`public/app/main.js: optional module ${moduleName} not wired`);
  }
  notes.push(`modules: ${modules.length} checked, optional modules wired`);
}

async function checkData() {
  const dataDir = abs('public/data');
  const records = await readCatalogue(dataDir);
  await Promise.all(
    records.core.shards?.map((url) => access(shardPath(dataDir, url)).catch(() => fail(`records.json: shard ${url} does not exist`))) ?? [],
  );
  const sources = JSON.parse(await readFile(path.join(dataDir, 'sources.json'), 'utf8'));
  const overlays = JSON.parse(await readFile(path.join(dataDir, 'overlays.json'), 'utf8'));
  if (!Array.isArray(records.core.records) || records.core.records.length === 0) fail('records.json: no records');
  if (!Array.isArray(sources.providers) || sources.providers.length === 0) fail('sources.json: no providers');
  if (!Array.isArray(overlays.overlays) || overlays.overlays.length === 0) fail('overlays.json: no overlays');
  const ids = new Set();
  let depicted = 0;
  const providerIds = new Set(sources.providers.map((p) => p.id));
  for (const record of records.records) {
    for (const field of ['id', 'title', 'providerId', 'institution', 'rights', 'recordUrl']) {
      if (record[field] === undefined || record[field] === null || record[field] === '') fail(`records.json: ${record.id ?? '?'} missing ${field}`);
    }
    if (ids.has(record.id)) fail(`records.json: duplicate id ${record.id}`);
    ids.add(record.id);
    if (!providerIds.has(record.providerId)) fail(`records.json: ${record.id} uses unknown provider ${record.providerId}`);
    if (record.recordUrl && !record.recordUrl.startsWith('https://')) fail(`records.json: ${record.id} recordUrl is not https`);
    if ((record.yearStart ?? 0) > (record.yearEnd ?? 0)) fail(`records.json: ${record.id} yearStart > yearEnd`);
    // Depicted dates are only allowed as a pair with the upstream evidence that
    // states them (the harvest writes `depictedSource` verbatim), and the map
    // cannot show a period that starts after it was printed.
    const hasDepicted = record.depictedYearStart != null || record.depictedYearEnd != null;
    if (hasDepicted) {
      if (record.depictedYearStart == null || record.depictedYearEnd == null) {
        fail(`records.json: ${record.id} states only half a depicted period`);
      } else {
        if (record.depictedYearStart > record.depictedYearEnd) fail(`records.json: ${record.id} depicted start > end`);
        if (Number.isFinite(record.yearEnd ?? record.yearStart) && record.depictedYearEnd > (record.yearEnd ?? record.yearStart)) {
          fail(`records.json: ${record.id} depicted period ends after the publication year`);
        }
      }
      if (typeof record.depictedSource !== 'string' || record.depictedSource.length < 10) {
        fail(`records.json: ${record.id} has a depicted period but no depictedSource evidence`);
      }
      depicted += 1;
    }
    if (record.extent) {
      const { west, east, south, north } = record.extent;
      if (!(west < east && south < north)) fail(`records.json: ${record.id} invalid bbox`);
    }
  }
  notes.push(
    `data: ${records.records.length} records (${records.core.records.length} core + ${records.shards.length} shards), ${sources.providers.length} providers, ${overlays.overlays.length} overlays, ${depicted} with a documented depicted period (generated ${records.core.generatedAt ?? '?'})`,
  );
}

async function checkHistory() {
  // The historical-borders bundle: harvested from aourednik/historical-basemaps
  // (GPL-3.0-or-later) by scripts/harvest-history.mjs. The build gate checks the
  // provenance and that every indexed snapshot is really on disk with the size
  // the harvest recorded, so a half-committed harvest cannot ship.
  const index = JSON.parse(await readFile(abs('public/data/history/index.json'), 'utf8'));
  if (index.dataset !== 'historical-basemaps') fail('history/index.json: unexpected dataset');
  if (index.license !== 'GPL-3.0-or-later') fail('history/index.json: the upstream licence is not recorded');
  if (!/^[0-9a-f]{40}$/.test(String(index.commit ?? ''))) fail('history/index.json: no pinned upstream commit');
  await access(abs('public/data/history', index.licenseFile));
  const years = index.years ?? [];
  if (years.length < 50) fail(`history/index.json: only ${years.length} snapshots (expected the full published index)`);
  let bytes = 0;
  for (const entry of years) {
    if (!Number.isFinite(entry.year) || !/^world_[a-z0-9]+\.json$/.test(String(entry.file ?? ''))) {
      fail(`history/index.json: bad entry ${JSON.stringify(entry).slice(0, 80)}`);
      continue;
    }
    try {
      const info = await stat(abs('public/data/history', entry.file));
      if (info.size !== entry.bytes) fail(`history/${entry.file}: ${info.size} bytes on disk, index says ${entry.bytes}`);
      bytes += info.size;
    } catch {
      fail(`history/${entry.file}: indexed but missing`);
    }
  }
  notes.push(`history: ${years.length} snapshots (${index.coverage?.firstYear} … ${index.coverage?.lastYear}), ${(bytes / 1048576).toFixed(1)} MiB, ${index.commitShort} ${index.license}`);
}

try {
  await checkWrangler();
  await checkHtmlAssets();
  await checkModules();
  await checkData();
  await checkHistory();
} catch (err) {
  fail(`validation crashed: ${err?.message || err}`);
}

if (problems.length > 0) {
  console.error(`✗ build validation failed (${problems.length} problem(s))`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log('✓ workers site validated');
for (const note of notes) console.log(`  · ${note}`);
