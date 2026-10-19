/**
 * Historical-borders tests: the harvested dataset bundle, the honesty rules of
 * the year control, and the pure helpers of the History view.
 *
 * The bundle is a simplified derivative of aourednik/historical-basemaps
 * (GPL-3.0-or-later); `scripts/harvest-history.mjs` pins the upstream commit and
 * records the provenance in `public/data/history/index.json`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { readStateFromUrl, sanitise, stateToQuery, STATE_DEFAULTS } from '../public/app/store.js';
import {
  clampView,
  featureBounds,
  featureColor,
  fitWorldZoom,
  formatViewParam,
  formatYear,
  geometryBounds,
  nearestSnapshot,
  parseViewParam,
  parseYearInput,
  pointInFeature,
  precisionStyle,
  projectPoint,
  ringsToPath,
  searchPolities,
  snapshotNote,
  unprojectPoint,
  yearWithPolity,
} from '../public/app/history.js';
import { convertSnapshot, simplifyRing, yearFromFilename } from '../scripts/harvest-history.mjs';

const DIR = fileURLToPath(new URL('../public/data/history/', import.meta.url));
const read = (file) => readFile(join(DIR, file), 'utf8');

let bundleCache = null;
async function bundle() {
  if (bundleCache) return bundleCache;
  const index = JSON.parse(await read('index.json'));
  const catalogue = JSON.parse(await read('catalogue.json')).years;
  const snapshots = new Map();
  for (const entry of index.years) {
    snapshots.set(entry.year, JSON.parse(await read(entry.file)));
  }
  bundleCache = { index, catalogue, snapshots };
  return bundleCache;
}

const namesOf = (snapshot) => new Set(snapshot.features.map((feature) => feature.name));
const featureOf = (snapshot, name) => snapshot.features.find((feature) => feature.name === name);

/* ------------------------------------------------------------------ *
 * the bundle                                                          *
 * ------------------------------------------------------------------ */

test('history bundle: provenance, licence and the published snapshot range', async () => {
  const { index } = await bundle();
  assert.equal(index.dataset, 'historical-basemaps');
  assert.equal(index.license, 'GPL-3.0-or-later');
  assert.match(index.commit, /^[0-9a-f]{40}$/, 'the harvest pins an upstream commit');
  assert.match(index.commitShort, /^[0-9a-f]{7,10}$/);
  assert.match(index.repository, /^https:\/\/github\.com\/aourednik\/historical-basemaps/);
  assert.match(index.credit, /Ourednik/);
  assert.ok(index.retrievedAt, 'the retrieval date is recorded');
  assert.match(index.simplification.caveat, /work in progress|approximate/i);

  const licence = await read(index.licenseFile);
  assert.match(licence, /GNU GENERAL PUBLIC LICENSE/);
  assert.match(licence, /Version 3/);

  assert.ok(index.years.length >= 50, `expected the full index, got ${index.years.length} snapshots`);
  assert.equal(index.coverage.snapshots, index.years.length);
  assert.equal(index.coverage.firstYear, -123000);
  assert.equal(index.coverage.lastYear, 2010);
  assert.match(index.coverage.note, /nearest snapshot/i, 'discrete snapshots are stated, not hidden');

  const years = index.years.map((entry) => entry.year);
  assert.deepEqual(years, [...years].sort((a, b) => a - b), 'the index is sorted');
  assert.ok(years.filter((year) => year < 0).length >= 15, 'early periods are covered');
  assert.ok(years.includes(-1) && years.includes(100) && years.includes(1960) && years.includes(2010));
  assert.ok(years.includes(1492) && years.includes(1914), 'the atlas keeps the well-known turning points');

  for (const entry of index.years) {
    const info = await stat(join(DIR, entry.file));
    assert.ok(info.size > 1000, `${entry.file} looks empty`);
    assert.equal(entry.bytes, info.size, `${entry.file} is stale — run the harvest`);
    assert.equal(entry.features, (await bundle()).snapshots.get(entry.year).features.length);
    assert.equal(
      entry.precision['1'] + entry.precision['2'] + entry.precision['3'] + entry.precision.unknown,
      entry.features,
      `${entry.year}: every feature has a precision bucket`,
    );
  }
});

