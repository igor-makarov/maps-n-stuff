/**
 * Map marker clustering (maps-2).
 *
 * The seed has grown past 80 records; at country zoom many markers share one
 * screen position. `clusterByCell` groups projected pixel points into grid
 * cells so `map.js` can draw one numbered cluster per cell instead of a pile of
 * overlapping pins. It is deliberately pure (global pixel coordinates in, cells
 * out) so the grouping can be tested without a DOM or tiles.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_LAYERS,
  CLUSTER_CELL,
  DEFAULT_BASE,
  MAX_ZOOM,
  baseLayerFor,
  clusterAnchorKey,
  clusterByCell,
  clusterCanSplit,
  clusterRecords,
  extentRects,
  latToTileY,
  lonToTileX,
  markerPoints,
  tileUrl,
} from '../public/app/map.js';
import { STATE_DEFAULTS, sanitise, stateToQuery } from '../public/app/store.js';

test('points in one cell become one cluster with a centroid and a count', () => {
  const cells = clusterByCell([
    { id: 'a', x: 10, y: 10 },
    { id: 'b', x: 20, y: 30 },
    { id: 'c', x: 40, y: 20 },
  ]);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].count, 3);
  assert.deepEqual(cells[0].members.map((m) => m.id), ['a', 'b', 'c']);
  assert.equal(cells[0].x, (10 + 20 + 40) / 3);
  assert.equal(cells[0].y, (10 + 30 + 20) / 3);
});

test('points in different cells stay separate (the 56 px grid boundary)', () => {
  const cells = clusterByCell([
    { id: 'left', x: CLUSTER_CELL - 1, y: 5 },
    { id: 'right', x: CLUSTER_CELL, y: 5 },
    { id: 'below', x: 5, y: CLUSTER_CELL + 1 },
  ]);
  assert.equal(cells.length, 3);
  assert.deepEqual(
    cells.map((cell) => cell.members[0].id).sort(),
    ['below', 'left', 'right'],
  );
});

test('cell keys are stable while panning (same points, shifted viewport)', () => {
  const points = [
    { id: 'a', x: 100, y: 100 },
    { id: 'b', x: 110, y: 96 },
  ];
  const before = clusterByCell(points);
  const after = clusterByCell(points); // the viewport origin is not part of a point
  assert.equal(before.length, 1);
  assert.equal(after.length, 1);
  assert.deepEqual(before[0].members.map((m) => m.id), after[0].members.map((m) => m.id));
});

test('an empty record set produces no clusters', () => {
  assert.deepEqual(clusterByCell([]), []);
  assert.deepEqual(clusterByCell(undefined), []);
});

/* ---------------------------------------------------------------------------
 * “Ausschnitte”: pixel geometry of the documented footprints (maps-2).
 *
 * The map draws one rectangle per filtered record that states an extent. The
 * geometry is pure, so it can be checked without a DOM: which records are
 * on-screen, where the rectangle lands, and that the numbers come from the
 * documented extent only.
 * ------------------------------------------------------------------------ */

test('a documented extent becomes a pixel rectangle around its projection', () => {
  const record = { id: 'x', extent: { west: 8.5, east: 8.6, south: 47.3, north: 47.4 } };
  const view = { lat: 47.35, lon: 8.55, zoom: 11 };
  const size = { width: 640, height: 420 };
  const { rects, withExtent, filtered, visible } = extentRects([record], view, size);
  assert.equal(withExtent, 1);
  assert.equal(filtered, 1);
  assert.equal(visible, 1);
  assert.equal(rects.length, 1);
  const [rect] = rects;
  // Expected size straight from the shared Web-Mercator helpers (zoom 11).
  const expectedWidth = (lonToTileX(8.6, 11) - lonToTileX(8.5, 11)) * 256;
  const expectedHeight = (latToTileY(47.3, 11) - latToTileY(47.4, 11)) * 256;
  assert.ok(Math.abs(rect.width - expectedWidth) < 1e-9, `width ${rect.width} vs ${expectedWidth}`);
  assert.ok(Math.abs(rect.height - expectedHeight) < 1e-9, `height ${rect.height} vs ${expectedHeight}`);
  // The view centre lies inside a record that covers it.
  assert.ok(rect.left <= size.width / 2 && rect.left + rect.width >= size.width / 2);
  assert.ok(rect.top <= size.height / 2 && rect.top + rect.height >= size.height / 2);
});

