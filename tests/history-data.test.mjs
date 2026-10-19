/**
 * History dataset tests (coordination README D14 — maps-2's data half of the
 * History/Borders feature).
 *
 * Two layers:
 *   1. the pure semantics in `public/app/history-data.js` — year numbering,
 *      nearest-snapshot reporting, gaps, clamping;
 *   2. the bundled dataset itself — every snapshot the index promises must exist,
 *      parse, stay inside plausible coordinates, and carry the attribution and
 *      licence files a GPL-3.0 derived dataset must ship.
 *
 * The pipeline's own pure functions are covered too, so a refresh cannot quietly
 * change what “simplify” means.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HISTORY_INDEX_URL,
  availableRange,
  borderPrecisionLabel,
  clampHistoricalYear,
  featureName,
  formatHistoricalYear,
  formatHistoricalYearShort,
  historyAttribution,
  historySnapshotUrl,
  parseHistoricalYear,
  precisionSummary,
  snapshotForYear,
  snapshotGaps,
} from '../public/app/history-data.js';
import {
  buildSnapshot,
  chooseTolerance,
  historicalYearLabel,
  ringCentroid,
  simplifyRing,
  splitRingAtAntimeridian,
} from '../scripts/fetch-history.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const historyDir = path.join(root, 'public/data/history');
const readJson = async (rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));

const index = await readJson('public/data/history/index.json');

/* --------------------------------------------------------------- numbering */

test('formatHistoricalYear: astronomical years read as historical years', () => {
  assert.equal(formatHistoricalYear(1492), '1492 CE');
  assert.equal(formatHistoricalYear(2010), '2010 CE');
  assert.equal(formatHistoricalYear(0), '1 BCE');
  assert.equal(formatHistoricalYear(-1), '2 BCE');
  assert.equal(formatHistoricalYear(-500), '501 BCE');
  assert.equal(formatHistoricalYear(-8000), '8001 BCE');
  assert.equal(formatHistoricalYear('1492'), '1492 CE');
  assert.equal(formatHistoricalYear('junk'), '');
  assert.equal(formatHistoricalYearShort(-500), '501 BCE');
  assert.equal(formatHistoricalYearShort(1492), '1492');
  assert.equal(historicalYearLabel(-500), '501 BCE', 'the index label uses the same rule as the client');
});

test('parseHistoricalYear: signed years and BCE/CE text, nothing invented', () => {
  assert.equal(parseHistoricalYear('1492'), 1492);
  assert.equal(parseHistoricalYear('-500'), -500);
  assert.equal(parseHistoricalYear('500 BCE'), -500);
  assert.equal(parseHistoricalYear('500 bce'), -500);
  assert.equal(parseHistoricalYear('500BC'), -500);
  assert.equal(parseHistoricalYear('1492 CE'), 1492);
  assert.equal(parseHistoricalYear('  1492   ce '), 1492);
  assert.equal(parseHistoricalYear('0'), 0);
  assert.equal(parseHistoricalYear(1492), 1492);
  assert.equal(parseHistoricalYear(''), null);
  assert.equal(parseHistoricalYear('   '), null);
  assert.equal(parseHistoricalYear('last year'), null);
  assert.equal(parseHistoricalYear(undefined), null);
  assert.equal(parseHistoricalYear('12.5'), null);
});

/* ------------------------------------------------------------- snapshots */

const tinyIndex = { years: [{ year: 100, label: '100 CE' }, { year: 300, label: '300 CE' }, { year: 800, label: '800 CE' }] };

test('snapshotForYear: an exact year is drawn as itself and says so', () => {
  const hit = snapshotForYear(tinyIndex, 300);
  assert.equal(hit.exact, true);
  assert.equal(hit.snapshot.year, 300);
  assert.equal(hit.distance, 0);
  assert.equal(hit.outsideRange, false);
  assert.match(hit.message, /Showing the 300 CE snapshot/);
});