test('every snapshot parses, with in-range, closed, quantised rings', async () => {
  const { snapshots } = await bundle();
  for (const [year, snapshot] of snapshots) {
    assert.equal(snapshot.year, year, `${year}: the file names its own year`);
    assert.ok(snapshot.features.length > 0, `${year} has features`);
    for (const feature of snapshot.features) {
      assert.ok(feature.name && feature.name.trim(), `${year}: a feature without a name`);
      assert.ok(feature.subject, `${year}/${feature.name}: no subject recorded`);
      assert.ok([0, 1, 2, 3].includes(feature.borderPrecision), `${year}/${feature.name}: precision outside the source scale`);
      assert.ok(Array.isArray(feature.parts) && feature.parts.length > 0, `${year}/${feature.name}: no geometry`);
      for (const part of feature.parts) {
        assert.ok(Array.isArray(part) && part.length % 2 === 0 && part.length >= 8, `${year}/${feature.name}: malformed ring`);
        for (let i = 0; i < part.length; i += 2) {
          assert.ok(Number.isInteger(part[i]) && part[i] >= -180000 && part[i] <= 180000, `${year}/${feature.name}: longitude ${part[i]} out of range`);
          assert.ok(Number.isInteger(part[i + 1]) && part[i + 1] >= -90000 && part[i + 1] <= 90000, `${year}/${feature.name}: latitude ${part[i + 1]} out of range`);
        }
        assert.equal(part[0], part[part.length - 2], `${year}/${feature.name}: ring is not closed`);
        assert.equal(part[1], part[part.length - 1], `${year}/${feature.name}: ring is not closed`);
      }
    }
  }
});

test('territorial polygons change with the year, on several continents', async () => {
  const { snapshots } = await bundle();
  const y1900 = snapshots.get(1900);
  const y1914 = snapshots.get(1914);
  const y1960 = snapshots.get(1960);
  const y2010 = snapshots.get(2010);

  // Europe/Middle East at the turn of the century: the empires are there.
  for (const name of ['Austria Hungary', 'Ottoman Empire', 'Russian Empire', 'Persia']) {
    assert.ok(namesOf(y1900).has(name), `1900 should show ${name}`);
  }
  assert.ok(namesOf(y1914).has('German Empire'), '1914 shows the German Empire');
  assert.ok(!namesOf(y2010).has('German Empire') && !namesOf(y2010).has('Ottoman Empire'));

  // The 20th century: decolonisation and the new states of the 1990s.
  for (const name of ['USSR', 'Czechoslovakia', 'Yugoslavia', 'Poland']) {
    assert.ok(namesOf(y1960).has(name), `1960 should show ${name}`);
  }
  for (const name of ['Czech Republic', 'Slovakia', 'Serbia', 'Croatia', 'Kazakhstan']) {
    assert.ok(namesOf(y2010).has(name), `2010 should show ${name}`);
  }
  assert.ok(!namesOf(y2010).has('USSR') && !namesOf(y2010).has('Czechoslovakia'));

  // Not just labels: the drawn geometry itself differs between the dates.
  const france = [y1900, y1914, y2010].map((snapshot) => JSON.stringify(featureOf(snapshot, 'France')?.parts ?? null));
  assert.ok(france.every((geometry) => geometry !== 'null'), 'France is drawn in all three snapshots');
  assert.notEqual(france[0], france[1], 'France 1900 and 1914 are different polygons');
  assert.notEqual(france[1], france[2], 'France 1914 and 2010 are different polygons');

  // And the polygons sit where the source puts them (no invented coordinates).
  const ottoman = geometryBounds(featureOf(y1900, 'Ottoman Empire').parts);
  assert.ok(ottoman.west < 15 && ottoman.east > 45 && ottoman.south < 15 && ottoman.north > 40, 'Ottoman Empire reaches from the Balkans to Arabia');
  const india = geometryBounds(featureOf(y2010, 'India').parts);
  assert.ok(india.west > 60 && india.west < 70 && india.east > 90 && india.south < 10 && india.north > 30, 'India 2010 is on the subcontinent');
  const germany = geometryBounds(featureOf(y1914, 'German Empire').parts);
  assert.ok(germany.west < 7 && germany.east > 20 && germany.north > 54, 'the 1914 German Empire is wider than Germany today');
});

test('early snapshots are marked approximate and BCE years survive the pipeline', async () => {
  const { index, snapshots } = await bundle();
  const early = snapshots.get(-123000);
  assert.ok(index.years.some((entry) => entry.year === -123000 && entry.file === 'world_bc123000.json'));
  assert.ok(namesOf(early).has('Neanderthal') || namesOf(early).has('Homo erectus'));
  for (const feature of early.features) {
    assert.equal(feature.borderPrecision, 1, 'stone-age ranges are approximate in the source');
  }
  const ancient = snapshots.get(-1000);
  assert.ok(ancient.features.length >= 40 && ancient.features.every((feature) => feature.borderPrecision === 1));

  // Modern snapshots carry legally determined borders; the two styles differ.
  const modern = snapshots.get(1960);
  assert.ok(modern.features.some((feature) => feature.borderPrecision === 3));
  const approximate = precisionStyle(1);
  const legal = precisionStyle(3);
  assert.equal(approximate.dashed, true);
  assert.equal(legal.dashed, false);
  assert.match(approximate.label, /approximate/);
  assert.match(legal.label, /international law/);
  assert.equal(precisionStyle(0).dashed, true, 'an unstated border is drawn as uncertain, not as certain');
});

