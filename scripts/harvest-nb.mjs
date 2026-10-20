#!/usr/bin/env node
/**
 * National Library of Norway (Nasjonalbiblioteket) map harvest — 2026-10-20.
 *
 * Discovery uses the documented Catalog Search API:
 *   https://api.nb.no/catalog/v1/items/api-docs
 *
 * The API exposes the library's `kart` media type (`mediatype:kart`) and a
 * numeric publication-year range filter. This lane reads maps dated 1500–1945
 * and admits only items whose item-level access record states all of:
 *
 *   accessInfo.isPublicDomain === true
 *   accessInfo.license        === "publicdomain"
 *   accessInfo.accessAllowedFrom === "EVERYWHERE"
 *   accessInfo.viewability    === "ALL"
 *
 * The IIIF manifest repeats the licence as
 * `https://www.nb.no/lisens/#public-domain` and is retained per record. The
 * item licence, not a site-wide footer, is the image-rights gate; copyrighted
 * and CC BY-NC items are counted and withheld, never relabelled.
 *
 * Records go to their own shard (`/data/records/nb.json`) and keep the verbatim
 * title, creators, language codes, place, publisher, issued date, extent and
 * URN. No map extent, projection or alignment is inferred from a place string.
 *
 * Usage:
 *   node scripts/harvest-nb.mjs                  # cached harvest, writes public/data
 *   node scripts/harvest-nb.mjs --refresh        # refetch all API pages
 *   node scripts/harvest-nb.mjs --no-write       # report only
 *   node scripts/harvest-nb.mjs --verify 10      # live sample size
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publishProviderShard, readCore, shardUrl } from './catalogue.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(value('out', resolve(ROOT, 'public/data')));
const CACHE = resolve(ROOT, '.cache/nb');
const REFRESH = has('refresh');
const WRITE = !has('no-write') && !has('dry-run');
const VERIFY_SAMPLE = Math.max(0, Number(value('verify', '10')) || 0);
const UA = 'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; National Library of Norway map harvest)';
const API = 'https://api.nb.no/catalog/v1/items';
const MANIFEST = 'https://api.nb.no/catalog/v1/iiif';
const RECORD = 'https://www.nb.no/items';
const SHARD = shardUrl('nb');
const RETRIEVED = '2026-10-20';
const YEAR_FROM = 1500;
const YEAR_TO = 1945;
/** The API caps page offsets at 5,000; each window is far below that. */
export const YEAR_WINDOWS = [
  [1500, 1899],
  [1900, 1945],
];
const PAGE_SIZE = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (text) =>
  String(text ?? '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .trim();

const plain = (text) => decode(String(text ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const unique = (values) => [...new Set(values.map((value) => plain(value)).filter(Boolean))];

/** First plausible publication year in a catalogue date string. */
export function publicationYear(text) {
  const match = String(text ?? '').match(/(1[0-9]{3}|20[0-9]{2})/);
  if (!match) return null;
  const year = Number(match[1]);
  return year >= 1000 && year <= 2100 ? year : null;
}

/** The item-level rights gate. A missing explicit statement withholds the item. */
export function admitItem(item) {
  const access = item?.accessInfo ?? {};
  const metadata = item?.metadata ?? {};
  if (!plain(metadata.title)) return { ok: false, reason: 'no-title' };
  if (access.isDigital !== true) return { ok: false, reason: 'not-digital' };
  if (access.isPublicDomain !== true) return { ok: false, reason: 'not-public-domain' };
  if (String(access.license ?? '').toLowerCase() !== 'publicdomain') {
    return { ok: false, reason: `licence:${access.license ?? 'unstated'}` };
  }
  if (access.accessAllowedFrom !== 'EVERYWHERE') {
    return { ok: false, reason: `access:${access.accessAllowedFrom ?? 'unstated'}` };
  }
  if (access.viewability && access.viewability !== 'ALL') {
    return { ok: false, reason: `viewability:${access.viewability}` };
  }
  if (access.legalDepositReservationStatus) {
    return { ok: false, reason: 'legal-deposit-reservation' };
  }
  const urn = metadata.identifiers?.urn;
  const thumbnail = item?._links?.thumbnail_large?.href;
  if (!urn && !thumbnail) return { ok: false, reason: 'no-image' };
  return { ok: true, urn, thumbnail };
}

/** Convert an API item into the catalogue record. Exported for tests. */
export function nbRecord(item) {
  const gate = admitItem(item);
  if (!gate.ok) return { record: null, reason: gate.reason };
  const metadata = item.metadata ?? {};
  const access = item.accessInfo ?? {};
  const id = String(item.id);
  const issued = plain(metadata.originInfo?.issued ?? '') || plain(metadata.originInfo?.issuedUntouched ?? '');
  const issuedDisplay = plain(metadata.originInfo?.issuedUntouched ?? '') || issued;
  const year = publicationYear(issued) ?? publicationYear(metadata.originInfo?.issuedUntouched);
  const thumbnail = gate.thumbnail?.startsWith('https://') ? gate.thumbnail : undefined;
  const imageService = thumbnail?.replace(/\/full\/[^/]+\/[^/]+\/[^/]+\.jpg$/i, '');
  const places = unique([
    plain(metadata.geographic?.placeString ?? ''),
    ...(metadata.originInfoTypes ?? []).flatMap((type) => type.placeTerms ?? []),
  ]);
  const publishers = unique([
    ...(metadata.originInfoTypes ?? []).map((type) => type.publisher ?? ''),
    metadata.originInfo?.publisher ?? '',
  ]);
  const languages = (metadata.languages ?? [])
    .map((language) => plain(language.code ?? language.name ?? ''))
    .filter(Boolean);
  const subjects = unique([
    ...(metadata.subject?.topics ?? []),
    ...(metadata.subject?.geographics ?? []),
    ...(metadata.subject?.genres ?? []),
  ]).slice(0, 24);
  const recordUrl = `${RECORD}/${id}`;
  const record = {
    id: `nb:${id}`,
    title: plain(metadata.title),
    creators: unique(metadata.creators ?? metadata.people ?? []),
    providerId: 'nb',
    institution: 'National Library of Norway (Nasjonalbiblioteket)',
    collection: 'Kart / Maps (Nasjonalbiblioteket)',
    originalCollection: 'Kart / Maps',
    type: 'map',
    rights:
      'Public Domain (falt i det fri). The item record states isPublicDomain=true, licence=publicdomain and accessAllowedFrom=EVERYWHERE; the IIIF manifest states https://www.nb.no/lisens/#public-domain.',
    rightsBasis: 'publicdomain',
    rightsUrl: 'https://www.nb.no/lisens/#public-domain',
    rightsPolicyUrl: 'https://www.nb.no/tilgang/lisens/',
    rightsNote:
      'The National Library of Norway states that a work identified as Public Domain may be copied, changed, distributed, displayed and performed, including commercially, without asking permission. The verbatim licence URL and item access record are retained.',
    attribution: `Nasjonalbiblioteket / National Library of Norway, ${recordUrl} (Public Domain)`,
    recordUrl,
    viewerUrl: recordUrl,
    metadataSource: `${API}/${id}`,
    iiifManifest: `${MANIFEST}/${id}/manifest`,
    retrieved: RETRIEVED,
    sourceModified: access.accessInfoLastModified,
    geoNote:
      'The National Library of Norway catalogue record states a place and/or publication place only. No map extent, projection, georeference or alignment is inferred from it; the IIIF manifest opens the original scan.',
  };
  if (thumbnail) record.thumbnail = thumbnail;
  if (imageService) record.imageService = imageService;
  if (metadata.identifiers?.urn) record.urn = metadata.identifiers.urn;
  if (metadata.identifiers?.oaiId) record.oaiId = metadata.identifiers.oaiId;
  if (issuedDisplay) record.dateDisplay = issuedDisplay;
  if (year) {
    record.yearStart = year;
    record.yearEnd = year;
  }
  if (places.length) record.place = places.join(' ; ');
  if (publishers.length) record.publisher = publishers.join(' ; ');
  if (languages.length) record.languages = languages;
  if (subjects.length) record.subjects = subjects;
  if (metadata.physicalDescription?.extent) record.physicalExtent = plain(metadata.physicalDescription.extent);
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (key === 'creators') continue;
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete record[key];
  }
  record.creators ??= [];
  return { record };
}

export function apiUrl(window, page) {
  const [from, to] = window;
  const params = new URLSearchParams();
  params.set('q', '*');
  params.append('filter', 'mediatype:kart');
  params.append('filter', `year:[${from} TO ${to}]`);
  params.set('size', String(PAGE_SIZE));
  params.set('page', String(page));
  params.set('sort', 'date,asc');
  return `${API}?${params.toString()}`;
}

async function cachedPage(window, page) {
  const file = resolve(CACHE, `year-${window[0]}-${window[1]}-page-${String(page).padStart(3, '0')}.json`);
  if (!REFRESH) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {}
  }
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(apiUrl(window, page), {
        headers: { accept: 'application/json', 'user-agent': UA },
      });
      if (res.ok) {
        const body = await res.text();
        JSON.parse(body);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
        return JSON.parse(body);
      }
      last = new Error(`${res.status} ${apiUrl(window, page)}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      last = error;
    }
    await sleep(900 * attempt);
  }
  throw last;
}

async function verify(records) {
  const sample = [];
  const step = Math.max(1, Math.floor(records.length / Math.max(1, VERIFY_SAMPLE)));
  for (let i = 0; i < records.length && sample.length < VERIFY_SAMPLE; i += step) sample.push(records[i]);
  const results = [];
  for (const record of sample) {
    const result = { id: record.id, manifest: null, thumbnail: null, recordPage: null };
    try {
      const res = await fetch(record.iiifManifest, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(25000),
      });
      const body = await res.text();
      const manifest = JSON.parse(body);
      result.manifest = { status: res.status, contentType: res.headers.get('content-type'), license: manifest.license };
    } catch (error) {
      result.manifest = { error: String(error?.message || error) };
    }
    if (record.thumbnail) {
      try {
        const res = await fetch(record.thumbnail, {
          headers: { 'user-agent': UA },
          signal: AbortSignal.timeout(25000),
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        result.thumbnail = {
          status: res.status,
          contentType: res.headers.get('content-type'),
          bytes: bytes.length,
          jpeg: bytes[0] === 0xff && bytes[1] === 0xd8,
        };
      } catch (error) {
        result.thumbnail = { error: String(error?.message || error) };
      }
    }
    try {
      const res = await fetch(record.recordUrl, {
        headers: { accept: 'text/html', 'user-agent': UA },
        signal: AbortSignal.timeout(25000),
      });
      result.recordPage = { status: res.status, contentType: res.headers.get('content-type') };
    } catch (error) {
      result.recordPage = { error: String(error?.message || error) };
    }
    results.push(result);
    await sleep(150);
  }
  return results;
}

export function summarise(page, seen, withheld, considered) {
  const counts = {};
  for (const reason of withheld.keys()) counts[reason] = (counts[reason] ?? 0) + 1;
  return {
    page: page?.page?.number ?? null,
    totalPages: page?.page?.totalPages ?? null,
    totalElements: page?.page?.totalElements ?? null,
    seen: seen.size,
    considered,
    withheld: Object.fromEntries(Object.entries(counts).sort()),
  };
}

async function main() {
  const records = [];
  const seen = new Set();
  const seenRecords = new Set();
  const withheld = new Map();
  let considered = 0;
  let firstPage = null;
  let pagesRead = 0;
  const windowSummary = [];
  for (const window of YEAR_WINDOWS) {
    let windowConsidered = 0;
    let windowKept = 0;
    let windowPages = 0;
    for (let pageNumber = 0; ; pageNumber++) {
      const page = await cachedPage(window, pageNumber);
      firstPage ??= page;
      const items = page?._embedded?.items ?? [];
      if (!items.length) break;
      pagesRead += 1;
      windowPages += 1;
      for (const item of items) {
        if (!item?.id) continue;
        considered += 1;
        windowConsidered += 1;
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const { record, reason } = nbRecord(item);
        if (!record) {
          withheld.set(reason, (withheld.get(reason) ?? 0) + 1);
          continue;
        }
        if (seenRecords.has(record.id)) continue;
        seenRecords.add(record.id);
        records.push(record);
        windowKept += 1;
      }
      const totalPages = page?.page?.totalPages ?? 0;
      if (pageNumber + 1 >= totalPages) break;
      await sleep(120);
    }
    windowSummary.push({ window: `${window[0]}-${window[1]}`, pages: windowPages, considered: windowConsidered, kept: windowKept });
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  console.log(summarise(firstPage, seen, withheld, considered));
  console.log(`Admitted ${records.length} public-domain maps from ${pagesRead} pages.`);
  const withheldCounts = Object.fromEntries([...withheld.entries()].sort());
  const verification = VERIFY_SAMPLE ? await verify(records) : [];
  if (verification.length) console.log('Verification:', verification);

  const generatedAt = new Date().toISOString();
  const method =
    'National Library of Norway Catalog Search API (mediatype:kart, publication years 1500–1945): item-level Public Domain gate, verbatim catalogue fields, IIIF manifest/viewer and original image-service links, published as a catalogue shard.';
  const selection = {
    source: 'National Library of Norway (Nasjonalbiblioteket)',
    endpoint: apiUrl(YEAR_WINDOWS[0], 0),
    yearWindows: YEAR_WINDOWS.map(([from, to]) => `${from}-${to}`),
    windows: windowSummary,
    documentation: 'https://api.nb.no/catalog/v1/items/api-docs',
    mediaType: 'kart',
    yearFilter: `year:[${YEAR_FROM} TO ${YEAR_TO}]`,
    sort: 'date,asc',
    pagesRead,
    considered,
    pageTotal: windowSummary.reduce((total, window) => total + window.considered, 0),
    kept: records.length,
    shard: SHARD,
    rightsBasis: 'item-level Public Domain (publicdomain, isPublicDomain=true, accessAllowedFrom=EVERYWHERE)',
    withheld: withheldCounts,
    rule:
      'Every item in the documented API query is a candidate. It is imported only when the item record states isDigital=true, isPublicDomain=true, license=publicdomain, accessAllowedFrom=EVERYWHERE, viewability=ALL, is not a legal-deposit reservation and publishes a URN or thumbnail. Titles, creators, language codes, place, publisher, issued date, extent and URN stay verbatim; no map extent, projection or alignment is inferred. Copyrighted and CC BY-NC items are withheld.',
    metadataReuse: {
      status: 'basis-recorded',
      basis:
        'Only item-level Public Domain works are redistributed. The National Library of Norway states that a work identified as Public Domain may be copied, changed, distributed, displayed and performed, including commercially, without permission. The redistributed fields are the factual description published with that object, plus its URN and record link. NB publishes no separate metadata licence; none is asserted.',
      primaryEvidence: [
        {
          url: 'https://www.nb.no/tilgang/lisens/',
          retrieved: RETRIEVED,
          quote:
            'Dette verket har blitt identifisert som «falt i det fri», det vil si at alle opphavsrettigheter til verket er falt bort, inklusive alle nærstående rettigheter. Du kan kopiere, endre, spre, vise og fremføre verket, også for kommersielle formål, uten å spørre om tillatelse.',
        },
        {
          url: 'https://www.nb.no/lisens/#public-domain',
          retrieved: RETRIEVED,
          quote: '"license": "https://www.nb.no/lisens/#public-domain" (per-item IIIF manifest).',
        },
      ],
      limits:
        'Applies only to the admitted item-level Public Domain objects. Copyrighted and CC BY-NC items are withheld. Attribution and the record/URN links stay on every record.',
    },
    verification,
    retrieved: RETRIEVED,
  };
  const provider = {
    id: 'nb',
    name: 'National Library of Norway — Kart (maps)',
    operator: 'National Library of Norway (Nasjonalbiblioteket)',
    homepage: 'https://www.nb.no/',
    home: 'https://www.nb.no/',
    institutions: ['National Library of Norway (Nasjonalbiblioteket)'],
    rights:
      'Item-level Public Domain only: isPublicDomain=true, license=publicdomain, accessAllowedFrom=EVERYWHERE and viewability=ALL. The verbatim licence and IIIF manifest stay on each record; copyrighted and CC BY-NC items are withheld.',
    attribution: 'Nasjonalbiblioteket / National Library of Norway',
    terms: 'https://www.nb.no/tilgang/lisens/',
    retrieved: RETRIEVED,
    api: {
      discovery: apiUrl(YEAR_WINDOWS[0], 0),
      documentation: 'https://api.nb.no/catalog/v1/items/api-docs',
      record: `${API}/{id}`,
      manifest: `${MANIFEST}/{id}/manifest`,
      image: 'https://www.nb.no/services/image/resolver/{urn}',
    },
    apiHosts: ['api.nb.no', 'www.nb.no'],
    method,
    collections: [{ id: 'kart', name: 'Kart / Maps (Nasjonalbiblioteket)', discovery: apiUrl(YEAR_WINDOWS[0], 0) }],
    verification,
    metadataReuse: selection.metadataReuse,
  };

  const sourcesPath = resolve(OUT, 'sources.json');
  const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  sources.providers = [...sources.providers.filter((source) => source.id !== 'nb'), provider];
  sources.generatedAt = generatedAt;
  const shardDocBytes = Buffer.byteLength(JSON.stringify({ records }));
  const coreBytes = Buffer.byteLength(JSON.stringify(await readCore(OUT), null, 2));
  console.log(`Shard ${(shardDocBytes / 1024 / 1024).toFixed(2)} MiB, core ${(coreBytes / 1024 / 1024).toFixed(2)} MiB`);
  if (coreBytes > 24 * 1024 * 1024 || shardDocBytes > 24 * 1024 * 1024) {
    throw new Error('A catalogue asset exceeds 24 MiB; split it before writing.');
  }
  if (WRITE) {
    const core = await publishProviderShard(OUT, SHARD, 'nb', records, {
      generatedAt,
      retrieved: RETRIEVED,
      providerId: 'nb',
      method,
      selection,
    });
    core.generatedAt = generatedAt;
    core.retrieved = RETRIEVED;
    core.method = `${core.method ? `${core.method} ` : ''}${method}`;
    core.selection ??= {};
    core.selection['nb:kart'] = selection;
    await writeFile(resolve(OUT, 'records.json'), `${JSON.stringify(core, null, 2)}\n`);
    await writeFile(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
    console.log('Wrote', resolve(OUT, 'records/nb.json'), 'and', sourcesPath);
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