test('snapshotForYear: a missing year names the nearest snapshot and its distance', () => {
  const earlier = snapshotForYear(tinyIndex, 250);
  assert.equal(earlier.exact, false);
  assert.equal(earlier.snapshot.year, 300);
  assert.equal(earlier.direction, 'later');
  assert.equal(earlier.distance, 50);
  assert.match(earlier.message, /no snapshot for 250 CE/i);
  assert.match(earlier.message, /300 CE, 50 years later/);

  const later = snapshotForYear(tinyIndex, 350);
  assert.equal(later.snapshot.year, 300);
  assert.equal(later.direction, 'earlier');
  assert.match(later.message, /50 years earlier/);

  const tie = snapshotForYear(tinyIndex, 200);
  assert.equal(tie.snapshot.year, 300, 'a tie is decided toward the later snapshot, deterministically');
  assert.equal(tie.distance, 100);
});

test('snapshotForYear: outside the dataset range it says the range, never a modern substitute', () => {
  const before = snapshotForYear(tinyIndex, -4000);
  assert.equal(before.outsideRange, true);
  assert.equal(before.snapshot.year, 100);
  assert.match(before.message, /There is no snapshot for 4001 BCE/);
  assert.match(before.message, /nearest snapshot, 100 CE, 4100 years later/);
  assert.match(before.message, /The dataset covers 100 CE – 800 CE/);

  const after = snapshotForYear(tinyIndex, 2024);
  assert.equal(after.outsideRange, true);
  assert.equal(after.snapshot.year, 800);
});

test('snapshotForYear: empty input degrades to an honest message, not a guess', () => {
  assert.equal(snapshotForYear({ years: [] }, 1500).snapshot, null);
  assert.match(snapshotForYear({ years: [] }, 1500).message, /no historical snapshots/i);
  assert.equal(snapshotForYear(tinyIndex, 'junk').snapshot, null);
});

test('availableRange / clampHistoricalYear / snapshotGaps describe the real series', () => {
  const range = availableRange(tinyIndex);
  assert.equal(range.first, 100);
  assert.equal(range.last, 800);
  assert.equal(range.count, 3);
  assert.equal(range.label, '100 CE – 800 CE');
  assert.equal(clampHistoricalYear(tinyIndex, 5000), 800);
  assert.equal(clampHistoricalYear(tinyIndex, -5000), 100);
  assert.equal(clampHistoricalYear(tinyIndex, 300), 300);
  assert.equal(clampHistoricalYear(tinyIndex, 'junk'), 100);

  const gaps = snapshotGaps(tinyIndex, 30);
  assert.deepEqual(
    gaps.map((g) => [g.from, g.to, g.span]),
    [
      [100, 300, 200],
      [300, 800, 500],
    ],
  );
  assert.match(gaps[0].label, /100 CE → 300 CE \(200 years without a snapshot\)/);
});

test('source-level descriptions: precision, unnamed areas, attribution, URLs', () => {
  assert.equal(borderPrecisionLabel(1), 'approximate (blurred zone)');
  assert.equal(borderPrecisionLabel(3), 'demarcated by international law');
  assert.equal(borderPrecisionLabel(undefined), 'precision not stated by the source');
  assert.equal(featureName({ n: 'Spain' }), 'Spain');
  assert.equal(featureName({ n: '  ' }), 'Unnamed area in the source data');
  assert.equal(featureName({ n: 'Unnamed' }), 'Unnamed area in the source data');
  assert.equal(historySnapshotUrl('world_1492.json'), '/data/history/world_1492.json');
  assert.match(historyAttribution(index), /historical-basemaps/);
  assert.equal(HISTORY_INDEX_URL, '/data/history/index.json');
});

/* ---------------------------------------------------------- the pipeline */

