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

import { CLUSTER_CELL, clusterByCell, extentRects, latToTileY, lonToTileX } from '../public/app/map.js';

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