test('records without an extent are counted, never drawn', () => {
  const records = [
    { id: 'has', extent: { west: 8.5, east: 8.6, south: 47.3, north: 47.4 } },
    { id: 'missing' },
    { id: 'broken', extent: { west: 'x', east: 8.6, south: 47.3, north: 47.4 } },
  ];
  const info = extentRects(records, { lat: 47.35, lon: 8.55, zoom: 11 }, { width: 640, height: 420 });
  assert.equal(info.filtered, 3);
  assert.equal(info.withExtent, 1);
  assert.deepEqual(info.rects.flatMap((r) => r.ids), ['has']);
});

test('footprints off the current view are not returned (margin respected)', () => {
  const view = { lat: 47.3769, lon: 8.5417, zoom: 12 };
  const size = { width: 640, height: 420 };
  const near = { id: 'near', extent: { west: 8.53, east: 8.55, south: 47.37, north: 47.385 } };
  const far = { id: 'far', extent: { west: 5.9, east: 6.0, south: 46.2, north: 46.3 } }; // Geneva
  const info = extentRects([near, far], view, size);
  assert.deepEqual(info.rects.flatMap((r) => r.ids), ['near']);
  assert.equal(info.visible, 1);
  assert.equal(info.withExtent, 2);
});

test('inverted bounds are normalised, and the largest footprint sorts first', () => {
  const inverted = { id: 'inverted', extent: { west: 8.6, east: 8.5, south: 47.4, north: 47.3 } };
  const big = { id: 'big', extent: { west: 8.0, east: 9.0, south: 47.0, north: 48.0 } };
  const normal = { id: 'normal', extent: { west: 8.5, east: 8.6, south: 47.3, north: 47.4 } };
  const info = extentRects([inverted, normal, big], { lat: 47.35, lon: 8.55, zoom: 11 }, { width: 640, height: 420 });
  assert.equal(info.visible, 3);
  assert.equal(info.areas, 2); // “inverted” and “normal” state the same box
  const small = info.rects.find((r) => r.ids.includes('inverted'));
  assert.deepEqual(small.ids, ['inverted', 'normal']);
  assert.ok(small.width > 0 && small.height > 0);
  const expectedWidth = (lonToTileX(8.6, 11) - lonToTileX(8.5, 11)) * 256;
  assert.ok(Math.abs(small.width - expectedWidth) < 1e-9);
  assert.equal(info.rects[0].ids[0], 'big'); // sorted largest-first
  assert.equal(info.rects.at(-1).ids[0], 'inverted');
});

test('the drawn set is capped, and the cap keeps the largest footprints', () => {
  const records = Array.from({ length: 20 }, (_, i) => ({
    id: `r${i}`,
    // r0 is the smallest, r19 the largest; all cover the view centre.
    extent: { west: 8.0 - i * 0.01, east: 9.0 + i * 0.01, south: 47.0 - i * 0.01, north: 48.0 + i * 0.01 },
  }));
  const info = extentRects(records, { lat: 47.5, lon: 8.5, zoom: 6 }, { width: 640, height: 420 }, { max: 5 });
  assert.equal(info.visible, 20);
  assert.equal(info.rects.length, 5);
  assert.deepEqual(info.rects.map((r) => r.ids[0]), ['r19', 'r18', 'r17', 'r16', 'r15']);
});

test('records that share one extent become one rectangle with all their ids', () => {
  const extent = { west: 5.14, east: 11.47, south: 45.4, north: 48.23 }; // swisstopo series extent
  const records = [
    { id: 'sheet-a', extent },
    { id: 'sheet-b', extent: { ...extent } },
    { id: 'other', extent: { west: 8.5, east: 8.6, south: 47.3, north: 47.4 } },
  ];
  const info = extentRects(records, { lat: 47.3769, lon: 8.5417, zoom: 12 }, { width: 640, height: 420 });
  assert.equal(info.withExtent, 3);
  assert.equal(info.visible, 3);
  assert.equal(info.areas, 2);
  const swiss = info.rects.find((r) => r.ids.length === 2);
  assert.deepEqual(swiss.ids.sort(), ['sheet-a', 'sheet-b']);
  assert.ok(info.rects[0].width > info.rects[1].width, 'country-wide extent first');
});

/* ------------------------------------------------------------------ Grundkarte */

