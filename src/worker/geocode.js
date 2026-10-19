/**
 * Worldwide place search: Nominatim (OpenStreetMap) mapping and URL building.
 *
 * Kept in its own module for two reasons:
 *  - the Worker entry module may only export a default handler (workerd rejects
 *    other exports), so pure helpers live here and are unit-tested directly;
 *  - the mapping is the part worth testing: a gazetteer answer must never become
 *    a position (or a bounding box) that the upstream did not publish.
 *
 * Upstream: https://nominatim.openstreetmap.org/search — documented at
 * https://nominatim.org/release-docs/latest/api/Search/ and governed by the
 * OSM Foundation's usage policy (identifiable User-Agent, at most one request
 * per second, results cached, no bulk geocoding). The Worker sends its project
 * User-Agent, the response is edge-cached for five minutes per query, and the
 * client debounces typing — the three things the policy asks of an app.
 *
 * Data © OpenStreetMap contributors, ODbL 1.0.
 */

export const NOMINATIM_HOST = 'nominatim.openstreetmap.org';
export const NOMINATIM_ATTRIBUTION = '© OpenStreetMap contributors (ODbL 1.0)';
export const NOMINATIM_SOURCE = 'OpenStreetMap (Nominatim)';

/** Deepest zoom the client may use for a placed point (the app clamps at 18). */
const MAX_ZOOM = 19;

/**
 * Nominatim search URL for one query. `accept-language=en` keeps the product's
 * interface English while place names stay the upstream's (`name` is whatever
 * OpenStreetMap stores; `display_name` is the local form with English fallbacks).
 */
export function nominatimUrl(query, { limit = 8, language = 'en' } = {}) {
  const url = new URL(`https://${NOMINATIM_HOST}/search`);
  url.searchParams.set('q', String(query).trim());
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', String(Math.min(Math.max(Math.trunc(limit) || 8, 1), 10)));
  url.searchParams.set('addressdetails', '0');
  url.searchParams.set('accept-language', String(language || 'en'));
  url.searchParams.set('dedupe', '1');
  return url.toString();
}

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/**
 * One Nominatim record → the app's suggestion shape:
 * `{ label, name, origin, lat, lon, bbox, zoom, osmType, osmId }`.
 * Returns null when the record has no usable position: a suggestion without a
 * latitude/longitude cannot move the map, and inventing one is not an option.
 */
export function mapNominatimRecord(record) {
  if (!record || typeof record !== 'object') return null;
  const lat = finite(record.lat);
  const lon = finite(record.lon);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const label = String(record.display_name || record.name || '').trim();
  if (!label) return null;

  // Nominatim's boundingbox is [south, north, west, east] as strings.
  const box = Array.isArray(record.boundingbox) ? record.boundingbox.map(finite) : [];
  const bbox =
    box.length === 4 && box.every((value) => value !== null) && box[0] < box[1] && box[2] < box[3]
      ? { south: box[0], north: box[1], west: box[2], east: box[3] }
      : null;

  const origin = String(record.addresstype || record.type || record.class || '').trim() || null;
  return {
    label,
    name: String(record.name || '').trim() || null,
    origin,
    lat,
    lon,
    bbox,
    // The client derives the zoom from the bbox; this is only a fallback hint.
    zoom: maxZoomForBbox(bbox) ?? 13,
    osmType: record.osm_type ? String(record.osm_type) : null,
    osmId: record.osm_id ? String(record.osm_id) : null,
    licence: record.licence ? String(record.licence) : null,
    importance: finite(record.importance),
  };
}

/** How deep a bbox can be shown before it is a meaningless stamp. */
export function maxZoomForBbox(bbox) {
  if (!bbox) return null;
  const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south);
  if (!Number.isFinite(span) || span <= 0) return null;
  const zoom = Math.floor(Math.log2(360 / span)) + 1;
  return Math.min(MAX_ZOOM, Math.max(2, zoom));
}

/**
 * The suggestions the client receives. Missing/duplicate records are dropped
 * (the same place often appears as a node and a relation), the order is the
 * upstream's relevance order, and the result never exceeds `limit`.
 */
export function mapNominatimResults(payload, { limit = 8 } = {}) {
  const records = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  const out = [];
  const seen = new Set();
  for (const record of records) {
    const mapped = mapNominatimRecord(record);
    if (!mapped) continue;
    const key = `${mapped.label.toLowerCase()}|${mapped.lat.toFixed(3)}|${mapped.lon.toFixed(3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mapped);
    if (out.length >= limit) break;
  }
  return out;
}

/** A payload the client can render honestly, including “nothing found”. */
export function searchPayload(payload, { limit = 8, query = '' } = {}) {
  const results = mapNominatimResults(payload, { limit });
  return {
    results,
    query,
    source: NOMINATIM_SOURCE,
    attribution: NOMINATIM_ATTRIBUTION,
    count: results.length,
    ...(results.length === 0 ? { note: 'No place in OpenStreetMap matches this query.' } : {}),
  };
}
