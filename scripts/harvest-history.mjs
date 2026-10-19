#!/usr/bin/env node
/**
 * Harvest the historical-borders snapshots used by the History view.
 *
 * Primary source (no aggregator in between):
 *   aourednik/historical-basemaps — georeferenced boundaries of world countries
 *   and cultural regions, one GeoJSON snapshot per documented year.
 *
 * The upstream files are published under the GNU GPL v3 (see the repository's
 * LICENSE); we redistribute a simplified, coordinate-quantised derivative of
 * them under the same licence, together with this script, the pinned upstream
 * revision and the upstream licence text. Provenance lands in the generated
 * `index.json`, so the app can show what it is drawing and where it came from.
 *
 * Usage:
 *   node scripts/harvest-history.mjs                       # full harvest (network)
 *   node scripts/harvest-history.mjs --offline             # rebuild from cache
 *   node scripts/harvest-history.mjs --tolerance 0.08      # coarser polygons
 *
 * The script is deterministic for a pinned commit and a cached fetch: the
 * retrieval date is remembered in the cache manifest and reused, so a rebuild
 * from the cache produces byte-identical output.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const UPSTREAM = {
  owner: 'aourednik',
  repo: 'historical-basemaps',
  // Pinned revision: the harvest is reproducible and the provenance names it.
  commit: 'da7a4b735ecef70aebdc9c73e409d8a2500d50f3',
  rawBase: 'https://raw.githubusercontent.com/aourednik/historical-basemaps',
  homepage: 'https://github.com/aourednik/historical-basemaps',
  license: 'GPL-3.0-or-later',
  licenseFile: 'LICENSE',
};

function parseArgs(argv) {
  const out = { out: join(ROOT, 'public', 'data', 'history'), cache: join(ROOT, '.cache', 'historical-basemaps'), tolerance: 0.05, offline: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--offline') out.offline = true;
    else if (arg === '--tolerance') out.tolerance = Number(argv[++i]);
    else if (arg === '--out') out.out = argv[++i];
    else if (arg === '--cache') out.cache = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.tolerance) || out.tolerance < 0) throw new Error('--tolerance must be a non-negative number');
  return out;
}

/* ------------------------------------------------------------------ *
 * fetching                                                            *
 * ------------------------------------------------------------------ */

async function fetchText(url, { attempts = 4, expectBinary = false } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'kartenzeit-history-harvest/1.0 (+https://github.com/aourednik/historical-basemaps)', accept: expectBinary ? '*/*' : 'text/plain,application/json,*/*' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.text();
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 400 * attempt));
    }
  }
  throw new Error(`fetch failed for ${url}: ${lastError?.message || lastError}`);
}

/**
 * Read a pinned upstream file through the cache. The cache keeps the harvest
 * reproducible and lets `--offline` rebuild the bundle without the network.
 */