test('splitRingAtAntimeridian: no ring sweeps across the map', () => {
  const eastward = splitRingAtAntimeridian([
    [170, 10],
    [175, 12],
    [-175, 14],
    [-170, 10],
    [170, 10],
  ]);
  assert.equal(eastward.length, 2, 'the ring is cut at the seam; the closing sliver collapses');
  assert.deepEqual(eastward[0].at(-1), [180, 13], 'the seam latitude is interpolated');
  assert.deepEqual(eastward[1][0], [-180, 13]);
  for (const part of eastward) {
    for (const [lon] of part) assert.ok(lon >= -180 && lon <= 180);
    for (let i = 0; i + 1 < part.length; i++) {
      assert.ok(Math.abs(part[i + 1][0] - part[i][0]) <= 180, 'no edge jumps the seam');
    }
  }

  const westward = splitRingAtAntimeridian([
    [-175, 10],
    [175, 12],
    [170, 10],
    [-175, 10],
  ]);
  // The two seam slivers of this contrived ring carry no area and are dropped;
  // the remaining piece keeps the interpolated seam latitude on both ends.
  assert.equal(westward.length, 1);
  assert.deepEqual(westward[0][0], [180, 11]);
  assert.deepEqual(westward[0].at(-1), [180, 10]);

  // The polar case: the rim runs along the pole and the seam edge is degenerate.
  // The real Antarctica rings are covered by the bundled-data test below, which
  // documents the one allowed wide edge (the pole chord on the map's clip line).
  const seamEdge = splitRingAtAntimeridian([
    [-180, -90],
    [-180, -60],
    [0, -60],
    [180, -60],
    [180, -90],
    [-180, -90],
  ]);
  assert.ok(seamEdge.length >= 1);
  for (const part of seamEdge) {
    for (let i = 0; i + 1 < part.length; i++) {
      const polar = Math.abs(part[i][1]) >= 89.9 && Math.abs(part[i + 1][1]) >= 89.9;
      assert.ok(polar || Math.abs(part[i + 1][0] - part[i][0]) <= 180);
    }
  }

  const plain = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];
  assert.deepEqual(splitRingAtAntimeridian(plain), [plain], 'a ring that does not cross is returned unchanged');
});

test('ringCentroid: the anchor is the area centroid, not a vertex average', () => {
  assert.deepEqual(ringCentroid([0, 0, 1000, 0, 1000, 1000, 0, 1000, 0, 0]), [500, 500]);
  // A triangle weighted by its area, not by how many vertices the source used.
  assert.deepEqual(ringCentroid([0, 0, 300, 0, 0, 300, 0, 0]), [100, 100]);
  assert.equal(ringCentroid([0, 0, 100, 0, 0, 0]), null, 'a degenerate ring has no anchor');
});

test('simplifyRing keeps the endpoints and drops points inside the tolerance', () => {
  const straight = [
    [0, 0],
    [0.1, 0.00001],
    [0.2, 0.00001],
    [0.25, 0.00001],
    [0.3, 0],
  ];
  assert.deepEqual(simplifyRing(straight, 0.05), [
    [0, 0],
    [0.3, 0],
  ]);
  const peak = [
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 1],
    [4, 0],
  ];
  assert.deepEqual(simplifyRing(peak, 0.5), [
    [0, 0],
    [2, 2],
    [4, 0],
  ], 'a peak taller than the tolerance survives');
  assert.deepEqual(simplifyRing(peak, 2), [
    [0, 0],
    [4, 0],
  ], 'a peak inside the tolerance collapses');
  assert.equal(simplifyRing([[0, 0], [1, 1], [2, 0]], 99).length, 3, 'a triangle is never simplified');
  const closed = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 0],
  ];
  assert.deepEqual(simplifyRing(closed, 0.1), closed, 'rings shorter than five points are never touched');
});

test('buildSnapshot is deterministic and carries the source provenance through', () => {
  const geojson = {
    features: [
      {
        properties: { NAME: 'Realm', SUBJECTO: 'Realm', BORDERPRECISION: 2 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [10, 0],
              [10, 10],
              [0, 10],
              [0, 0],
            ],
          ],
        },
      },
      {
        properties: { NAME: 'Vassal', SUBJECTO: 'Realm', PARTOF: 'Realm', BORDERPRECISION: 1 },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [
            [
              [
                [20, 0],
                [22, 0],
                [22, 2],
                [20, 0],
              ],
            ],
          ],
        },
      },
      { properties: { NAME: 'Speck' }, geometry: { type: 'Polygon', coordinates: [[[30, 30], [30.001, 30], [30, 30.001], [30, 30]]] } },
    ],
  };
  const a = buildSnapshot(1500, geojson, 0.05);
  const b = buildSnapshot(1500, geojson, 0.05);
  assert.equal(a.body, b.body, 'the same input yields byte-identical output');
  assert.equal(a.features, 2, 'the degenerate speck is dropped, not invented');
  assert.equal(a.dropped, 1);
  assert.deepEqual(a.precision, { 1: 1, 2: 1, 3: 0, unknown: 0 });
  const parsed = JSON.parse(a.body);
  assert.equal(parsed.year, 1500);
  assert.equal(parsed.features[0].a > parsed.features[1].a, true, 'features are sorted by area, largest first');
  const realm = parsed.features.find((f) => f.n === 'Realm');
  assert.equal(realm.s, undefined, 'SUBJECTO identical to NAME is not repeated');
  assert.equal(realm.b, 2);
  assert.deepEqual(realm.c, [500, 500]);
  const vassal = parsed.features.find((f) => f.n === 'Vassal');
  assert.equal(vassal.s, 'Realm');
  assert.equal(vassal.p, 'Realm');
  assert.deepEqual(vassal.b, 1);
});

