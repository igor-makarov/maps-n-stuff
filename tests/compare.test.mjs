/**
 * Tests for the comparison list's shareable state (`cmp`, maps-1).
 *
 * The compare list is a hand-editable URL value, so the interesting cases are
 * hostile or sloppy links: unknown ids, more than four entries, ids that would
 * break the record lookup, and the round-trip through the URL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { PARAM, STATE_DEFAULTS, readStateFromUrl, sanitise, stateToQuery } from '../public/app/store.js';

test('cmp keeps real record ids (provider:value) intact', () => {
  const ids = ['e-rara:6507640', 'swisstopo:zeitreise-18441231'];
  const state = sanitise({ ...STATE_DEFAULTS, cmp: ids.join(',') });
  assert.equal(state.cmp, ids.join(','), 'the ":" of the data contract must survive sanitising');
});

test('cmp drops junk, empty entries and everything beyond four records', () => {
  const state = sanitise({
    ...STATE_DEFAULTS,
    cmp: 'e-rara:1,,  e-rara:2 ,<script>,../../etc/passwd,e-rara:3,e-rara:4,e-rara:5',
  });
  assert.equal(state.cmp, 'e-rara:1,e-rara:2,e-rara:3,e-rara:4');
  assert.ok(!state.cmp.includes('<'), 'markup never reaches the state');
  assert.ok(!state.cmp.includes('/'), 'path traversal never reaches the state');
});

test('cmp round-trips through the shareable URL', () => {
  const state = { ...STATE_DEFAULTS, from: 1600, to: 2021, cmp: 'e-rara:6507640,e-rara:6484810' };
  const query = stateToQuery(state);
  assert.equal(new URLSearchParams(query).get(PARAM.cmp), state.cmp);
  assert.equal(readStateFromUrl(`?${query}`).cmp, state.cmp);
});

test('an empty compare list stays out of the URL', () => {
  assert.equal(new URLSearchParams(stateToQuery(STATE_DEFAULTS)).has(PARAM.cmp), false);
  assert.equal(readStateFromUrl('?cmp=').cmp, '');
});

test('the compare module is wired into the shell as an optional module', async () => {
  const [main, html] = await Promise.all([
    readFile(new URL('../public/app/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../public/index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(main, /'compare',\s*'\.\/compare\.js'/, 'main.js loads the compare module');
  for (const id of ['compare-panel', 'compare-list', 'compare-add', 'compare-clear', 'compare-status', 'compare-view', 'compare-view-body', 'compare-view-close']) {
    assert.ok(html.includes(`id="${id}"`), `index.html provides #${id}`);
  }
});

/**
 * Device-local “Merkliste” (the brief's saved maps). The shareable `?cmp=` link
 * stays authoritative; the stored list is only read when a page load carries no
 * list at all. Storage access must never throw into the app (private mode).
 */
test('the saved list is read from localStorage under its versioned key only', async () => {
  const { readStoredIds, writeStoredIds } = await import('../public/app/compare.js');
  const store = new Map();
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
  };
  try {
    assert.deepEqual(readStoredIds(), [], 'no saved list means an empty list');

    writeStoredIds(['e-rara:6507640', 'e-rara:6484810']);
    assert.equal(store.get('kartenzeit.cmp.v1'), JSON.stringify(['e-rara:6507640', 'e-rara:6484810']));
    assert.deepEqual(readStoredIds(), ['e-rara:6507640', 'e-rara:6484810']);

    // Hostile or stale values: junk, duplicates, separators, too many entries.
    store.set('kartenzeit.cmp.v1', JSON.stringify(['e-rara:1', 'e-rara:1', '', 'a,b', 42, 'e-rara:2', 'e-rara:3', 'e-rara:4', 'e-rara:5']));
    assert.deepEqual(readStoredIds(), ['e-rara:1', 'e-rara:2', 'e-rara:3', 'e-rara:4']);
    store.set('kartenzeit.cmp.v1', '{not json');
    assert.deepEqual(readStoredIds(), [], 'a corrupt value is ignored, not thrown');

    // Clearing removes the entry instead of leaving an empty list behind.
    writeStoredIds([]);
    assert.equal(store.has('kartenzeit.cmp.v1'), false);
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});

test('storage failures stay silent (private mode, disabled storage)', async () => {
  const { readStoredIds, writeStoredIds } = await import('../public/app/compare.js');
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => {
      throw new Error('SecurityError: storage disabled');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
    removeItem: () => {
      throw new Error('SecurityError: storage disabled');
    },
  };
  try {
    assert.deepEqual(readStoredIds(), []);
    assert.doesNotThrow(() => writeStoredIds(['e-rara:1']));
    assert.doesNotThrow(() => writeStoredIds([]));
  } finally {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  }
});