async function cachedText(cache, relative, { offline }) {
  const local = join(cache, relative.replace(/\//g, '__'));
  if (existsSync(local)) return readFile(local, 'utf8');
  if (offline) throw new Error(`offline and no cached copy of ${relative}`);
  const url = `${UPSTREAM.rawBase}/${UPSTREAM.commit}/${relative}`;
  process.stdout.write(`  fetch ${relative} … `);
  const text = await fetchText(url);
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, text);
  process.stdout.write(`${(text.length / 1024).toFixed(0)} KiB\n`);
  return text;
}

/* ------------------------------------------------------------------ *
 * geometry simplification                                             *
 * ------------------------------------------------------------------ */

/** Perpendicular distance of p to the segment a–b, in degrees (equirectangular). */
function pointSegmentDistance(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Iterative Douglas–Peucker so long rings cannot hit the call stack. */
export function simplifyRing(points, tolerance) {
  if (!Array.isArray(points) || points.length <= 3 || tolerance <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let index = -1;
    let max = tolerance;
    for (let i = first + 1; i < last; i += 1) {
      const distance = pointSegmentDistance(points[i], points[first], points[last]);
      if (distance > max) {
        max = distance;
        index = i;
      }
    }
    if (index !== -1) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Shoelace area of a ring in square degrees (absolute value, half-open ring). */
function ringArea(points) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    sum += (points[j][0] * points[i][1]) - (points[i][0] * points[j][1]);
  }
  return Math.abs(sum / 2);
}

/** Quantise to integer millidegrees and drop consecutive duplicates. */
function quantiseRing(points, scale = 1000) {
  const out = [];
  let lastX = null;
  let lastY = null;
  for (const [x, y] of points) {
    const qx = Math.round(x * scale);
    const qy = Math.round(y * scale);
    if (qx === lastX && qy === lastY) continue;
    out.push(qx, qy);
    lastX = qx;
    lastY = qy;
  }
  // A closed ring needs at least three distinct vertices; a flat array repeats
  // the first vertex at the end, so keep it when the ring survived.
  if (out.length < 8) return null;
  if (out[0] !== out[out.length - 2] || out[1] !== out[out.length - 1]) {
    out.push(out[0], out[1]);
  }
  return out;
}

const FEATURE_NAME = (props) => String(props?.NAME ?? props?.name ?? '').trim();
const FEATURE_SUBJECT = (props) => String(props?.SUBJECTO ?? props?.subjecto ?? '').trim();
const FEATURE_PART_OF = (props) => String(props?.PARTOF ?? props?.partof ?? '').trim();

function featurePrecision(props) {
  const raw = Number(props?.BORDERPRECISION ?? props?.borderprecision);
  return Number.isInteger(raw) && raw >= 1 && raw <= 3 ? raw : 0;
}

/**
 * Simplify one polygon (array of rings) and flatten it for compact storage.
 * Returns `{ parts: [flatRing, …], area, dropped }` for the surviving parts.
 */
export function simplifyPolygon(rings, { tolerance, minArea }) {
  const parts = [];
  let dropped = 0;
  const areas = rings.map((ring) => ringArea(ring));
  const largest = Math.max(...areas, 0);
  rings.forEach((ring, i) => {
    const area = areas[i];
    // Keep the largest ring of every polygon no matter how small it is (island
    // states, Vatican, …); drop the rest only below the area threshold.
    if (area < minArea && area < largest * 0.999) {
      dropped += 1;
      return;
    }
    const flat = quantiseRing(simplifyRing(ring, tolerance));
    if (!flat) {
      dropped += 1;
      return;
    }
    parts.push(flat);
  });
  return { parts, dropped, area: largest };
}

/**
 * Convert a GeoJSON geometry to the compact `parts` representation.
 * Returns null when nothing usable survives.
 */
/** Keep only well-formed rings (arrays of [x, y] pairs). */
function cleanRings(polygon) {
  if (!Array.isArray(polygon)) return [];
  return polygon
    .filter((ring) => Array.isArray(ring) && ring.length >= 3)
    .map((ring) => ring.filter((point) => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])));
}

/**
 * Convert a GeoJSON geometry to the compact `parts` representation.
 * Returns null when nothing usable survives.
 */
export function simplifyGeometry(geometry, options) {
  if (!geometry) return null;
  const { type, coordinates } = geometry;
  const rawPolygons = type === 'Polygon' ? [coordinates] : type === 'MultiPolygon' ? coordinates : [];
  const parts = [];
  let dropped = 0;
  for (const polygon of rawPolygons) {
    const result = simplifyPolygon(cleanRings(polygon), options);
    parts.push(...result.parts);
    dropped += result.dropped;
  }
  if (!parts.length) return null;
  return { parts, dropped };
}

/* ------------------------------------------------------------------ *
 * snapshot conversion                                                 *
 * ------------------------------------------------------------------ */

/** `world_bc123000.geojson` -> `-123000`, `world_1878.geojson` -> `1878`. */
export function yearFromFilename(filename) {
  const match = /world_(bc)?(\d+)\.geojson$/.exec(filename);
  if (!match) return null;
  return match[1] ? -Number(match[2]) : Number(match[2]);
}

