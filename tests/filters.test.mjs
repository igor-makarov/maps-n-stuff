/**
 * Collection ("Kartenwerk") filter + facet counts (maps-2).
 *
 * The UI exposes the collection facet from `facets(records).collections` and the
 * URL key `c`. Both are covered here so a data refresh or a store change cannot
 * silently drop the filter.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { STATE_DEFAULTS, readStateFromUrl, stateToQuery } from '../public/app/store.js';
import { facets, filterRecords } from '../public/app/records.js';
import { readCatalogue } from '../scripts/catalogue.mjs';

const records = (await readCatalogue()).records;

test('collection defaults to "all" and is not repeated in the URL', () => {
  assert.equal(STATE_DEFAULTS.collection, '');
  assert.equal(stateToQuery({ ...STATE_DEFAULTS }), '');
});

test('collection round-trips through the shareable URL key "c"', () => {
  const series = 'Siegfriedkarte 1:25 000';
  const query = stateToQuery({ ...STATE_DEFAULTS, collection: series, from: 1850 });
  const params = new URLSearchParams(query);
  assert.equal(params.get('c'), series);
  const back = readStateFromUrl(`?${query}`);
  assert.equal(back.collection, series);
  assert.equal(back.from, 1850);
});

test('a hand-written URL cannot smuggle an over-long collection value', () => {
  const back = readStateFromUrl(`?c=${'x'.repeat(400)}`);
  assert.equal(back.collection.length, 120);
});

test('filterRecords honours the collection together with time and provider', () => {
  const series = [...new Set(records.map((r) => r.collection).filter(Boolean))].sort();
  assert.ok(series.length > 0, 'the committed seed must carry at least one collection');
  const target = series[0];
  const filtered = filterRecords({ collection: target, from: 0, to: 9999 }, records);
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((r) => r.collection === target));
  const withProvider = filterRecords({ collection: target, provider: filtered[0].providerId, from: 0, to: 9999 }, records);
  assert.ok(withProvider.every((r) => r.collection === target && r.providerId === filtered[0].providerId));
  assert.ok(withProvider.length <= filtered.length);
});

test('facets count exactly the committed collection values', () => {
  const { collections } = facets(records);
  const withCollection = records.filter((r) => r.collection);
  assert.equal([...collections.values()].reduce((sum, n) => sum + n, 0), withCollection.length);
  for (const [name, count] of collections) {
    assert.equal(count, withCollection.filter((r) => r.collection === name).length, `${name} count`);
  }
  // No invented series: every facet name comes from a record.
  assert.ok([...collections.keys()].every((name) => withCollection.some((r) => r.collection === name)));
});
