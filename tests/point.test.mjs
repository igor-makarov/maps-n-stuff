/**
 * Point filter (“Karten an diesem Punkt”): the pure geometry, the URL/state
 * round-trip and the honest behaviour against the committed seed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { coversPoint } from '../public/app/records.js';
import { PARAM, STATE_DEFAULTS, parsePoint, readStateFromUrl, sanitise, sanitisePoint, stateToQuery } from '../public/app/store.js';

const records = JSON.parse(await readFile(new URL('../public/data/records.json', import.meta.url), 'utf8')).records;

test('coversPoint uses the documented extent, bounds inclusive', () => {
  const record = { id: 'x:1', extent: { west: 8, east: 9, south: 47, north: 48 } };
  assert.equal(coversPoint(record, 47.5, 8.5), true);
  assert.equal(coversPoint(record, 47, 8), true, 'the bounding box includes its own corner');
  assert.equal(coversPoint(record, 48, 9), true);
  assert.equal(coversPoint(record, 47.5, 7.999), false);
  assert.equal(coversPoint(record, 48.001, 8.5), false);
});

test('coversPoint never treats a centre point or broken bounds as coverage', () => {
  assert.equal(coversPoint({ geo: { lat: 47.4, lon: 8.5 } }, 47.4, 8.5), false, 'geo is a centre, not a footprint');
  assert.equal(coversPoint({ extent: { west: 9, east: 8, south: 47, north: 48 } }, 47.5, 8.5), false);
  assert.equal(coversPoint({ extent: { west: 8, east: 9, south: 47, north: 48 } }, NaN, 8.5), false);
  assert.equal(coversPoint(null, 47.5, 8.5), false);
});

test('parsePoint / sanitisePoint accept only a real "lat,lon" pair', () => {
  assert.deepEqual(parsePoint('47.3769,8.5417'), { lat: 47.3769, lon: 8.5417 });
  assert.equal(parsePoint(''), null);
  assert.equal(parsePoint('Zürich'), null);
  assert.equal(parsePoint('47.4'), null);
  assert.equal(parsePoint('47.4,8.5,9'), null);
  assert.equal(parsePoint('quatsch,8.5'), null);
  assert.equal(sanitisePoint('47.37691,8.54174'), '47.3769,8.5417');
  assert.equal(sanitisePoint('95,8.5'), '85.0000,8.5000', 'latitude is clamped like every other map state');
  assert.equal(sanitisePoint('nonsense'), '');
});

test('the point filter round-trips through the shareable URL', () => {
  const query = stateToQuery({ ...STATE_DEFAULTS, at: '47.3769,8.5417', from: 1850 });
  const params = new URLSearchParams(query);
  assert.equal(params.get(PARAM.at), '47.3769,8.5417');
  const back = readStateFromUrl(query);
  assert.equal(back.at, '47.3769,8.5417');
  assert.equal(back.from, 1850);
  assert.equal(new URLSearchParams(stateToQuery({ ...STATE_DEFAULTS })).has(PARAM.at), false, 'no point filter is not repeated in the URL');
});

test('a hand-written point value cannot break the filter', () => {
  assert.equal(sanitise({ ...STATE_DEFAULTS, at: '<script>' }).at, '');
  assert.equal(sanitise({ ...STATE_DEFAULTS, at: '47.5,8.5' }).at, '47.5000,8.5000');
  assert.equal(sanitise({ ...STATE_DEFAULTS, at: '47.5,999' }).at, sanitisePoint('47.5,999'));
});

test('the point filter uses documented footprints and excludes maps with unknown extents', () => {
  assert.equal(records.length > 0, true);
  const withoutExtent = records.filter((record) => !record.extent);
  assert.ok(withoutExtent.every((record) => record.geoNote), 'unknown extents must be explained');
  assert.ok(withoutExtent.every((record) => !coversPoint(record, record.geo?.lat ?? 0, record.geo?.lon ?? 0)), 'place anchors must never become fabricated map footprints');
  const zurich = records.filter((record) => coversPoint(record, 47.3769, 8.5417));
  assert.ok(zurich.length > 0, 'at least one committed record states a footprint covering Zürich');
  for (const record of zurich) {
    assert.ok(47.3769 >= record.extent.south && 47.3769 <= record.extent.north);
    assert.ok(8.5417 >= record.extent.west && 8.5417 <= record.extent.east);
  }
  // The seed is no longer Switzerland-only: the “Übersichtskarten von Europa und
  // der Welt” set states continental extents, so the honest-empty case must be
  // checked with a point no record claims (Berlin used to be it until the
  // overview maps landed — the assertion moved, the behaviour did not).
  // Iteration 7-21 added whole-globe sheets (“W 180°-E 180°/N 90°-S 90°”), whose
  // documented footprint really is the whole earth — from then on *every* point
  // has an answer, so the empty state is exercised on the records that do not
  // claim the globe (the point below is in the South Pacific).
  const notWorldMaps = records.filter((record) => record.collection !== 'Übersichtskarten von Europa und der Welt');
  assert.deepEqual(
    notWorldMaps.filter((record) => coversPoint(record, -25, -140)),
    [],
    'a point outside every regional footprint keeps the empty state honest',
  );
  assert.ok(
    records.filter((record) => coversPoint(record, -25, -140)).length > 0,
    'the committed world maps document a whole-globe footprint, so the point filter answers even there',
  );
  assert.ok(
    records.filter((record) => coversPoint(record, 48.2082, 16.3738)).length > 0,
    'the overview set gives places outside Switzerland real footprints and a point filter answer',
  );
});
