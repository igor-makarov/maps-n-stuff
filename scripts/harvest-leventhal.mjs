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
 *   node scripts/harvest-leventhal.mjs --all-bpl       # every BPL-held eligible record
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

async function fetchJson(url, { attempts = 3, accept = 'application/json' } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept, 'user-agent': UA } });
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

export const RIGHTS_POLICY_URL = 'https://www.digitalcommonwealth.org/copyright';
export const API_DOCUMENTATION_URL = 'https://www.digitalcommonwealth.org/api';
const NO_KNOWN = /^No known copyright restrictions\.?$/i;
const NO_RESTRICTIONS = /^No known restrictions on use\.?$/i;
const CC0 = /(?:CC0|public domain under a creative commons no rights reserved license|creativecommons\.org\/publicdomain\/zero)/i;
const NOC_US = /No Copyright - United States|rightsstatements\.org\/vocab\/NoC-US/i;
const CC_BY = /Creative Commons Attribution License \(CC BY\)/i;
const PUBLIC_DOMAIN = /^(?:Public Domain|Public domain)\b/i;
const BLOCKING = /non[ -]?commercial|all rights reserved|permission (?:is )?required|prior written permission|contact (?:the )?host|rights status not evaluated|copyright undetermined|not in the public domain|may be restricted|under copyright|protected by copyright|copyright \(c\)|copyright ©|copyright expired|^(?:copyright|©)\b/i;
// A restriction on reuse is not rescued by an open licence named elsewhere: an
// item that says both "All rights reserved" and "CC0" is contradictory and must
// stay out of the reusable catalogue.
const STRICT_RESTRICTION = /all rights reserved|(?<!no )rights reserved|may not be (?:used|reproduced|distributed|published)|reproduction (?:is )?prohibited|permission (?:is )?required|prior written permission|non[ -]?commercial/i;

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
  if (STRICT_RESTRICTION.test(rights) || STRICT_RESTRICTION.test(license)) return null;
  if (BLOCKING.test(combined)) {
    // An explicit public-domain/CC0 statement wins over a generic "copyright"
    // word only when it names the public domain directly.
    if (!(CC0.test(combined) || NOC_US.test(rights) || PUBLIC_DOMAIN.test(rights))) return null;
  }
  // A restrictive item statement is not cancelled by an open label in a second
  // field ("Under copyright. All rights reserved." + "CC0" is a conflict).
  if (BLOCKING.test(rights) && !(NOC_US.test(rights) || PUBLIC_DOMAIN.test(rights))) return null;
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

/**
 * Per-record rights evidence exactly as the holding institution's catalogue
 * states it. The search feed's `license_uri_ss` is an item-level licence URI;
 * it is kept verbatim when present and never synthesised from a free-text
 * statement. The policy URL is Digital Commonwealth's own copyright/terms page
 * (the service provider, not a licence applied to the item).
 */
function canonicalRightsUrl(value) {
  const raw = String(value ?? '').trim();
  // The canonical deed URLs are served over HTTPS. Upstream manifests sometimes
  // still spell creativecommons.org/rightsstatements.org with http; normalise
  // only those two known licence hosts, and keep anything else exactly as stated.
  const known = raw.match(/^http:\/\/((?:www\.)?creativecommons\.org\/|rightsstatements\.org\/)/i);
  if (known) return `https://${raw.slice(7)}`;
  return /^https:\/\//.test(raw) ? raw : null;
}

export function rightsEvidence(attributes, id = '') {
  const rightsStatement = plain(attributes.rights_ss);
  const licenseStatement = plain(attributes.license_ss);
  const licenceUri = canonicalRightsUrl(attributes.license_uri_ss) ?? '';
  const evidence = {
    rightsStatement,
    licenseStatement,
    rightsPolicyUrl: RIGHTS_POLICY_URL,
  };
  if (licenceUri) evidence.rightsUrl = licenceUri;
  if (/^commonwealth:[a-z0-9]+$/.test(id)) {
    evidence.metadataSource = `https://collections.leventhalmap.org/search/${id}.json`;
  }
  return evidence;
}

/**
 * CC BY items get their versioned licence URI and the credit line from the
 * item's own IIIF manifest. A missing manifest field stays unknown: the search
 * feed's licence URI, when present, is retained; no licence version or credit
 * is invented. Other rights bases are returned unchanged.
 */
