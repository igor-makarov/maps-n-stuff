/**
 * Shared catalogue document helpers for the Node-side scripts and tests.
 *
 * The bundled catalogue is sharded so no single static asset has to stay under
 * Cloudflare's 25 MiB limit as providers grow:
 *
 *   public/data/records.json          core document, may carry `shards`
 *   public/data/records/<name>.json   { generatedAt, method, records: [...] }
 *
 * `records.json.shards` lists the shard URLs (`/data/records/<name>.json`).
 * A shard record is loaded by `public/app/records.js`, the Worker route
 * `/api/records` and every Node-side reader through `readCatalogue()` here.
 * Shard order is core-first; duplicate ids never appear twice.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** `/data/records/x.json` → `<outDir>/records/x.json` (outDir is usually public/data). */
export function shardPath(outDir, url) {
  const value = String(url ?? '');
  if (!value.startsWith('/data/') || value.includes('..') || value.includes('\\')) {
    throw new Error(`invalid shard URL: ${value}`);
  }
  const parts = value.replace(/^\//, '').split('/').filter(Boolean);
  if (parts[0] !== 'data' || parts.length < 3) throw new Error(`invalid shard URL: ${value}`);
  return path.join(outDir, ...parts.slice(1));
}

export function shardUrl(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(name))) throw new Error(`invalid shard name: ${name}`);
  return `/data/records/${name}.json`;
}

/** The core document only (records array untouched, shard URLs preserved). */
export async function readCore(outDir = path.join(ROOT, 'public', 'data')) {
  return JSON.parse(await readFile(path.join(outDir, 'records.json'), 'utf8'));
}

/** Read one shard document by its public URL. */
export async function readShard(outDir, url) {
  return JSON.parse(await readFile(shardPath(outDir, url), 'utf8'));
}

/**
 * Merge the core and all shards. Throws on a missing or malformed shard so a
 * broken commit cannot silently ship a partial catalogue; duplicate ids keep
 * the first (core) occurrence.
 */
export async function readCatalogue(outDir = path.join(ROOT, 'public', 'data')) {
  const core = await readCore(outDir);
  const records = [];
  const seen = new Set();
  const shards = [];
  const push = (record) => {
    if (!record || typeof record !== 'object' || typeof record.id !== 'string') return;
    if (seen.has(record.id)) return;
    seen.add(record.id);
    records.push(record);
  };
  for (const record of Array.isArray(core.records) ? core.records : []) push(record);
  for (const url of Array.isArray(core.shards) ? core.shards : []) {
    const doc = await readShard(outDir, url);
    if (!Array.isArray(doc.records)) throw new Error(`${url}: shard document has no records array`);
    shards.push({ url, doc });
    for (const record of doc.records) push(record);
  }
  return { core, records, shards };
}

/** Write one shard document. `meta` is merged before the records array. */
export async function writeShard(outDir, url, records, meta = {}) {
  const file = shardPath(outDir, url);
  await mkdir(path.dirname(file), { recursive: true });
  const doc = {
    generatedAt: meta.generatedAt ?? new Date().toISOString(),
    ...meta,
    records,
  };
  await writeFile(file, `${JSON.stringify(doc)}\n`);
  return file;
}

/**
 * Replace one provider's records inside a shard (or create the shard), and
 * remove that provider from the core so a record is never bundled twice.
 * Returns the merged core document with the shard URL registered.
 */
export async function publishProviderShard(outDir, url, providerId, records, meta = {}) {
  const core = await readCore(outDir);
  const shards = new Set(Array.isArray(core.shards) ? core.shards : []);
  shards.add(url);
  core.shards = [...shards].sort();
  core.records = (Array.isArray(core.records) ? core.records : []).filter(
    (record) => record.providerId !== providerId,
  );
  await writeShard(outDir, url, records, meta);
  await writeFile(path.join(outDir, 'records.json'), `${JSON.stringify(core, null, 2)}\n`);
  return core;
}
