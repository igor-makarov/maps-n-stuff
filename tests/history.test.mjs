/**
 * Browser history navigation (back/forward) for the URL-backed state.
 *
 * The whole product promises shareable state, so the browser buttons have to
 * walk the same path the user took: a search or a selection is a history step,
 * while panning the map and dragging the year control must not flood the
 * history. These tests drive a fake history/location/window so they run in
 * plain Node (no jsdom, like the rest of the suite).
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { HISTORY_COALESCE_MS, HISTORY_PUSH_KEYS, STATE_DEFAULTS, createStore } from '../public/app/store.js';

/** A stand-in for window.history + window.location + window. */
function fakeBrowser(startUrl = '/?from=1754') {
  const listeners = new Map();
  const location = { pathname: '/', search: '', hash: '' };
  const calls = [];

  const apply = (url) => {
    const parsed = new URL(String(url), 'http://localhost');
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  const history = {
    length: 1,
    pushState(_state, _title, url) {
      calls.push(['push', String(url)]);
      history.length += 1;
      apply(url);
    },
    replaceState(_state, _title, url) {
      calls.push(['replace', String(url)]);
      apply(url);
    },
  };
  const win = {
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
  };
  const emit = (type, detail = {}) => {
    for (const fn of listeners.get(type) ?? []) fn({ type, ...detail });
  };
  apply(startUrl);
  return {
    history,
    location,
    win,
    calls,
    /** Simulate the browser moving to another entry (back/forward button). */
    popTo: (url) => {
      apply(url);
      emit('popstate');
    },
    /** Simulate the first real user interaction (the store pushes only after one). */
    act: () => emit('pointerdown'),
    /** A programmatic activation: `click` alone, as a screen reader or `el.click()` sends it. */
    click: () => emit('click'),
    url: () => `${location.pathname}${location.search}${location.hash}`,
    kinds: () => calls.map(([kind]) => kind),
  };
}

/** A store wired to a fake browser and a hand-cranked clock. */
function makeStore(startUrl = '/') {
  const browser = fakeBrowser(startUrl);
  let clock = 1_000_000;
  const store = createStore({
    history: browser.history,
    location: browser.location,
    window: browser.win,
    now: () => clock,
  });
  return { browser, store, tick: (ms) => (clock += ms) };
}

test('the push keys are the deliberate search/selection steps, never the view', () => {
  for (const key of ['q', 'from', 'to', 'collection', 'at', 'place', 'selected']) {
    assert.ok(HISTORY_PUSH_KEYS.includes(key), `${key} should open a history entry`);
  }
  for (const key of ['lat', 'lon', 'zoom', 'sheet', 'vv', 'extents', 'view', 'sort', 'overlay', 'otime', 'cmp']) {
    assert.equal(HISTORY_PUSH_KEYS.includes(key), false, `${key} must only replace the current entry`);
  }
});

test('a search or a selection opens a history entry; panning replaces the current one', () => {
  const { browser, store } = makeStore('/');
  browser.act();

  store.update({ q: 'rheinau' });
  assert.deepEqual(browser.calls.at(-1), ['push', '/?q=rheinau'], 'a search is a history step');

  store.update({ lat: 47.4, lon: 8.6, zoom: 13 });
  assert.equal(browser.calls.at(-1)[0], 'replace', 'panning must not add an entry');
  assert.equal(browser.url(), '/?q=rheinau&lat=47.4000&lon=8.6000&z=13');

  store.update({ selected: 'e-rara:22142031' });
  assert.deepEqual(browser.calls.at(-1), ['push', '/?q=rheinau&lat=47.4000&lon=8.6000&z=13&sel=e-rara%3A22142031']);

  store.update({ sheet: 3 });
  assert.equal(browser.calls.at(-1)[0], 'replace', 'walking the sheets of a work is not a history step');

  store.update({ view: 'map' });
  assert.equal(browser.calls.at(-1)[0], 'replace', 'choosing a view is not a history step');
});

test('typing and dragging coalesce into one entry per gesture', () => {
  const { browser, store, tick } = makeStore('/');
  browser.act();

  for (const text of ['r', 'rh', 'rhe', 'rhei']) {
    tick(80); // keystrokes are milliseconds apart
    store.update({ q: text });
  }
  const pushes = browser.calls.filter(([kind]) => kind === 'push');
  assert.equal(pushes.length, 1, 'four keystrokes are one entry');
  assert.equal(pushes[0][1], '/?q=r');
  assert.equal(browser.url(), '/?q=rhei', 'the latest text still lands in the URL');
  assert.equal(browser.history.length, 2, 'one extra entry, not one per keystroke');

  // A later gesture on the same control is its own entry again.
  tick(HISTORY_COALESCE_MS + 1);
  store.update({ q: 'rheinau' });
  assert.equal(browser.calls.at(-1)[0], 'push');
  assert.equal(browser.history.length, 3);

  // A drag of the year control is one entry, even with the knob moving a lot.
  const before = browser.history.length;
  for (const year of [1600, 1610, 1620, 1630]) {
    tick(60);
    store.update({ from: year });
  }
  assert.equal(browser.history.length, before + 1, 'a slider drag is a single step');
  assert.equal(browser.url(), '/?q=rheinau&from=1630');

  // A gesture that lasts longer than the window stays one entry as long as the
  // changes keep arriving — otherwise a slow drag would push halfway through.
  tick(HISTORY_COALESCE_MS + 1);
  const longStart = browser.history.length;
  for (let i = 0; i < 12; i += 1) {
    tick(500); // twice the window from the entry, well inside it from the last change
    store.update({ from: 1700 + i });
  }
  assert.equal(browser.history.length, longStart + 1, '12 slow steps are still one gesture');
  assert.equal(browser.url(), '/?q=rheinau&from=1711');
});

test('the app repairing its own start-up state does not open a history entry', () => {
  // A plain page load has from=1500 (the default); the data only starts in 1754,
  // so results.js clamps the year range as soon as the records arrive. That
  // repair must stay in the entry the visitor arrived on.
  const { browser, store } = makeStore('/');
  store.update({ from: 1754 });
  assert.deepEqual(browser.calls.at(-1), ['replace', '/?from=1754'], 'start-up repair replaces');
  assert.equal(browser.history.length, 1, 'the visitor still has one entry');

  // Everything the visitor asks for afterwards is a step again.
  browser.act();
  store.update({ q: 'uster' });
  assert.equal(browser.calls.at(-1)[0], 'push');
  assert.equal(browser.history.length, 2);
});

test('a bare click event counts as the interaction too (screen reader, el.click())', () => {
  const { browser, store } = makeStore('/');
  store.update({ from: 1754 }); // start-up repair, replaces
  browser.click();
  store.update({ selected: 'e-rara:22142031' });
  assert.equal(browser.calls.at(-1)[0], 'push', 'the first bare click already opens history');
});

test('popstate re-reads the URL and notifies exactly like an update (back and forward)', () => {
  const { browser, store, tick } = makeStore('/?from=1754');
  const seen = [];
  store.subscribe((state, changed) => seen.push([state, changed.join(',')]));
  browser.act();

  // The user opens a record: a new entry.
  store.update({ selected: 'e-rara:22142031' });
  assert.equal(browser.url(), '/?from=1754&sel=e-rara%3A22142031');

  // Back: the browser is on the previous entry again.
  tick(10_000);
  browser.popTo('/?from=1754');
  assert.equal(store.getState().selected, '', 'back closes the record');
  assert.equal(seen.at(-1)[1], 'selected', 'the modules hear about the change');
  assert.equal(seen.length, 2);

  // Forward: the record comes back.
  tick(10_000);
  browser.popTo('/?from=1754&sel=e-rara%3A22142031');
  assert.equal(store.getState().selected, 'e-rara:22142031');
  assert.equal(seen.at(-1)[1], 'selected');

  // A popstate that changes nothing (a hash-only move, for example) is silent.
  const before = seen.length;
  browser.popTo('/?from=1754&sel=e-rara%3A22142031#about');
  assert.equal(seen.length, before, 'no notification without a state change');
});

test('a view writing clamped state back right after a back press does not add an entry', () => {
  const { browser, store, tick } = makeStore('/?from=1754');
  browser.act();
  store.update({ selected: 'e-rara:22142031', sheet: 9 });
  tick(10_000);
  browser.popTo('/?from=1754&sel=e-rara%3A22142031');

  const entries = browser.history.length;
  store.update({ sheet: 2 }); // detail.js clamping a sheet number to the manifest
  assert.equal(browser.calls.at(-1)[0], 'replace');
  assert.equal(browser.history.length, entries, 'no new entry while the pop is being applied');
  assert.equal(browser.url(), '/?from=1754&sel=e-rara%3A22142031&sh=2');
});

test('the URL is only written when it really changes, and the fragment survives', () => {
  const { browser, store } = makeStore('/?q=rheinau');
  browser.act();
  const before = browser.calls.length;
  store.update({ q: 'rheinau' }); // no state change at all
  assert.equal(browser.calls.length, before, 'a no-op writes nothing');

  browser.location.hash = '#map';
  store.update({ from: 1800 });
  assert.equal(browser.url(), '/?q=rheinau&from=1800#map', 'the fragment is kept');
  assert.equal(browser.calls.at(-1)[0], 'push');
});

test('a hand-written URL with junk still restores sane state on popstate', () => {
  const { browser, store } = makeStore('/');
  browser.popTo('/?from=1900&to=1500&z=99&lat=NaN&view=hologram&sel=e-rara:22142031');
  const state = store.getState();
  assert.equal(state.from, 1500);
  assert.equal(state.to, 1900);
  assert.equal(state.zoom, 18);
  assert.equal(state.lat, STATE_DEFAULTS.lat);
  assert.equal(state.view, STATE_DEFAULTS.view);
  assert.equal(state.selected, 'e-rara:22142031');
});

test('without history/location the store keeps working and applyUrl is a no-op', () => {
  const store = createStore({ history: null, location: null, window: null });
  assert.deepEqual(store.applyUrl(), []);
  store.update({ selected: 'e-rara:22142031' });
  assert.equal(store.getState().selected, 'e-rara:22142031');
});
