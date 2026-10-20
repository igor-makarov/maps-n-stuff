/**
 * Decade histogram: bins, filter-scoped counts and the brush range (maps-2).
 *
 * The chart above the year slider is fixed in *structure* (one bin per decade of
 * the seed) and dynamic in *counts*: the bars count every active filter except
 * the period itself, so they say what widening the range would bring back. Both
 * halves are pure functions, so they are tested here without a DOM; the DOM
 * wiring in `results.js` is covered by `scripts/browser-check.mjs` (section 2c).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readCatalogue } from '../scripts/catalogue.mjs';
import { brushYears, countHistogramBins, histogramBinsFor } from '../public/app/results.js';
import { filterRecords } from '../public/app/records.js';

const seed = await readCatalogue();
const records = seed.records;

test('bins cover every decade of the data range, including empty ones', () => {
  const bins = histogramBinsFor(1696, 2021);
  assert.equal(bins[0].start, 1690);
  assert.equal(bins[0].end, 1699);
  assert.equal(bins.at(-1).start, 2020);
  assert.equal(bins.at(-1).end, 2029);
  assert.equal(bins.length, 34);
  // A decade with no record is still a bin: the axis must not skip a gap.
  assert.ok(bins.some((bin) => bin.start === 1700));
});

test('bins are empty for a missing or inverted range instead of inventing one', () => {
  assert.deepEqual(histogramBinsFor(undefined, 1900), []);
  assert.deepEqual(histogramBinsFor(1900, 1800), []);
  assert.deepEqual(histogramBinsFor(NaN, NaN), []);
});

test('counts use the publication year, fall back to yearEnd, and skip records without one', () => {
  const bins = histogramBinsFor(1800, 1849);
  const counts = countHistogramBins(bins, [
    { yearStart: 1801, yearEnd: 1810 }, // yearStart wins
    { yearStart: null, yearEnd: 1844 }, // honest fallback
    { yearStart: null, yearEnd: null }, // unusable, not counted
    { yearStart: undefined }, // missing field, not counted
    {}, // empty record
  ]);
  assert.equal(counts.get(1800), 1);
  assert.equal(counts.get(1840), 1);
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 2);
});

test('years outside the data range land in the end bins, not outside the chart', () => {
  const bins = histogramBinsFor(1900, 1989);
  const counts = countHistogramBins(bins, [{ yearStart: 1750 }, { yearStart: 2500 }], 1900, 1989);
  assert.equal(counts.get(1900), 1);
  assert.equal(counts.get(1980), 1);
  assert.equal([...counts.values()].reduce((a, b) => a + b, 0), 2);
});

test('a brush range is order-insensitive and clamped to the data range', () => {
  const bins = histogramBinsFor(1696, 2021);
  // 1690 is the first bin's nominal start, 1696 what the data actually offers.
  assert.deepEqual(brushYears(bins, 0, 2, 1696, 2021), { from: 1696, to: 1719 });
  assert.deepEqual(brushYears(bins, 2, 0, 1696, 2021), { from: 1696, to: 1719 });
  // The last bin ends in 2029, the newest record is from 2021.
  assert.deepEqual(brushYears(bins, bins.length - 1, bins.length - 1, 1696, 2021), { from: 2020, to: 2021 });
  // Out-of-range indices are clamped, not NaN.
  assert.deepEqual(brushYears(bins, -5, 999, 1696, 2021), { from: 1696, to: 2021 });
  assert.equal(brushYears([], 0, 1), null);
});

test('the histogram scope is every filter except the period', () => {
  const min = Math.min(...records.map((r) => r.yearStart).filter(Number.isFinite));
  const max = Math.max(...records.map((r) => (r.yearEnd ?? r.yearStart) || 0));
  const bins = histogramBinsFor(min, max);

  // The scope replaces the period with an open range: every record counts, even
  // the ones a narrow period filter hides, so the bars stay a map of what is
  // available rather than of what is currently selected.
  const scope = filterRecords({ from: -Infinity, to: Infinity }, records);
  const all = countHistogramBins(bins, scope, min, max);
  assert.equal(scope.length, records.length);
  assert.equal([...all.values()].reduce((a, b) => a + b, 0), records.filter(r=>Number.isFinite(r.yearStart)).length);

  const periodOnly = countHistogramBins(bins, filterRecords({ from: 1800, to: 1900 }, records), min, max);
  const inPeriod = [...periodOnly.values()].reduce((a, b) => a + b, 0);
  assert.ok(inPeriod < records.length, 'the seed has records outside 1800–1900');
  // Decades outside the period are the visible difference between the two.
  assert.ok(all.get(1750) > periodOnly.get(1750));
  assert.ok(all.get(2020) > periodOnly.get(2020));

  // Every other filter does narrow them, and only by its own records.
  const provider = records[0].providerId;
  const scoped = countHistogramBins(bins, filterRecords({ from: -Infinity, to: Infinity, provider }, records), min, max);
  assert.equal([...scoped.values()].reduce((a, b) => a + b, 0), records.filter((r) => r.providerId === provider && Number.isFinite(r.yearStart)).length);

  // A keyword that matches nothing empties the chart instead of keeping stale bars.
  const none = countHistogramBins(bins, filterRecords({ from: -Infinity, to: Infinity, q: 'xyzzy-kein-treffer' }, records), min, max);
  assert.equal([...none.values()].reduce((a, b) => a + b, 0), 0);
  assert.equal(none.size, bins.length);
});
