#!/usr/bin/env node
/**
 * Reproducible harvest of the Library of Congress Geography and Map Division.
 *
 * Routes are documented LoC JSON search endpoints (`?fo=json`), not scraped
 * HTML. Two complete/named scopes are supported:
 *
 *   civil-war-maps  every map-format item in the complete "Civil War Maps" set
 *   general-maps    the "General Maps" collection, oldest first (resumable)
 *
 * Rights are read from every item record. An item is admitted only when:
 *   - its `partof` names the Geography and Map Division (so the division's
 *     published free-to-use-and-reuse statement applies to that object), and
 *   - the item's own `rights` statement affirmatively says the digitised
 *     content is free to use and reuse or in the public domain, and
 *   - no Rights Advisory / access advisory states a restriction. An advisory
 *     that itself names the public domain is accepted and retained verbatim.
 * Public access or an old date is not used as a substitute for that evidence.
 * Sanborn volumes carry the Sanborn Maps Collection public-domain statement
 * and are therefore accepted on that explicit statement, not on age.
 *
 * The IIFF image service and manifest are read from the item record and
 * verified on a deterministic sample after the metadata harvest. A missing
 * preview never silently becomes a fabricated thumbnail.
 *
 * Usage:
 *   node scripts/harvest-loc.mjs --scope civil-war-maps --pages 5
 *   node scripts/harvest-loc.mjs --scope general-maps --pages 4 --max-items 300
 *   node scripts/harvest-loc.mjs --refresh --no-write
   node scripts/harvest-loc.mjs --cached-only --no-write   # offline merge test
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
const CACHE = resolve(ROOT, '.cache/loc');
const REFRESH = has('refresh');
const WRITE = !has('no-write');
const PAGE_SIZE = Math.max(1, Math.min(150, Number(value('page-size', '100')) || 100));
const CONCURRENCY = Math.max(1, Math.min(12, Number(value('concurrency', '5')) || 5));
const PAGES = Math.max(1, Number(value('pages', '100')) || 100);
const START_PAGE = Math.max(1, Number(value('start-page', '1')) || 1);
const MAX_ITEMS = Math.max(1, Number(value('max-items', '100000')) || 100000);
const CACHED_ONLY = has('cached-only');
const UA =
  'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; historical map catalogue)';
export const RETRIEVED = '2026-10-20';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Documented scopes. `total` is the upstream collection size seen on the
 * retrieval date and is recorded as evidence, not assumed to stay constant.
 */
export const SCOPES = {
  'civil-war-maps': {
    label: 'Civil War Maps',
    collectionUrl: 'https://www.loc.gov/collections/civil-war-maps/',
    aboutUrl: 'https://www.loc.gov/collections/civil-war-maps/about-this-collection/',
    rule: 'every map-format item in the complete Civil War Maps collection',
    search: (page) =>
      `https://www.loc.gov/collections/civil-war-maps/?fo=json&c=${PAGE_SIZE}&sp=${page}&fa=original_format:map&at=results,pagination`,
    // The collection's own about page documents that the maps are in the
    // public domain; the per-item `rights` string is still required below.
    expectedTotal: 464,
  },
  'general-maps': {
    label: 'General Maps',
    collectionUrl: 'https://www.loc.gov/collections/general-maps/',
    aboutUrl: 'https://www.loc.gov/collections/general-maps/about-this-collection/',
    rule:
      'the General Maps collection, oldest first; a resumable prefix of the collection, never presented as the whole set until the cursor reaches the last page',
    search: (page) =>
      `https://www.loc.gov/collections/general-maps/?fo=json&c=${PAGE_SIZE}&sp=${page}&sb=date&at=results,pagination`,
    expectedTotal: 2313,
  },
};
const scopeName = value('scope', 'civil-war-maps');
const SCOPE = SCOPES[scopeName];
if (!SCOPE) throw new Error(`unknown scope: ${scopeName}`);

