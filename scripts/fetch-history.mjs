#!/usr/bin/env node
/**
 * Historical world-boundary snapshots for the History (borders) map.
 *
 * Upstream: **aourednik/historical-basemaps** — "Historical boundaries of world
 * countries and cultural regions", a published GeoJSON collection of dated world
 * snapshots (8000 BCE … 1994 CE, plus 2000/2010), licensed GPL-3.0. This script
 * is the reproducible pipeline: it fetches the files at a *pinned upstream
 * revision*, simplifies each snapshot for world/continent scale, quantises the
 * coordinates and writes a compact, documented dataset next to the app:
 *
 *   public/data/history/index.json       what exists, from which revision, how much
 *   public/data/history/world_<y>.json   the snapshot itself (y<0 = BCE)
 *   public/data/history/LICENSE.txt      the upstream licence (GPL-3.0)
 *   public/data/history/ATTRIBUTION.txt  source, revision, modifications, retrieval
 *
 * Only the upstream's own documented files are used (`geojson/*.geojson` and the
 * published `index.json`); no aggregator endpoints. Requests are sequential and
 * carry a descriptive User-Agent. `--offline` rebuilds from the cache only.
 *
 * Usage:
 *   node scripts/fetch-history.mjs                      # refresh (network + cache)
 *   node scripts/fetch-history.mjs --offline            # rebuild from .cache only
 *   node scripts/fetch-history.mjs --budget 300         # KiB per snapshot (default 300)
 *   node scripts/fetch-history.mjs --precision 0.02     # coordinate quantum in degrees
 *   node scripts/fetch-history.mjs --rev master         # follow master instead of the pin
 *
 * The output schema is documented in docs/history-data.md and frozen for the
 * renderer (`public/app/history.js`, maps-3).
 */

import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const UPSTREAM = {
  repo: 'aourednik/historical-basemaps',
  html: 'https://github.com/aourednik/historical-basemaps',
  raw: 'https://raw.githubusercontent.com/aourednik/historical-basemaps',
  api: 'https://api.github.com/repos/aourednik/historical-basemaps',
  licence: 'GPL-3.0',
  title: 'Historical boundaries of world countries and cultural regions',
  credit: 'André Ourednik and contributors, historical-basemaps (GPL-3.0)',
};

/**
 * The revision this pipeline was last run against (`--rev` overrides it).
 * Pinning keeps the bundled dataset reproducible after upstream moves on; the
 * resolved commit is written into index.json either way.
 */
const PINNED_REV = 'master';

const USER_AGENT = 'maps-n-stuff-history-pipeline/0.1 (+https://github.com/igor-makarov/maps-n-stuff)';

/** Trees younger than this are civilisation-scale areas, not polities. */
const MIN_YEAR = -8000;

