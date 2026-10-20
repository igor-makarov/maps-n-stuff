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
  const withoutGeo = records.filter((record) => !record.geo && record.extent);
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
  assert.equal(hit.origin, 'record');
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
  assert.match(suggestion.label, /Maps matching “Siegfriedkarte”/);
  assert.equal(suggestion.origin, expected === 1 ? '1 record' : `${expected} records`);
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

/* ------------------------------------------------------------------ *
 * Spelling: “Zuerich” must find “Zürich” (7-19, maps-2)
 * ------------------------------------------------------------------ */

test('the ASCII transcription of an umlaut finds the umlaut spelling (and vice versa)', () => {
  const count = (query) => records.filter((record) => matchesQuery(record, query)).length;
  const umlaut = count('Zürich');
  assert.ok(umlaut > 0, 'the committed seed names Zürich');
  // Before the folding, “Zuerich” found 0 of the 138 records that “Zürich”
  // finds; a Swiss keyboard types the digraph, so the box was unusable for it.
  assert.equal(count('Zuerich'), umlaut);
  assert.equal(count('zuerich'), umlaut);
  // …and the plain form without the umlaut at all.
  assert.equal(count('Zurich'), umlaut);
  assert.equal(count('ZÜRICH'), umlaut);
  // A compound name folded the same way, not just the bare place name.
  assert.equal(count('Zuerichsee'), count('Zürichsee'));
  assert.ok(count('Zürichsee') > 0);
});

test('diacritics outside German fold the same way', () => {
  const count = (query) => records.filter((record) => matchesQuery(record, query)).length;
  assert.ok(count('Genève') > 0, 'the seed carries a Genève record');
  assert.equal(count('Geneve'), count('Genève'));
  assert.equal(count('geneve'), count('Genève'));
});

test('ß folds to ss, so either spelling finds the other', () => {
  const record = {
    id: 'e-rara:999',
    title: 'Grosse Karte des Kantons Zürich',
    creators: ['Murer, Jos'],
    providerId: 'e-rara',
    institution: 'Zentralbibliothek Zürich',
    rights: 'Public Domain Mark',
    recordUrl: 'https://www.e-rara.ch/doi/10.3931/e-rara-999',
    thumbnail: 'https://www.e-rara.ch/i3f/v20/999/full/304/0/default.jpg',
    yearStart: 1600,
    yearEnd: 1600,
  };
  assert.ok(matchesQuery(record, 'grosse'));
  assert.ok(matchesQuery(record, 'große'), 'the ß spelling must find the ss spelling');
  assert.ok(matchesQuery(record, 'zuerich'));
  // Folding widens the *spelling*, never the meaning: an unrelated word still
  // matches nothing.
  assert.ok(!matchesQuery(record, 'basel'));
  assert.ok(!matchesQuery(record, 'grossraum'));
});

test('mixed spellings inside one multi-token query still have to match together', () => {
  const hits = records.filter((record) => matchesQuery(record, 'wildkarte zuerich'));
  assert.ok(hits.length > 0, '“Wildkarte” + “Zürich” in one query');
  assert.ok(hits.every((record) => matchesQuery(record, 'Zürich')));
  assert.equal(records.filter((record) => matchesQuery(record, 'wildkarte zzz')).length, 0);
});

test('the “Karten zum Stichwort …” offer counts the folded search honestly', () => {
  const state = { from: 1500, to: 2025, q: '', provider: '', type: '', collection: '', at: '', viewport: '' };
  for (const query of ['Zuerich', 'Zürichsee', 'Geneve']) {
    const suggestion = datasetSuggestion(records, query, state);
    const rows = filterRecords({ ...state, q: query }, records).length;
    assert.ok(rows > 0, `${query}: expected matches in the committed seed`);
    assert.equal(suggestion.count, rows, `${query}: the offer must not promise a different count`);
    assert.equal(suggestion.query, query, `${query}: the offer applies what was typed`);
  }
});

test('a digraph query also reaches a record that already spells the name without the umlaut', () => {
  const record = { id: 'fixture:zurichgow', title: 'Zurichgow et Basiliensis provincia', creators: [], institution: 'Fixture' };
  assert.equal(matchesQuery(record, 'Zürich'), true);
  assert.equal(matchesQuery(record, 'Zuerich'), true);
  assert.equal(matchesQuery(record, 'Zurich'), true);
  const umlaut = { id: 'fixture:zurich', title: 'Plan der Statt Zürich', creators: [], institution: 'Fixture' };
  assert.equal(matchesQuery(umlaut, 'Zuerich'), true);
  assert.equal(matchesQuery(umlaut, 'Zurich'), true);
});
