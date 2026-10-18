/**
 * Records/index tests: filtering, sorting, bounds and validation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  bboxIntersects,
  facets,
  filterRecords,
  indexRecords,
  loadRecords,
  matchesQuery,
  overlapsRange,
  recordCenter,
  recordsInBounds,
  sortRecords,
  validateRecord,
  yearBounds,
} from '../public/app/records.js';

const fixture = [
  {
    id: 'e-rara:1',
    title: 'Karte des Kantons Zürich',
    creators: ['Dufour, Guillaume-Henri'],
    providerId: 'e-rara',
    institution: 'Zentralbibliothek Zürich',
    rights: 'PDM 1.0',
    recordUrl: 'https://www.e-rara.ch/doi/10.3931/e-rara-1',
    thumbnail: 'https://www.e-rara.ch/i3f/v20/1/full/304/0/default.jpg',
    yearStart: 1852,
    yearEnd: 1865,
    type: 'map',
    extent: { west: 8.3, east: 8.9, south: 47.2, north: 47.6 },
    geo: { lat: 47.37, lon: 8.54 },
  },
  {
    id: 'swisstopo:zeitreihen',
    title: 'Zeitreise Kartenwerke',
    creators: [],
    providerId: 'swisstopo',
    institution: 'Bundesamt für Landestopografie',
    rights: 'OGD',
    recordUrl: 'https://map.geo.admin.ch/',
    thumbnail: 'https://wmts.geo.admin.ch/tile.png',
    yearStart: 1844,
    yearEnd: 2021,
    type: 'overlay',
    extent: { west: 5.14, east: 11.47, south: 45.39, north: 48.23 },
  },
];

test('validateRecord accepts good records and reports broken ones', () => {
  assert.deepEqual(validateRecord(fixture[0]), []);
  const problems = validateRecord({ ...fixture[0], recordUrl: 'http://insecure.example', extent: { west: 9, east: 8, south: 47, north: 46 } });
  assert.ok(problems.some((p) => p.includes('https')));
  assert.ok(problems.some((p) => p.includes('extent')));
  assert.ok(validateRecord({ id: 'bad id' }).length > 0);
});

test('matchesQuery is token-based and case-insensitive', () => {
  assert.ok(matchesQuery(fixture[0], 'kantons zürich'));
  assert.ok(matchesQuery(fixture[0], 'DUFOUR'));
  assert.ok(matchesQuery(fixture[0], 'zentralbibliothek'));
  assert.ok(!matchesQuery(fixture[0], 'basel'));
  assert.ok(matchesQuery(fixture[0], ''));
});

test('overlapsRange handles publication ranges and single years', () => {
  assert.ok(overlapsRange(fixture[0], 1800, 1900));
  assert.ok(overlapsRange(fixture[0], 1860, 1870), 'range intersects');
  assert.ok(!overlapsRange(fixture[0], 1900, 1950));
  assert.ok(overlapsRange({ yearStart: 1850, yearEnd: 1850 }, 1850, 1850));
});

test('filterRecords combines keyword, range, provider and type', () => {
  const all = fixture;
  const open = { from: 1400, to: 2100, q: '', provider: '', type: '' };
  assert.equal(filterRecords(open, all).length, 2);
  // 1852–1865 (Zürich) and 1844–2021 (Zeitreise) both overlap 1855–1900 …
  assert.equal(filterRecords({ ...open, from: 1855, to: 1900 }, all).length, 2);
  // … but only the Zeitreise layer overlaps 1866–1900.
  assert.equal(filterRecords({ ...open, from: 1866, to: 1900 }, all).length, 1);
  assert.equal(filterRecords({ ...open, provider: 'swisstopo' }, all).length, 1);
  assert.equal(filterRecords({ ...open, q: 'zeitreise', type: 'overlay' }, all).length, 1);
  assert.equal(filterRecords({ ...open, q: 'zeitreise', type: 'map' }, all).length, 0);
});

test('sortRecords sorts by year and title', () => {
  assert.deepEqual(sortRecords(fixture, 'year-asc').map((r) => r.yearStart), [1844, 1852]);
  assert.deepEqual(sortRecords(fixture, 'year-desc').map((r) => r.yearStart), [1852, 1844]);
  assert.equal(sortRecords(fixture, 'title')[0].title.startsWith('Karte'), true);
});

test('recordCenter prefers a documented point, then the bbox centre', () => {
  assert.deepEqual(recordCenter(fixture[0]), { lat: 47.37, lon: 8.54 });
  assert.deepEqual(recordCenter(fixture[1]).lat.toFixed(4), '46.8100');
  assert.equal(recordCenter({ id: 'x' }), null);
});

test('bboxIntersects and recordsInBounds respect the viewport', () => {
  assert.ok(bboxIntersects({ west: 8, east: 9, south: 47, north: 48 }, { west: 8.5, east: 9.5, south: 47.5, north: 49 }));
  assert.ok(!bboxIntersects({ west: 8, east: 8.4, south: 47, north: 47.4 }, { west: 9, east: 9.5, south: 48, north: 49 }));
  // A Zürich-sized box still intersects the Switzerland-wide Zeitreise bbox …
  const inZuerich = recordsInBounds(fixture, { west: 8.4, east: 8.7, south: 47.3, north: 47.5 });
  assert.deepEqual(inZuerich.map((r) => r.id), ['e-rara:1', 'swisstopo:zeitreihen']);
  // … while a box outside the country excludes both.
  assert.deepEqual(recordsInBounds(fixture, { west: 13, east: 14, south: 52, north: 53 }), []);
  assert.deepEqual(recordsInBounds(fixture, null).length, 2);
});

test('facets and yearBounds describe the corpus', () => {
  const { providers, types } = facets(fixture);
  assert.equal(providers.get('e-rara'), 1);
  assert.equal(types.get('overlay'), 1);
  assert.deepEqual(yearBounds(fixture), { min: 1844, max: 2021 });
  assert.equal(indexRecords(fixture).get('e-rara:1').title.includes('Zürich'), true);
});

test('overlay records match the advertised comparison layers', async () => {
  const records = JSON.parse(await readFile(new URL('../public/data/records.json', import.meta.url), 'utf8'));
  const { overlays } = JSON.parse(await readFile(new URL('../public/data/overlays.json', import.meta.url), 'utf8'));
  const byId = new Map(overlays.map((layer) => [layer.id, layer]));
  const overlayRecords = records.records.filter((record) => record.type === 'overlay');
  assert.ok(overlayRecords.length >= 10, `expected overlay records, found ${overlayRecords.length}`);
  for (const record of overlayRecords) {
    const layer = byId.get(record.overlay.layerId);
    assert.ok(layer, `${record.id}: layer ${record.overlay.layerId} missing from overlays.json`);
    assert.ok(layer.timeValues.includes(record.overlay.timeValue), `${record.id}: ${record.overlay.timeValue} not advertised by the layer`);
    assert.equal(record.overlay.maxZoom, layer.maxZoom, `${record.id}: maxZoom must match the layer's TileMatrixSet`);
    assert.equal(
      record.overlay.urlTemplate,
      layer.urlTemplate.replace('{Time}', record.overlay.timeValue),
      `${record.id}: urlTemplate must be the advertised template for its own edition`,
    );
    assert.ok(record.thumbnail.startsWith('https://wmts.geo.admin.ch/'), `${record.id}: thumbnail must be a WMTS tile`);
    assert.ok(record.thumbnail.includes(`/${record.overlay.timeValue}/`), `${record.id}: thumbnail must show its own edition`);
  }
});

test('skipped harvest entries are documented, never silent', async () => {
  const records = JSON.parse(await readFile(new URL('../public/data/records.json', import.meta.url), 'utf8'));
  assert.ok(Array.isArray(records.skipped));
  for (const entry of records.skipped) {
    assert.ok(entry.id && typeof entry.reason === 'string' && entry.reason.length > 20, `skipped entry needs id + reason: ${JSON.stringify(entry)}`);
  }
});

test('loadRecords reads the shipped seed file and validates it', async () => {
  const raw = JSON.parse(await readFile(new URL('../public/data/records.json', import.meta.url), 'utf8'));
  const fetchStub = async () => ({ ok: true, json: async () => raw });
  const result = await loadRecords(fetchStub);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.records.length, raw.records.length);
  assert.ok(result.generatedAt);
});