export async function enrichCcBy(records, fetchJson) {
  const enriched = [];
  for (const record of records) {
    if (record.rightsBasis !== 'cc-by' || typeof fetchJson !== 'function') continue;
    try {
      const manifest = await fetchJson(record.iiifManifest);
      const licence = String(manifest?.license ?? '').trim();
      const attribution = plain(manifest?.attribution);
      const canonical = canonicalRightsUrl(licence);
      if (canonical) record.rightsUrl = canonical;
      const version = canonical?.match(/\/licenses\/[a-z-]+\/(\d+\.\d+)\//i);
      if (version) record.licenseVersion = version[1];
      if (attribution) record.attribution = attribution;
      record.rightsEvidenceSource = record.iiifManifest;
      enriched.push(record.id);
    } catch (error) {
      record.rightsEvidenceNote = `The IIIF manifest did not answer when the rights evidence was read (${String(error.message ?? error)}); the catalogue statements above are retained unchanged.`;
    }
  }
  return enriched;
}

export function recordOf(document, { scope = 'bpl' } = {}) {
  const a = document.attributes ?? {};
  if (!Array.isArray(a.genre_basic_ssim) || !a.genre_basic_ssim.includes('Maps')) return null;
  if (!(a.type_of_resource_ssim ?? []).includes('Cartographic')) return null;
  const holders = (a.physical_location_ssim ?? []).map(plain).filter(Boolean);
  if (scope === 'bpl') {
    if (!(a.physical_location_ssim ?? []).includes('Boston Public Library')) return null;
    if (!ALL_BPL && !(a.collection_name_ssim ?? []).some((name) => COLLECTIONS.includes(name))) return null;
  } else {
    // The consortium scope is the complement of the BPL scope: partner-held
    // items only, with the contributing institution named in `institution`.
    // A private collector is kept only if the record names a real institution.
    if (!holders.length || holders.includes('Boston Public Library')) return null;
    if (holders.every((holder) => /^private collection$/i.test(holder))) return null;
  }
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
  const providerId = scope === 'bpl' ? 'leventhal' : 'digitalcommonwealth';
  const collection = (a.collection_name_ssim ?? []).map(plain).filter(Boolean).join(' / ') || (scope === 'bpl' ? 'Norman B. Leventhal Map & Education Center Collection' : 'Digital Commonwealth map collections');
  const creators = (a.name_tsim ?? []).map(plain).filter(Boolean);
  const evidence = rightsEvidence(a, String(id));
  const institution = scope === 'bpl' ? 'Boston Public Library, Norman B. Leventhal Map & Education Center' : holders.join('; ');
  const record = {
    id: `${providerId}:${id}`,
    title,
    creators,
    providerId,
    institution,
    rights: [plain(a.rights_ss), plain(a.license_ss)].filter(Boolean).join(' '),
    ...evidence,
    rightsBasis: basis,
    reuseAllowed: plain(a.reuse_allowed_ssi),
    creditLine: scope === 'bpl' ? 'Norman B. Leventhal Map & Education Center at the Boston Public Library' : holders.join('; '),
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

  // CC BY items are a small, explicitly licensed subset: read the versioned
  // licence URI and the stated credit from their own manifests, cached so a
  // refresh is reproducible. A manifest failure is recorded, never guessed.
  const ccEnriched = await enrichCcBy(records, async (url) => {
    const match = String(url).match(/ark:\/50959\/([a-z0-9]+)\/manifest$/);
    const item = match ? match[1] : createHash('sha1').update(String(url)).digest('hex').slice(0, 16);
    const path = resolve(CACHE, 'manifests', `${item}.json`);
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      // not cached yet
    }
    // Digital Commonwealth's ARK endpoint answers 404 when a request asks for
    // `application/json` alone; its IIIF manifests are `application/ld+json`.
    // Ask for that (the response is still JSON) rather than weakening the check.
    const body = await fetchJson(url, { accept: 'application/ld+json' });
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(body));
    return body;
  });

  console.log(`Eligible Boston Public Library records: ${records.length}`);
  const basis = {};
  for (const record of records) basis[record.rightsBasis] = (basis[record.rightsBasis] || 0) + 1;
  const rights = {
    withRightsUrl: records.filter((record) => record.rightsUrl).length,
    withPolicyUrl: records.filter((record) => record.rightsPolicyUrl).length,
    ccByManifestEnriched: ccEnriched.length,
    ccByEvidenceFailed: records.filter((record) => record.rightsEvidenceNote).length,
  };
  console.log('Rights evidence:', rights);
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
    rightsEvidence: rights,
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
      (ALL_BPL
        ? 'Documented Blacklight JSON search (genre Maps, per_page 100, 153 pages) over every Boston Public Library-held cartographic record, with per-record rights evidence; no decade, geography, collection or record-count cap.'
        : 'Documented Blacklight JSON search (genre Maps, per_page 100, 153 pages), filtered to Boston Public Library holdings in the complete Boston and New England, American Revolutionary War-Era, Maritime Charts and Atlases, and Urban Maps collections, with per-record rights evidence; no decade, geography or record-count cap.'),
    rightsPolicy: {
      copyright: RIGHTS_POLICY_URL,
      apiDocumentation: API_DOCUMENTATION_URL,
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
      imageRightsBasis: {
        'no-known-restrictions':
          'rights_ss "No known copyright restrictions." + license_ss "No known restrictions on use." + reuse_allowed_ssi "no restrictions" as stated by the holding institution; retained verbatim, not labelled public domain or CC0.',
        'cc-by':
          'license_ss explicitly names a Creative Commons Attribution licence; the versioned licence URI (license_uri_ss or the IIIF manifest license) and the stated credit are retained.',
        'no-copyright-us': 'rights_ss states NoC-US; the rightsstatements.org URI is retained when supplied.',
        cc0: 'rights_ss/license_ss explicitly names CC0.',
        'public-domain': 'rights_ss explicitly names the public domain with no restrictions on use.',
      },
    },
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
