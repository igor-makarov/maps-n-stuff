/**
 * “Bring the row of a map selection into view”: the pure scroll rule behind
 * `results.js` `revealRow()`. Rectangles are viewport coordinates, exactly what
 * `getBoundingClientRect()` returns, so the rule can be tested without a
 * browser — and the harness drives the real pin click on top of it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { REVEAL_HIGHLIGHT_MS, revealScrollDelta, selectionAnnouncement } from '../public/app/results.js';

const view = { height: 900 };
/** A row of the real list height (`.zh-result` is ~112 px tall). */
const row = (top, height = 112) => ({ top, bottom: top + height, left: 0, right: 400 });

test('revealScrollDelta leaves a row inside the readable band alone', () => {
  assert.equal(revealScrollDelta(row(100), view), 0);
  assert.equal(revealScrollDelta(row(700), view), 0, 'bottom at 812 is inside the 876 band');
  assert.equal(revealScrollDelta(row(8), view), 0, 'exactly at the top of the band');
});

test('revealScrollDelta scrolls a row below the band up by the missing amount', () => {
  const below = row(1200);
  const delta = revealScrollDelta(below, view, { bottom: 24, gap: 8 });
  assert.ok(delta > 0, `expected a downward scroll, got ${delta}`);
  // Scrolling down by `delta` moves the row up by the same amount in the new
  // viewport coordinates: its bottom lands `gap` above the band's bottom edge.
  assert.equal(below.bottom - delta, view.height - 24 - 8);
});

test('revealScrollDelta scrolls a row above the band down (negative delta)', () => {
  const above = row(-300);
  const delta = revealScrollDelta(above, view, { top: 8, gap: 8 });
  assert.ok(delta < 0, `expected an upward scroll, got ${delta}`);
  assert.equal(above.top - delta, 8 + 8);
});

test('revealScrollDelta honours the band insets it is given', () => {
  const inShrunkBand = row(100);
  assert.equal(revealScrollDelta(inShrunkBand, view, { bottom: 400, gap: 0 }), 0, 'a deep bottom inset still leaves it inside');
  assert.notEqual(revealScrollDelta(row(600), view, { bottom: 400 }), 0, 'the same row is below the shrunken band');
  assert.equal(revealScrollDelta(row(600), view, { bottom: 0 }), 0, 'and inside the full band');
  assert.equal(revealScrollDelta(row(600), view, { top: 700, bottom: 400 }), 0, 'an empty band never scrolls');
});

test('revealScrollDelta aligns a row taller than the band to the band top', () => {
  const tall = { top: -50, bottom: 1200, left: 0, right: 400 };
  const delta = revealScrollDelta(tall, view, { top: 0, bottom: 0, gap: 8 });
  assert.equal(tall.top + delta, 8, 'the title, not the foot, is what the visitor needs');
});

test('revealScrollDelta is defensive about missing rectangles and stays integral', () => {
  assert.equal(revealScrollDelta(null, view), 0);
  assert.equal(revealScrollDelta(row(1200), null), 0);
  assert.equal(revealScrollDelta(row(1200), { height: 0 }), 0);
  const delta = revealScrollDelta(row(1234.6), view, { bottom: 24, gap: 8 });
  assert.equal(delta, Math.round(delta), 'scrollBy gets whole pixels');
});

test('the reveal mark is long enough to be seen but not permanent', () => {
  assert.ok(REVEAL_HIGHLIGHT_MS >= 1000 && REVEAL_HIGHLIGHT_MS <= 6000, String(REVEAL_HIGHLIGHT_MS));
});

test('selectionAnnouncement names the 1-based row a map selection moved the list to', () => {
  assert.equal(
    selectionAnnouncement({ index: 11, total: 167, title: 'Zürich 1850', revealed: true }),
    '167 results. Row 12 of 167 selected: Zürich 1850. The list scrolled to this row.',
  );
  assert.equal(
    selectionAnnouncement({ index: 0, total: 1, title: 'Plan', revealed: false }),
    '1 results. Row 1 of 1 selected: Plan.',
  );
});

test('selectionAnnouncement is honest when the record is not in the current list', () => {
  assert.equal(
    selectionAnnouncement({ index: -1, total: 42, title: 'Basel 1900' }),
    '42 results. Selected: Basel 1900. This record is outside the current results.',
  );
  assert.equal(
    selectionAnnouncement({ index: 0, total: 0, title: 'Plan' }),
    '0 results. Selected: Plan. This record is outside the current results.',
    'an empty list cannot have row 1',
  );
  assert.equal(
    selectionAnnouncement({ index: 3, total: 3, title: 'Plan' }),
    '3 results. Selected: Plan. This record is outside the current results.',
    'an out-of-range index is not a row',
  );
  assert.equal(selectionAnnouncement({ index: -1, total: 5, title: '' }), '', 'nothing to announce without a title');
  assert.equal(selectionAnnouncement(), '');
  assert.equal(selectionAnnouncement({ index: 1.5, total: 5, title: 'Plan' }), '5 results. Selected: Plan. This record is outside the current results.');
});

test('selectionAnnouncement folds a multi-line title into one sentence', () => {
  assert.equal(
    selectionAnnouncement({ index: 1, total: 2, title: '  Karte\n  von   Zürich ', revealed: false }),
    '2 results. Row 2 of 2 selected: Karte von Zürich.',
  );
});
