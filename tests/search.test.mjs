/**
 * Place-search fallback suggestions (maps-2).
 *
 * When the swisstopo gazetteer cannot answer (Worker/upstream outage) the
 * combobox falls back to record titles from the committed seed. Those records
 * do not all publish a point (`geo`), so the suggestion coordinates must come
 * from `recordCenter()`, which falls back to the documented extent. A null
 * coordinate used to crash `choose()` with "Cannot read properties of null
 * (reading 'toFixed')" and never opened the record.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { fallbackSuggestions } from '../public/app/search.js';

const records = JSON.parse(await readFile(new URL('../public/data/records.json', import.meta.url), 'utf8')).records;

test('fallback suggestions never carry a null coordinate for a record with an extent', () => {
  const withoutGeo = records.filter((record) => !record.geo);
  assert.ok(withoutGeo.length > 0, 'the seed is expected to contain overlay records without a point');
  const hits = fallbackSuggestions(withoutGeo, 'karte');
  assert.ok(hits.length > 0, 'the overlay titles match "karte"');
  for (const hit of hits) {
    assert.ok(Number.isFinite(hit.lat), `${hit.recordId}: lat must be finite`);
    assert.ok(Number.isFinite(hit.lon), `${hit.recordId}: lon must be finite`);
    assert.ok(hit.bbox && Number.isFinite(hit.bbox.west), `${hit.recordId}: bbox carried for the map fit`);
  }
});

test('fallback suggestions prefer the published point when there is one', () => {
  const withGeo = records.find((record) => record.geo && record.extent);
  assert.ok(withGeo, 'the seed is expected to contain a record with point and extent');
  const [hit] = fallbackSuggestions([withGeo], withGeo.title.slice(0, 12));
  assert.equal(hit.lat, withGeo.geo.lat);
  assert.equal(hit.lon, withGeo.geo.lon);
  assert.equal(hit.recordId, withGeo.id);
  assert.equal(hit.origin, 'Datensatz');
});

test('fallback suggestions are bounded, truncated and empty on no match', () => {
  const many = fallbackSuggestions(records, '', 4);
  assert.equal(many.length, 4);
  const long = fallbackSuggestions(records, '', 1)[0];
  assert.ok(long.label.length <= 80);
  assert.deepEqual(fallbackSuggestions(records, 'zzz-kein-treffer-zzz'), []);
});
