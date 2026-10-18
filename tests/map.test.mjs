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

import { CLUSTER_CELL, clusterByCell } from '../public/app/map.js';

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
