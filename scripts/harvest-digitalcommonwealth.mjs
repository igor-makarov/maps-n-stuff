#!/usr/bin/env node
/**
 * Digital Commonwealth partner-held map harvest (member 0, sourcing swarm
 * 2026-10-20).
 *
 * Digital Commonwealth is the Massachusetts statewide digital library service
 * operated by the Boston Public Library. Its documented Blacklight JSON API is
 * the same one the Leventhal importer uses, but this lane imports the
 * **partner-held** cartographic records that are outside the BPL/Leventhal
 * scope, naming the contributing institution on every record.
 *
 * Rights are read per record from the contributing institution's catalogue
 * entry. The gate is the Leventhal importer's exported `rightsBasis`, unchanged:
 * only an affirmative no-known-restrictions + no-restrictions-on-use
 * determination, NoC-US, CC0 or CC BY is admitted. Non-commercial licences,
 * rights-not-evaluated, contact-host, permission-required and all-rights-
 * reserved records stay out. A private collector with no named institution is
 * not counted as an institution.
 *
 * Usage:
 *   node scripts/harvest-digitalcommonwealth.mjs
 *   node scripts/harvest-digitalcommonwealth.mjs --refresh --no-write
 *
 * Pages and manifests are cached under .cache/digitalcommonwealth/ (git-ignored);
 * the script reuses the Leventhal page cache when it exists because both lanes
 * read the same documented inventory.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shardUrl } from './catalogue.mjs';
import { recordOf, rightsBasis } from './harvest-leventhal.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(value('out', resolve(ROOT, 'public/data')));
const CACHE = resolve(ROOT, '.cache/digitalcommonwealth');
const LEVENTHAL_CACHE = resolve(ROOT, '.cache/leventhal');
const REFRESH = has('refresh');
const WRITE = !has('no-write');
const PAGE_SIZE = 100;
const CONCURRENCY = Math.max(1, Math.min(4, Number(value('concurrency', '3')) || 3));
const RETRIEVED = '2026-10-20';
const UA = 'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; historical map catalogue)';
const API = 'https://collections.leventhalmap.org/search.json';
const QUERY = 'q=&f%5Bgenre_basic_ssim%5D%5B%5D=Maps';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, { attempts = 3 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': UA } });
      if (res.ok) return await res.json();
      last = new Error(`${res.status} ${url}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      last = error;
    }
    await sleep(400 * attempt);
  }
  throw last;
}

async function cachedPage(page) {
  const own = resolve(CACHE, 'pages', `page-${page}.json`);
  const shared = resolve(LEVENTHAL_CACHE, 'pages', `page-${page}.json`);
  if (!REFRESH) {
    for (const path of [own, shared]) {
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch {
        // try the next cache
      }
    }
  }
  const url = `${API}?q=&per_page=${PAGE_SIZE}&page=${page}&f%5Bgenre_basic_ssim%5D%5B%5D=Maps`;
  const body = await fetchJson(url);
  await mkdir(dirname(own), { recursive: true });
  await writeFile(own, JSON.stringify(body));
  return body;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      await sleep(60);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function head(url, accept) {
  try {
    const res = await fetch(url, { headers: { accept, 'user-agent': UA, range: 'bytes=0-2047' } });
    return { status: res.status, type: res.headers.get('content-type') };
  } catch (error) {
    return { status: 0, error: String(error.message) };
  }
}

async function verify(records) {
  const sample = [];
  const step = Math.max(1, Math.floor(records.length / 30));
  for (let i = 0; i < records.length && sample.length < 30; i += step) sample.push(records[i]);
  const results = await pool(sample, 3, async (record) => {
    const image = await head(record.thumbnail, 'image/jpeg');
    const info = await head(`${record.imageService}/info.json`, 'application/json');
    return { id: record.id, thumbnail: image.status, info: info.status, thumbnailType: image.type, infoType: info.type };
  });
  return {
    retrieved: RETRIEVED,
    sample: results.length,
    thumbnailOk: results.filter((r) => r.thumbnail === 200 && /image\//.test(r.thumbnailType ?? '')).length,
    imageInfoOk: results.filter((r) => r.info === 200 && /json/.test(r.infoType ?? '')).length,
    examples: results.slice(0, 5),
  };
}

async function main() {
  const first = await cachedPage(1);
  const total = first.meta.pages.total_count;
  const pages = first.meta.pages.total_pages;
  console.log(`Digital Commonwealth inventory: ${total} cartographic records in ${pages} pages`);
  const documents = [...first.data];
  let next = 2;
  async function worker() {
    while (true) {
      const page = next++;
      if (page > pages) return;
      const body = await cachedPage(page);
      documents.push(...body.data);
      await sleep(100);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const seen = new Set();
  const records = [];
  const rejected = {};
  for (const document of documents) {
    const record = recordOf(document, { scope: 'partner' });
    if (!record) {
      const a = document.attributes ?? {};
      const holder = (a.physical_location_ssim ?? []).join('; ');
      const reason = (a.physical_location_ssim ?? []).includes('Boston Public Library')
        ? 'BPL-held (owned by the Leventhal lane)'
        : /^private collection$/i.test(holder)
          ? 'private collector without a named institution'
          : rightsBasis(a)
            ? 'metadata gate (title, genre or IIIF identity)'
            : `rights withheld: ${holder || 'unstated'}`;
      rejected[reason] = (rejected[reason] || 0) + 1;
      continue;
    }
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  if (!records.length) throw new Error('No eligible partner records; leaving the catalogue unchanged.');
  records.sort((a, b) => (a.yearStart ?? Infinity) - (b.yearStart ?? Infinity) || a.id.localeCompare(b.id));

  const basis = {};
  for (const record of records) basis[record.rightsBasis] = (basis[record.rightsBasis] || 0) + 1;
  const institutions = {};
  for (const record of records) institutions[record.institution] = (institutions[record.institution] || 0) + 1;
  console.log(`Eligible partner records: ${records.length}`);
  console.log('Rights bases:', basis);
  console.log('Institutions:', institutions);
  console.log('Withheld:', Object.fromEntries(Object.entries(rejected).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  const verification = await verify(records);
  console.log('Verification sample:', verification);

  const recordsPath = resolve(OUT, 'records.json');
  const sourcesPath = resolve(OUT, 'sources.json');
  const recordsDoc = JSON.parse(await readFile(recordsPath, 'utf8'));
  const sourcesDoc = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const shard = shardUrl('digitalcommonwealth');
  recordsDoc.shards = [...new Set([...(recordsDoc.shards ?? []), shard])].sort();
  recordsDoc.records = recordsDoc.records.filter((record) => record.providerId !== 'digitalcommonwealth');
  recordsDoc.generatedAt = new Date().toISOString();
  recordsDoc.retrieved = RETRIEVED;
  recordsDoc.method = `${recordsDoc.method ? recordsDoc.method + ' ' : ''}Digital Commonwealth partner-held maps are imported through the documented Blacklight JSON search API with per-record rights confirmation; they are bundled in ${shard}.`;
  recordsDoc.selection ??= {};
  recordsDoc.selection['digitalcommonwealth:partners'] = {
    considered: documents.length,
    kept: records.length,
    shard,
    rightsBasis: basis,
    institutions,
    withheld: rejected,
    rule:
      'Every partner-held cartographic record in the digitalcommonwealth inventory whose catalogue entry carries an affirmative reuse determination (No known copyright restrictions + No known restrictions on use + no restrictions, NoC-US, CC0 or CC BY), with the contributing institution named verbatim. Boston Public Library records belong to the Leventhal lane; private collectors without a named institution, rights-not-evaluated, contact-host, all-rights-reserved, non-commercial and permission-required records stay out.',
    verification,
  };
  const provider = {
    id: 'digitalcommonwealth',
    name: 'Digital Commonwealth partner collections',
    operator: 'Digital Commonwealth (Boston Public Library)',
    homepage: 'https://www.digitalcommonwealth.org/',
    home: 'https://www.digitalcommonwealth.org/',
    institutions: Object.keys(institutions).sort(),
    rights:
      'The verbatim rights and licence statement from the contributing institution is retained on every record. Bundled records carry an affirmative no-known-copyright-restrictions / no-restrictions-on-use determination, NoC-US, CC0 or CC BY. Items without such a determination are not imported.',
    attribution: 'Contributing institutions via Digital Commonwealth',
    retrieved: RETRIEVED,
    api: {
      catalogue: 'https://collections.leventhalmap.org/search.json',
      manifest: 'https://ark.digitalcommonwealth.org/ark:/50959/{id}/manifest',
      image: 'https://iiif.digitalcommonwealth.org/iiif/2/{imageId}/full/304,/0/default.jpg',
      documentation: 'https://www.digitalcommonwealth.org/api',
    },
    apiHosts: ['collections.leventhalmap.org', 'ark.digitalcommonwealth.org', 'iiif.digitalcommonwealth.org'],
    method:
      'Documented Blacklight JSON search (genre Maps, per_page 100, 153 pages) over the Digital Commonwealth inventory, restricted to partner-held records with per-record rights evidence; no decade, geography, institution or record-count cap.',
    rightsPolicy: {
      copyright: 'https://www.digitalcommonwealth.org/copyright',
      apiDocumentation: 'https://www.digitalcommonwealth.org/api',
      metadataReuse:
        "The documented JSON search, OAI-PMH feed and item endpoints are published for machine reuse, and Digital Commonwealth's API page states that its metadata content may be used in other applications and data services; Digital Commonwealth/BPL does not publish a separate metadata licence, so none is claimed. The redistributed fields are factual catalogue descriptions; per-item rights statements are retained verbatim and images are reused only where the item itself carries an affirmative determination. See metadataReuseBasis and coordination/metadata-rights-decision-20261020.md.",
      metadataReuseBasis: {
        "status": "basis-recorded",
        "decided": "2026-10-20T12:16Z",
        "basis": "The redistributed fields are the factual catalogue description (title, creator, date, publisher, language, identifiers, holding, links) that Digital Commonwealth and the Boston Public Library publish through a documented API explicitly intended for use in other applications and data services. No separate rights in those description fields are asserted. No metadata licence is published and none is claimed; image reuse stays a separate per-item gate.",
        "primaryEvidence": [
          {
            "url": "https://www.digitalcommonwealth.org/api",
            "retrieved": "2026-10-20",
            "quote": "APIs (Application Programming Interface) provide programmatic machine-based interaction with metadata and image content from items in the Digital Commonwealth collections, allowing this content to be used in other applications and data services."
          },
          {
            "url": "https://www.digitalcommonwealth.org/copyright",
            "retrieved": "2026-10-20",
            "quote": "Digital Commonwealth provides access to copyrighted materials strictly for noncommercial educational and research purposes and places no restrictions on public domain material."
          },
          {
            "url": "https://www.digitalcommonwealth.org/copyright",
            "retrieved": "2026-10-20",
            "quote": "Digital Commonwealth does not charge permission fees for use of such material and does not grant or deny permission to publish or otherwise distribute material in its collections."
          }
        ],
        "limits": "Descriptive fields and links only. Image admission remains gated per item (no-known-copyright/no-restrictions, NoC-US, CC0 or CC BY) with the verbatim rights statement retained; restrictive items stay withheld. Any future institution statement restricting catalogue data requires withholding the affected records pending review, not relabelling.",
        "decisionNote": "coordination/metadata-rights-decision-20261020.md"
      },
    },
    verification,
  };
  sourcesDoc.providers = [...sourcesDoc.providers.filter((source) => source.id !== 'digitalcommonwealth'), provider]
    .sort((a, b) => a.id.localeCompare(b.id));
  sourcesDoc.generatedAt = recordsDoc.generatedAt;
  const shardDoc = {
    generatedAt: recordsDoc.generatedAt,
    retrieved: RETRIEVED,
    providerId: 'digitalcommonwealth',
    method: recordsDoc.selection['digitalcommonwealth:partners'].rule,
    selection: recordsDoc.selection['digitalcommonwealth:partners'],
    records,
  };
  if (WRITE) {
    await mkdir(dirname(resolve(OUT, 'records', 'digitalcommonwealth.json')), { recursive: true });
    await writeFile(resolve(OUT, 'records.json'), JSON.stringify(recordsDoc));
    await writeFile(resolve(OUT, 'sources.json'), JSON.stringify(sourcesDoc, null, 2) + '\n');
    await writeFile(resolve(OUT, 'records', 'digitalcommonwealth.json'), JSON.stringify(shardDoc));
  }
  console.log(`Catalogue: ${recordsDoc.records.length} core + ${records.length} digitalcommonwealth partner records; shard ${(Buffer.byteLength(JSON.stringify(shardDoc)) / 1048576).toFixed(2)} MiB`);
  if (WRITE) console.log(`Wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