const DIVISION = /geography and map division/i;
const FREE_USE = /free to use and reuse/i;
const PUBLIC_DOMAIN =
  /\b(?:is|are|in the|in) (?:the )?public domain\b|publicdomain\/(?:mark|zero)\/1\.0|noc-us/i;
const RESTRICTED =
  /all rights reserved|permission (?:is )?required|rights status not evaluated|copyright undetermined|may be restricted|under copyright|protected by copyright|non[ -]?commercial|contact (?:the )?host/i;

export function locText(value) {
  return String(Array.isArray(value) ? value.join(' ') : (value ?? ''))
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Publication years from the source's own date string; never the depicted period. */
export function locYearRange(value) {
  const years = [
    ...locText(value).matchAll(/\b(1[0-9]{3}|20[0-9]{2})\b/g),
  ].map((m) => Number(m[1])).filter((y) => y >= 1000 && y <= 2100);
  if (!years.length) return { start: null, end: null };
  const start = Math.min(...years);
  const end = Math.max(...years);
  return { start, end };
}

/** Keep the delivered IIIF JPEG thumbnail; drop the sizing fragment. */
export function locThumbnail(imageUrls) {
  const urls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);
  const iiif = urls
    .map((u) => String(u).split('#')[0])
    .filter((u) => /^https:\/\/tile\.loc\.gov\/image-services\/iiif\/service:gmd:[^/]+\/full\/(?:pct:\d+(?:\.\d+)?|\d*,)\/0\/default\.jpg$/.test(u));
  const large = iiif.find((u) => /\/full\/(?:pct:25|\d*,)\/0\//.test(u)) ?? iiif[0];
  if (!large) return { thumbnail: null, imageService: null };
  const imageService = large.replace(/\/full\/.*$/, '');
  return { thumbnail: large, imageService };
}

/** The item's own affirmative rights statement, or null when it cannot carry reuse. */
export function locRightsBasis(item) {
  const partOf = (item.partof ?? []).map((p) => locText(p?.title ?? p));
  if (!partOf.some((p) => DIVISION.test(p))) return null;
  const rights = locText(item.rights ?? item.rights_information ?? '');
  if (!rights) return null;
  const advisory = locText([
    item.rights_advisory,
    item.access_advisory,
    item.access_restricted,
  ].filter((v) => v != null && v !== false && v !== 'false'));
  if (advisory && !PUBLIC_DOMAIN.test(advisory)) return null;
  if (RESTRICTED.test(rights) && !PUBLIC_DOMAIN.test(rights)) return null;
  if (!FREE_USE.test(rights) && !PUBLIC_DOMAIN.test(rights)) return null;
  if (/sanborn maps collection/i.test(rights)) return 'sanborn-public-domain';
  if (PUBLIC_DOMAIN.test(rights)) return 'public-domain';
  return 'division-free-to-use-and-reuse';
}

const COLLECTION_LABELS = new Map([
  ['civil war maps', 'Civil War Maps'],
  ['county landownership maps', 'County Landownership Maps'],
  ['sanborn maps', 'Sanborn Fire Insurance Maps'],
  ['panoramic maps', 'Panoramic Maps'],
  ['railroad maps, 1828 to 1900', 'Railroad Maps, 1828–1900'],
  ['general maps', 'General Maps'],
  ['geography and map division', 'Geography and Map Division'],
  ['cultural landscapes', 'Cultural Landscapes'],
]);

function collectionNames(item) {
  return (item.partof ?? [])
    .map((p) => locText(p?.title ?? p))
    .filter(Boolean)
    .filter((name) => !/^catalog$/i.test(name));
}

function labelFor(names) {
  const specific = names.find(
    (name) => !/geography and map division/i.test(name) && COLLECTION_LABELS.has(name.toLowerCase()),
  );
  return specific ? COLLECTION_LABELS.get(specific.toLowerCase()) : 'General Maps';
}

/**
 * Turn one LoC item JSON document into a catalogue record, or return null when
 * the item fails the rights or identity gate. `reason` is filled by the
 * caller from the same rules for reporting.
 */
export function locItemRecord(data) {
  const item = data?.item ?? data ?? {};
  const rawId = locText(item.id ?? item.url).match(/\/item\/([^/]+)\//)?.[1];
  if (!rawId || !/^[a-zA-Z0-9._-]{1,80}$/.test(rawId)) return null;
  const basis = locRightsBasis(item);
  if (!basis) return null;
  const { thumbnail, imageService } = locThumbnail(item.image_url);
  if (!thumbnail || !imageService) return null;
  const title = locText(item.title);
  if (!title) return null;
  const { start, end } = locYearRange(item.date ?? item.dates);
  const names = collectionNames(item);
  const manifest = locText(item.iiif_manifest_url);
  const recordUrl = `https://www.loc.gov/item/${rawId}/`;
  const record = {
    id: `loc:${rawId}`,
    title,
    creators: (item.contributor_names ?? []).map(locText).filter(Boolean).slice(0, 12),
    providerId: 'loc',
    institution: 'Library of Congress, Geography and Map Division',
    rights: locText(item.rights),
    rightsBasis: basis,
    rightsUrl: 'https://www.loc.gov/legal/',
    recordUrl,
    viewerUrl: (item.resources ?? []).map((r) => locText(r?.url)).find((u) => /^https:\/\/www\.loc\.gov\/resource\//.test(u)) ?? null,
    thumbnail,
    imageService,
    iiifManifest: /^https:\/\/www\.loc\.gov\/item\/[^/]+\/manifest\.json$/.test(manifest) ? manifest : `https://www.loc.gov/item/${rawId}/manifest.json`,
    type: 'map',
    collection: labelFor(names),
    originalCollection: names.join(' / ') || undefined,
    dateDisplay: locText(item.date) || undefined,
    imprint: locText(item.created_published ?? item.created_published_date) || undefined,
    publisher: locText(item.created_published) || undefined,
    languages: (item.languages ?? []).map((l) => locText(Object.keys(l ?? {})[0] ?? l)).filter(Boolean).slice(0, 8),
    subjects: (item.subjects ?? []).map((s) => locText(Object.keys(s ?? {})[0] ?? s)).filter(Boolean).slice(0, 12),
    shelfmark: (item.call_number ?? [])[0],
    metadataSource: `https://www.loc.gov/item/${rawId}/?fo=json`,
    sourceModified: locText(item.source_modified) || undefined,
    liveCatalogue: false,
    geoNote:
      'Library of Congress catalogue record. No image alignment, projection or map boundary is inferred from the record; the IIIF image service is the original delivered scan.',
  };
  if (start != null) {
    record.yearStart = start;
    record.yearEnd = end;
  }
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete record[key];
  }
  if (!Array.isArray(record.creators)) record.creators = [];
  return record;
}

/** Why an item was withheld, for the selection evidence. */
/**
 * Resume state for a search-page budget. A challenge, a fetch failure or a
 * --max-items truncation leaves unprocessed candidates on the scanned pages;
 * in that case the cursor must replay those pages (the item and search caches
 * make the replay cheap and stable-id dedupe makes it safe), never skip to the
 * next page. Only a fully processed page budget advances the cursor.
 */
export function locResumeState({
  documents,
  queue,
  fetchedIds,
  startPage,
  lastPage,
  challenged,
  failed = [],
  pageCount = null,
}) {
  const unattempted = documents
    .map((document) => document.id)
    .filter((id) => !fetchedIds.has(id));
  const truncatedByMaxItems = documents.length > queue.length;
  const complete =
    !challenged && failed.length === 0 && unattempted.length === 0;
  return {
    complete,
    nextPage: complete ? lastPage + 1 : startPage,
    pageCount,
    scannedPages: `${startPage}-${lastPage}`,
    considered: documents.length,
    queued: queue.length,
    fetched: fetchedIds.size,
    unattemptedCount: unattempted.length,
    truncatedByMaxItems,
    pendingItems: unattempted.slice(0, 1000),
    pendingItemsTruncated: unattempted.length > 1000,
  };
}

export function locRejection(item) {
  const partOf = (item?.partof ?? []).map((p) => locText(p?.title ?? p));
  if (!partOf.some((p) => DIVISION.test(p))) return 'outside Geography and Map Division';
  const advisory = locText([item.rights_advisory, item.access_advisory].filter(Boolean));
  if (advisory && !PUBLIC_DOMAIN.test(advisory)) return `rights advisory: ${advisory.slice(0, 120)}`;
  if (RESTRICTED.test(locText(item.rights)) && !PUBLIC_DOMAIN.test(locText(item.rights)))
    return 'restricted rights statement';
  if (!locRightsBasis(item)) return `rights unstated or not affirmative: ${locText(item.rights).slice(0, 120) || 'none'}`;
  if (!locThumbnail(item.image_url).thumbnail) return 'no delivered IIIF image service';
  if (!locText(item.title)) return 'no title';
  return 'identity gate';
}

async function fetchJson(url, { attempts = 4, timeout = 25000 } = {}) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(timeout),
      });
      if (res.ok) {
        const body = await res.text();
        if (body.trimStart().startsWith('{')) return JSON.parse(body);
        if (/Just a moment|Enable JavaScript and cookies/i.test(body)) {
          throw new Error(`blocked by the LoC edge challenge: ${url}`);
        }
        last = new Error(`non-JSON response from ${url}`);
      } else {
        const body = await res.text().catch(() => '');
        if (res.status === 429 || /Just a moment|Enable JavaScript and cookies/i.test(body)) {
          throw new Error(
            `blocked by the LoC edge challenge (HTTP ${res.status}); stop and retry later: ${url}`,
          );
        }
        last = new Error(`HTTP ${res.status} from ${url}`);
        if (res.status < 500) break;
      }
    } catch (error) {
      // A Cloudflare "Just a moment" page is not a transient timeout: stop the
      // run instead of hammering the collection and extending the block.
      if (/blocked by the LoC edge challenge/i.test(String(error.message))) throw error;
      last = error;
    }
    await sleep(800 * attempt);
  }
  throw last;
}

