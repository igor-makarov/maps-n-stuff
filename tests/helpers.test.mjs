/**
 * Pure geometry + formatting helpers (map projection and honest date text).
 * These are the parts of the UI that can be verified without a browser.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { formatYear, formatYearRange, formatLanguage, escapeHtml, debounce, throttle } from '../public/app/dom.js';
import { latToTileY, lonToTileX, tileUrl, tileXToLon, tileYToLat } from '../public/app/map.js';
import { bboxIntersects, filterRecords, overlapsRange, recordsInBounds, sortRecords, yearBounds, recordCenter } from '../public/app/records.js';

test('formatYear is honest about missing or BCE dates', () => {
  assert.equal(formatYear(1846), '1846');
  assert.equal(formatYear(-20), '20 BCE');
  assert.equal(formatYear(null), 'Undated');
  assert.equal(formatYear('nope'), 'Undated');
  assert.equal(formatYearRange(1846, 1846), '1846');
  assert.equal(formatYearRange(1846, 1860), '1846–1860');
  assert.equal(formatYearRange(null, 1860), '1860');
});

test('catalogue language codes display readable English names', () => {
  for (const [code, name] of [['ger', 'German'], ['fre', 'French'], ['lat', 'Latin'], ['chi', 'Chinese'], ['ota', 'Ottoman Turkish'], ['English', 'English']]) assert.equal(formatLanguage(code), name);
  assert.equal(formatLanguage(null), 'not stated');
  assert.equal(formatLanguage('original source label'), 'original source label');
});

test('escapeHtml neutralises markup from upstream metadata', () => {
  assert.equal(escapeHtml('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(escapeHtml(`"quoted" & 'single'`), '&quot;quoted&quot; &amp; &#39;single&#39;');
});

test('debounce and throttle stay callable in tests', async () => {
  let calls = 0;
  const debounced = debounce(() => (calls += 1), 5);
  debounced();
  debounced();
  assert.equal(calls, 0, 'debounce waits');
  debounced.flush();
  assert.equal(calls, 1);

  let throttled = 0;
  const t = throttle(() => (throttled += 1), 50);
  t();
  t();
  assert.equal(throttled, 1, 'throttle runs the leading call once');
});

test('Web-Mercator tile maths round-trips inside the Swiss extent', () => {
  for (const [lat, lon] of [
    [47.3769, 8.5417],
    [45.818, 5.9559],
    [47.8084, 10.5],
  ]) {
    const z = 13;
    const x = lonToTileX(lon, z);
    const y = latToTileY(lat, z);
    assert.ok(Math.abs(tileXToLon(x, z) - lon) < 1e-6, 'lon round-trip');
    assert.ok(Math.abs(tileYToLat(y, z) - lat) < 1e-6, 'lat round-trip');
    assert.ok(x > 0 && y > 0);
  }
});

test('tileUrl fills the documented swisstopo WMTS placeholders', () => {
  const template = 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/{Time}/3857/{TileMatrix}/{TileCol}/{TileRow}.png';
  const url = tileUrl(template, { z: 12, x: 2130, y: 1430, time: '18831231' });
  assert.equal(url, 'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/18831231/3857/12/2130/1430.png');
  assert.ok(tileUrl(template, { z: 1, x: 1, y: 1 }).includes('/current/'), 'missing time falls back to the documented "current" value');
  assert.ok(!url.includes('{'), 'no placeholder survives');
});

test('time filtering uses publication years and prefers overlap', () => {
  const record = { yearStart: 1850, yearEnd: 1860 };
  assert.equal(overlapsRange(record, 1855, 1856), true);
  assert.equal(overlapsRange(record, 1861, 1900), false);
  assert.equal(overlapsRange(record, 1800, 1849), false);
  assert.equal(overlapsRange(record, 1840, 1850), true, 'ranges touching at an endpoint overlap');
  assert.equal(overlapsRange({ yearStart: null, yearEnd: null }, 1500, 1501), true, 'unknown years are not silently hidden');
});

test('filterRecords combines free text, provider and time range', () => {
  const records = [
    { id: 'a', title: 'Rheinau und Umgebung', yearStart: 1790, yearEnd: 1790, providerId: 'e-rara', type: 'map', creators: [] },
    { id: 'b', title: 'Kanton Zürich', yearStart: 1853, yearEnd: 1867, providerId: 'e-rara', type: 'atlas', creators: ['Wild'] },
    { id: 'c', title: 'Winterthur', yearStart: 1900, yearEnd: 1900, providerId: 'other', type: 'map', creators: [] },
  ];
  assert.equal(filterRecords({ q: 'rheinau' }, records).length, 1);
  assert.equal(filterRecords({ q: 'wild', providerId: 'e-rara' }, records).length, 1, 'creator names are searchable');
  assert.equal(filterRecords({ from: 1850, to: 1870 }, records).map((r) => r.id).join(''), 'b');
  assert.equal(filterRecords({ type: 'map' }, records).length, 2);
  assert.equal(filterRecords({}, records).length, 3);
});

test('sortRecords orders by publication year then title', () => {
  const sorted = sortRecords(
    [
      { title: 'B', yearStart: 1900, yearEnd: 1900 },
      { title: 'A', yearStart: 1800, yearEnd: 1800 },
      { title: 'C', yearStart: 1900, yearEnd: 1900 },
    ],
    'year-asc',
  );
  assert.deepEqual(sorted.map((r) => r.title), ['A', 'B', 'C']);
  assert.deepEqual(sortRecords(sorted, 'year-desc').map((r) => r.title), ['B', 'C', 'A']);
  assert.deepEqual(sortRecords(sorted, 'title').map((r) => r.title), ['A', 'B', 'C']);
});

test('bounds helpers use documented geometry only', () => {
  const withBox = { id: 'box', extent: { west: 8.4, east: 8.7, south: 47.3, north: 47.5 } };
  const withPoint = { id: 'point', geo: { lat: 47.38, lon: 8.54 } };
  const nowhere = { id: 'none' };
  const view = { west: 8.0, east: 9.0, south: 47.0, north: 48.0 };
  assert.deepEqual(recordsInBounds([withBox, withPoint, nowhere], view).map((r) => r.id), ['box', 'point']);
  assert.deepEqual(recordsInBounds([withBox, withPoint, nowhere], null).map((r) => r.id), ['box', 'point', 'none']);
  assert.equal(bboxIntersects(withBox.extent, { west: 8.0, east: 8.5, south: 47.0, north: 48.0 }), true);
  assert.equal(bboxIntersects(withBox.extent, { west: 9.0, east: 9.5, south: 47.0, north: 48.0 }), false);
  assert.deepEqual(recordCenter(withBox), { lat: 47.4, lon: 8.55 });
  assert.deepEqual(recordCenter(withPoint), { lat: 47.38, lon: 8.54 });
  assert.equal(recordCenter(nowhere), null);
  assert.deepEqual(yearBounds([{ yearStart: 1846, yearEnd: 1846 }, { yearStart: 1700, yearEnd: 1750 }]), { min: 1700, max: 1846 });
});
