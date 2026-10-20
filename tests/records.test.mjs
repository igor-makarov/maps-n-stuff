/**
 * Records/index tests: filtering, sorting, bounds and validation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readCatalogue } from '../scripts/catalogue.mjs';
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

test('the keyword search also covers the collection, imprint and shelfmark', () => {
  const sheet = {
    ...fixture[0],
    collection: 'Karte des Kantons Zürich 1:25 000 (Wildkarte)',
    imprint: 'Zürich : [s. n.], 1853',
    shelfmark: '4 Lb 06: 9',
  };
  // Words a visitor reads in the facet list, the citation or the detail panel.
  assert.ok(matchesQuery(sheet, 'Wildkarte'));
  assert.ok(matchesQuery(sheet, 'wildkarte 1:25'));
  assert.ok(matchesQuery(sheet, '4 Lb 06'));
  assert.ok(matchesQuery(sheet, 'zürich : [s. n.], 1853'));
  // Still a filter: an unrelated word matches nothing.
  assert.ok(!matchesQuery(sheet, 'siegfriedkarte'));
});

test('the committed seed answers the words its own facets use', async () => {
  const raw = JSON.parse(await readFile(new URL('../public/data/records.json', import.meta.url), 'utf8'));
  const docs = new Map([['/data/records.json', raw]]);
  for (const url of raw.shards ?? []) {
    docs.set(url, JSON.parse(await readFile(new URL(`../public${url}`, import.meta.url), 'utf8')));
  }
  const { records } = await loadRecords(async (url) => ({ ok: docs.has(url), json: async () => docs.get(url) }));
  const byWord = (word) => records.filter((r) => matchesQuery(r, word));
  // Every collection name in the seed is findable through the keyword box, and a
  // collection search cannot return more records than the collection has rows
  // (both come from the same data, so a facet rename cannot break the search).
  for (const collection of new Set(records.map((r) => r.collection))) {
    const found=new Set(byWord(collection).map(r=>r.id));
    assert.ok(
      records.filter((r) => r.collection === collection).every(r=>found.has(r.id)),
      `the collection “${collection}” must be findable by its own name`,
    );
  }
  // And every institution the records credit is findable, including the ones
  // added by the SRU discovery runs (UB Bern, Bibliothèque de Genève).
  for (const institution of new Set(records.map((r) => r.institution))) {
    assert.ok(byWord(institution).length > 0, `${institution} must be findable`);
  }
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

test('collection filtering and facets use the series field when present', () => {
  const withCollections = [
    { ...fixture[0], collection: 'Karte des Kantons Zürich 1:25 000 (Wildkarte)' },
    { ...fixture[1], collection: 'Zeitreise – Kartenwerke' },
  ];
  const open = { from: 1400, to: 2100, q: '', provider: '', type: '' };
  const wildkarte = filterRecords({ ...open, collection: 'Karte des Kantons Zürich 1:25 000 (Wildkarte)' }, withCollections);
  assert.deepEqual(wildkarte.map((r) => r.id), ['e-rara:1']);
  assert.equal(filterRecords({ ...open, collection: '' }, withCollections).length, 2);
  assert.equal(filterRecords({ ...open, collection: 'Unbekannt' }, withCollections).length, 0);
  const { collections } = facets(withCollections);
  assert.equal(collections.get('Zeitreise – Kartenwerke'), 1);
  assert.equal(collections.size, 2);
});

test('sortRecords sorts by year and title', () => {
  assert.deepEqual(sortRecords(fixture, 'year-asc').map((r) => r.yearStart), [1844, 1852]);
  assert.deepEqual(sortRecords(fixture, 'year-desc').map((r) => r.yearStart), [1852, 1844]);
  assert.equal(sortRecords(fixture, 'title')[0].title.startsWith('Karte'), true);
});

test('undated maps follow dated maps in both publication-year sort orders', () => {
  const maps = [{title:'Unknown date',yearStart:null,yearEnd:null},{title:'Old',yearStart:1500,yearEnd:1500},{title:'New',yearStart:1900,yearEnd:1900},{title:'End date only',yearStart:null,yearEnd:1800}];
  assert.deepEqual(sortRecords(maps,'year-asc').map(r=>r.title),['Old','End date only','New','Unknown date']);
  assert.deepEqual(sortRecords(maps,'year-desc').map(r=>r.title),['New','End date only','Old','Unknown date']);
  assert.equal(maps[0].title,'Unknown date','sorting does not mutate the catalogue');
});

test('original collection matches survive metadata fields omitted by the local index', () => {
  const record={title:'Harbour plan',creators:[],catalogueQueries:[]};
  assert.equal(matchesQuery(record,'Boston waterfront'),false);
  record.catalogueQueries.push('Boston waterfront');
  assert.equal(matchesQuery(record,'BOSTON   waterfront'),true,'works even after the local title cache has been built');
  assert.equal(matchesQuery(record,'Boston waterfront 1900'),false,'source matches only establish the query that was actually searched');
  assert.equal(record.title,'Harbour plan','the original map title is preserved');
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
  const records = (await readCatalogue()).records;
  const { overlays } = JSON.parse(await readFile(new URL('../public/data/overlays.json', import.meta.url), 'utf8'));
  const byId = new Map(overlays.map((layer) => [layer.id, layer]));
  const overlayRecords = records.filter((record) => record.type === 'overlay');
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
  const records = (await readCatalogue()).core;
  assert.ok(Array.isArray(records.skipped));
  for (const entry of records.skipped) {
    assert.ok(entry.id && typeof entry.reason === 'string' && entry.reason.length > 20, `skipped entry needs id + reason: ${JSON.stringify(entry)}`);
  }
});

test('loadRecords reads the shipped core and shard files and validates them', async () => {
  const raw = JSON.parse(await readFile(new URL('../public/data/records.json', import.meta.url), 'utf8'));
  const docs = new Map([['/data/records.json', raw]]);
  for (const url of raw.shards ?? []) {
    docs.set(url, JSON.parse(await readFile(new URL(`../public${url}`, import.meta.url), 'utf8')));
  }
  const fetchStub = async (url) => ({ ok: docs.has(url), json: async () => docs.get(url) });
  const result = await loadRecords(fetchStub);
  assert.equal(result.ok, true, result.errors.join('; '));
  assert.equal(result.records.length, (await readCatalogue()).records.length);
  assert.equal(result.loadedShards.length, raw.shards?.length ?? 0);
  assert.ok(result.generatedAt);
});

test('a failing shard keeps the rest of the catalogue and reports the gap', async () => {
  const raw = {
    generatedAt: '2026-10-20T00:00:00.000Z',
    method: 'test fixture describing the shard contract',
    shards: ['/data/records/fixture.json'],
    records: [fixture[0]],
  };
  const fetchStub = async (url) =>
    url === '/data/records/fixture.json'
      ? { ok: false, status: 503, json: async () => ({}) }
      : { ok: true, json: async () => raw };
  const result = await loadRecords(fetchStub);
  assert.equal(result.ok, false);
  assert.equal(result.records.length, 1);
  assert.ok(result.errors.some((error) => error.includes('shard unavailable')), result.errors.join('; '));
});

/**
 * `Kartendaten` → extent. The catalogue states four labelled corners; the
 * hemisphere letter of every corner decides the sign (a wrong reading put six
 * committed Europe maps at 25°E instead of 25°W until iteration 7-21 and dropped
 * every map that reaches into the western or southern hemisphere).
 */
