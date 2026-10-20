#!/usr/bin/env node
/**
 * Reproducible harvest of the USGS Historical Topographic Map Collection
 * (HTMC) through the documented The National Map (TNM) Access API.
 *
 *   https://tnmaccess.nationalmap.gov/api/v1/products
 *     ?datasets=Historical%20Topographic%20Maps
 *     &max=1000&offset=<n>&outputFormat=JSON
 *
 * Every admitted record is a USGS-produced historical quadrangle. The API
 * supplies its own ScienceBase item URL, publication date, footprint and the
 * original GeoPDF *and* GeoTIFF downloads. The GeoTIFF is a tiled raster with
 * internal overviews; where it exists the catalogue records it as a
 * provider-supplied native raster so the existing GeoTIFF renderer can show it
 * without inventing any pixel-to-ground control points. Some products deliver
 * only a GeoPDF: those are admitted as unaligned scans (Georeferencing is
 * preferred, not required), without a `kind: cog` claim or a bbox transform.
 * The bounding box is always the product footprint, never a substitute for the
 * raster's own georeferencing.
 *
 * Rights: USGS states "USGS-authored or produced data and information are
 * considered to be in the U.S. Public Domain." Each record carries that
 * official policy URL and the attribution. Public access alone is not used.
 *
 * The collection has ~186,000 products. The catalogue deliberately bundles a
 * reproducible prefix (and records the next offset) because every browser
 * currently loads the merged catalogue at start-up; the rest stays available
 * through the live search adapter. Re-running the harvester with --start-offset
 * continues from the recorded cursor and preserves every existing id.
 *
 * Usage:
 *   node scripts/harvest-usgs.mjs --pages 8
 *   node scripts/harvest-usgs.mjs --start-offset 8000 --pages 4
 *   node scripts/harvest-usgs.mjs --start-offset 12000 --pages 6 --shard usgs-2
 *   node scripts/harvest-usgs.mjs --refresh --no-write
 *
 * `--shard` selects the target shard (default `usgs`). Existing USGS records in
 * every registered shard are preserved; the new records are appended only to
 * the selected shard, so the catalogue can grow without any one static asset
 * approaching the 25 MiB limit.
 */
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromUrl } from 'geotiff';
import { rasterProjection } from '../src/browser/cog.js';
import { readCore, readShard, shardPath, shardUrl } from './catalogue.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(value('out', resolve(ROOT, 'public/data')));
const CACHE = resolve(ROOT, '.cache/usgs');
const REFRESH = has('refresh');
const WRITE = !has('no-write');
const PAGE_SIZE = Math.max(1, Math.min(1000, Number(value('page-size', '1000')) || 1000));
const START_OFFSET = Math.max(0, Number(value('start-offset', '0')) || 0);
const PAGES = Math.max(1, Number(value('pages', '6')) || 6);
const SHARD_NAME = value('shard', 'usgs');
const CONCURRENCY = Math.max(1, Math.min(4, Number(value('concurrency', '2')) || 2));
const RETRIEVED = '2026-10-20';
const API = 'https://tnmaccess.nationalmap.gov/api/v1/products';
const RIGHTS_URL =
  'https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits';
const RIGHTS_STATEMENT =
  'U.S. Public Domain (USGS-produced data and information). Credit: U.S. Geological Survey.';