test('chooseTolerance: the finest tolerance that fits the budget wins, and a coarse floor is reported', () => {
  const heavy = {
    features: Array.from({ length: 400 }, (_, i) => ({
      properties: { NAME: `Area ${i}`, BORDERPRECISION: 1 },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [i * 0.1, 0],
            [i * 0.1 + 5, 0.3],
            [i * 0.1 + 5, 5.3],
            [i * 0.1 - 0.2, 5],
            [i * 0.1, 0],
          ],
        ],
      },
    })),
  };
  const chosen = chooseTolerance(1000, heavy, 40 * 1024);
  assert.ok(chosen.tolerance >= 0.05, 'a tolerance was applied');
  assert.ok(chosen.bytes <= 40 * 1024, 'the budget is respected when a rung fits');
  assert.equal(chosen.overBudget, false);

  const impossible = chooseTolerance(1000, heavy, 10);
  assert.equal(impossible.overBudget, true, 'an impossible budget is flagged instead of dropping features');
  assert.ok(impossible.features > 0);
});

/* ------------------------------------------------------ the bundled data */

test('history index: the shipped dataset is documented and self-consistent', () => {
  assert.equal(index.source.licence, 'GPL-3.0');
  assert.match(index.source.datasetUrl, /aourednik\/historical-basemaps/);
  assert.match(index.source.retrieval.upstreamCommit, /^[0-9a-f]{40}$/, 'the upstream revision is pinned to a commit');
  assert.match(index.source.retrieval.retrievedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(index.source.method, /simplification/i);
  assert.equal(index.stats.years, index.years.length);
  assert.equal(index.stats.earlierYear, index.years[0].year);
  assert.equal(index.stats.latestYear, index.years.at(-1).year);
  assert.ok(index.years.length >= 50, 'the full usable upstream year index is bundled, not a handful of demo years');
  assert.ok(index.years[0].year <= -8000, 'early periods are covered');
  assert.ok(index.years.at(-1).year >= 2000, 'modern periods are covered');

  const seen = new Set();
  let previous = -Infinity;
  for (const entry of index.years) {
    assert.equal(seen.has(entry.year), false, `duplicate snapshot year ${entry.year}`);
    seen.add(entry.year);
    assert.ok(entry.year > previous, `snapshot years are ascending (${entry.year})`);
    previous = entry.year;
    assert.equal(entry.label, historicalYearLabel(entry.year));
    assert.match(entry.file, /^world_(bc)?\d+\.json$/);
    assert.equal(entry.file, entry.year < 0 ? `world_bc${Math.abs(entry.year)}.json` : `world_${entry.year}.json`);
    assert.ok(entry.features > 0);
    assert.ok(entry.points >= entry.features);
    assert.ok(Number.isInteger(entry.unnamedFeatures) && entry.unnamedFeatures >= 0);
    assert.ok(entry.unnamedFeatures <= entry.features);
    assert.ok(entry.upstream.features >= entry.features, `we never add features (${entry.year})`);
    assert.ok(entry.toleranceDeg >= 0.05 && entry.toleranceDeg <= 0.75);
    assert.ok(entry.bbox && entry.bbox.length === 4);
    const [w, s, e, n] = entry.bbox;
    assert.ok(w >= -181 && e <= 181 && s >= -91 && n <= 91, `bbox inside the work (${entry.year})`);
    assert.ok(w < e && s < n);
  }

  for (const entry of index.excluded) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 10, 'an excluded upstream year carries a reason');
  }
});

