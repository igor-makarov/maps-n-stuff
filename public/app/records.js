/**
 * Data layer: load, validate, index, filter and sort the seed records.
 *
 * Files (see coordination/data-contract.md):
 *   /data/records.json   { generatedAt, method, records: [...] }
 *   /data/sources.json   { generatedAt, providers: [...] }
 *   /data/overlays.json  { generatedAt, overlays: [...] }   (swisstopo WMTS layers)
 *
 * The record schema is fixed by D4; this module is the only place that knows it.
 */

export const RECORDS_URL = '/data/records.json';
export const SOURCES_URL = '/data/sources.json';
export const OVERLAYS_URL = '/data/overlays.json';

const REQUIRED_STRING_FIELDS = ['id', 'title', 'providerId', 'institution', 'rights', 'recordUrl'];

export function validateRecord(record, index = -1) {
  const problems = [];
  if (!record || typeof record !== 'object') return [`record[${index}] is not an object`];
  for (const field of REQUIRED_STRING_FIELDS) {
    if (!record[field] || typeof record[field] !== 'string') problems.push(`${record.id ?? `record[${index}]`}: missing ${field}`);
  }
  if (record.id && !/^[a-z0-9-]+:.+$/.test(record.id)) problems.push(`${record.id}: id must be "<providerId>:<upstream id>"`);
  if (record.recordUrl && !/^https:\/\//.test(record.recordUrl)) problems.push(`${record.id}: recordUrl must be https`);
  if ((record.yearStart != null || record.yearEnd != null) && (!Number.isFinite(record.yearStart) || !Number.isFinite(record.yearEnd))) problems.push(`${record.id}: publication date must be a complete pair or explicitly unknown`);
  else if (record.yearStart > record.yearEnd) problems.push(`${record.id}: yearStart > yearEnd`);
  if (record.extent) {
    const { west, east, south, north } = record.extent;
    if (![west, east, south, north].every(Number.isFinite)) problems.push(`${record.id}: extent must be numeric`);
    else if (west >= east || south >= north) problems.push(`${record.id}: extent bounds inverted`);
  }
  if (record.overlay?.urlTemplate && !/^https:\/\//.test(record.overlay.urlTemplate)) {
    problems.push(`${record.id}: overlay.urlTemplate must be https`);
  }
  return problems;
}

/** Fetch + validate. Never throws: returns { records, errors, ok }. */
export async function loadRecords(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') return { records: [], errors: ['no fetch implementation'], ok: false };
  const res = await fetchImpl(RECORDS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${RECORDS_URL}`);
  const data = await res.json();
  const records = Array.isArray(data.records) ? data.records : [];
  const errors = records.flatMap((record, i) => validateRecord(record, i));
  return { records, errors, generatedAt: data.generatedAt ?? null, method: data.method ?? null, ok: errors.length === 0 };
}

export async function loadSources(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(SOURCES_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${SOURCES_URL}`);
  const data = await res.json();
  return { providers: data.providers ?? [], generatedAt: data.generatedAt ?? null };
}

export async function loadOverlays(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(OVERLAYS_URL, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${OVERLAYS_URL}`);
  const data = await res.json();
  return { overlays: data.overlays ?? [], attribution: data.attribution ?? null, generatedAt: data.generatedAt ?? null };
}

export function indexRecords(records) {
  return new Map(records.map((record) => [record.id, record]));
}

/** Publication years available in the data (never invented). */
export function yearBounds(records) {
  const years = records.flatMap((r) => [r.yearStart, r.yearEnd]).filter(Number.isFinite);
  if (years.length === 0) return { min: 1500, max: new Date().getFullYear() };
  return { min: Math.min(...years), max: Math.max(...years) };
}

export function recordCenter(record) {
  if (record?.geo && Number.isFinite(record.geo.lat) && Number.isFinite(record.geo.lon)) {
    return { lat: record.geo.lat, lon: record.geo.lon };
  }
  const e = record?.extent;
  if (e && [e.west, e.east, e.south, e.north].every(Number.isFinite)) {
    return { lat: (e.south + e.north) / 2, lon: (e.west + e.east) / 2 };
  }
  return null;
}

/**
 * The searchable text of a record: everything the dataset itself states about
 * it. The collection (Kartenwerk) and the imprint are included on purpose — a
 * visitor who reads “Karte des Kantons Zürich 1:25 000 (Wildkarte)” in the
 * collection facet or “Zentralbibliothek Zürich, 4 Lb 06: 9” in a citation can
 * type those words and must find the sheet. Nothing is derived from them.
 */
export function titleText(record) {
  return [
    record.title,
    ...(record.titleAlt ?? []),
    ...(record.creators ?? []),
    record.institution,
    record.publisher,
    record.subjectPlace,
    record.shelfmark,
    record.collection,
    record.originalCollection,
    record.imprint,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/**
 * Fold one spelling of a name onto the other so the box finds both.
 *
 * Swiss names are written with or without diacritics, and the German
 * transcription of an umlaut is what most keyboards produce: a visitor types
 * “Zuerich”, “Zurich” or “Zürich”, and the catalogue says whichever it says.
 * Two foldings are needed, because neither is a superset of the other:
 *
 *   foldDigraph('Zürich')  -> 'zuerich'   (ä→ae, ö→oe, ü→ue, ß→ss)
 *   foldPlain('Zürich')    -> 'zurich'    (diacritics dropped)
 *   foldPlain('Zuerich')   -> 'zuerich'   (the typed “ue” is literal)
 *
 * A token matches when it matches in *either* folding: “Zuerich” finds
 * “Zürich” through the digraph form, “Zurich” finds it through the plain
 * form, and “Genève” ↔ “Geneve” works through the plain form too. Anything
 * else the catalogue states about a record keeps matching exactly as before.
 */
export function foldDigraph(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss');
}

export function foldPlain(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '');
}

const foldedTextCache = new WeakMap();

/** The two folded spellings of a record's searchable text (computed once). */
function foldedText(record) {
  let entry = foldedTextCache.get(record);
  if (!entry) {
    const text = titleText(record);
    entry = { digraph: foldPlain(foldDigraph(text)), plain: foldPlain(text) };
    foldedTextCache.set(record, entry);
  }
  return entry;
}

export function matchesQuery(record, query) {
  const needle = String(query || '').trim();
  if (!needle) return true;
  // Original collection searches can match fields absent from our compact
  // record. Retain that exact query match without inventing a map title.
  const catalogueQuery = foldPlain(needle).replace(/\s+/g, ' ');
  if (record.catalogueQueries?.some(value => foldPlain(value).replace(/\s+/g, ' ') === catalogueQuery)) return true;
  const haystack = foldedText(record);
  return needle
    .split(/\s+/)
    .every((token) => {
      const digraph = foldPlain(foldDigraph(token));
      return digraph.length > 0 && (haystack.digraph.includes(digraph) || haystack.plain.includes(foldPlain(token)));
    });
}

export function overlapsRange(record, from, to) {
  const start = record.yearStart ?? record.yearEnd;
  const end = record.yearEnd ?? record.yearStart;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  return start <= to && end >= from;
}

/** The shared filter pipeline (also used by the Worker-free tests). */
export function filterRecords(state, records) {
  const from = Number(state?.from ?? -Infinity);
  const to = Number(state?.to ?? Infinity);
  const provider = state?.provider || '';
  const type = state?.type || '';
  const collection = state?.collection || '';
  return records.filter(
    (record) =>
      matchesQuery(record, state?.q) &&
      overlapsRange(record, from, to) &&
      (!provider || record.providerId === provider) &&
      (!type || record.type === type) &&
      (!collection || record.collection === collection),
  );
}

export function sortRecords(records, sort = 'year-asc') {
  const copy = [...records];
  if (sort === 'title') copy.sort((a, b) => a.title.localeCompare(b.title, 'en'));
  else copy.sort((a, b) => {
    const ay = a.yearStart ?? a.yearEnd, by = b.yearStart ?? b.yearEnd;
    const aDated = Number.isFinite(ay), bDated = Number.isFinite(by);
    if (aDated !== bDated) return aDated ? -1 : 1;
    return (aDated ? (sort === 'year-desc' ? by - ay : ay - by) : 0) || a.title.localeCompare(b.title, 'en');
  });
  return copy;
}

export function bboxIntersects(a, b) {
  if (!a || !b) return false;
  return a.west <= b.east && a.east >= b.west && a.south <= b.north && a.north >= b.south;
}

/**
 * Does the record's documented extent cover this point?
 *
 * Strictly the published bbox (bounds inclusive) — a record's `geo` point is a
 * centre, not a coverage claim, so it is deliberately not used here. A record
 * without a usable extent cannot match, and the caller can say so honestly.
 */
export function coversPoint(record, lat, lon) {
  const e = record?.extent;
  if (!e || ![e.west, e.east, e.south, e.north].every(Number.isFinite)) return false;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  return lat >= e.south && lat <= e.north && lon >= e.west && lon <= e.east;
}

/** Records whose point or bbox lies inside the current map view. */
export function recordsInBounds(records, bounds) {
  if (!bounds) return records;
  return records.filter((record) => {
    const center = recordCenter(record);
    if (record.extent && bboxIntersects(record.extent, bounds)) return true;
    if (!center) return false;
    return center.lat >= bounds.south && center.lat <= bounds.north && center.lon >= bounds.west && center.lon <= bounds.east;
  });
}

export function facets(records) {
  const providers = new Map();
  const types = new Map();
  const collections = new Map();
  for (const record of records) {
    providers.set(record.providerId, (providers.get(record.providerId) ?? 0) + 1);
    types.set(record.type ?? 'map', (types.get(record.type ?? 'map') ?? 0) + 1);
    if (record.collection) collections.set(record.collection, (collections.get(record.collection) ?? 0) + 1);
  }
  return { providers, types, collections };
}

export function extentUnion(records) {
  const boxes = records.map((r) => r.extent).filter(Boolean);
  if (boxes.length === 0) return null;
  return {
    west: Math.min(...boxes.map((b) => b.west)),
    east: Math.max(...boxes.map((b) => b.east)),
    south: Math.min(...boxes.map((b) => b.south)),
    north: Math.max(...boxes.map((b) => b.north)),
  };
}