test('every documented base map is a real swisstopo WMTS layer with attribution', () => {
  assert.equal(BASE_LAYERS.length, 3, 'farbig, grau and Luftbild are the documented choice');
  const keys = new Set();
  const ids = new Set();
  for (const layer of BASE_LAYERS) {
    assert.match(layer.key, /^[a-z0-9-]{1,24}$/, `URL-safe key: ${layer.key}`);
    assert.ok(!keys.has(layer.key), `unique key: ${layer.key}`);
    keys.add(layer.key);
    assert.match(layer.id, /^ch\.swisstopo\.[a-z0-9-]+$/, `official layer id: ${layer.id}`);
    assert.ok(!ids.has(layer.id), `unique id: ${layer.id}`);
    ids.add(layer.id);
    assert.match(layer.title, /\S/);
    assert.match(layer.chip, /\S/);
    assert.match(layer.hint, /\S/);
    // The tile template must be the public OGD endpoint and carry every
    // placeholder `tileUrl()` replaces – a typo would silently request one
    // endless tile.
    assert.ok(layer.urlTemplate.startsWith('https://wmts.geo.admin.ch/1.0.0/'), layer.urlTemplate);
    assert.ok(layer.urlTemplate.includes(`/${layer.id}/`), 'template serves the layer it names');
    for (const placeholder of ['{TileMatrix}', '{TileCol}', '{TileRow}']) {
      assert.ok(layer.urlTemplate.includes(placeholder), `${layer.id} needs ${placeholder}`);
    }
    // swisstopo publishes 3857_19 (zoom 0–18); the store clamps the zoom to 18.
    assert.ok(Number.isInteger(layer.maxZoom) && layer.maxZoom >= 15 && layer.maxZoom <= 18, `${layer.id} maxZoom ${layer.maxZoom}`);
    assert.match(layer.attribution, /^© swisstopo/, `${layer.id} must credit swisstopo`);
  }
});

test('baseLayerFor resolves the URL key and falls back to the default', () => {
  assert.equal(baseLayerFor('grau').id, 'ch.swisstopo.pixelkarte-grau');
  assert.equal(baseLayerFor('luftbild').id, 'ch.swisstopo.swissimage', 'the Luftbild key maps to SWISSIMAGE');
  assert.equal(baseLayerFor('farbe'), DEFAULT_BASE);
  // Empty, unknown, hand-edited or non-string values never break the map.
  for (const junk of ['', '  ', null, undefined, 'FARBE X', 'nope', 'ch.swisstopo.pixelkarte-grau', 42, {}, []]) {
    assert.equal(baseLayerFor(junk), DEFAULT_BASE, `fallback for ${JSON.stringify(junk)}`);
  }
  // Case and surrounding whitespace are tolerated (a hand-typed link).
  assert.equal(baseLayerFor('  GRAU ').key, 'grau');
});

test('each base map renders its own tile URL, without leftovers', () => {
  for (const layer of BASE_LAYERS) {
    const url = tileUrl(layer.urlTemplate, { z: 12, x: 2143, y: 1432 });
    assert.ok(url.includes(`/${layer.id}/`), url);
    assert.match(url, /\/12\/2143\/1432\.jpeg$/, url);
    assert.ok(!url.includes('{'), `no placeholder left in ${url}`);
  }
  assert.notEqual(
    tileUrl(BASE_LAYERS[1].urlTemplate, { z: 12, x: 2143, y: 1432 }),
    tileUrl(BASE_LAYERS[0].urlTemplate, { z: 12, x: 2143, y: 1432 }),
  );
});

test('the Grundkarte key is shareable URL state but never trusted blindly', () => {
  assert.equal(sanitise({ base: 'grau' }).base, 'grau');
  assert.equal(sanitise({ base: '' }).base, '');
  assert.equal(sanitise({ base: 'GR AU' }).base, '', 'only the documented shape survives');
  assert.equal(sanitise({ base: '<script>' }).base, '');
  assert.equal(sanitise({ base: 'x'.repeat(40) }).base, '');
  assert.equal(stateToQuery({ ...STATE_DEFAULTS, base: 'luftbild', from: 1781 }), 'from=1781&base=luftbild');
  assert.equal(stateToQuery({ ...STATE_DEFAULTS }), '', 'the default layer stays out of the URL');
});

/* ---------------------------------------------------------------------------
 * “Karten an diesem Punkt”: point piles cannot be split by zooming (maps-2).
 *
 * Ten groups in the seed share one documented anchor (six Zürich Stadtpläne on
 * 47.358330 / 8.533340, three on 47.341660 / 8.508330, …). Their pins keep
 * landing in the same 56 px cell at every zoom level and at MAX_ZOOM no cell
 * shrinks any further, so a click must offer the records instead of a zoom that
 * provably changes nothing. These three helpers decide that; they are pure.
 */
const pileMember = (id, yearStart, lat, lon, title = id) => ({
  id,
  record: { id, title, yearStart, yearEnd: yearStart, geo: { lat, lon } },
});

test('a cluster of records on different anchors can still be split by zooming', () => {
  const members = [pileMember('a', 1696, 47.35833, 8.53334), pileMember('b', 1838, 47.37, 8.54)];
  assert.equal(clusterCanSplit(members, 12), true);
  assert.equal(clusterCanSplit(members, 17), true);
});

