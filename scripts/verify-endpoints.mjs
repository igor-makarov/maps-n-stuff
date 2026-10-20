#!/usr/bin/env node
/**
 * Probe every external URL the committed data promises to the user.
 *
 * The seed records cite four kinds of upstream URL (the original record, the
 * library's own viewer, the IIIF image service and its thumbnail, the IIIF
 * manifest) and the overlay records cite WMTS tiles. A refresh can leave a dead
 * link behind, and a dead link is invisible in `npm test` because the tests run
 * offline on purpose. This script is the online counterpart: it opens every
 * distinct URL once, with a small concurrency budget and a descriptive
 * User-Agent, and exits non-zero if any of them stops answering 200.
 *
 * Usage:
 *   node scripts/verify-endpoints.mjs                 # probe all records + overlays
 *   node scripts/verify-endpoints.mjs --limit 10      # only the first 10 records
 *   node scripts/verify-endpoints.mjs --json out.json # write the raw report
 *   node scripts/verify-endpoints.mjs --offline       # list the URLs, no requests
 *
 * Not part of `npm run check` (the build stays offline and hermetic); run it
 * before/after a harvest when the network is available.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_LAYERS, tileUrl } from '../public/app/map.js';
import { readCatalogue } from './catalogue.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const UA = 'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; endpoint verification)';
const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const LIMIT = Number(argValue('limit', '0')) || 0;
const JSON_OUT = argValue('json', '');
const OFFLINE = args.includes('--offline');
const CONCURRENCY = Math.max(1, Math.min(8, Number(argValue('concurrency', '4')) || 4));
const TIMEOUT = Number(argValue('timeout', '20000')) || 20000;
const PAUSE = 120;
// A 429/5xx is an upstream under load, not a dead link: e-rara's DOI landing pages
// answer intermittent 500s when ~40 of them are probed in a row (measured
// 2026-10-19: the same URL answered 200, 200, 500 on three consecutive probes), so
// every probe is retried a bounded number of times with a growing pause.
const RETRIES = Math.max(0, Math.min(5, Number(argValue('retries', '2'))));

const readJson = async (rel) => JSON.parse(await readFile(path.join(ROOT, rel), 'utf8'));
const catalogue = await readCatalogue(path.join(ROOT, 'public/data'));
const overlaysDoc = await readJson('public/data/overlays.json');

const records = LIMIT ? catalogue.records.slice(0, LIMIT) : catalogue.records;

/** Every URL the UI can send a visitor to, deduplicated, with its owners. */
const targets = new Map();
function add(url, kind, id) {
  if (!url || typeof url !== 'string' || !url.startsWith('https://')) return;
  if (!targets.has(url)) targets.set(url, { url, kind, ids: [] });
  const entry = targets.get(url);
  if (!entry.ids.includes(id)) entry.ids.push(id);
}

for (const r of records) {
  add(r.recordUrl, 'record', r.id);
  add(r.viewerUrl, 'viewer', r.id);
  add(r.thumbnail, 'thumbnail', r.id);
  add(r.iiifManifest, 'manifest', r.id);
  add(r.georeference?.url, 'raster', r.id);
  // The first canvas image service: the detail viewer asks it for `info.json`.
  if (r.imageService) add(`${r.imageService.replace(/\/$/, '')}/info.json`, 'image-service', r.id);
}

// Overlay previews: the tile the UI renders in the map/detail preview.
for (const o of overlaysDoc.overlays) {
  if (o.thumbnail) add(o.thumbnail, 'overlay-thumbnail', o.id);
}
for (const layer of BASE_LAYERS) add(tileUrl(layer.urlTemplate, { z: 2, x: 2, y: 1 }), 'reference-tile', layer.id);

const list = [...targets.values()];
if (OFFLINE) {
  for (const t of list) console.log(`${t.kind.padEnd(18)} ${t.url}  (${t.ids.length} records)`);
  console.log(`${list.length} distinct URLs across ${records.length} records and ${overlaysDoc.overlays.length} overlays`);
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(target) {
  const started = Date.now();
  const attempt = async (method) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
    try {
      const res = await fetch(target.url, {
        method,
        headers: { 'user-agent': UA, accept: '*/*', ...(target.kind === 'raster' ? { range: 'bytes=0-1023' } : {}) },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      // 403/405 on HEAD is the upstream refusing the method, not a dead link.
      if (method === 'HEAD' && (res.status === 403 || res.status === 405 || res.status === 501)) {
        return null;
      }
      await res.body?.cancel?.();
      return { status: res.status, type: res.headers.get('content-type') || '' };
    } finally {
      clearTimeout(timer);
    }
  };
  let result;
  let retries = 0;
  for (;;) {
    try {
      result = target.kind === 'raster' ? await attempt('GET') : (await attempt('HEAD')) || (await attempt('GET'));
    } catch (err) {
      result = { status: 0, type: '', error: err.name === 'AbortError' ? 'timeout' : String(err.message) };
    }
    const transient = result.status === 0 || result.status === 429 || result.status >= 500;
    if (!transient || retries >= RETRIES) break;
    retries += 1;
    await sleep(600 * retries + Math.floor(Math.random() * 400));
  }
  return { ...target, ...result, ok: result.status === (target.kind === 'raster' ? 206 : 200), ms: Date.now() - started, retries };
}

let next = 0;
const results = [];
async function worker() {
  while (next < list.length) {
    const target = list[next++];
    const result = await probe(target);
    results.push(result);
    const ok = result.ok;
    console.log(
      `${ok ? '✔' : '✖'} ${String(result.status).padEnd(4)} ${result.kind.padEnd(18)} ${result.url.slice(0, 110)}` +
        `${ok ? '' : `  — ${result.error || result.type}`}`,
    );
    await sleep(PAUSE);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

results.sort((a, b) => a.status - b.status || a.url.localeCompare(b.url));
const failures = results.filter((r) => !r.ok);
const byKind = {};
for (const r of results) {
  byKind[r.kind] = byKind[r.kind] || { total: 0, failed: 0 };
  byKind[r.kind].total += 1;
  if (!r.ok) byKind[r.kind].failed += 1;
}
console.log('');
for (const [kind, { total, failed }] of Object.entries(byKind)) {
  console.log(`${kind.padEnd(18)} ${String(total - failed).padStart(4)}/${String(total).padEnd(4)} ok`);
}
console.log(`${results.length} URLs probed, ${failures.length} failed (expected HTTP 200, or 206 for raster ranges)`);
const retried = results.filter((r) => r.retries > 0);
if (retried.length) {
  console.log(
    `${retried.length} URL(s) needed a retry (transient 5xx/429/timeout) and ` +
      `${retried.filter((r) => r.ok).length} of them answered 200 on the retry`,
  );
}

if (JSON_OUT) {
  await writeFile(
    JSON_OUT,
    JSON.stringify(
      {
        probedAt: new Date().toISOString(),
        userAgent: UA,
        records: records.length,
        overlays: overlaysDoc.overlays.length,
        byKind,
        failures,
        results,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`report: ${JSON_OUT}`);
}

if (failures.length) {
  console.error('\nDead or unreachable endpoints:');
  for (const f of failures) console.error(`  ${f.status} ${f.kind} ${f.url} (${f.ids.slice(0, 3).join(', ')})`);
  process.exit(1);
}
