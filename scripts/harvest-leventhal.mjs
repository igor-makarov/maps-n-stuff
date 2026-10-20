#!/usr/bin/env node
/**
 * Reproducible harvest of the Norman B. Leventhal Map & Education Center
 * (Boston Public Library) catalogue through its documented Blacklight JSON API.
 *
 * Scope: every cartographic record held by the Boston Public Library whose
 * catalogue entry carries an affirmative reuse determination. Partner-held
 * items in the same discovery feed are not imported here: they belong to their
 * own institutions and are not BPL's collection to redistribute.
 *
 * Rights are read per record. The importer accepts only:
 *   - "No known copyright restrictions." + "No known restrictions on use."
 *     + reuse_allowed_ssi "no restrictions" (BPL's affirmative determination),
 *   - an explicit NoC-US / CC0 / CC BY statement,
 *   - or an explicit "Public Domain" rights statement with "no restrictions".
 * Everything else (rights not evaluated, contact host, all rights reserved,
 * non-commercial, permission required, copyright undetermined, unstated) is
 * withheld. The verbatim statements are kept on every record.
 *
 * Usage:
 *   node scripts/harvest-leventhal.mjs                 # cached, writes public/data
 *   node scripts/harvest-leventhal.mjs --refresh       # re-fetch all pages
 *   node scripts/harvest-leventhal.mjs --no-write      # report only
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shardPath, shardUrl } from './catalogue.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(value('out', resolve(ROOT, 'public/data')));
const CACHE = resolve(ROOT, '.cache/leventhal');
const REFRESH = has('refresh');
const WRITE = !has('no-write');
const PAGE_SIZE = 100;
const CONCURRENCY = Math.max(1, Math.min(4, Number(value('concurrency', '3')) || 3));
const UA = 'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; historical map catalogue)';
const API = 'https://collections.leventhalmap.org/search.json';
const QUERY = 'q=&f%5Bgenre_basic_ssim%5D%5B%5D=Maps';
const RETRIEVED = '2026-10-20';
/**
 * Complete named collections, not a record cap. These four subject collections
 * are the curated Boston/New England, Revolutionary-War and maritime map sets;
 * every eligible BPL record in them is imported. `--all-bpl` widens the run to
 * the whole BPL-held rights-cleared set once the catalogue is sharded.
 */
const COLLECTIONS = [
  'Boston and New England Maps',
  'American Revolutionary War-Era Maps',
  'Maritime Charts and Atlases',
  'Urban Maps',
];
const ALL_BPL = has('all-bpl');
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
  const path = resolve(CACHE, 'pages', `page-${page}.json`);
  if (!REFRESH) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {}
  }
  const url = `${API}?${QUERY}&per_page=${PAGE_SIZE}&page=${page}`;
  const body = await fetchJson(url);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(body));
  await rename(temp, path);
  return body;
}

/** Parse the catalogue's ENVELOPE(W, E, N, S) boxes. Return one only when unambiguous. */
function extentOf(attributes) {
  const boxes = attributes.subject_bbox_geospatial ?? [];
  if (boxes.length !== 1) return null;
  const match = String(boxes[0]).match(/^ENVELOPE\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/);
  if (!match) return null;
  const [west, east, north, south] = match.slice(1).map(Number);
  if (![west, east, south, north].every(Number.isFinite)) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) return null;
  return { west, east, south, north };
}

function pointOf(attributes) {
  const points = attributes.subject_point_geospatial ?? [];
  if (points.length !== 1) return null;
  const match = String(points[0]).match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : null;
}

/** Publication period stated by the catalogue; never the depicted period. */
function publicationYears(attributes) {
  const year = (value) => {
    const match = String(value ?? '').match(/\b(1[0-9]{3}|20[0-9]{2})\b/);
    return match ? Number(match[1]) : null;
  };
  let start = year(attributes.date_start_dtsi) ?? year((attributes.date_tsim ?? [])[0]);
  let end = year(attributes.date_end_dtsi) ?? start;
  if (start == null) return { start: null, end: null };
  if (end == null || end < start) end = start;
  if (start < 1400 || end > 2100) return { start: null, end: null };
  return { start, end };
}

