import { ALLOWLIST, USER_AGENT, VERSION, isAllowed } from './allowlist.js';
import { NOMINATIM_ATTRIBUTION, NOMINATIM_SOURCE, nominatimUrl, searchPayload } from './geocode.js';

/**
 * Request handler for the Zurich maps Workers site.
 *
 * The Worker only answers `/api/*` (see `assets.run_worker_first` in
 * wrangler.jsonc); every other request is served directly from the static asset
 * directory `public/`.
 *
 * Why a proxy at all?
 *  - Worldwide place search runs on *OpenStreetMap's* Nominatim gazetteer. Its
 *    usage policy asks for an identified client, low request rates and caching;
 *    routing it through the Worker gives the project one identifiable
 *    User-Agent, a bounded query and a five-minute edge cache per query. The
 *    Swiss swisstopo SearchServer stays as the fallback for Swiss places.
 *  - e-rara IIIF images/manifests normally allow CORS; `/api/fetch` is a
 *    *fallback* for clients/networks where the direct call fails. It is limited
 *    to a literal allowlist of hosts, so it cannot be used as an open proxy.
 *
 * No credentials are required or read by this Worker.
 */

function json(body, init = {}) {
  return new Response(JSON.stringify(body, null, 1), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...(init.headers || {}) },
  });
}

async function upstream(url, { accept = '*/*', timeoutMs = 8000 } = {}) {
  return fetch(url, {
    headers: { 'user-agent': USER_AGENT, accept },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'follow',
  });
}

/** Read a JSON file that ships with the site through the assets binding. */
async function asset(env, path, request) {
  const url = new URL(request.url);
  url.pathname = path;
  url.search = '';
  return env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
}