async function cachedJson(path, url, options) {
  if (!REFRESH) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {}
  }
  const body = await fetchJson(url, options);
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(body));
  await rename(temp, path);
  return body;
}

function pageCache(page) {
  return resolve(CACHE, 'search', `${scopeName}-${PAGE_SIZE}-${page}.json`);
}
function itemCache(id) {
  return resolve(CACHE, 'items', `${id}.json`);
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      await sleep(30);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function head(url, accept) {
  try {
    const res = await fetch(url, {
      headers: { accept, 'user-agent': UA, range: 'bytes=0-4095' },
      signal: AbortSignal.timeout(20000),
    });
    return { status: res.status, type: res.headers.get('content-type') };
  } catch (error) {
    return { status: 0, type: null, error: String(error.message) };
  }
}

export async function verify(records, limit = 12) {
  const sample = [];
  const step = Math.max(1, Math.floor(records.length / limit));
  for (let i = 0; i < records.length && sample.length < limit; i += step) sample.push(records[i]);
  const results = await pool(sample, 2, async (record) => {
    const thumb = await head(record.thumbnail, 'image/jpeg');
    const info = record.imageService
      ? await head(`${record.imageService}/info.json`, 'application/json')
      : { status: null, type: null };
    const manifest = record.iiifManifest
      ? await head(record.iiifManifest, 'application/json')
      : { status: null, type: null };
    return {
      id: record.id,
      info: info.status,
      infoType: info.type,
      thumbnail: thumb.status,
      thumbnailType: thumb.type,
      manifest: manifest.status,
      manifestType: manifest.type,
    };
  });
  // A ranged GET answers 206, which is an available resource, not a failure.
  const ok = (status) => status === 200 || status === 206;
  return {
    retrieved: RETRIEVED,
    sample: results.length,
    imageInfoOk: results.filter((r) => ok(r.info) && /json/.test(r.infoType ?? '')).length,
    imageInfoChecked: results.filter((r) => r.info != null).length,
    thumbnailOk: results.filter((r) => ok(r.thumbnail) && /image\//.test(r.thumbnailType ?? '')).length,
    manifestOk: results.filter((r) => ok(r.manifest) && /json/.test(r.manifestType ?? '')).length,
    manifestChecked: results.filter((r) => r.manifest != null).length,
    examples: results.slice(0, 6),
  };
}

async function main() {
  const first = await cachedJson(pageCache(START_PAGE), SCOPE.search(START_PAGE));
  const total = first.pagination?.total ?? null;
  // The LoC pagination total is occasionally smaller than the delivered page
  // when a facet is combined with `c`/`at`. Trust the explicit page budget in
  // that case instead of silently scanning one page.
  const delivered = first.results?.length ?? 0;
  const pageCount = total && total >= delivered ? Math.ceil(total / PAGE_SIZE) : null;
  const lastPage = pageCount ? Math.min(pageCount, START_PAGE + PAGES - 1) : START_PAGE + PAGES - 1;
  console.log(`${SCOPE.label}: ${total ?? '?'} upstream records, pages ${START_PAGE}..${lastPage} of ${pageCount ?? 'unknown (explicit page budget)'}`);
  const pages = [first];
  let nextPage = START_PAGE + 1;
  async function pageWorker() {
    while (true) {
      const page = nextPage++;
      if (page > lastPage) return;
      try {
        pages.push(await cachedJson(pageCache(page), SCOPE.search(page)));
        if (page % 10 === 0) console.log(`cached search page ${page}/${lastPage}`);
      } catch (error) {
        console.error(`search page ${page}: ${error.message}`);
      }
      await sleep(150);
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, PAGES) }, pageWorker));
  const documents = [];
  const seen = new Set();
  for (const page of pages) {
    for (const result of page.results ?? []) {
      const id = locText(result.id ?? result.url).match(/\/item\/([^/]+)\//)?.[1];
      if (!id || !/\/item\//.test(locText(result.id ?? result.url)) || seen.has(id)) continue;
      seen.add(id);
      documents.push({ id, result });
    }
  }
  console.log(`Candidate item records on those pages: ${documents.length}`);
  const queue = documents.slice(0, MAX_ITEMS);
  const withheld = {};
  const records = [];
  const failed = [];
  const fetchedIds = new Set();
  let unattemptedCachedOnly = 0;
  let challenged = null;
  await pool(queue, CONCURRENCY, async ({ id }) => {
    if (challenged) return;
    let body;
    const cache = itemCache(id);
    if (CACHED_ONLY) {
      try {
        body = JSON.parse(await readFile(cache, 'utf8'));
        fetchedIds.add(id);
      } catch {
        unattemptedCachedOnly++;
        return;
      }
    } else {
      try {
        body = await cachedJson(cache, `https://www.loc.gov/item/${id}/?fo=json&at=item`, {
          attempts: 3,
          timeout: 25000,
        });
      } catch (error) {
        if (/edge challenge/i.test(String(error.message))) challenged = String(error.message);
        failed.push({ id, error: String(error.message) });
        return;
      }
    }
    fetchedIds.add(id);
    const item = body.item ?? body;
    const record = locItemRecord(body);
    if (!record) {
      const reason = locRejection(item);
      withheld[reason] = (withheld[reason] || 0) + 1;
      return;
    }
    records.push(record);
  });
  records.sort(
    (a, b) => (a.yearStart ?? 9999) - (b.yearStart ?? 9999) || a.id.localeCompare(b.id),
  );
  const resume = locResumeState({
    documents,
    queue,
    fetchedIds,
    startPage: START_PAGE,
    lastPage,
    challenged,
    failed,
    pageCount,
  });
  console.log(`Eligible: ${records.length}; withheld ${Object.values(withheld).reduce((a, b) => a + b, 0)}; item fetch failures ${failed.length}; unattempted ${resume.unattemptedCount}${CACHED_ONLY ? ` (${unattemptedCachedOnly} lacking cache)` : ''}`);
  console.log('Rights bases:', records.reduce((acc, r) => ((acc[r.rightsBasis] = (acc[r.rightsBasis] || 0) + 1), acc), {}));
  console.log('Top withholding reasons:', Object.entries(withheld).sort((a, b) => b[1] - a[1]).slice(0, 6));
  if (failed.length) console.log('Fetch failures:', failed.slice(0, 5));
  if (challenged) console.log(`STOPPED by the LoC edge challenge; ${resume.unattemptedCount} item requests were not attempted. ${challenged}`);
  console.log(`Resume: ${resume.complete ? `next page ${resume.nextPage}` : `replay page ${resume.nextPage} (${resume.unattemptedCount} pending ids)`}`);

  const recordsPath = resolve(OUT, 'records.json');
  const sourcesPath = resolve(OUT, 'sources.json');
  const recordsDoc = JSON.parse(await readFile(recordsPath, 'utf8'));
  const sourcesDoc = JSON.parse(await readFile(sourcesPath, 'utf8'));
  const merged = new Map();
  for (const record of recordsDoc.records ?? []) if (record.providerId === 'loc') merged.set(record.id, record);
  let shardRecords = [];
  const shard = shardUrl('loc');
  if ((recordsDoc.shards ?? []).includes(shard)) {
    const doc = JSON.parse(await readFile(shardPath(OUT, shard), 'utf8'));
    for (const record of doc.records ?? []) merged.set(record.id, record);
  }
  const preserved = merged.size;
  for (const record of records) merged.set(record.id, record);
  shardRecords = [...merged.values()].sort(
    (a, b) => (a.yearStart ?? 9999) - (b.yearStart ?? 9999) || a.id.localeCompare(b.id),
  );
  const verification = records.length ? await verify(records) : null;
  console.log(`Catalogue: ${preserved} existing LoC records preserved, ${records.length} new eligible, ${shardRecords.length} total`);
  if (!records.length) throw new Error('No eligible LoC records; leaving the catalogue unchanged.');

  recordsDoc.shards = [...new Set([...(recordsDoc.shards ?? []), shard])].sort();
  recordsDoc.records = recordsDoc.records.filter((record) => record.providerId !== 'loc');
  recordsDoc.generatedAt = new Date().toISOString();
  recordsDoc.retrieved = RETRIEVED;
  if (!recordsDoc.method?.includes('Library of Congress Geography and Map Division records are imported'))
    recordsDoc.method = `${recordsDoc.method ? recordsDoc.method + ' ' : ''}Library of Congress Geography and Map Division records are imported from documented item JSON with per-item rights evidence; they are bundled in ${shard}.`;
  recordsDoc.selection ??= {};
  const selection = {
    scope: scopeName,
    upstreamTotal: total,
    // The LoC API reported a smaller total than the page it delivered when the
    // format facet was combined with c/at. Keep the reported value as evidence
    // and record the explicit page budget that was actually used.
    reportedPaginationTotal: total,
    explicitPageBudget: lastPage,
    pagesScanned: `${START_PAGE}-${lastPage}`,
    considered: queue.length,
    kept: records.length,
    preserved,
    shard,
    rightsBasis: records.reduce((acc, r) => ((acc[r.rightsBasis] = (acc[r.rightsBasis] || 0) + 1), acc), {}),
    withheld,
    fetchFailures: failed.length,
    edgeChallenge: challenged ?? false,
    unattempted: resume.unattemptedCount,
    truncatedByMaxItems: resume.truncatedByMaxItems,
    rule: `Library of Congress ${SCOPE.label}: ${SCOPE.rule}. Admitted only when the item's partof names the Geography and Map Division, the item's own rights statement affirmatively permits free reuse or names the public domain, and no Rights Advisory states a restriction. Public access or age alone is not evidence.`,
    resumable: {
      scope: scopeName,
      complete: resume.complete,
      nextPage: resume.nextPage,
      pageCount: pageCount ?? null,
      fetchedItems: resume.fetched,
      unattemptedCount: resume.unattemptedCount,
      pendingItems: resume.pendingItems,
      pendingItemsTruncated: resume.pendingItemsTruncated,
      truncatedByMaxItems: resume.truncatedByMaxItems,
      note: resume.complete
        ? 'Every candidate on the scanned pages was fetched and admitted or explicitly withheld. Re-running with --start-page continues the collection; cached JSON and stable ids make the replay safe.'
        : 'Unprocessed candidates remain on the scanned pages; nextPage intentionally replays them after a permitted cooldown. Cached search pages and item JSON are reused, and stable-id dedupe makes the replay safe. The cursor advances only after every candidate on the page budget is fetched and admitted or explicitly withheld.',
    },
    verification,
  };
  recordsDoc.selection[`loc:${scopeName}`] = selection;
  const provider = {
    id: 'loc',
    name: 'Library of Congress — Geography and Map Division',
    operator: 'Library of Congress, Geography and Map Division',
    homepage: 'https://www.loc.gov/maps/',
    home: 'https://www.loc.gov/maps/',
    institutions: ['Library of Congress'],
    rights:
      'Each record retains the Library of Congress rights statement read from its item record. Admitted items carry the division\'s "free to use and reuse" statement, the Sanborn Maps Collection public-domain statement, or an explicit public-domain statement, and have no restricting Rights Advisory. Credit: Library of Congress, Geography and Map Division.',
    attribution: 'Library of Congress, Geography and Map Division',
    retrieved: RETRIEVED,
    rightsUrl: 'https://www.loc.gov/legal/',
    api: {
      catalogue: 'https://www.loc.gov/collections/{collection}/?fo=json',
      item: 'https://www.loc.gov/item/{id}/?fo=json',
      manifest: 'https://www.loc.gov/item/{id}/manifest.json',
      image: 'https://tile.loc.gov/image-services/iiif/{service}',
      documentation: 'https://www.loc.gov/apis/',
    },
    apiHosts: ['www.loc.gov', 'tile.loc.gov'],
    method: `Documented LoC JSON search (${PAGE_SIZE} per page) over the ${SCOPE.label} scope, with the item JSON rights statement and Rights Advisory checked for every admitted record. No date, geography or record-count cap; the collection cursor is recorded so the next run continues from the last scanned page.`,
    collections: [
      {
        id: scopeName,
        name: SCOPE.label,
        discovery: SCOPE.collectionUrl,
        about: SCOPE.aboutUrl,
      },
    ],
    verification,
  };
  sourcesDoc.providers = [...sourcesDoc.providers.filter((source) => source.id !== 'loc'), provider];
  sourcesDoc.generatedAt = recordsDoc.generatedAt;
  const shardDoc = {
    generatedAt: recordsDoc.generatedAt,
    retrieved: RETRIEVED,
    providerId: 'loc',
    method: selection.rule,
    selection,
    records: shardRecords,
  };
  const coreBytes = Buffer.byteLength(JSON.stringify(recordsDoc));
  const shardBytes = Buffer.byteLength(JSON.stringify(shardDoc));
  console.log(
    `Core ${(coreBytes / 1048576).toFixed(2)} MiB, loc shard ${(shardBytes / 1048576).toFixed(2)} MiB`,
  );
  if (coreBytes > 24 * 1048576 || shardBytes > 24 * 1048576)
    throw new Error('A catalogue asset exceeds 24 MiB; split it before writing.');
  if (WRITE) {
    await mkdir(dirname(shardPath(OUT, shard)), { recursive: true });
    await writeFile(shardPath(OUT, shard), `${JSON.stringify(shardDoc)}\n`);
    await writeFile(recordsPath, `${JSON.stringify(recordsDoc, null, 2)}\n`);
    await writeFile(sourcesPath, `${JSON.stringify(sourcesDoc, null, 2)}\n`);
    console.log('Wrote', OUT, 'and', shard);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
