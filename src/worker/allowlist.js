/**
 * Upstream allowlist for the request handler.
 *
 * Kept in its own module because a Worker's entry module may only export a
 * default handler (workerd rejects other top-level exports); everything the
 * tests want to import lives here instead.
 */

export const VERSION = '0.1.0';

/** Hosts the proxy may talk to, and the path prefixes allowed per host. */
export const ALLOWLIST = [
  // Worldwide place search (OpenStreetMap, ODbL). `/search` only: the Worker is
  // not a general Nominatim client, and the usage policy wants identified,
  // cached, low-volume traffic.
  { host: 'nominatim.openstreetmap.org', prefixes: ['/search'] },
  // Swiss places/addresses: the fallback when the worldwide gazetteer is down or
  // returns nothing, and the source of Swiss micro-toponyms Nominatim lacks.
  { host: 'api3.geo.admin.ch', prefixes: ['/rest/services/api/SearchServer'] },
  { host: 'www.loc.gov', prefixes: ['/item/'] },
  { host: 'tile.loc.gov', prefixes: ['/image-services/iiif/service:gmd:'] },
  { host: 'www.e-rara.ch', prefixes: ['/i3f/', '/zuz/oai', '/oai'] },
  { host: 'wmts.geo.admin.ch', prefixes: ['/1.0.0/', '/EPSG/'] },
  { host: 'data.geo.admin.ch', prefixes: ['/'] },
];

export const USER_AGENT =
  'meridian-atlas/0.1 (+https://github.com/igor-makarov/maps-n-stuff; historical map explorer)';

/** True when the URL is https, on an allowlisted host and path. */
export function isAllowed(target) {
  if (!(target instanceof URL) || target.protocol !== 'https:') return false;
  const rule = ALLOWLIST.find((r) => r.host === target.hostname);
  if (!rule) return false;
  return rule.prefixes.some((prefix) => target.pathname.startsWith(prefix));
}