/* ------------------------------------------------------------------ *
 * the year control                                                    *
 * ------------------------------------------------------------------ */

test('a date between snapshots resolves to the nearest snapshot and says so', async () => {
  const { index } = await bundle();
  const years = index.years.map((entry) => entry.year);

  const between = nearestSnapshot(years, 1899);
  assert.equal(between.year, 1900);
  assert.equal(between.exact, false);
  assert.equal(between.distance, 1);
  assert.equal(between.direction, 'later');

  const exact = nearestSnapshot(years, 1500);
  assert.equal(exact.exact, true);
  assert.match(snapshotNote(years, 1500), /published as its own map/);

  const honest = snapshotNote(years, 1899);
  assert.match(honest, /1900 CE/);
  assert.match(honest, /nearest published map/);
  assert.match(honest, /1899 CE/);

  // Ties go to the earlier snapshot: a map drawn for 1100 must not jump forward.
  assert.equal(nearestSnapshot([1000, 1200], 1100).year, 1000);
  assert.equal(nearestSnapshot([1200, 1000], 1100).year, 1000);

  // A period the dataset does not cover is handled honestly, not faked.
  const tooEarly = nearestSnapshot(years, -500000);
  assert.equal(tooEarly.year, -123000);
  assert.equal(tooEarly.exact, false);
  assert.match(snapshotNote(years, -500000), /nearest published map/);
});

test('the year field accepts BCE/CE and rejects junk', () => {
  assert.equal(parseYearInput('1900'), 1900);
  assert.equal(parseYearInput('1900 CE'), 1900);
  assert.equal(parseYearInput('1250 BCE'), -1250);
  assert.equal(parseYearInput('-1000'), -1000);
  assert.equal(parseYearInput(' 44 BC '), -44);
  assert.equal(parseYearInput('twelve'), null);
  assert.equal(parseYearInput(''), null);
  assert.equal(parseYearInput('12.5'), null);
  assert.equal(formatYear(1900), '1900 CE');
  assert.equal(formatYear(-1250), '1250 BCE');
});

test('URL state carries the mode, the year and the borders window', () => {
  const state = { ...STATE_DEFAULTS, view: 'history', year: -1000, hv: '20,-30,2.5' };
  const query = stateToQuery(state);
  const params = new URLSearchParams(query);
  assert.equal(params.get('view'), 'history');
  assert.equal(params.get('year'), '-1000');
  assert.equal(params.get('hv'), '20,-30,2.5');

  const back = readStateFromUrl(`?${query}`);
  assert.equal(back.view, 'history');
  assert.equal(back.year, -1000);
  assert.equal(back.hv, '20,-30,2.5');

  // A hand-written URL cannot open a view that does not exist or smuggle junk.
  const junk = sanitise({ ...STATE_DEFAULTS, view: 'history; drop table', year: 'not a year', hv: 'here be dragons' });
  assert.equal(junk.view, 'split');
  assert.equal(junk.year, STATE_DEFAULTS.year);
  assert.equal(junk.hv, '');
  assert.equal(sanitise({ ...STATE_DEFAULTS, year: 999999 }).year, 2200, 'the year is clamped to the atlas range');
  assert.equal(sanitise({ ...STATE_DEFAULTS, year: 1899.7 }).year, 1900, 'fractional years are rounded');

  // The shareable window round-trips through its own parser.
  const view = parseViewParam('20,-30,2.5', { lat: 0, lon: 0, zoom: 1 });
  assert.deepEqual(view, { lat: 20, lon: -30, zoom: 2.5 });
  assert.deepEqual(parseViewParam('nonsense', { lat: 1, lon: 2, zoom: 3 }), { lat: 1, lon: 2, zoom: 3 });
  assert.equal(formatViewParam({ lat: 20, lon: -30.12345, zoom: 2.5 }), '20.000,-30.123,2.50');
});

/* ------------------------------------------------------------------ *
 * the projection and the drawing helpers                              *
 * ------------------------------------------------------------------ */

test('the world fits the viewport and the projection round-trips', () => {
  const size = { width: 1200, height: 600 };
  const zoom = fitWorldZoom(size);
  assert.ok(zoom >= 0 && zoom <= 3, `world zoom ${zoom} is a world view`);
  assert.ok(256 * 2 ** zoom <= size.height + 1, 'the whole world fits vertically');

  const view = clampView({ lat: 20, lon: 0, zoom: 2 });
  const center = projectPoint(view.lat, view.lon, view, size);
  assert.ok(Math.abs(center.x - size.width / 2) < 0.001 && Math.abs(center.y - size.height / 2) < 0.001);
  for (const [lat, lon] of [[47.37, 8.54], [-33.9, 151.2], [0, -60], [64, -21.9]]) {
    const point = projectPoint(lat, lon, view, size);
    const back = unprojectPoint(point.x, point.y, view, size);
    assert.ok(Math.abs(back.lat - lat) < 0.001, `${lat} → ${back.lat}`);
    assert.ok(Math.abs(back.lon - lon) < 0.001, `${lon} → ${back.lon}`);
  }
  assert.equal(clampView({ lat: 95, lon: 200, zoom: 99 }).lon, -160, 'longitudes wrap, latitudes and zoom clamp');
});