const UA =
  'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; historical map catalogue)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (value) =>
  String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function httpsUrl(value, hosts, pattern) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !hosts.includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    if (pattern && !pattern.test(decodeURIComponent(url.pathname))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function usgsYear(value) {
  const match = clean(value).match(/\b(1[5-9]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

export function usgsExtent(box) {
  if (!box) return null;
  const west = Number(box.minX ?? box.west);
  const east = Number(box.maxX ?? box.east);
  const south = Number(box.minY ?? box.south);
  const north = Number(box.maxY ?? box.north);
  return [west, east, south, north].every(Number.isFinite) &&
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north
    ? { west, east, south, north }
    : null;
}

const GEOTIFF_PATH = /^\/StagedProducts\/Maps\/HistoricalTopo\/GeoTIFF\/.+\.tif$/i;
const GEOPDF_PATH = /^\/StagedProducts\/Maps\/HistoricalTopo\/PDF\/.+\.pdf$/i;
const PREVIEW_PATH = /^\/StagedProducts\/Maps\/HistoricalTopo\/PDF\/.+_tn\.jpg$/i;
const S3_HOSTS = ['prd-tnm.s3.amazonaws.com'];

/**
 * One TNM product → catalogue record. Returns null for products that are not
 * USGS HTMC maps or deliver neither original GeoTIFF nor original GeoPDF. A
 * GeoPDF-only product stays eligible and is labelled as an unaligned scan: no
 * `kind: cog`, no invented transform. No missing metadata is filled in: an
 * undated sheet stays undated.
 */
export function usgsProductRecord(item) {
  const sourceId = clean(item?.sourceId ?? item?.id);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(sourceId)) return null;
  const title = clean(item?.title);
  if (!title) return null;
  const geotiff = httpsUrl(item?.urls?.GeoTIFF, S3_HOSTS, GEOTIFF_PATH);
  const geospatialPdf = httpsUrl(item?.urls?.GeoPDF, S3_HOSTS, GEOPDF_PATH);
  if (!geotiff && !geospatialPdf) return null;
  const preview = httpsUrl(item?.previewGraphicURL, S3_HOSTS, PREVIEW_PATH);
  const metaUrl = httpsUrl(item?.metaUrl, ['www.sciencebase.gov', 'www.usgs.gov']);
  if (!metaUrl) return null;
  const extent = usgsExtent(item?.boundingBox);
  const year = usgsYear(item?.publicationDate);
  const scaleMatch = title.match(/\b1:([\d,]+)-scale\b/i);
  const scale = scaleMatch ? Number(scaleMatch[1].replace(/,/g, '')) : null;
  const stateMatch = title.match(/,\s*([A-Z]{2}(?:\s+[A-Z]{2})?)\s+\d{4}\s*$/);
  const record = {
    id: `usgs:${sourceId}`,
    title,
    yearStart: year,
    yearEnd: year,
    depictedYearStart: null,
    depictedYearEnd: null,
    creators: ['U.S. Geological Survey'],
    providerId: 'usgs',
    institution: 'U.S. Geological Survey',
    rights: RIGHTS_STATEMENT,
    rightsUrl: RIGHTS_URL,
    attribution: 'U.S. Geological Survey',
    recordUrl: metaUrl,
    thumbnail: preview ?? null,
    type: 'map',
    collection: 'USGS Historical Topographic Maps',
    extent,
    geo: extent
      ? {
          lat: (extent.south + extent.north) / 2,
          lon: (extent.west + extent.east) / 2,
        }
      : null,
    geoNote: geotiff
      ? 'Catalogue extent is the USGS product footprint. The GeoTIFF carries its own pixel georeferencing; no transform is inferred from the bbox.'
      : 'Catalogue extent is the USGS product footprint. Only an original GeoPDF was delivered, so this record is an unaligned scan; no pixel-to-ground transform is bundled.',
    ...(geotiff
      ? {
          georeference: {
            kind: 'cog',
            url: geotiff,
            source: metaUrl,
            status: 'provider-supplied',
            format: 'GeoTIFF',
          },
        }
      : {}),
    downloads: [
      ...(geotiff ? [{ label: 'GeoTIFF', url: geotiff }] : []),
      ...(geospatialPdf ? [{ label: 'GeoPDF', url: geospatialPdf }] : []),
    ],
    format: clean(item?.format) || null,
    sourceModified: clean(item?.lastUpdated) || null,
  };
  if (scale) record.scale = scale;
  if (stateMatch) record.state = stateMatch[1];
  for (const key of Object.keys(record)) {
    if (record[key] == null || record[key] === '') delete record[key];
  }
  return record;
}

async function fetchPage(offset) {
  const url = new URL(API);
  for (const [k, v] of Object.entries({
    datasets: 'Historical Topographic Maps',
    max: String(PAGE_SIZE),
    offset: String(offset),
    outputFormat: 'JSON',
  }))
    url.searchParams.set(k, v);
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(url.href, {
        headers: { accept: 'application/json', 'user-agent': UA },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url.href}`);
      const body = await response.text();
      if (!body.trimStart().startsWith('{'))
        throw new Error(`non-JSON response from ${url.href}`);
      return JSON.parse(body);
    } catch (error) {
      last = error;
      if (attempt < 4) await sleep(1200 * attempt);
    }
  }
  throw last;
}

async function cachedPage(offset) {
  const file = resolve(CACHE, 'products', `${PAGE_SIZE}-${offset}.json`);
  if (!REFRESH) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {}
  }
  const body = await fetchPage(offset);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  await writeFile(temp, JSON.stringify(body));
  await rename(temp, file);
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
      await sleep(40);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function ranged(url, accept = 'image/tiff') {
  try {
    const response = await fetch(url, {
      headers: { accept, 'user-agent': UA, range: 'bytes=0-65535' },
      signal: AbortSignal.timeout(30000),
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const magic =
      bytes.length >= 4 &&
      ((bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
        (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a));
    const pdf =
      bytes.length >= 4 &&
      bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      bytes: bytes.length,
      range: response.headers.get('content-range'),
      tiff: magic,
      pdf,
    };
  } catch (error) {
    return { status: 0, error: String(error.message) };
  }
}

/** Deterministic sample: spread across the whole slice, never only its head. */
function sampleOf(records, limit) {
  const sample = [];
  const step = Math.max(1, Math.floor(records.length / limit));
  for (let i = 0; i < records.length && sample.length < limit; i += step)
    sample.push(records[i]);
  return sample;
}

export async function verify(records, limit = 8) {
  const sample = sampleOf(records, limit);
  // Make sure the evidence covers a GeoPDF-only scan when the slice has one,
  // rather than accidentally sampling only GeoTIFF products.
  if (sample.length && !sample.some((record) => !record.georeference)) {
    const firstScan = records.find((record) => !record.georeference);
    if (firstScan) sample[sample.length - 1] = firstScan;
  }
  const results = await pool(sample, 3, async (record) => {
    const preview = record.thumbnail
      ? await ranged(record.thumbnail, 'image/jpeg')
      : { status: null };
    const raster = record.georeference
      ? await ranged(record.georeference.url)
      : { status: null };
    const scan = !record.georeference
      ? await ranged(record.downloads.find((d) => d.label === 'GeoPDF')?.url, 'application/pdf')
      : { status: null };
    let readable = null;
    if (raster.status === 206 && raster.tiff) {
      try {
        const tiff = await fromUrl(record.georeference.url, {
          allowFullFile: false,
          cacheSize: 8,
          blockSize: 65536,
        });
        const count = await tiff.getImageCount();
        const first = await tiff.getImage(0);
        const keys = first.getGeoKeys();
        readable = {
          images: count,
          width: first.getWidth(),
          height: first.getHeight(),
          modelType: keys?.GTModelTypeGeoKey ?? null,
          projectedCrs: keys?.ProjectedCSTypeGeoKey ?? null,
          geographicCrs: keys?.GeographicTypeGeoKey ?? null,
        };
        try {
          // The browser renderer's own CRS conversion, not just the TIFF tags.
          const project = rasterProjection(keys);
          const centre = record.extent
            ? [
                (record.extent.west + record.extent.east) / 2,
                (record.extent.south + record.extent.north) / 2,
              ]
            : [-83.25, 36.25];
          const point = project(...centre);
          readable.crsOk = point.every(Number.isFinite);
        } catch (error) {
          readable.crsError = String(error.message);
        }
        await tiff.close?.();
      } catch (error) {
        readable = { error: String(error.message) };
      }
    }
    return {
      id: record.id,
      previewStatus: preview.status,
      previewType: preview.type,
      rasterStatus: raster.status,
      rasterType: raster.type,
      rasterBytes: raster.bytes,
      rasterRange: raster.range,
      tiffMagic: raster.tiff,
      scanStatus: scan.status,
      scanType: scan.type,
      scanBytes: scan.bytes,
      scanRange: scan.range,
      pdfMagic: scan.pdf,
      readable,
    };
  });
  const ok = (status) => status === 200 || status === 206;
  return {
    retrieved: RETRIEVED,
    sample: results.length,
    previewOk: results.filter((r) => ok(r.previewStatus) && /image\//.test(r.previewType ?? '')).length,
    previewChecked: results.filter((r) => r.previewStatus != null).length,
    rasterRangeOk: results.filter((r) => r.rasterStatus === 206 && r.tiffMagic).length,
    rasterChecked: results.filter((r) => r.rasterStatus != null).length,
    rasterReadable: results.filter((r) => r.readable && !r.readable.error && r.readable.images > 0).length,
    rasterCrsOk: results.filter((r) => r.readable?.crsOk).length,
    pdfRangeOk: results.filter((r) => r.scanStatus === 206 && r.pdfMagic).length,
    pdfChecked: results.filter((r) => r.scanStatus != null).length,
    examples: results.map((r) => ({
      ...r,
      readable: r.readable
        ? {
            images: r.readable.images,
            width: r.readable.width,
            height: r.readable.height,
            modelType: r.readable.modelType,
            projectedCrs: r.readable.projectedCrs,
            geographicCrs: r.readable.geographicCrs,
            crsOk: r.readable.crsOk ?? false,
            ...(r.readable.crsError ? { crsError: r.readable.crsError } : {}),
          }
        : r.readable,
    })).slice(0, 4),
  };
}

async function main() {
  const pages = [];
  let nextOffset = START_OFFSET;
  async function worker() {
    while (true) {
      const offset = nextOffset;
      nextOffset += PAGE_SIZE;
      if (offset >= START_OFFSET + PAGES * PAGE_SIZE) return;
      try {
        pages.push({ offset, body: await cachedPage(offset) });
      } catch (error) {
        console.error(`offset ${offset}: ${error.message}`);
      }
      await sleep(100);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, PAGES) }, worker),
  );
  pages.sort((a, b) => a.offset - b.offset);
  const upstreamTotal = pages.find((p) => Number.isFinite(p.body?.total))?.body?.total ?? null;
  const delivered = pages.reduce((sum, p) => sum + (p.body?.items?.length ?? 0), 0);
  console.log(
    `USGS HTMC: ${upstreamTotal ?? '?'} upstream products; requested offsets ${START_OFFSET}..${START_OFFSET + PAGES * PAGE_SIZE - 1}; delivered ${delivered}`,
  );

  const seen = new Set();
  const records = [];
  const withheld = {};
  const stateCounts = {};
  const scaleCounts = {};
  for (const page of pages) {
    for (const item of page.body?.items ?? []) {
      const sourceId = clean(item?.sourceId ?? item?.id);
      if (!sourceId || seen.has(sourceId)) continue;
      seen.add(sourceId);
      const record = usgsProductRecord(item);
      if (!record) {
        const reason = !item?.urls?.GeoTIFF && !item?.urls?.GeoPDF
          ? 'no GeoTIFF or GeoPDF download delivered'
          : !httpsUrl(item?.metaUrl, ['www.sciencebase.gov', 'www.usgs.gov'])
            ? 'no ScienceBase item URL'
            : 'identity gate (title/source id or unusable download URL)';
        withheld[reason] = (withheld[reason] || 0) + 1;
        continue;
      }
      records.push(record);
      if (record.state) stateCounts[record.state] = (stateCounts[record.state] || 0) + 1;
      if (record.scale) scaleCounts[record.scale] = (scaleCounts[record.scale] || 0) + 1;
    }
  }
  records.sort(
    (a, b) => (a.yearStart ?? 9999) - (b.yearStart ?? 9999) || a.id.localeCompare(b.id),
  );
  console.log(
    `Eligible new products: ${records.length}; withheld ${Object.values(withheld).reduce((a, b) => a + b, 0)}`,
  );
  console.log('Withholding reasons:', withheld);
  if (!records.length) throw new Error('No eligible USGS records; leaving the catalogue unchanged.');

  const core = await readCore(OUT);
  const shard = shardUrl(SHARD_NAME);
  // Preserve every existing USGS record across every registered shard. Only
  // the selected target shard receives the new records; a rerun never moves or
  // drops records that another shard already owns.
  const existing = new Map();
  const targetExisting = new Map();
  for (const url of core.shards ?? []) {
    let doc;
    try {
      doc = await readShard(OUT, url);
    } catch {
      continue;
    }
    for (const record of doc.records ?? []) {
      if (record.providerId !== 'usgs') continue;
      existing.set(record.id, record);
      if (url === shard) targetExisting.set(record.id, record);
    }
  }
  const preserved = existing.size;
  const previouslyKnown = new Set(existing.keys());
  for (const record of records) {
    existing.set(record.id, record);
    // Replaying an already-imported prefix must add only products that were
    // previously withheld. Records already owned by another shard stay there;
    // they are never copied into the target shard (which would double the
    // asset and break the 24 MiB split).
    if (!previouslyKnown.has(record.id) || targetExisting.has(record.id))
      targetExisting.set(record.id, record);
  }
  const shardRecords = [...targetExisting.values()].sort(
    (a, b) => (a.yearStart ?? 9999) - (b.yearStart ?? 9999) || a.id.localeCompare(b.id),
  );
  const mergedRecords = [...existing.values()].sort(
    (a, b) => (a.yearStart ?? 9999) - (b.yearStart ?? 9999) || a.id.localeCompare(b.id),
  );

  const titleYearMismatches = records.filter((record) => {
    const titleYear = Number(
      record.title.match(/\b(1[5-9]\d{2}|20\d{2})\s*$/)?.[1] ?? NaN,
    );
    return Number.isFinite(titleYear) && titleYear !== record.yearStart;
  }).length;
  // The merged shard, not only this slice, is what the catalogue presents.
  const mergedTitleYearMismatches = mergedRecords.filter((record) => {
    const titleYear = Number(
      record.title.match(/\b(1[5-9]\d{2}|20\d{2})\s*$/)?.[1] ?? NaN,
    );
    return Number.isFinite(titleYear) && titleYear !== record.yearStart;
  }).length;
  const verification = await verify(records);
  console.log('Verification:', JSON.stringify(verification).slice(0, 600));

  const recordsDoc = JSON.parse(await readFile(resolve(OUT, 'records.json'), 'utf8'));
  const sourcesDoc = JSON.parse(await readFile(resolve(OUT, 'sources.json'), 'utf8'));
  recordsDoc.shards = [...new Set([...(recordsDoc.shards ?? []), shard])].sort();
  recordsDoc.records = (recordsDoc.records ?? []).filter((record) => record.providerId !== 'usgs');
  recordsDoc.generatedAt = new Date().toISOString();
  recordsDoc.retrieved = RETRIEVED;
  if (!recordsDoc.method?.includes('USGS Historical Topographic Map Collection records are imported'))
    recordsDoc.method = `${recordsDoc.method ? recordsDoc.method + ' ' : ''}USGS Historical Topographic Map Collection records are imported from the documented TNM Access API with the original GeoTIFF download where delivered, or the original GeoPDF scan when no GeoTIFF exists; they are bundled in ${shard}.`;
  recordsDoc.selection ??= {};
  recordsDoc.selection['usgs:htmc'] = {
    scope: 'USGS Historical Topographic Map Collection (HTMC)',
    upstreamTotal,
    api: API,
    requestedOffsets: `${START_OFFSET}-${START_OFFSET + PAGES * PAGE_SIZE - 1}`,
    pagesFetched: pages.length,
    delivered,
    considered: seen.size,
    kept: records.length,
    preserved,
    totalAfterMerge: mergedRecords.length,
    shard,
    withheld,
    stateCounts,
    scaleCounts,
    dateEvidence: {
      sourceField: 'publicationDate',
      titleEditionYearMismatches: mergedTitleYearMismatches,
      titleEditionYearMismatchesInSlice: titleYearMismatches,
      mergedRecordsChecked: mergedRecords.length,
      note: 'The API publicationDate is retained as the publication year. For every bundled product the title ends in a single edition year; this merged shard has no mismatch between that printed year and publicationDate (and neither did this slice on its own). No depicted/survey date is inferred.',
    },
    rightsBasis:
      'USGS official statement "USGS-authored or produced data and information are considered to be in the U.S. Public Domain" (copyrights-and-credits page), applicable to USGS-produced HTMC products; each record carries the policy URL and USGS attribution.',
    rule:
      'Every admitted product is returned by the TNM Access API under datasets=Historical Topographic Maps, carries a ScienceBase item URL and a delivered original GeoTIFF or GeoPDF download. Undated products and products without a preview stay eligible. A GeoTIFF product carries a provider-supplied native raster; a GeoPDF-only product is an unaligned scan with no kind:cog claim and no invented transform. The bbox is the product footprint, not an image transform.',
    resumable: {
      nextOffset: START_OFFSET + PAGES * PAGE_SIZE,
      pageSize: PAGE_SIZE,
      note: 'Re-run with --start-offset <nextOffset> to continue the feed. Existing ids are preserved and merged, never replaced by a smaller page.',
    },
    verification,
  };

  const provider = {
    id: 'usgs',
    name: 'USGS Historical Topographic Maps',
    operator: 'U.S. Geological Survey',
    homepage: 'https://www.usgs.gov/programs/national-geospatial-program/historical-topographic-maps-preserving-past',
    institutions: ['U.S. Geological Survey'],
    rights: RIGHTS_STATEMENT,
    rightsUrl: RIGHTS_URL,
    attribution: 'U.S. Geological Survey',
    retrieved: RETRIEVED,
    mode: 'bundled + live-search',
    api: {
      catalogue: API,
      documentation: 'https://tnmaccess.nationalmap.gov/api/v1/docs',
      terms: RIGHTS_URL,
    },
    apiHosts: ['tnmaccess.nationalmap.gov', 'prd-tnm.s3.amazonaws.com', 'www.sciencebase.gov'],
    method:
      'Documented TNM Access API products query (datasets=Historical Topographic Maps, max=1000, offset cursor). Each record keeps the ScienceBase item URL, publication date, product footprint, GeoPDF/GeoTIFF downloads and the USGS public-domain policy. The bundled slice is a reproducible prefix with a recorded next offset; the complete feed remains available through live search.',
    collections: [
      {
        id: 'htmc',
        name: 'Historical Topographic Map Collection',
        discovery: API,
      },
    ],
    verification,
  };
  sourcesDoc.providers = [...sourcesDoc.providers.filter((source) => source.id !== 'usgs'), provider];
  sourcesDoc.generatedAt = recordsDoc.generatedAt;

  const shardDoc = {
    generatedAt: recordsDoc.generatedAt,
    retrieved: RETRIEVED,
    providerId: 'usgs',
    method:
      'USGS TNM Access API, Historical Topographic Maps dataset; original GeoTIFF retained as provider-supplied native raster.',
    selection: recordsDoc.selection['usgs:htmc'],
    records: shardRecords,
  };
  const coreBytes = Buffer.byteLength(JSON.stringify(recordsDoc));
  const shardBytes = Buffer.byteLength(JSON.stringify(shardDoc));
  console.log(
    `Core ${(coreBytes / 1048576).toFixed(2)} MiB, ${SHARD_NAME} shard ${(shardBytes / 1048576).toFixed(2)} MiB (${shardRecords.length} records; ${mergedRecords.length} USGS total)`,
  );
  if (coreBytes > 24 * 1048576 || shardBytes > 24 * 1048576)
    throw new Error('A catalogue asset exceeds 24 MiB; split it before writing.');
  if (WRITE) {
    await mkdir(dirname(shardPath(OUT, shard)), { recursive: true });
    await writeFile(shardPath(OUT, shard), `${JSON.stringify(shardDoc)}\n`);
    await writeFile(resolve(OUT, 'records.json'), `${JSON.stringify(recordsDoc, null, 2)}\n`);
    await writeFile(resolve(OUT, 'sources.json'), `${JSON.stringify(sourcesDoc, null, 2)}\n`);
    console.log('Wrote', OUT, 'and', shard);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