export function convertSnapshot(featureCollection, { tolerance, minArea }) {
  const features = [];
  let droppedFeatures = 0;
  let droppedParts = 0;
  const precisionCounts = { 1: 0, 2: 0, 3: 0, unknown: 0 };
  for (const feature of featureCollection?.features ?? []) {
    const name = FEATURE_NAME(feature.properties);
    const geometry = simplifyGeometry(feature.geometry, { tolerance, minArea });
    if (!name || !geometry) {
      droppedFeatures += 1;
      continue;
    }
    const borderPrecision = featurePrecision(feature.properties);
    precisionCounts[borderPrecision === 1 || borderPrecision === 2 || borderPrecision === 3 ? borderPrecision : 'unknown'] += 1;
    droppedParts += geometry.dropped;
    features.push({
      name,
      subject: FEATURE_SUBJECT(feature.properties) || name,
      partOf: FEATURE_PART_OF(feature.properties),
      borderPrecision,
      parts: geometry.parts,
    });
  }
  features.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { features, droppedFeatures, droppedParts, precisionCounts };
}

/* ------------------------------------------------------------------ *
 * places (city/settlement points with inhabitedSince/Until)           *
 * ------------------------------------------------------------------ */

export function convertPlaces(featureCollection) {
  const places = [];
  for (const feature of featureCollection?.features ?? []) {
    const props = feature.properties ?? {};
    const name = String(props.name ?? '').trim();
    const geometry = feature.geometry;
    if (!name || geometry?.type !== 'Point' || !Array.isArray(geometry.coordinates)) continue;
    const [lon, lat] = geometry.coordinates;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const since = Number.isFinite(Number(props.inhabitedSince)) ? Number(props.inhabitedSince) : null;
    const until = Number.isFinite(Number(props.inhabitedUntil)) ? Number(props.inhabitedUntil) : null;
    places.push({ name, lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000, since, until });
  }
  places.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return places;
}

/* ------------------------------------------------------------------ *
 * main                                                                *
 * ------------------------------------------------------------------ */