test('parseBbox reads the hemisphere of every stated corner', async () => {
  const { parseBbox } = await import('../scripts/fetch-records.mjs');
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

  // The common Zürich-region form, with the latitude pair stated north-first.
  const zurich = parseBbox("1:25 000 (E 8°49'-E 9°00'/N 47°26'-N 47°21')");
  close(zurich.west, 8.816666666666666);
  close(zurich.east, 9);
  close(zurich.south, 47.35);
  close(zurich.north, 47.43333333333333);

  // West of Greenwich: west must be negative, and east too when it is stated W.
  const atlantic = parseBbox("[Ca. 1:12 000 000] (W 25°00'-E 60°00'/N 73°00'-N 25°00')");
  close(atlantic.west, -25);
  close(atlantic.east, 60);
  close(atlantic.south, 25);
  close(atlantic.north, 73);

  // Southern + western hemisphere (the Südamerika sheets), N 12°30' - S 56°05'.
  const southAmerica = parseBbox("1:13 000 000 (W 81°33' - W 34°45' / N 12°30' - S 56°05')");
  close(southAmerica.west, -81.55);
  close(southAmerica.east, -34.75);
  close(southAmerica.south, -56.083333333333336);
  close(southAmerica.north, 12.5);

  const allSouth = parseBbox("1:4 000 000 (W 76°00'-W 65°00'/S 22°00'-S 56°00')");
  close(allSouth.west, -76);
  close(allSouth.east, -65);
  close(allSouth.south, -56);
  close(allSouth.north, -22);

  // Arc-seconds are stated upstream but not carried into the extent (minute resolution).
  const seconds = parseBbox('1:5 000 (E 8°28\'35"-E 8°35\'14"/N 47°24\'34"-N 47°19\'54")');
  close(seconds.west, 8.466666666666667);
  close(seconds.east, 8.583333333333334);

  // A whole-globe pair is a real bbox; a date-line crossing is not expressible.
  const globe = parseBbox('[Ca. 1:100 000 000] (W 180°-E 180°/N 80°-S 70°)');
  close(globe.west, -180);
  close(globe.east, 180);
  close(globe.south, -70);
  close(globe.north, 80);
  assert.equal(parseBbox('circa 1:8 000 000 (E 155°-W 165°/N 70°-N 50°)'), null);

  // Scale-only or incomplete statements never produce coordinates.
  assert.equal(parseBbox('Echelle 1:200 000'), null);
  assert.equal(parseBbox('[Echelle non déterminée]'), null);
  assert.equal(parseBbox('1:500 000 (E 8°-N 47°)'), null);
  assert.equal(parseBbox(''), null);
  assert.equal(parseBbox(null), null);
});

