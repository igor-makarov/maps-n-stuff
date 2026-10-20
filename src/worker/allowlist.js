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
  { host: 'purl.stanford.edu', prefixes: ['/'] },
  { host: 'stacks.stanford.edu', prefixes: ['/image/iiif/'] },
  { host: 'collections.leventhalmap.org', prefixes: ['/search/commonwealth:'] },
  { host: 'ark.digitalcommonwealth.org', prefixes: ['/ark:/50959/'] },
  { host: 'iiif.digitalcommonwealth.org', prefixes: ['/iiif/'] },
  { host: 'www.loc.gov', prefixes: ['/item/'] },
  { host: 'tile.loc.gov', prefixes: ['/image-services/iiif/service:gmd:'] },
  { host: 'www.e-rara.ch', prefixes: ['/i3f/', '/zuz/oai', '/oai'] },
  { host: 'wmts.geo.admin.ch', prefixes: ['/1.0.0/', '/EPSG/'] },
];

export const USER_AGENT =
  'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; historical map explorer)';

/** True when the URL is https, on an allowlisted host and path. */
export function isAllowed(target) {
  if (!(target instanceof URL) || target.protocol !== 'https:') return false;
  if (target.username || target.password || target.port) return false;
  if (target.hostname === 'purl.stanford.edu') return /^\/[a-z]{2}\d{3}[a-z]{2}\d{4}\/iiif3?\/manifest$/.test(target.pathname);
  if (target.hostname === 'collections.leventhalmap.org') return /^\/search\/commonwealth:[a-z0-9]+\/manifest$/.test(target.pathname);
  if (target.hostname === 'ark.digitalcommonwealth.org') return /^\/ark:\/50959\/[a-z0-9]+\/manifest$/.test(target.pathname);
  const rule = ALLOWLIST.find((r) => r.host === target.hostname);
  if (!rule) return false;
  return rule.prefixes.some((prefix) => target.pathname.startsWith(prefix));
}