/** Tolerance ladder (degrees) — the first rung that fits the byte budget wins. */
const TOLERANCES = [0.05, 0.08, 0.12, 0.18, 0.25, 0.35, 0.5, 0.75];

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const value = process.argv[i + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

const REV = arg('rev', PINNED_REV);
const OFFLINE = process.argv.includes('--offline');
const PRECISION = Number(arg('precision', '0.01')); // degrees per coordinate unit
const BUDGET_BYTES = Math.round(Number(arg('budget', '300')) * 1024);
const OUT_DIR = path.resolve(ROOT, arg('out', 'public/data/history'));
const CACHE_DIR = path.resolve(ROOT, arg('cache', '.cache/history'));
const UNITS_PER_DEGREE = Math.round(1 / PRECISION);

/* ------------------------------------------------------------------ upstream */

async function fetchText(url, { accept = 'application/json' } = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    signal: AbortSignal.timeout(30_000),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}

/** Resolve the pinned branch/ref to the commit it points at, so the index can name it. */
async function resolveRevision(ref) {
  try {
    const body = await fetchText(`${UPSTREAM.api}/commits/${encodeURIComponent(ref)}`);
    const commit = JSON.parse(body);
    return { sha: commit.sha, date: commit.commit?.committer?.date ?? null };
  } catch (err) {
    if (OFFLINE) return { sha: 'unknown (offline)', date: null };
    console.warn(`! could not resolve upstream revision (${err.message}); continuing with "${ref}"`);
    return { sha: null, date: null };
  }
}

async function cachedFetch(relPath, cacheName) {
  const cached = path.join(CACHE_DIR, cacheName);
  if (existsSync(cached)) return readFile(cached, 'utf8');
  if (OFFLINE) throw new Error(`offline and not cached: ${cacheName}`);
  const body = await fetchText(`${UPSTREAM.raw}/${REV}/${relPath}`, {
    accept: relPath.endsWith('.json') ? 'application/json' : '*/*',
  });
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(cached, body);
  return body;
}

/* --------------------------------------------------------------- geometry */

/** Ramer–Douglas–Peucker on a closed ring in lon/lat degrees. Deterministic. */
export function simplifyRing(points, tolerance) {
  const n = points.length;
  if (n <= 4) return points.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const tol2 = tolerance * tolerance;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax;
    const dy = by - ay;
    const den = dx * dx + dy * dy;
    let worst = -1;
    let worstIndex = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let d;
      if (den === 0) {
        d = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        const t = ((px - ax) * dx + (py - ay) * dy) / den;
        const cx = ax + t * dx;
        const cy = ay + t * dy;
        d = (px - cx) ** 2 + (py - cy) ** 2;
      }
      if (d > worst) {
        worst = d;
        worstIndex = i;
      }
    }
    if (worst > tol2 && worstIndex > a) {
      keep[worstIndex] = 1;
      stack.push([a, worstIndex], [worstIndex, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
  return out;
}

const quant = (value) => Math.round(value / PRECISION);

/** Twice the signed area of a ring in coordinate units (shoelace, 2*area). */
export function ringArea(flat) {
  let sum = 0;
  for (let i = 0; i < flat.length; i += 2) {
    const x1 = flat[i];
    const y1 = flat[i + 1];
    const x2 = flat[(i + 2) % flat.length];
    const y2 = flat[(i + 3) % flat.length];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/**
 * Split a ring that crosses the antimeridian into rings that do not, so a
 * renderer never has to draw a polygon sweeping across the whole map (the
 * upstream files contain a world-spanning “unattributed space” ring). The seam
 * latitudes are interpolated; the pieces stay inside [-180, 180].
 */
export function splitRingAtAntimeridian(ring) {
  const parts = [];
  let current = [];
  for (const [lon, lat] of ring) {
    if (current.length === 0) {
      current.push([lon, lat]);
      continue;
    }
    const [prevLon, prevLat] = current[current.length - 1];
    const delta = lon - prevLon;
    if (Math.abs(delta) > 180) {
      // The edge travels the short way across the seam: eastward exits at +180,
      // westward exits at -180.
      const wrapped = ((delta + 540) % 360) - 180;
      // Both vertices on the seam (|delta| = 360, as the polar and world rings
      // have): cut at the current boundary at the same latitude.
      const exitLon = wrapped === 0 ? (prevLon > 0 ? 180 : -180) : wrapped > 0 ? 180 : -180;
      const entryLon = -exitLon;
      const seamLat = wrapped === 0 ? prevLat : prevLat + (lat - prevLat) * ((exitLon - prevLon) / wrapped);
      current.push([exitLon, seamLat]);
      parts.push(current);
      current = [
        [entryLon, seamLat],
        [lon, lat],
      ];
    } else {
      current.push([lon, lat]);
    }
  }
  if (current.length > 0) parts.push(current);
  // A ring that never crossed the seam must come back unchanged.
  if (parts.length === 1) return [ring];
  // Drop pieces that carry no area (a duplicated seam vertex leaves two points).
  return parts.filter((part) => part.length >= 3);
}

/**
 * Area-weighted centroid (shoelace) of a closed ring in coordinate units, or
 * null when the ring has no measurable area. A vertex average would pull labels
 * toward whichever side the source digitised more densely; the centroid of the
 * area is where a label belongs.
 */
export function ringCentroid(flat) {
  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i + 3 < flat.length; i += 2) {
    const x1 = flat[i];
    const y1 = flat[i + 1];
    const x2 = flat[i + 2];
    const y2 = flat[i + 3];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (twiceArea === 0) return null;
  return [Math.round(cx / (3 * twiceArea)), Math.round(cy / (3 * twiceArea))];
}

/** Rings of a (Multi)Polygon geometry, as flat lon/lat degree arrays. */
export function ringsOf(geometry) {
  if (!geometry) return [];
  const polys =
    geometry.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const rings = [];
  for (const poly of polys) {
    for (const ring of poly) {
      if (Array.isArray(ring) && ring.length >= 3) rings.push(ring.map(([x, y]) => [x, y]));
    }
  }
  return rings;
}

/**
 * One upstream feature → the compact bundled feature (or null when nothing but
 * degenerate rings is left). Rings that collapse below a triangle are dropped
 * and counted; the index reports how many, so the loss is visible.
 */
export function compactFeature(feature, tolerance) {
  const props = feature.properties ?? {};
  const rings = [];
  let dropped = 0;
  let spansWorld = false;
  for (const ring of ringsOf(feature.geometry)) {
    let minLon = Infinity;
    let maxLon = -Infinity;
    for (const [lon] of ring) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
    if (maxLon - minLon > 180) spansWorld = true;
    for (const part of splitRingAtAntimeridian(ring)) {
      const simple = simplifyRing(part, tolerance);
      if (simple.length < 4) {
        dropped += 1;
        continue;
      }
      // Simplification can create a seam edge of its own (a straight run along
      // the antimeridian or the pole collapses into one chord). Those chords are
      // kept: in Web Mercator the pole chord lies along the map's clip line, and
      // the affected features are the source's globe-spanning unattributed-space
      // polygons, which are flagged `bg` so a renderer can keep them out of the
      // way instead of sweeping a path across the map.
      const flat = [];
      for (const [lon, lat] of simple) {
        const x = quant(lon);
        const y = quant(lat);
        const lastX = flat[flat.length - 2];
        const lastY = flat[flat.length - 1];
        if (x === lastX && y === lastY) continue;
        flat.push(x, y);
      }
      // A closed ring needs at least three distinct vertices plus its repeat.
      if (flat.length < 8) {
        dropped += 1;
        continue;
      }
      // Keep the closure explicit: the first vertex is repeated at the end.
      if (flat[0] !== flat[flat.length - 2] || flat[1] !== flat[flat.length - 1]) {
        flat.push(flat[0], flat[1]);
      }
      rings.push(flat);
    }
  }
  if (rings.length === 0) return { feature: null, dropped, spansWorld };

  // Label anchor: the centroid of the largest ring, so a label sits on the main
  // landmass instead of in a bay. Also the area lets the renderer thin labels.
  let best = null;
  let bestArea = -1;
  let total = 0;
  for (const flat of rings) {
    const area = Math.abs(ringArea(flat)) / 2;
    total += area;
    if (area > bestArea) {
      bestArea = area;
      best = flat;
    }
  }
  const anchor = ringCentroid(best) ?? [best[0], best[1]];
  const name = String(props.NAME ?? '').trim() || 'Unnamed';
  const subject = String(props.SUBJECTO ?? '').trim() || name;
  const partOf = String(props.PARTOF ?? '').trim();
  const precision = Number(props.BORDERPRECISION);
  const out = {
    n: name,
    c: anchor,
    a: Math.round(total),
    r: rings,
  };
  if (subject && subject !== name) out.s = subject;
  if (partOf && partOf !== name) out.p = partOf;
  if (Number.isFinite(precision) && precision >= 1 && precision <= 3) out.b = Math.round(precision);
  // A nameless feature whose geometry wraps the globe is the source's way of
  // marking unattributed space: flag it so a renderer can keep it out of the
  // way instead of painting a polygon over every polity.
  if (spansWorld && name === 'Unnamed') out.bg = 1;
  return { feature: out, dropped };
}

/** Build the bundled snapshot for one upstream year file at a given tolerance. */
export function buildSnapshot(year, geojson, tolerance) {
  const features = [];
  let dropped = 0;
  let points = 0;
  let unnamed = 0;
  let background = 0;
  let wideEdges = 0;
  let bbox = [Infinity, Infinity, -Infinity, -Infinity];
  const precision = { 1: 0, 2: 0, 3: 0, unknown: 0 };
  for (const feature of geojson.features ?? []) {
    const { feature: compact, dropped: lost } = compactFeature(feature, tolerance);
    dropped += lost;
    if (!compact) continue;
    features.push(compact);
    if (compact.n === 'Unnamed') unnamed += 1;
    if (compact.bg) background += 1;
    points += compact.r.reduce((sum, ring) => sum + ring.length / 2, 0);
    for (const ring of compact.r) {
      for (let i = 0; i + 3 < ring.length; i += 2) {
        if (Math.abs(ring[i + 2] - ring[i]) > 180 * UNITS_PER_DEGREE) wideEdges += 1;
      }
    }
    precision[compact.b ?? 'unknown'] += 1;
    for (const ring of compact.r) {
      for (let i = 0; i < ring.length; i += 2) {
        const lon = ring[i] / UNITS_PER_DEGREE;
        const lat = ring[i + 1] / UNITS_PER_DEGREE;
        if (lon < bbox[0]) bbox[0] = lon;
        if (lat < bbox[1]) bbox[1] = lat;
        if (lon > bbox[2]) bbox[2] = lon;
        if (lat > bbox[3]) bbox[3] = lat;
      }
    }
  }
  features.sort((a, b) => b.a - a.a); // big areas first: the renderer paints small ones on top
  const body = JSON.stringify({ year, features });
  return {
    body,
    bytes: Buffer.byteLength(body),
    features: features.length,
    points,
    dropped,
    unnamed,
    background,
    wideEdges,
    precision,
    bbox: bbox[0] === Infinity ? null : bbox.map((v) => Number(v.toFixed(3))),
  };
}

/**
 * Pick the finest tolerance whose snapshot fits the byte budget. A snapshot that
 * still exceeds the budget at the coarsest rung is written anyway (an honest
 * "too detailed to fit" beats silently dropping features) and flagged.
 */
export function chooseTolerance(year, geojson, budgetBytes, tolerances = TOLERANCES) {
  let last = null;
  for (const tolerance of tolerances) {
    const snapshot = buildSnapshot(year, geojson, tolerance);
    if (snapshot.bytes <= budgetBytes) return { ...snapshot, tolerance, overBudget: false };
    last = { ...snapshot, tolerance, overBudget: true };
  }
  return last;
}

/* ----------------------------------------------------------------- output */

/**
 * Astronomical year → the historical label people read. There is no year zero:
 * astronomical 0 is 1 BCE, -500 is 501 BCE, 1492 is 1492 CE.
 */
export function historicalYearLabel(year) {
  if (year > 0) return `${year} CE`;
  return `${1 - year} BCE`;
}

export function fileNameFor(year) {
  return year < 0 ? `world_bc${Math.abs(year)}.json` : `world_${year}.json`;
}

async function main() {
  const started = Date.now();
  const indexRev = await resolveRevision(REV);
  const upstreamIndex = JSON.parse(await cachedFetch('index.json', 'index.json'));
  const listed = (upstreamIndex.years ?? []).filter((entry) => Number.isFinite(entry.year));
  const usable = listed.filter((entry) => entry.year >= MIN_YEAR);
  const excluded = listed
    .filter((entry) => entry.year < MIN_YEAR)
    .map((entry) => ({ year: entry.year, filename: entry.filename, reason: `before ${MIN_YEAR} (pre-Neolithic range areas, not polities)` }));

  await mkdir(OUT_DIR, { recursive: true });
  const years = [];
  let totalBytes = 0;

  for (const entry of usable) {
    const cacheName = `world_${entry.filename.replace(/^world_/, '')}`;
    let geojson;
    try {
      geojson = JSON.parse(await cachedFetch(`geojson/${entry.filename}`, cacheName));
    } catch (err) {
      console.warn(`! ${entry.filename}: ${err.message} — skipped`);
      excluded.push({ year: entry.year, filename: entry.filename, reason: `fetch failed: ${err.message}` });
      continue;
    }
    const snapshot = chooseTolerance(entry.year, geojson, BUDGET_BYTES);
    const file = fileNameFor(entry.year);
    await writeFile(path.join(OUT_DIR, file), snapshot.body);
    totalBytes += snapshot.bytes;
    years.push({
      year: entry.year, // astronomical numbering: 0 = 1 BCE, -500 = 501 BCE
      label: historicalYearLabel(entry.year),
      file,
      features: snapshot.features,
      points: snapshot.points,
      ringsDropped: snapshot.dropped,
      unnamedFeatures: snapshot.unnamed,
      backgroundFeatures: snapshot.background || undefined,
      wideEdges: snapshot.wideEdges || undefined,
      toleranceDeg: snapshot.tolerance,
      overBudget: snapshot.overBudget || undefined,
      precision: { approximate: snapshot.precision[1], moderate: snapshot.precision[2], demarcated: snapshot.precision[3], unclassified: snapshot.precision.unknown },
      bbox: snapshot.bbox,
      upstream: { filename: entry.filename, features: (geojson.features ?? []).length, names: (entry.countries ?? []).length },
    });
    process.stdout.write(`  ${String(entry.year).padStart(6)} °  ${String(Math.round(snapshot.bytes / 1024)).padStart(4)} KiB  ${String(snapshot.features).padStart(5)} features  tol ${snapshot.tolerance}°\n`);
  }

  years.sort((a, b) => a.year - b.year);

  // Licence + attribution travel with the data: GPL-3.0 requires the licence and
  // an offer of the corresponding source for a derived work.
  let licenceText = null;
  try {
    licenceText = await cachedFetch('LICENSE', 'LICENSE.txt');
    await writeFile(path.join(OUT_DIR, 'LICENSE.txt'), licenceText);
  } catch (err) {
    console.warn(`! licence text not available: ${err.message}`);
  }

  const index = {
    source: {
      title: UPSTREAM.title,
      credit: UPSTREAM.credit,
      homepage: UPSTREAM.html,
      datasetUrl: `${UPSTREAM.html}/tree/${indexRev.sha ?? REV}/geojson`,
      licence: UPSTREAM.licence,
      licenceFile: 'LICENSE.txt',
      attribution: 'Boundaries © André Ourednik and the historical-basemaps contributors (GPL-3.0)',
      retrieval: {
        retrievedAt: new Date().toISOString(),
        requestedRef: REV,
        upstreamCommit: indexRev.sha,
        upstreamCommitDate: indexRev.date,
      },
      method:
        `Ramer–Douglas–Peucker simplification of every ring (finest tolerance that keeps a snapshot under ` +
        `${Math.round(BUDGET_BYTES / 1024)} KiB), coordinates quantised to ${PRECISION}° (≈${Math.round(PRECISION * 111)} km at the equator), ` +
        'rings crossing the antimeridian split at the seam, rings that collapse dropped, features sorted by area (largest first), ' +
        'closed rings with an explicit repeated first vertex. No borders were invented or edited; anchors are the area centroid of each feature\'s largest ring. ' +
        'A few edges still span the antimeridian (source pole/unattributed-space rings; `wideEdges` per year): they are kept because in Web Mercator such a chord lies on the map\'s clip line, and the affected features are flagged `bg`.',
      upstreamNote:
        'The upstream project calls itself work in progress and asks users to verify the maps against other sources; ' +
        'it also warns that territory and fixed borders are a modern concept in many regions and periods. ' +
        'BORDERPRECISION (1 approximate … 3 demarcated) is carried through unchanged as `b`.',
    },
    schema: {
      index: 'source, years[{year, label, file, features, points, ringsDropped, toleranceDeg, precision{approximate,moderate,demarcated,unclassified}, bbox, upstream}], excluded[{year, reason}]',
      snapshot:
        '{ year, features[{ n: NAME ("Unnamed" when the source has none), s: SUBJECTO (omitted when equal to n), p: PARTOF, b: BORDERPRECISION 1..3, bg: 1 for the source\'s unattributed-space polygons, c: [anchorLon, anchorLat] (area centroid of the largest ring), a: ring area, r: [[lon,lat,…], …] (closed rings) }] }',
      units: `all coordinates are integers in ${PRECISION}° units (1 unit = ${PRECISION}°)`,
      yearNumbering: 'year is astronomical (0 = 1 BCE, -500 = 501 BCE, 1492 = 1492 CE); `label` is the same year as text',
    },
    stats: {
      years: years.length,
      earlierYear: years[0]?.year ?? null,
      latestYear: years.at(-1)?.year ?? null,
      bytes: totalBytes,
      features: years.reduce((sum, y) => sum + y.features, 0),
      points: years.reduce((sum, y) => sum + y.points, 0),
      budgetKiB: Math.round(BUDGET_BYTES / 1024),
      intervalNote:
        'The upstream publisher provides snapshots, not continuous validity ranges. The app must name the snapshot it ' +
        'actually draws for any requested date and must not interpolate between snapshots.',
    },
    years,
    excluded,
  };
  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 1) + '\n');

  await writeFile(
    path.join(OUT_DIR, 'ATTRIBUTION.txt'),
    [
      'Historical world-boundary snapshots used by the History map.',
      '',
      `Source: ${UPSTREAM.title}`,
      `Project: ${UPSTREAM.html}`,
      `Upstream revision: ${indexRev.sha ?? REV}${indexRev.date ? ` (${indexRev.date})` : ''}`,
      `Licence: ${UPSTREAM.licence} — see LICENSE.txt in this directory (GPL-3.0).`,
      '',
      'Modifications by this project (reproducible with scripts/fetch-history.mjs):',
      index.source.method,
      '',
      'The data is a derivative work of the upstream dataset and stays under GPL-3.0.',
      'Corresponding source: the upstream repository at the revision above plus the',
      'pipeline script in this repository.',
      '',
      `Retrieved: ${index.source.retrieval.retrievedAt}`,
      '',
    ].join('\n'),
  );

  const kib = Math.round(totalBytes / 1024);
  console.log(
    `\n${years.length} snapshots · ${kib} KiB total (${(kib / 1024).toFixed(1)} MiB) · ` +
      `${index.stats.features} features · ${index.stats.points} points · ${Math.round((Date.now() - started) / 1000)}s`,
  );
  console.log(`range ${years[0]?.year} … ${years.at(-1)?.year} · excluded ${index.excluded.length} upstream year(s) → ${path.relative(ROOT, OUT_DIR)}/index.json`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  main().catch((err) => {
    console.error(`history pipeline failed: ${err.stack || err}`);
    process.exitCode = 1;
  });
}
