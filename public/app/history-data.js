/**
 * History dataset semantics: the honest reading of `public/data/history/`.
 *
 * The bundled snapshots come from aourednik/historical-basemaps (GPL-3.0, see
 * `public/data/history/ATTRIBUTION.txt`). They are *snapshots*, not continuous
 * validity ranges: for a requested date the app must draw one named snapshot and
 * say which one it drew, never an interpolated or “modern” substitute. This
 * module holds that logic as pure functions so both the map and the tests use
 * the same rules.
 *
 * Owner: zurich-maps-2 (the data half of the History feature).
 */

export const HISTORY_INDEX_URL = '/data/history/index.json';
export const HISTORY_DIR = '/data/history/';

/** How many adjacent snapshots must be apart before it counts as a visible gap. */
export const GAP_YEARS = 30;

export const PRECISION_LABELS = Object.freeze({
  1: 'approximate (blurred zone)',
  2: 'moderately precise',
  3: 'demarcated by international law',
  unknown: 'precision not stated by the source',
});

/**
 * Astronomical year numbering → what people read. There is no year zero:
 * astronomical 0 is 1 BCE, -500 is 501 BCE, 1492 is 1492 CE.
 */
export function formatHistoricalYear(year) {
  const value = Math.trunc(Number(year));
  if (!Number.isFinite(value)) return '';
  if (value > 0) return `${value} CE`;
  return `${1 - value} BCE`;
}

/** Short form for dense controls: “1492”, “501 BCE”. */
export function formatHistoricalYearShort(year) {
  const value = Math.trunc(Number(year));
  if (!Number.isFinite(value)) return '';
  return value > 0 ? String(value) : `${1 - value} BCE`;
}

/**
 * Parse the `hy=` URL value. Accepts signed astronomical years (`1492`, `-500`)
 * and BCE/CE text (`500 BCE`, `1492 CE`, `8000BC`), which is how a person writes
 * a date into the address bar. Empty/garbage yields null (the caller keeps its
 * default instead of guessing).
 */