test('path building, bounds, hit testing and colours are decided by the data', async () => {
  const { snapshots } = await bundle();
  const snapshot = snapshots.get(2010);
  const india = featureOf(snapshot, 'India');

  const project = (lat, lon) => ({ x: (lon + 180) * 2, y: (90 - lat) * 2 });
  const path = ringsToPath(india.parts, project);
  assert.match(path, /^M[-\d.]+ [-\d.]+L/);
  assert.ok(path.endsWith('Z'));
  assert.ok((path.match(/M/g) ?? []).length === india.parts.length, 'every ring becomes its own subpath');

  const bounds = geometryBounds(india.parts);
  assert.ok(bounds.west >= 60 && bounds.east <= 100 && bounds.south >= 0 && bounds.north <= 40);
  assert.deepEqual(featureBounds(india), geometryBounds([india.parts[0]]), 'the largest ring is the label anchor');

  assert.equal(pointInFeature(india, 22, 78), true, 'a point in central India is inside');
  assert.equal(pointInFeature(india, 40, 78), false, 'a point in the Himalaya is outside the drawn polygon');

  assert.equal(featureColor('India'), featureColor('India'), 'colours are stable');
  assert.notEqual(featureColor('India'), featureColor('France'), 'different polities get different colours');
});

test('the polity search finds names across snapshots and jumps to a covered year', async () => {
  const { catalogue } = await bundle();
  const prussia = searchPolities(catalogue, 'prussia');
  const exact = prussia.find((hit) => hit.name === 'Prussia');
  assert.ok(exact, 'Prussia is one of the matches');
  assert.deepEqual(exact.years, [1530, 1600, 1650, 1700, 1715, 1783, 1800, 1815]);
  assert.ok(prussia.some((hit) => hit.name === 'East Prussia'), 'partial matches are listed too');
  assert.equal(yearWithPolity(catalogue, 'Prussia', 1990), 1815, 'the nearest covered snapshot wins');
  assert.equal(yearWithPolity(catalogue, 'Nowhereland', 1900), null);
  assert.deepEqual(searchPolities(catalogue, 'p'), [], 'one letter is not a search');
  assert.deepEqual(searchPolities(catalogue, 'zzzz'), []);
});

/* ------------------------------------------------------------------ *
 * the harvest pipeline                                                *
 * ------------------------------------------------------------------ */

test('harvest helpers: Douglas–Peucker, year parsing and conversion', () => {
  const dense = [];
  for (let i = 0; i <= 40; i += 1) dense.push([i / 40, 0]);
  dense.push([1, 1]);
  const simplified = simplifyRing(dense, 0.001);
  assert.ok(simplified.length < dense.length / 4, 'collinear points are dropped');
  assert.deepEqual(simplified[0], [0, 0], 'the first point stays');
  assert.deepEqual(simplified[simplified.length - 1], [1, 1], 'the last point stays');
  assert.deepEqual(simplifyRing(dense, 0), dense, 'tolerance 0 keeps everything');

  assert.equal(yearFromFilename('world_bc1000.geojson'), -1000);
  assert.equal(yearFromFilename('world_1878.geojson'), 1878);
  assert.equal(yearFromFilename('places.geojson'), null);

  const converted = convertSnapshot(
    {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { NAME: 'Testland', SUBJECTO: 'Testland', BORDERPRECISION: 3 },
          geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
        },
        {
          type: 'Feature',
          properties: { NAME: '', SUBJECTO: 'ignored', BORDERPRECISION: 1 },
          geometry: { type: 'Polygon', coordinates: [[[2, 2], [3, 2], [3, 3], [2, 2]]] },
        },
      ],
    },
    { tolerance: 0.01, minArea: 0.001 },
  );
  assert.equal(converted.features.length, 1, 'a feature without a name is not invented');
  assert.equal(converted.droppedFeatures, 1);
  assert.equal(converted.features[0].name, 'Testland');
  assert.equal(converted.features[0].borderPrecision, 3);
  assert.deepEqual(converted.features[0].parts[0], [0, 0, 1000, 0, 1000, 1000, 0, 1000, 0, 0], 'millidegree integers, closed ring');
  assert.deepEqual(converted.precisionCounts, { 1: 0, 2: 0, 3: 1, unknown: 0 });
});