test('every committed extent is a finite, correctly ordered WGS84 box', async () => {
  const records = (await readCatalogue()).records;
  for (const record of records) {
    if (!record.extent) continue;
    const { west, east, south, north } = record.extent;
    assert.ok([west, east, south, north].every(Number.isFinite), `${record.id}: non-finite extent`);
    assert.ok(west >= -180 && east <= 180, `${record.id}: longitude outside WGS84`);
    assert.ok(south >= -90 && north <= 90, `${record.id}: latitude outside WGS84`);
    assert.ok(west < east && south < north, `${record.id}: invalid extent order`);
  }
});

/**
 * swisscovery (ZB Zürich catalogue) Alma SRU discovery, added in iteration 7-69.
 *
 * The channel is discovery only: `parseAlmaRecord` reads the catalogue record's
 * gates (DOI, year, genre, MARC 034 box) and `parseMarcCoordinate` reads a MARC
 * coordinate; the record's real title/date/extent still comes from the e-rara IIIF
 * manifest. These tests pin the parsing that decides whether a candidate is worth a
 * manifest request — a wrong sign would re-introduce the 7-21 hemisphere defect for
 * every Altkarte south or west of Greenwich.
 */
test('parseMarcCoordinate reads MARC 034 degrees-minutes-seconds and decimals', async () => {
  const { parseMarcCoordinate } = await import('../scripts/fetch-records.mjs');
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(parseMarcCoordinate('E0083200'), 8 + 32 / 60);
  close(parseMarcCoordinate('E0083100'), 8 + 31 / 60);
  close(parseMarcCoordinate('N0472300'), 47 + 23 / 60);
  close(parseMarcCoordinate('W0245400'), -(24 + 54 / 60));
  close(parseMarcCoordinate('S0220000'), -22);
  close(parseMarcCoordinate('E1800000'), 180);
  close(parseMarcCoordinate('8.5333'), 8.5333);
  close(parseMarcCoordinate('-24.9'), -24.9);
  assert.equal(parseMarcCoordinate(''), null);
  assert.equal(parseMarcCoordinate(null), null);
  assert.equal(parseMarcCoordinate('circa 8°'), null);
  assert.equal(parseMarcCoordinate('E83200'), null);
});

