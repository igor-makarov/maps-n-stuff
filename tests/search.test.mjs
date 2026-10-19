/**
 * Place-search fallback suggestions (maps-2).
 *
 * When the swisstopo gazetteer cannot answer (Worker/upstream outage) the
 * combobox falls back to record titles from the committed seed. Those records
 * do not all publish a point (`geo`), so the suggestion coordinates must come
 * from `recordCenter()`, which falls back to the documented extent. A null
 * coordinate used to crash `choose()` with "Cannot read properties of null
 * (reading 'toFixed')" and never opened the record.
 *
 * The box also offers the record keyword search (“Karten zum Stichwort …”):
 * `datasetSuggestion()` runs the same filter pipeline, so its count is what the
 * result list will really show — and a query without matches yields nothing
 * instead of an empty promise.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { datasetSuggestion, fallbackSuggestions } from '../public/app/search.js';
import { filterRecords, matchesQuery } from '../public/app/records.js';

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

test('the record search suggestion counts exactly the rows the filter will show', () => {
  const state = { from: 1500, to: 2025, q: '', provider: '', type: '', collection: '', at: '', viewport: '' };
  const suggestion = datasetSuggestion(records, 'Siegfriedkarte', state);
  const expected = filterRecords({ ...state, q: 'Siegfriedkarte' }, records).length;
  assert.ok(expected > 0, 'the committed seed names the Siegfriedkarte');
  assert.equal(suggestion.count, expected);
  assert.equal(suggestion.kind, 'dataset');
  assert.equal(suggestion.query, 'Siegfriedkarte');
  assert.match(suggestion.label, /Karten zum Stichwort „Siegfriedkarte“/);
  assert.equal(suggestion.origin, expected === 1 ? '1 Datensatz' : `${expected} Datensätze`);
});

test('the record search suggestion respects the time filter in its count', () => {
  const wide = datasetSuggestion(records, 'Siegfriedkarte', { from: 1500, to: 2025 });
  const narrow = datasetSuggestion(records, 'Siegfriedkarte', { from: 1870, to: 1880 });
  assert.ok(wide.count > narrow.count, `${wide.count} should be more than ${narrow.count}`);
  assert.equal(narrow.count, filterRecords({ from: 1870, to: 1880, q: 'Siegfriedkarte' }, records).length);
  // The period the series does not cover at all yields no promise at all.
  assert.equal(datasetSuggestion(records, 'Siegfriedkarte', { from: 1800, to: 1850 }), null);
});

test('no matches means no suggestion, and short queries are ignored', () => {
  assert.equal(datasetSuggestion(records, 'zzz-kein-treffer-zzz'), null);
  assert.equal(datasetSuggestion(records, 'x'), null);
  assert.equal(datasetSuggestion(records, ''), null);
  assert.equal(datasetSuggestion(records, undefined), null);
});

test('the offer is honest: its count equals the number of matching committed records', () => {
  const state = { from: 1500, to: 2025 };
  for (const query of ['Zürich', 'Wildkarte', 'Zentralbibliothek', '4 Lb 06']) {
    const suggestion = datasetSuggestion(records, query, state);
    const matches = records.filter((record) => matchesQuery(record, query));
    if (suggestion === null) assert.equal(matches.length, 0, `${query}: no suggestion but ${matches.length} matches`);
    else assert.equal(suggestion.count, matches.length, `${query}: count vs. matches`);
  }
});