export function parseHistoricalYear(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.trunc(input) : null;
  const text = String(input ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (text === '') return null;
  const match = text.match(/^(-?\d{1,6})\s*(bce?|b\.c\.?|ce|c\.e\.|ad|bc)?$/i);
  if (!match) return null;
  const magnitude = Math.abs(Number(match[1]));
  if (!Number.isFinite(magnitude)) return null;
  const era = (match[2] ?? '').toLowerCase();
  const negative = match[1].startsWith('-');
  if (era.startsWith('b')) return -magnitude; // 500 BCE → astronomical -500
  if (era === '' && negative) return -magnitude;
  return magnitude === 0 ? 0 : magnitude;
}

const byYear = (index) => (Array.isArray(index) ? index : (index?.years ?? []));

/**
 * The snapshot the app may draw for a requested year, plus how honest that is.
 *
 *   snapshotForYear(index, 1495)
 *   → { requested: 1495, exact: false, snapshot: {year: 1492, …},
 *       distance: 3, direction: 'earlier', message: '…' }
 *
 * The nearest snapshot in either direction wins; on a tie the later one does
 * (documented, deterministic). Outside the dataset's range the closest end is
 * used and `outsideRange` is set, so a caller can say so instead of pretending.
 */
export function snapshotForYear(index, requested) {
  const years = byYear(index);
  const want = Math.trunc(Number(requested));
  if (!Number.isFinite(want)) return { requested: null, snapshot: null, exact: false, message: 'No year selected.' };
  if (years.length === 0) return { requested: want, snapshot: null, exact: false, message: 'No historical snapshots are bundled.' };

  let best = years[0];
  let bestDistance = Math.abs(years[0].year - want);
  for (const candidate of years) {
    const distance = Math.abs(candidate.year - want);
    if (distance < bestDistance || (distance === bestDistance && candidate.year > best.year)) {
      best = candidate;
      bestDistance = distance;
    }
  }

  const first = years[0].year;
  const last = years[years.length - 1].year;
  const outsideRange = want < first || want > last;
  const direction = best.year === want ? 'exact' : best.year < want ? 'earlier' : 'later';
  return {
    requested: want,
    snapshot: best,
    exact: best.year === want,
    distance: bestDistance,
    direction,
    outsideRange,
    requestedLabel: formatHistoricalYear(want),
    snapshotLabel: best.label ?? formatHistoricalYear(best.year),
    message: snapshotMessage({ want, best, bestDistance, direction, outsideRange, first, last }),
  };
}

function snapshotMessage({ want, best, bestDistance, direction, outsideRange, first, last }) {
  const asked = `There is no snapshot for ${formatHistoricalYear(want)}`;
  if (best.year === want) {
    return outsideRange
      ? `${formatHistoricalYear(want)} is outside the dataset's range (${formatHistoricalYear(first)} – ${formatHistoricalYear(last)}); drawn snapshot: ${formatHistoricalYear(best.year)}.`
      : `Showing the ${formatHistoricalYear(best.year)} snapshot.`;
  }
  const distance = `${bestDistance} year${bestDistance === 1 ? '' : 's'}`;
  const when = direction === 'earlier' ? 'earlier' : 'later';
  const range = outsideRange
    ? ` The dataset covers ${formatHistoricalYear(first)} – ${formatHistoricalYear(last)}.`
    : '';
  return `${asked} — showing the nearest snapshot, ${formatHistoricalYear(best.year)}, ${distance} ${when}. Boundaries are only drawn for the snapshot years the source publishes.${range}`;
}

/** The available range, as the UI states it. */
export function availableRange(index) {
  const years = byYear(index);
  if (years.length === 0) return null;
  const first = years[0].year;
  const last = years[years.length - 1].year;
  return {
    first,
    last,
    firstLabel: formatHistoricalYear(first),
    lastLabel: formatHistoricalYear(last),
    count: years.length,
    label: `${formatHistoricalYear(first)} – ${formatHistoricalYear(last)}`,
  };
}

/**
 * Where the snapshot series is sparse. The UI shows this instead of implying
 * that every year is available: e.g. no snapshot between 1815 and 1878.
 */
export function snapshotGaps(index, gapYears = GAP_YEARS) {
  const years = byYear(index);
  const gaps = [];
  for (let i = 1; i < years.length; i++) {
    const from = years[i - 1].year;
    const to = years[i].year;
    if (to - from >= gapYears) {
      gaps.push({ from, to, span: to - from, label: `${formatHistoricalYear(from)} → ${formatHistoricalYear(to)} (${to - from} years without a snapshot)` });
    }
  }
  return gaps;
}

/** Snap a year onto the dataset's range: the slider/stepper cannot leave it. */
export function clampHistoricalYear(index, year) {
  const range = availableRange(index);
  const value = Math.trunc(Number(year));
  if (!range) return Number.isFinite(value) ? value : 0;
  if (!Number.isFinite(value)) return range.first;
  return Math.min(range.last, Math.max(range.first, value));
}

/** One-line description of a snapshot's border-precision mix, in plain English. */
export function precisionSummary(snapshot) {
  const p = snapshot?.precision ?? {};
  const parts = [];
  if (p.approximate) parts.push(`${p.approximate} approximate`);
  if (p.moderate) parts.push(`${p.moderate} moderately precise`);
  if (p.demarcated) parts.push(`${p.demarcated} demarcated`);
  if (p.unclassified) parts.push(`${p.unclassified} unclassified`);
  return parts.length > 0 ? parts.join(' · ') : 'no precision information';
}

/** Human label for one feature's `b` (BORDERPRECISION) value. */
export function borderPrecisionLabel(value) {
  return PRECISION_LABELS[value] ?? PRECISION_LABELS.unknown;
}

/** Feature name that is safe to display (the source has a few unnamed areas). */
export function featureName(feature) {
  const name = String(feature?.n ?? '').trim();
  return name === '' || name.toLowerCase() === 'unnamed' ? 'Unnamed area in the source data' : name;
}

export function historySnapshotUrl(file) {
  return `${HISTORY_DIR}${String(file).replace(/^\/+/, '')}`;
}

/**
 * Load the bundled index. `fetchImpl` is injectable so tests stay offline.
 * A failure is reported as an error the caller can show, not as an empty dataset.
 */
export async function loadHistoryIndex(fetchImpl = globalThis.fetch, url = HISTORY_INDEX_URL) {
  if (typeof fetchImpl !== 'function') throw new Error('no fetch implementation available');
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const index = await res.json();
  if (!Array.isArray(index?.years) || index.years.length === 0) {
    throw new Error('the history index carries no snapshots');
  }
  return index;
}

/** Load one snapshot (the renderer calls this when the year changes). */
export async function loadSnapshot(yearEntry, fetchImpl = globalThis.fetch) {
  const url = historySnapshotUrl(yearEntry.file);
  const res = await fetchImpl(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const snapshot = await res.json();
  if (!Array.isArray(snapshot?.features)) throw new Error(`${url} carries no features`);
  return snapshot;
}

/**
 * Attribution line for the map badge and the details panel — the same string in
 * both places, from the index the data actually shipped with.
 */
export function historyAttribution(index) {
  const source = index?.source ?? {};
  return source.attribution || 'Boundaries © historical-basemaps contributors (GPL-3.0)';
}