test('a point pile cannot be split at any zoom — the click must open the list', () => {
  const pile = [pileMember('a', 1696, 47.35833, 8.53334), pileMember('b', 1705, 47.35833, 8.53334), pileMember('c', 1838, 47.35833, 8.53334)];
  for (const zoom of [4, 8, 12, 16, 17]) assert.equal(clusterCanSplit(pile, zoom), false, `zoom ${zoom}`);
});

test('deepest zoom cannot split even a mixed cluster, and a lone member needs no list', () => {
  const mixed = [pileMember('a', 1696, 47.35833, 8.53334), pileMember('b', 1838, 47.37, 8.54)];
  assert.equal(clusterCanSplit(mixed, MAX_ZOOM), false);
  assert.equal(clusterCanSplit(mixed, MAX_ZOOM + 1), false);
  assert.equal(clusterCanSplit([pileMember('a', 1696, 47.35833, 8.53334)], 12), true);
  assert.equal(clusterCanSplit([], 12), true);
  assert.equal(clusterCanSplit(undefined, 12), true);
});

test('a record without a point is keyed by its documented extent centre', () => {
  assert.equal(clusterAnchorKey({ extent: { west: 8, east: 9, south: 47, north: 48 } }), '47.500000:8.500000');
  assert.equal(clusterAnchorKey({}), '');
  const anonymous = [{ record: { id: 'a' } }, { record: { id: 'b' } }];
  // Two anchors that cannot be computed are not proof of a shared point: the
  // cluster stays zoomable (records without any location never reach a marker).
  assert.equal(clusterCanSplit(anonymous, 12), true);
});

test('the point list is chronological, then alphabetical, and keeps every record', () => {
  const pile = [
    pileMember('c', 1838, 47.35833, 8.53334, 'Stadt Zürich 1838'),
    pileMember('a', 1696, 47.35833, 8.53334, 'Grundriss 1696'),
    pileMember('b', 1705, 47.35833, 8.53334, 'Grundriss 1705'),
    pileMember('a2', 1696, 47.35833, 8.53334, 'Atlas 1696'),
  ];
  assert.deepEqual(
    clusterRecords(pile).map((record) => record.id),
    ['a2', 'a', 'b', 'c'],
  );
  assert.deepEqual(clusterRecords(undefined), []);
  assert.equal(clusterRecords([{ record: null }]).length, 0);
});

test('markerPoints pins every placeable record (no silent 300-record slice)', () => {
  // The map used to render `state.filtered.slice(0, 300)`; the seed is at 169,
  // so the slice was invisible until a harvest crossed it. A synthetic set well
  // past that line must come back whole, in list order (the pin number is the
  // list's "Nr.").
  const synthetic = Array.from({ length: 320 }, (_, i) => ({
    id: `probe:${i}`,
    title: `Probe ${i}`,
    geo: { lat: 47.37, lon: 8.54 },
  }));
  const { points, unplaced } = markerPoints(synthetic, 12);
  assert.equal(points.length, 320);
  assert.equal(unplaced, 0);
  assert.deepEqual(points.map((point) => point.index), synthetic.map((_, i) => i));
  assert.equal(points[319].id, 'probe:319');
});

test('markerPoints counts what cannot be placed and uses the documented position', () => {
  const TILE = 256; // the module's tile size (not exported)
  const withPoint = { id: 'probe:geo', geo: { lat: 47.1, lon: 8.2 }, extent: { west: 0, east: 1, south: 0, north: 1 } };
  const extentOnly = { id: 'probe:extent', extent: { west: 8, east: 9, south: 47, north: 48 } };
  const nowhere = { id: 'probe:nowhere' };
  const { points, unplaced } = markerPoints([withPoint, extentOnly, nowhere], 10);
  assert.equal(points.length, 2);
  assert.equal(unplaced, 1, 'a record without geo and without extent is counted, not silently skipped');
  // The published point wins over the extent centre …
  assert.equal(points[0].x, lonToTileX(8.2, 10) * TILE);
  assert.equal(points[0].y, latToTileY(47.1, 10) * TILE);
  // … and an extent-only record is pinned at its documented centre.
  assert.equal(points[1].x, lonToTileX(8.5, 10) * TILE);
  assert.equal(points[1].y, latToTileY(47.5, 10) * TILE);
  // The list position of the unplaceable record is not reused.
  assert.deepEqual(points.map((point) => point.index), [0, 1]);
  // An unloaded / empty result set is not an error.
  assert.deepEqual(markerPoints(undefined, 10), { points: [], unplaced: 0 });
});