const NO_KNOWN = /^No known copyright restrictions\.?$/i;
const NO_RESTRICTIONS = /^No known restrictions on use\.?$/i;
const CC0 = /(?:CC0|public domain under a creative commons no rights reserved license|creativecommons\.org\/publicdomain\/zero)/i;
const NOC_US = /No Copyright - United States|rightsstatements\.org\/vocab\/NoC-US/i;
const CC_BY = /Creative Commons Attribution License \(CC BY\)/i;
const PUBLIC_DOMAIN = /^(?:Public Domain|Public domain)\b/i;
const BLOCKING = /non[ -]?commercial|all rights reserved|permission (?:is )?required|prior written permission|contact (?:the )?host|rights status not evaluated|copyright undetermined|not in the public domain|may be restricted|under copyright|protected by copyright|copyright \(c\)|copyright ©|copyright expired|^(?:copyright|©)\b/i;

/**
 * Return a named rights basis or null. The check is deliberately narrow and
 * keeps the catalogue's own statement rather than relabelling anything as PD.
 */
export function rightsBasis(attributes) {
  const rights = String(attributes.rights_ss ?? '').trim();
  const license = String(attributes.license_ss ?? '').trim();
  const reuse = String(attributes.reuse_allowed_ssi ?? '').trim();
  const combined = `${rights} ${license}`;
  if (!rights) return null;
  if (BLOCKING.test(combined)) {
    // An explicit public-domain/CC0 statement wins over a generic "copyright"
    // word only when it names the public domain directly.
    if (!(CC0.test(combined) || NOC_US.test(rights) || PUBLIC_DOMAIN.test(rights))) return null;
  }
  if (NO_KNOWN.test(rights) && NO_RESTRICTIONS.test(license) && /^no restrictions$/i.test(reuse)) return 'no-known-restrictions';
  if (NOC_US.test(rights)) return 'no-copyright-us';
  if (CC0.test(combined)) return 'cc0';
  if (CC_BY.test(license) && !/non[ -]?commercial/i.test(license)) return 'cc-by';
  if (PUBLIC_DOMAIN.test(rights) && /^no restrictions$/i.test(reuse)) return 'public-domain';
  return null;
}