async function main() {
  const args = parseArgs(process.argv);
  const outDir = args.out;
  await mkdir(outDir, { recursive: true });
  await mkdir(args.cache, { recursive: true });

  const manifestPath = join(args.cache, 'manifest.json');
  let manifest = existsSync(manifestPath) ? JSON.parse(await readFile(manifestPath, 'utf8')) : null;
  if (!manifest) {
    manifest = { retrievedAt: new Date().toISOString(), commit: UPSTREAM.commit };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (manifest.commit !== UPSTREAM.commit) {
    throw new Error(`cache holds ${manifest.commit} but this script pins ${UPSTREAM.commit}; use a fresh --cache directory`);
  }

  console.log(`historical-basemaps @ ${UPSTREAM.commit.slice(0, 10)} · tolerance ${args.tolerance}° · ${args.offline ? 'offline' : 'network'} · → ${outDir}`);

  const indexRaw = JSON.parse(await cachedText(args.cache, 'index.json', { offline: args.offline }));
  const upstreamYears = Array.isArray(indexRaw.years) ? indexRaw.years : [];
  if (!upstreamYears.length) throw new Error('upstream index.json has no years — refusing to write an empty bundle');

  const licenseText = await cachedText(args.cache, UPSTREAM.licenseFile, { offline: args.offline });
  await writeFile(join(outDir, 'LICENSE-GPL-3.0.txt'), licenseText);

  const minArea = 0.02;
  const years = [];
  /** [year, deduplicated polity names] for the cross-snapshot polity search. */
  const catalogue = [];
  let totalBytes = 0;
  for (const entry of upstreamYears) {
    const year = Number.isFinite(Number(entry.year)) ? Number(entry.year) : yearFromFilename(String(entry.filename || ''));
    const filename = String(entry.filename || `world_${year < 0 ? `bc${-year}` : year}.geojson`);
    if (year === null || !Number.isFinite(year)) {
      console.warn(`  ! skipping ${filename}: no usable year`);
      continue;
    }
    const raw = JSON.parse(await cachedText(args.cache, `geojson/${filename}`, { offline: args.offline }));
    const converted = convertSnapshot(raw, { tolerance: args.tolerance, minArea });
    const storedFile = `${filename.replace(/\.geojson$/, '')}.json`;
    const payload = {
      year,
      source: 'historical-basemaps',
      features: converted.features,
    };
    const text = JSON.stringify(payload);
    await writeFile(join(outDir, storedFile), text);
    const bytes = Buffer.byteLength(text);
    totalBytes += bytes;
    const countries = [...new Set(converted.features.map((feature) => feature.name))];
    catalogue.push([year, countries]);
    years.push({
      year,
      file: storedFile,
      upstream: `geojson/${filename}`,
      features: converted.features.length,
      countries: countries.length,
      droppedFeatures: converted.droppedFeatures,
      droppedParts: converted.droppedParts,
      precision: converted.precisionCounts,
      bytes,
    });
    process.stdout.write(`  ${String(year).padStart(7)} · ${String(converted.features.length).padStart(4)} features · ${(text.length / 1024).toFixed(0)} KiB\n`);
  }

  // Places: settlements with a documented inhabitedSince/Until window.
  let placesBytes = 0;
  try {
    const rawPlaces = JSON.parse(await cachedText(args.cache, 'geojson/places.geojson', { offline: args.offline }));
    const places = convertPlaces(rawPlaces);
    const text = JSON.stringify({ source: 'historical-basemaps', file: 'geojson/places.geojson', places });
    await writeFile(join(outDir, 'places.json'), text);
    placesBytes = text.length;
    console.log(`  places · ${places.length} points · ${(text.length / 1024).toFixed(0)} KiB`);
  } catch (err) {
    console.warn(`  ! places.json skipped: ${err.message}`);
  }

  const index = {
    dataset: 'historical-basemaps',
    title: 'Historical boundaries of world countries and cultural regions',
    homepage: UPSTREAM.homepage,
    repository: `${UPSTREAM.homepage}/tree/${UPSTREAM.commit}`,
    commit: UPSTREAM.commit,
    commitShort: UPSTREAM.commit.slice(0, 10),
    license: UPSTREAM.license,
    licenseFile: 'LICENSE-GPL-3.0.txt',
    credit: 'Historical Basemaps © André Ourednik and contributors (GPL-3.0-or-later)',
    retrievedAt: manifest.retrievedAt,
    generatedBy: 'scripts/harvest-history.mjs',
    simplification: {
      method: 'Douglas–Peucker per ring; rings below the area threshold are dropped except each polygon’s largest ring',
      toleranceDeg: args.tolerance,
      minRingAreaDeg2: minArea,
      coordinateUnit: 'millidegrees (0.001°), integer, rings are flat [x0,y0,x1,y1,…] and closed',
      caveat: 'World/continent scale only. The upstream data is explicitly work in progress; borders before 1648 are conceptual and approximate.',
    },
    fields: {
      features: '{name, subject, partOf, borderPrecision (1 approximate, 2 moderate, 3 international law, 0 unknown), parts: [flatRing, …]}',
      catalogue: '[[year, [names…]], …] — the names present in each snapshot, for the cross-snapshot polity search',
    },
    coverage: {
      firstYear: years.length ? years[0].year : null,
      lastYear: years.length ? years[years.length - 1].year : null,
      snapshots: years.length,
      snapshotYears: years.map((entry) => entry.year),
      note: 'One discrete snapshot per published year — not continuous validity ranges. Dates between snapshots resolve to the nearest snapshot and the UI must name the represented snapshot.',
    },
    caveats: [
      'Coverage is global in intent but thin for some regions and periods; the per-snapshot feature list is the honest coverage statement.',
      'The upstream repository asks that the maps be verified against other sources before academic use.',
      'Where the dataset marks a border as approximate (borderPrecision 1) or leaves it unknown (0), the map draws it differently and the details panel says so.',
    ],
    years,
    catalogue: { file: 'catalogue.json', years: catalogue.length },
    places: placesBytes ? { file: 'places.json', bytes: placesBytes } : null,
    totalBytes,
  };
  await writeFile(join(outDir, 'catalogue.json'), JSON.stringify({ source: 'historical-basemaps', years: catalogue }));
  await writeFile(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  console.log(`\nindex.json · ${years.length} snapshots · ${(totalBytes / 1048576).toFixed(1)} MiB of snapshot data${placesBytes ? ` + ${(placesBytes / 1024).toFixed(0)} KiB places` : ''}`);
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  });
}