async function cachedJson(request, ctx, build, maxAge) {
  const cache = caches.default;
  const cacheKey = new Request(new URL(request.url).toString(), { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const body = await build();
  const res = json(body, { headers: { 'cache-control': `public, max-age=${maxAge}` } });
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

/** GET /api/health — liveness plus the upstreams this Worker may contact. */
function health(request) {
  return json({
    ok: true,
    version: VERSION,
    runtime: 'cloudflare-workers',
    upstreams: ALLOWLIST.map((r) => r.host),
    endpoints: ['/api/health', '/api/records', '/api/layers', '/api/sources', '/api/search/places', '/api/fetch'],
    placeSearch: {
      primary: NOMINATIM_SOURCE,
      attribution: NOMINATIM_ATTRIBUTION,
      fallback: 'swisstopo SearchServer (Swiss places)',
    },
    time: new Date().toISOString(),
  });
}

/** GET /api/search/places?q=&limit= — worldwide places, Swiss places as fallback. */
async function searchPlaces(request, ctx) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') || 8), 1), 10);
  if (q.length < 2 || q.length > 120) {
    return json({ error: 'query_too_short', detail: 'q must be 2..120 characters', results: [] }, { status: 400 });
  }
  return cachedJson(
    request,
    ctx,
    async () => {
      // 1) The worldwide gazetteer. One request per distinct, cached query.
      try {
        const res = await upstream(nominatimUrl(q, { limit }), { accept: 'application/json' });
        if (res.ok) {
          const payload = searchPayload(await res.json(), { limit, query: q });
          if (payload.results.length > 0) return payload;
          // No worldwide hit: a Swiss micro-toponym may still exist, so fall
          // through to swisstopo instead of answering “nothing” too early.
        }
      } catch {
        // Network/timeout: the Swiss fallback below still answers.
      }
      // 2) Swiss fallback (documented SearchServer API, covers the country only).
      try {
        const target = new URL('https://api3.geo.admin.ch/rest/services/api/SearchServer');
        target.searchParams.set('searchText', q);
        target.searchParams.set('type', 'locations');
        target.searchParams.set('sr', '4326'); // WGS84 lon/lat
        target.searchParams.set('limit', String(limit));
        const res = await upstream(target.toString(), { accept: 'application/json' });
        if (!res.ok) {
          return { results: [], query: q, upstreamStatus: res.status, note: 'Both place services failed.' };
        }
        const data = await res.json();
        const results = (data.results || [])
          .map((r) => {
            const a = r.attrs || {};
            const box = (a.geom_st_box2d || '').match(/BOX\(([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+)\)/);
            return {
              label: String(a.label || '').replace(/<[^>]*>/g, ''),
              origin: a.origin || null,
              lat: typeof a.lat === 'number' ? a.lat : null,
              lon: typeof a.lon === 'number' ? a.lon : null,
              layerBodId: a.layerBodId || null,
              zoom: Number.isFinite(a.zoomlevel) && a.zoomlevel > 0 && a.zoomlevel <= 20 ? a.zoomlevel : null,
              bbox: box ? { west: Number(box[1]), south: Number(box[2]), east: Number(box[3]), north: Number(box[4]) } : null,
            };
          })
          .filter((r) => r.label && Number.isFinite(r.lat) && Number.isFinite(r.lon));
        return {
          results,
          query: q,
          source: 'swisstopo SearchServer (Swiss places)',
          attribution: '© swisstopo',
          ...(results.length === 0 ? { note: 'No place matches this query.' } : {}),
        };
      } catch (err) {
        return { results: [], query: q, note: `Place search unavailable: ${String(err && err.message).slice(0, 80)}` };
      }
    },
    300,
  );
}

/** GET /api/fetch?url= — allowlisted pass-through with a 1 h edge cache. */
async function fetchUpstream(request, ctx) {
  const url = new URL(request.url);
  const raw = url.searchParams.get('url');
  if (!raw) return json({ error: 'missing_url' }, { status: 400 });
  let target;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'invalid_url' }, { status: 400 });
  }
  if (!isAllowed(target)) {
    return json({ error: 'host_not_allowed', host: target.hostname, allowlist: ALLOWLIST.map((r) => r.host) }, { status: 403 });
  }
  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/fetch?url=${encodeURIComponent(target.toString())}`, { method: 'GET' });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let res;
  try {
    res = await upstream(target.toString(), { accept: url.searchParams.get('accept') || '*/*' });
  } catch (err) {
    return json({ error: 'upstream_unreachable', detail: String(err && err.message) }, { status: 502 });
  }
  if (!res.ok) return json({ error: 'upstream_error', status: res.status }, { status: 502 });
  const type = res.headers.get('content-type') || 'application/octet-stream';
  const out = new Response(res.body, {
    status: 200,
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
      'x-proxied-from': target.hostname,
    },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return out;
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch: (r: Request) => Promise<Response> } }} env
   * @param {{ waitUntil: (p: Promise<unknown>) => void }} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'method_not_allowed' }, { status: 405, headers: { allow: 'GET, HEAD' } });
      }
      try {
        switch (url.pathname) {
          case '/api/health':
            return health(request);
          case '/api/search/places':
            return await searchPlaces(request, ctx);
          case '/api/fetch':
            return await fetchUpstream(request, ctx);
          case '/api/records':
          case '/api/layers':
          case '/api/sources': {
            const path = { '/api/records': '/data/records.json', '/api/layers': '/data/overlays.json', '/api/sources': '/data/sources.json' }[
              url.pathname
            ];
            const res = await asset(env, path, request);
            if (!res.ok) return json({ error: 'asset_missing', path }, { status: 500 });
            return new Response(res.body, {
              status: 200,
              headers: {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'public, max-age=300',
                'access-control-allow-origin': '*',
              },
            });
          }
          default:
            return json({ error: 'not_found', path: url.pathname }, { status: 404 });
        }
      } catch (err) {
        return json({ error: 'worker_error', detail: String(err && err.message) }, { status: 500 });
      }
    }

    // Defensive: if run_worker_first is widened, still behave like a static host.
    if (env && env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
};

// NOTE: only `default` may be exported from a Workers entrypoint. workerd rejects
// non-function named exports at startup ("Incorrect type for map entry 'VERSION'"
// is the exact failure), so constants stay module-private and are exercised through
// the HTTP surface (see tests/worker.test.mjs → /api/health).