test('parseAlmaRecord reads the ZB catalogue gates and keeps the sign of 034 W/S', async () => {
  const { parseAlmaRecord } = await import('../scripts/fetch-records.mjs');
  // A verbatim excerpt of the 1588 “Contrafactur der Statt Zürich” MARC record
  // (swisscovery SRU, 2026-10-19): 024 DOI, 034 box, 245 title, 264 year,
  // 655 genre, 700 creator.
  const marc = `
  <controlfield tag="008">970514s1588    fr        |     |   ger|d</controlfield>
  <datafield ind1="7" ind2=" " tag="024"><subfield code="a">10.3931/e-rara-26717</subfield><subfield code="2">doi</subfield></datafield>
  <datafield ind1="0" ind2=" " tag="034"><subfield code="a">a</subfield><subfield code="d">E0083200</subfield><subfield code="e">E0083300</subfield><subfield code="f">N0472300</subfield><subfield code="g">N0472100</subfield></datafield>
  <datafield ind1="0" ind2="0" tag="245"><subfield code="a">Contrafactur der Statt Zürich anno 1588</subfield></datafield>
  <datafield ind1=" " ind2="1" tag="264"><subfield code="c">1588</subfield></datafield>
  <datafield ind1=" " ind2="7" tag="655"><subfield code="a">Altkarte</subfield><subfield code="2">gnd-content</subfield></datafield>
  <datafield ind1="1" ind2=" " tag="700"><subfield code="a">Maurer, Christoph</subfield></datafield>
  <datafield ind1=" " ind2=" " tag="AVA"><subfield code="d">3 Lb 02: 1</subfield></datafield>`;
  const hit = parseAlmaRecord(marc);
  assert.equal(hit.doi, '10.3931/e-rara-26717');
  assert.equal(hit.year, 1588);
  assert.equal(hit.title, 'Contrafactur der Statt Zürich anno 1588');
  assert.equal(hit.isMap, true);
  assert.deepEqual(hit.creators, ['Maurer, Christoph']);
  assert.equal(hit.signature, '3 Lb 02: 1');
  assert.ok(Math.abs(hit.coordinates.west - (8 + 32 / 60)) < 1e-9);
  assert.ok(Math.abs(hit.coordinates.north - (47 + 23 / 60)) < 1e-9);

  // A record without 034 or without a 4-digit year must not pass the gates.
  const bare = parseAlmaRecord(
    '<datafield tag="245"><subfield code="a">Karte ohne Datum</subfield></datafield>',
  );
  assert.equal(bare.coordinates, null);
  assert.equal(bare.year, null);
  assert.equal(bare.doi, null);
  assert.equal(bare.isMap, false);
});

test('almaSruUrl states the documented endpoint, query and MARCXML schema', async () => {
  const { almaSruUrl } = await import('../scripts/fetch-records.mjs');
  const url = new URL(almaSruUrl('alma.genre_form=Altkarte and alma.all=Zürich', 51));
  assert.equal(url.hostname, 'uzb.swisscovery.ch');
  assert.equal(url.pathname, '/view/sru/41SLSP_UZB');
  assert.equal(url.searchParams.get('version'), '1.1');
  assert.equal(url.searchParams.get('operation'), 'searchRetrieve');
  assert.equal(url.searchParams.get('recordSchema'), 'marcxml');
  assert.equal(url.searchParams.get('startRecord'), '51');
  assert.equal(url.searchParams.get('maximumRecords'), '50');
  assert.equal(url.searchParams.get('query'), 'alma.genre_form=Altkarte and alma.all=Zürich');
});