test('history snapshots: every promised file exists, parses and stays inside the world', async () => {
  let bytes = 0;
  for (const entry of index.years) {
    const file = path.join(historyDir, entry.file);
    const info = await stat(file);
    bytes += info.size;

    const snapshot = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(snapshot.year, entry.year, `${entry.file} carries its own year`);
    assert.equal(snapshot.features.length, entry.features);
    for (const feature of snapshot.features) {
      assert.ok(typeof feature.n === 'string' && feature.n.length > 0);
      assert.ok(Array.isArray(feature.r) && feature.r.length > 0);
      assert.ok(Number.isInteger(feature.a) && feature.a >= 0);
      assert.ok(feature.b === undefined || (feature.b >= 1 && feature.b <= 3));
      assert.ok(Array.isArray(feature.c) && feature.c.length === 2);
      assert.ok(Math.abs(feature.c[0]) <= 18000 && Math.abs(feature.c[1]) <= 9000, `anchor inside the work (${entry.year} ${feature.n})`);
      const unnamed = feature.n === 'Unnamed';
      assert.equal(unnamed, (feature.s ?? feature.n) === 'Unnamed' ? true : unnamed);
      for (const ring of feature.r) {
        assert.equal(ring.length % 2, 0, `ring coordinate pairs (${entry.year} ${feature.n})`);
        assert.ok(ring.length >= 8, `a ring keeps at least three vertices (${entry.year} ${feature.n})`);
        for (const value of ring) {
          assert.ok(Number.isInteger(value), `integers only (${entry.year} ${feature.n})`);
        }
        assert.ok(Math.abs(ring[0]) <= 18100 && Math.abs(ring[1]) <= 9100);
        assert.equal(ring[0], ring[ring.length - 2], `rings are closed (${entry.year} ${feature.n})`);
        assert.equal(ring[1], ring[ring.length - 1], `rings are closed (${entry.year} ${feature.n})`);
        // The seam invariant that matters for drawing: no edge may jump more
        // than half the world, otherwise a renderer sweeps a path across the map.
        // Two documented exceptions: the pole edge (both ends at |lat| ≥ 89.9°,
        // which lies on the map's clip line in Web Mercator) and the source's
        // globe-spanning unattributed-space rings (flagged `bg`, which a renderer
        // skips). They are counted in `wideEdges` so the exemption stays visible.
        let wide = 0;
        for (let i = 0; i + 3 < ring.length; i += 2) {
          const step = Math.abs(ring[i + 2] - ring[i]);
          if (step <= 18100) continue;
          wide += 1;
          const polar = Math.abs(ring[i + 1]) >= 8990 && Math.abs(ring[i + 3]) >= 8990;
          assert.ok(polar || feature.bg === 1, `no unexplained wide edge (${entry.year} ${feature.n}: ${step / 100}°)`);
        }
        if (wide > 0) assert.equal(entry.wideEdges > 0, true, `${entry.year} reports its wide edges`);
      }
    }
  }
  const recorded = index.stats.bytes;
  assert.ok(Math.abs(bytes - recorded) / recorded < 0.02, `the index reports the shipped bytes (${bytes} vs ${recorded})`);
  assert.ok(bytes < 30 * 1024 * 1024, 'the bundled dataset stays inside a sane asset budget');
});

test('history data ships its licence and attribution, as GPL-3.0 requires', async () => {
  const licence = await readFile(path.join(historyDir, 'LICENSE.txt'), 'utf8');
  assert.match(licence, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(licence, /Version 3/);
  const attribution = await readFile(path.join(historyDir, 'ATTRIBUTION.txt'), 'utf8');
  assert.match(attribution, /historical-basemaps/);
  assert.match(attribution, /GPL-3\.0/);
  assert.match(attribution, /Modifications/);
  assert.match(attribution, new RegExp(index.source.retrieval.upstreamCommit));
  assert.match(index.source.attribution, /GPL-3\.0/);
});
