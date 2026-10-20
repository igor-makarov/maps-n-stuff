/**
 * URL-backed state + event bus tests (coordination/README.md D4).
 *
 * The store is what makes searches and selections shareable, so the URL
 * round-trip (state -> query -> state) and the "hand-written URL cannot break
 * the UI" rule are worth pinning down.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { PARAM, STATE_DEFAULTS, createBus, createStore, readStateFromUrl, sanitise, stateToQuery } from '../public/app/store.js';

test('zero latitude remains the equator in state and shared map positions', () => {
  const state = sanitise({ ...STATE_DEFAULTS, lat: 0 });
  assert.equal(state.lat, 0);
  assert.equal(readStateFromUrl(stateToQuery(state)).lat, 0);
  assert.equal(sanitise({ ...STATE_DEFAULTS, lat: NaN }).lat, STATE_DEFAULTS.lat);
});

test('defaults describe the documented worldwide initial view', () => {
  // Corrected product scope (2026-10-19): the atlas opens on the world, not on
  // one canton. The old Swiss-first default was removed with the redirect.
  assert.equal(STATE_DEFAULTS.lat, 20);
  assert.equal(STATE_DEFAULTS.lon, 0);
  assert.ok(STATE_DEFAULTS.zoom <= 4, 'the initial zoom must show the whole world');
  assert.equal(STATE_DEFAULTS.selected, '');
  assert.equal(STATE_DEFAULTS.view, 'split');
});

test('readStateFromUrl reads the short shareable parameters', () => {
  const state = readStateFromUrl(`?${new URLSearchParams({ q: 'rheinau', from: '1790', to: '1880', p: 'e-rara', place: 'Rheinau', lat: '47.64', lon: '8.60', z: '13', sel: 'e-rara:11' })}`);
  assert.equal(state.q, 'rheinau');
  assert.equal(state.from, 1790);
  assert.equal(state.to, 1880);
  assert.equal(state.provider, 'e-rara');
  assert.equal(state.place, 'Rheinau');
  assert.equal(state.lat, 47.64);
  assert.equal(state.lon, 8.6);
  assert.equal(state.zoom, 13);
  assert.equal(state.selected, 'e-rara:11');
});

test('stateToQuery omits defaults and round-trips through readStateFromUrl', () => {
  const query = stateToQuery({ ...STATE_DEFAULTS, q: 'uster', from: 1700, selected: 'e-rara:11' });
  const params = new URLSearchParams(query);
  assert.equal(params.get(PARAM.q), 'uster');
  assert.equal(params.has(PARAM.lat), false, 'default view is not repeated in the URL');
  const back = readStateFromUrl(`?${query}`);
  assert.equal(back.q, 'uster');
  assert.equal(back.from, 1700);
  assert.equal(back.selected, 'e-rara:11');
  assert.equal(back.lat, STATE_DEFAULTS.lat);
});

test('sanitise keeps a hand-written URL from breaking the UI', () => {
  const state = sanitise({ ...STATE_DEFAULTS, from: 1900, to: 1500, lat: 'NaN', lon: 900, zoom: 99, view: 'hologram', sort: 'random', q: 'x'.repeat(500) });
  assert.equal(state.from, 1500, 'from/to are ordered');
  assert.equal(state.to, 1900);
  assert.equal(state.lat, STATE_DEFAULTS.lat);
  assert.ok(state.lon >= -180 && state.lon <= 180);
  assert.equal(state.zoom, 18);
  assert.equal(state.view, STATE_DEFAULTS.view);
  assert.equal(state.sort, STATE_DEFAULTS.sort);
  assert.equal(state.q.length, 200, 'free text is capped');
});

test('the sheet number round-trips through the URL and is clamped by sanitise', () => {
  assert.equal(STATE_DEFAULTS.sheet, 1, 'a work starts on its first sheet');
  const query = stateToQuery({ ...STATE_DEFAULTS, selected: 'e-rara:11', sheet: 3 });
  const params = new URLSearchParams(query);
  assert.equal(params.get(PARAM.sheet), '3');
  const back = readStateFromUrl(`?${query}`);
  assert.equal(back.selected, 'e-rara:11');
  assert.equal(back.sheet, 3);
  assert.equal(new URLSearchParams(stateToQuery({ ...STATE_DEFAULTS, sheet: 1 })).has(PARAM.sheet), false, 'sheet 1 is the default and stays out of the URL');
  assert.equal(sanitise({ ...STATE_DEFAULTS, sheet: 0 }).sheet, 1);
  assert.equal(sanitise({ ...STATE_DEFAULTS, sheet: -4 }).sheet, 1);
  assert.equal(sanitise({ ...STATE_DEFAULTS, sheet: 9999 }).sheet, 999);
  assert.equal(sanitise({ ...STATE_DEFAULTS, sheet: 'quatsch' }).sheet, 1);
  assert.equal(sanitise({ ...STATE_DEFAULTS, sheet: '2.7' }).sheet, 2, 'fractional sheet numbers are floored');
});

test('the viewer region round-trips through the URL and only keeps the exact shape', () => {
  assert.equal(STATE_DEFAULTS.vv, '', 'the whole sheet is the default and has no parameter');
  const query = stateToQuery({ ...STATE_DEFAULTS, selected: 'e-rara:11', vv: '1160,2395,1487,824' });
  const params = new URLSearchParams(query);
  assert.equal(params.get(PARAM.vv), '1160,2395,1487,824');
  const back = readStateFromUrl(`?${query}`);
  assert.equal(back.selected, 'e-rara:11');
  assert.equal(back.vv, '1160,2395,1487,824');
  assert.equal(new URLSearchParams(stateToQuery({ ...STATE_DEFAULTS, vv: '' })).has(PARAM.vv), false);
  // A hand-edited value cannot reach the viewer: only "x,y,w,h" in plain digits is kept.
  assert.equal(sanitise({ ...STATE_DEFAULTS, vv: '0,0,1000' }).vv, '');
  assert.equal(sanitise({ ...STATE_DEFAULTS, vv: '0,0,1000,1000,5' }).vv, '');
  assert.equal(sanitise({ ...STATE_DEFAULTS, vv: 'javascript:alert(1)' }).vv, '');
  assert.equal(sanitise({ ...STATE_DEFAULTS, vv: '1e3,0,500,500' }).vv, '');
  assert.equal(sanitise({ ...STATE_DEFAULTS, vv: ' 1,2,3,4 ' }).vv, '', 'whitespace is not normalised silently');
  assert.equal(sanitise({ ...STATE_DEFAULTS, vv: '1234567,0,500,500' }).vv, '', 'absurdly large coordinates are dropped');
});

test('createStore updates, notifies subscribers with changed keys and stays silent on no-ops', () => {
  const store = createStore({ initial: { q: '' } });
  const seen = [];
  const off = store.subscribe((state, changed) => seen.push([state.q, changed.join(',')]));

  store.update({ q: 'brack', nonsense: 'ignored' });
  assert.equal(store.getState().q, 'brack');
  assert.equal(store.getState().nonsense, undefined, 'unknown keys are ignored');

  store.update({ q: 'brack' }); // no change -> no notification
  store.update({ from: STATE_DEFAULTS.from - 5 }, { silent: true });

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ['brack', 'q']);

  off();
  store.update({ q: 'other' });
  assert.equal(seen.length, 1, 'unsubscribe stops notifications');
});

test('createStore falls back to in-memory state when history/location are unavailable', () => {
  const store = createStore({ history: null, location: null });
  const state = store.update({ q: 'zürich', zoom: 14 });
  assert.equal(state.q, 'zürich');
  assert.equal(store.getState().zoom, 14);
});

test('the bus keeps one failing listener from taking down the others', () => {
  const bus = createBus();
  const calls = [];
  bus.on('ping', () => {
    throw new Error('boom');
  });
  bus.on('ping', (detail) => calls.push(detail));
  const originalError = console.error;
  console.error = () => {};
  try {
    bus.emit('ping', { ok: true });
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(calls, [{ ok: true }]);
});
