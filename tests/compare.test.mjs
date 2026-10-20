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
import { formatCompareViews, parseCompareViews } from '../public/app/iiif.js';

test('institutional identifiers with nested namespaces survive comparison links', () => {
  const id = 'leventhal:commonwealth:abcd123';
  const region = '0,0,100,100';
  const state = sanitise({ ...STATE_DEFAULTS, cmp: id, cvv: `${id}@${region}` });
  const restored = readStateFromUrl(stateToQuery(state));
  assert.equal(restored.cmp, id);
  assert.equal(restored.cvv, `${id}@${region}`);
  assert.equal(parseCompareViews(restored.cvv).get(id), region);
  assert.equal(formatCompareViews(new Map([[id, region]])), `${id}@${region}`);
});

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

/**
 * `cvv` carries the cut-outs of the comparison panes (`id@x,y,w,h`, maps-3).
 * It is hand-editable like every other parameter and must agree with the codec
 * the comparison view writes (`formatCompareViews`/`parseCompareViews`).
 */
test('cvv keeps one region per pinned record and drops everything else', () => {
  const good = 'e-rara:8602401@1160,2395,1487,824;e-rara:8751735@10,20,30,40';
  const state = sanitise({ ...STATE_DEFAULTS, cvv: good });
  assert.equal(state.cvv, good, 'real ids and regions survive sanitising');
  assert.equal(state.cvv, formatCompareViews([...parseCompareViews(good)]), 'the store keeps exactly what the codec writes');

  const junk = sanitise({
    ...STATE_DEFAULTS,
    cvv: '<img src=x onerror=1>@1,2,3,4;;  ,@1,2,3,4;e-rara:1@-1,2,3,4;e-rara:1@1,2,3,4,5;e-rara:2@1,2,3,4',
  });
  assert.equal(junk.cvv, 'e-rara:2@1,2,3,4');
  assert.equal(sanitise({ ...STATE_DEFAULTS, cvv: 'e-rara:1@' }).cvv, '');
  assert.equal(sanitise({ ...STATE_DEFAULTS, cvv: ['e-rara:1', '1,2,3,4'] }).cvv, '', 'an array never becomes a region list');
});

test('cvv keeps at most the four comparison panes and round-trips through the URL', () => {
  const many = Array.from({ length: 7 }, (_, i) => `e-rara:${i + 1}@${i + 1},20,30,40`).join(';');
  const state = sanitise({ ...STATE_DEFAULTS, cvv: many });
  assert.equal(state.cvv.split(';').length, 4);

  const query = stateToQuery({ ...STATE_DEFAULTS, cmp: 'e-rara:1,e-rara:2', cvv: 'e-rara:1@10,20,30,40;e-rara:2@50,60,70,80' });
  assert.equal(new URLSearchParams(query).get(PARAM.cvv), 'e-rara:1@10,20,30,40;e-rara:2@50,60,70,80');
  assert.equal(readStateFromUrl(`?${query}`).cvv, 'e-rara:1@10,20,30,40;e-rara:2@50,60,70,80');
  assert.equal(new URLSearchParams(stateToQuery(STATE_DEFAULTS)).has(PARAM.cvv), false, 'no cut-outs, no parameter');
  assert.equal(readStateFromUrl('?cvv=').cvv, '');
});

test('the comparison view restores, writes back and resets its cut-outs', async () => {
  const source = await readFile(new URL('../public/app/compare.js', import.meta.url), 'utf8');
  assert.match(source, /parseCompareViews\(ctx\.store\.getState\(\)\.cvv\)/, "each pane restores the link's cut-out");
  assert.match(source, /update\(\{ cvv: value \}\)/, 'a view change is written back as the shareable cvv value');
  assert.match(source, /'data-compare-reset'/, 'each viewer pane carries its own “Ganzes Blatt” reset');
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

/**
 * The coupling state of the comparison panes (`csync`). Coupled is the
 * documented default and stays out of the URL; only “uncoupled” travels in a
 * link, so a comparison link reproduces the view it names instead of silently
 * re-coupling sheets the sender had decoupled (D13).
 */
test('csync defaults to coupled and only "uncoupled" reaches the URL', () => {
  assert.equal(STATE_DEFAULTS.csync, '1');
  assert.equal(new URLSearchParams(stateToQuery(STATE_DEFAULTS)).has(PARAM.csync), false, 'coupled is the default and not repeated');
  assert.equal(new URLSearchParams(stateToQuery({ ...STATE_DEFAULTS, csync: '1' })).has(PARAM.csync), false);

  const uncoupled = stateToQuery({ ...STATE_DEFAULTS, csync: '0' });
  assert.equal(new URLSearchParams(uncoupled).get(PARAM.csync), '0');
  assert.equal(readStateFromUrl(`?${uncoupled}`).csync, '0');
});

test('csync is a flag: junk, empty values and lookalikes fall back to coupled', () => {
  for (const raw of ['', 'maybe', '2', 'yes', 'csync']) {
    assert.equal(sanitise({ ...STATE_DEFAULTS, csync: raw }).csync, '1', `"${raw}" is not a decoupling request`);
  }
  assert.equal(sanitise({ ...STATE_DEFAULTS, csync: '0' }).csync, '0');
  assert.equal(sanitise({ ...STATE_DEFAULTS, csync: 'false' }).csync, '0');
});

test('a comparison link keeps its cut-outs and its coupling state together', () => {
  const state = { ...STATE_DEFAULTS, cmp: 'e-rara:6507640,e-rara:6484810', cvv: 'e-rara:6507640@10,20,30,40', csync: '0' };
  const back = readStateFromUrl(`?${stateToQuery(state)}`);
  assert.equal(back.cmp, state.cmp);
  assert.equal(back.cvv, state.cvv);
  assert.equal(back.csync, '0');
});