function plain(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function recordOf(document) {
  const a = document.attributes ?? {};
  if (!Array.isArray(a.genre_basic_ssim) || !a.genre_basic_ssim.includes('Maps')) return null;
  if (!(a.type_of_resource_ssim ?? []).includes('Cartographic')) return null;
  if (!(a.physical_location_ssim ?? []).includes('Boston Public Library')) return null;
  if (!ALL_BPL && !(a.collection_name_ssim ?? []).some((name) => COLLECTIONS.includes(name))) return null;
  const basis = rightsBasis(a);
  if (!basis) return null;
  const title = plain(a.title_info_primary_tsi);
  const manifest = String(a.identifier_iiif_manifest_ss ?? '');
  const imageId = String(a.exemplary_image_ssi ?? '');
  if (!title || !/^https:\/\/ark\.digitalcommonwealth\.org\/ark:\/50959\/[a-z0-9]+\/manifest$/.test(manifest)) return null;
  if (!/^commonwealth:[a-z0-9]+$/.test(imageId)) return null;
  const id = document.id ?? a.id;
  if (!/^commonwealth:[a-z0-9]+$/.test(String(id))) return null;
  const { start, end } = publicationYears(a);
  const extent = extentOf(a);
  const point = pointOf(a);
  const imageService = `https://iiif.digitalcommonwealth.org/iiif/2/${imageId}`;
  const collection = (a.collection_name_ssim ?? []).map(plain).filter(Boolean).join(' / ') || 'Norman B. Leventhal Map & Education Center Collection';
  const creators = (a.name_tsim ?? []).map(plain).filter(Boolean);
  const record = {
    id: `leventhal:${id}`,
    title,
    creators,
    providerId: 'leventhal',
    institution: 'Boston Public Library, Norman B. Leventhal Map & Education Center',
    rights: [plain(a.rights_ss), plain(a.license_ss)].filter(Boolean).join(' '),
    rightsBasis: basis,
    reuseAllowed: plain(a.reuse_allowed_ssi),
    recordUrl: `https://collections.leventhalmap.org/search/${id}`,
    viewerUrl: /^https:\/\//.test(String(a.identifier_uri_ss ?? '')) ? String(a.identifier_uri_ss) : null,
    thumbnail: `${imageService}/full/304,/0/default.jpg`,
    imageService,
    iiifManifest: manifest,
    type: 'map',
    collection,
    dateDisplay: plain((a.date_tsim ?? [])[0]),
    subjectPlace: (a.subject_geographic_sim ?? a.subject_topic_tsim ?? []).map(plain).filter(Boolean).join('; '),
    languages: (a.lang_term_ssim ?? []).map(plain).filter(Boolean),
    publisher: plain(a.publisher_tsi),
    imprint: [plain(a.pubplace_tsi), plain(a.publisher_tsi)].filter(Boolean).join(' : '),
    shelfmark: (a.identifier_local_call_tsim ?? [])[0],
    extent,
    geo: point ?? (extent ? { lat: (extent.south + extent.north) / 2, lon: (extent.west + extent.east) / 2 } : null),
  };
  if (start != null) {
    record.yearStart = start;
    record.yearEnd = end;
  }
  if (!record.extent) {
    record.geoNote =
      'Catalogue location supplied by the Leventhal Map & Education Center. It is a search footprint or place anchor, not an image alignment or a verified map boundary.';
  }
  // Null/empty optional fields are omitted: the schema treats an absent field as
  // unknown, and repeating hundreds of thousands of nulls would make the static
  // catalogue needlessly large.
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (key === 'creators') continue;
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) delete record[key];
  }
  if (!Array.isArray(record.creators)) record.creators = [];
  return record;
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
    const res = await fetch(url, { method: 'GET', headers: { accept, 'user-agent': UA, range: 'bytes=0-2047' } });
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
  console.log(`Leventhal inventory: ${total} cartographic records in ${pages} pages`);
  const documents = [...first.data];
  let next = 2;
  async function worker() {
    while (true) {
      const page = next++;
      if (page > pages) return;
      const body = await cachedPage(page);
      documents.push(...body.data);
      if (page % 25 === 0) console.log(`cached page ${page}/${pages}`);
      await sleep(100);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const seen = new Set();
  const records = [];
  const rejected = {};
  for (const document of documents) {
    const record = recordOf(document);
    if (!record) {
      const a = document.attributes ?? {};
      const reason = !(a.physical_location_ssim ?? []).includes('Boston Public Library')
        ? 'partner-held (not Boston Public Library)'
        : !ALL_BPL && !(a.collection_name_ssim ?? []).some((name) => COLLECTIONS.includes(name))
          ? 'outside the selected named collections'
          : rightsBasis(a)
          ? 'metadata gate (title, genre or IIIF identity)'
          : `rights withheld: ${plain(a.rights_ss) || 'unstated'}`;
      rejected[reason] = (rejected[reason] || 0) + 1;
      continue;
    }
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
  }
  if (!records.length) throw new Error('No eligible Leventhal records; leaving the catalogue unchanged.');
  records.sort((a, b) => (a.yearStart ?? Infinity) - (b.yearStart ?? Infinity) || a.id.localeCompare(b.id));

  console.log(`Eligible Boston Public Library records: ${records.length}`);
  const basis = {};
  for (const record of records) basis[record.rightsBasis] = (basis[record.rightsBasis] || 0) + 1;
  console.log('Rights bases:', basis);
  console.log('With a catalogue extent:', records.filter((r) => r.extent).length, 'with a point:', records.filter((r) => r.geo).length);
  console.log('Withheld:', Object.fromEntries(Object.entries(rejected).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  const verification = await verify(records);
  console.log('Verification sample:', verification);

  const recordsPath = resolve(OUT, 'records.json');
  const sourcesPath = resolve(OUT, 'sources.json');
  const recordsDoc = JSON.parse(await readFile(recordsPath, 'utf8'));
  const sourcesDoc = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const shard = shardUrl('leventhal');
  // Leventhal is a bulk provider: its records live in their own static asset so
  // the core document stays well below Cloudflare's 25 MiB limit. The core keeps
  // the shard URL, the selection evidence and the provider registry entry.
  recordsDoc.shards = [...new Set([...(recordsDoc.shards ?? []), shard])].sort();
  recordsDoc.records = recordsDoc.records.filter((record) => record.providerId !== 'leventhal');
  recordsDoc.generatedAt = new Date().toISOString();
  recordsDoc.retrieved = RETRIEVED;
  recordsDoc.method = `${recordsDoc.method ? recordsDoc.method + ' ' : ''}Leventhal/Boston Public Library cartographic records are imported through the documented Digital Commonwealth search JSON API with per-record rights confirmation; they are bundled in ${shard} and merged by the catalogue loader.`;
  recordsDoc.selection ??= {};
  recordsDoc.selection['leventhal:bpl'] = {
    considered: documents.length,
    kept: records.length,
    shard,
    rightsBasis: basis,
    withheld: rejected,
    rule:
      (ALL_BPL ? 'every' : 'every record in the complete Boston and New England, American Revolutionary War-Era, Maritime Charts and Atlases, and Urban Maps collections') + ' Boston Public Library cartographic record in the Leventhal discovery feed with an affirmative reuse determination (No known copyright restrictions + No known restrictions on use + no restrictions, NoC-US, CC0, CC BY, or an explicit Public Domain statement). Partner-held items are excluded so one feed is not split into pretend institutions; rights not evaluated, contact-host, all-rights-reserved, non-commercial and permission-required records stay out.',
    verification,
  };
  const provider = {
    id: 'leventhal',
    name: 'Leventhal Map & Education Center — Boston Public Library',
    operator: 'Boston Public Library, Norman B. Leventhal Map & Education Center',
    homepage: 'https://collections.leventhalmap.org/',
    home: 'https://collections.leventhalmap.org/',
    institutions: ['Boston Public Library'],
    rights:
      'The verbatim rights and licence statement is retained on every record. Bundled records carry an affirmative no-known-copyright-restrictions / no-restrictions-on-use determination, NoC-US, CC0 or CC BY. Items without such a determination are not imported.',
    attribution: 'Norman B. Leventhal Map & Education Center, Boston Public Library',
    retrieved: RETRIEVED,
    api: {
      catalogue: 'https://collections.leventhalmap.org/search.json',
      manifest: 'https://ark.digitalcommonwealth.org/ark:/50959/{id}/manifest',
      image: 'https://iiif.digitalcommonwealth.org/iiif/2/{imageId}/full/304,/0/default.jpg',
      documentation: 'https://www.digitalcommonwealth.org/',
    },
    apiHosts: ['collections.leventhalmap.org', 'ark.digitalcommonwealth.org', 'iiif.digitalcommonwealth.org'],
    method:
      'Documented Blacklight JSON search (genre Maps, per_page 100, 153 pages), filtered to Boston Public Library holdings in the complete Boston and New England, American Revolutionary War-Era, Maritime Charts and Atlases, and Urban Maps collections, with per-record rights evidence; no decade, geography or record-count cap.',
    collections: [
      { id: 'boston-new-england', name: 'Boston and New England Maps', discovery: 'https://collections.leventhalmap.org/search?q=&f%5Bcollection_name_ssim%5D%5B%5D=Boston+and+New+England+Maps' },
      { id: 'revolutionary-war', name: 'American Revolutionary War-Era Maps', discovery: 'https://collections.leventhalmap.org/search?q=&f%5Bcollection_name_ssim%5D%5B%5D=American+Revolutionary+War-Era+Maps' },
      { id: 'maritime', name: 'Maritime Charts and Atlases', discovery: 'https://collections.leventhalmap.org/search?q=&f%5Bcollection_name_ssim%5D%5B%5D=Maritime+Charts+and+Atlases' },
      { id: 'urban', name: 'Urban Maps', discovery: 'https://collections.leventhalmap.org/search?q=&f%5Bcollection_name_ssim%5D%5B%5D=Urban+Maps' },
    ],
    verification,
  };
  sourcesDoc.providers = [...sourcesDoc.providers.filter((source) => source.id !== 'leventhal'), provider];
  sourcesDoc.generatedAt = recordsDoc.generatedAt;
  const shardDoc = {
    generatedAt: recordsDoc.generatedAt,
    retrieved: RETRIEVED,
    providerId: 'leventhal',
    method: recordsDoc.selection['leventhal:bpl'].rule,
    selection: recordsDoc.selection['leventhal:bpl'],
    records,
  };
  const coreBytes = Buffer.byteLength(JSON.stringify(recordsDoc));
  const shardBytes = Buffer.byteLength(JSON.stringify(shardDoc));
  console.log(
    `Catalogue would be ${recordsDoc.records.length} core + ${records.length} leventhal records; ` +
      `core ${(coreBytes / 1024 / 1024).toFixed(2)} MiB, shard ${(shardBytes / 1024 / 1024).toFixed(2)} MiB`,
  );
  if (coreBytes > 24 * 1024 * 1024 || shardBytes > 24 * 1024 * 1024) {
    throw new Error('A catalogue asset exceeds 24 MiB; split it before writing.');
  }
  if (WRITE) {
    await mkdir(dirname(shardPath(OUT, shard)), { recursive: true });
    await writeFile(shardPath(OUT, shard), JSON.stringify(shardDoc) + '\n');
    await writeFile(recordsPath, JSON.stringify(recordsDoc) + '\n');
    await writeFile(sourcesPath, JSON.stringify(sourcesDoc, null, 2) + '\n');
    console.log('Wrote', OUT, 'and', shard);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
