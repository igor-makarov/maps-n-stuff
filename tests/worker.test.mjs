/**
 * Worker request-handler tests.
 *
 * The Worker only answers `/api/*`; these tests import the real entry module
 * (so anything that would break `wrangler dev` shows up here) and drive it with
 * stubbed `fetch`, `caches.default` and the `ASSETS` binding. No network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalogue } from '../scripts/catalogue.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const committed = await readCatalogue(path.join(root, 'public/data'));

// --- Cloudflare runtime stubs -------------------------------------------------
class MemoryCache {
  constructor() {
    this.store = new Map();
  }
  async match(request) {
    const hit = this.store.get(request.url);
    return hit ? hit.clone() : undefined;
  }
  async put(request, response) {
    this.store.set(request.url, response.clone());
  }
}

const cache = new MemoryCache();
globalThis.caches = { default: cache };

const upstreamCalls = [];
let upstreamResponder = () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  upstreamCalls.push({ url, init });
  return upstreamResponder(url, init);
};

const { default: worker } = await import('../src/worker/index.js');

/** Minimal ASSETS binding: serves the real files from public/. */
const env = {
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      const file = path.join(root, 'public', url.pathname.replace(/^\//, ''));
      try {
        const body = await readFile(file);
        const type = url.pathname.endsWith('.json') ? 'application/json' : 'application/octet-stream';
        return new Response(body, { status: 200, headers: { 'content-type': type } });
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  },
};

const ctx = { waitUntil() {}, passThroughOnException() {} };
const call = (pathname, init) => worker.fetch(new Request(`https://example.test${pathname}`, init), env, ctx);

test.beforeEach(() => {
  upstreamCalls.length = 0;
});

test('the entry module exports only a default ExportedHandler (workerd requirement)', async () => {
  const module = await import('../src/worker/index.js');
  assert.deepEqual(Object.keys(module), ['default'], 'named exports make workerd refuse to start the Worker');
  assert.equal(typeof module.default.fetch, 'function');
  const source = await readFile(path.join(root, 'src/worker/index.js'), 'utf8');
  assert.ok(!/^export\s*\{[^}]*\}/m.test(source), 'no bare re-export of values');
});

test('GET /api/health reports the allowlisted upstreams', async () => {
  const res = await call('/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(body.upstreams.includes('purl.stanford.edu'));
  assert.ok(body.upstreams.includes('wmts.geo.admin.ch'));
  assert.ok(!body.upstreams.includes('www.oldmapsonline.org'), 'the aggregator is not a data backend');
  assert.deepEqual(body.endpoints, ['/api/health', '/api/records', '/api/layers', '/api/sources', '/api/search/places', '/api/fetch', '/api/raster', '/api/georeference', '/api/catalogue']);
});

test('GET /api/records serves the committed seed data with a cache header', async () => {
  const res = await call('/api/records');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=\d+/);
  const body = await res.json();
  assert.ok(Array.isArray(body.records) && body.records.length > 0);
  assert.equal(body.records.length, committed.records.length, 'the route merges every committed shard');
  assert.ok(body.records.some((record) => record.providerId === 'leventhal'), 'a shard provider is present');
  assert.ok(body.generatedAt);
});

test('GET /api/layers and /api/sources serve the registry files', async () => {
  const layers = await (await call('/api/layers')).json();
  assert.ok(Array.isArray(layers.overlays) && layers.overlays.length > 0);
  const sources = await (await call('/api/sources')).json();
  assert.ok(Array.isArray(sources.providers) && sources.providers.length > 0);
});

test('GET /api/search/places validates input and uses worldwide English geocoding', async () => {
  assert.equal((await call('/api/search/places?q=z')).status,400);
  assert.equal(upstreamCalls.length,0);
  upstreamResponder=()=>Response.json([{display_name:'Cairo, Egypt',lat:'30.04',lon:'31.23',boundingbox:['29.7','30.3','31','31.6'],type:'city',class:'place'}]);
  const body=await(await call('/api/search/places?q=Cairo')).json();
  assert.equal(body.results.length,1);
  assert.match(body.results[0].label,/Cairo/);
  assert.match(body.attribution,/OpenStreetMap/);
  assert.equal(new URL(upstreamCalls[0].url).hostname,'nominatim.openstreetmap.org');
  assert.match(upstreamCalls[0].init.headers['user-agent'],/maps-n-stuff/);
});
test('place search outages return an honest empty result without Swiss fallback', async () => {
  upstreamResponder=()=>new Response('unavailable',{status:503});
  const body=await(await call('/api/search/places?q=Tokyo')).json();
  assert.deepEqual(body.results,[]);
  assert.equal(upstreamCalls.length,1);
});

test('GET /api/fetch refuses everything outside the host allowlist', async () => {
  const cases = [
    'https://evil.example/manifest.json',
    'http://www.e-rara.ch/i3f/v20/1/manifest',
    'https://www.e-rara.ch.evil.example/i3f/v20/1/manifest',
    'https://www.e-rara.ch/zuz/content/titleinfo/22142031',
    'https://wmts.geo.admin.ch/foo/bar.png',
    'https://api3.geo.admin.ch/rest/services/api/MapServer',
  ];
  for (const target of cases) {
    const res = await call(`/api/fetch?url=${encodeURIComponent(target)}`);
    assert.equal(res.status, 403, `${target} must be refused`);
  }
  assert.equal(upstreamCalls.length, 0, 'refused targets are never fetched');

  const missing = await call('/api/fetch');
  assert.equal(missing.status, 400);
  const invalid = await call('/api/fetch?url=not-a-url');
  assert.equal(invalid.status, 400);
});

test('GET /api/fetch proxies allowlisted IIIF requests with CORS + cache headers', async () => {
  upstreamResponder = () =>
    new Response('{"@context":"http://iiif.io/api/presentation/2/context.json"}', {
      status: 200,
      headers: { 'content-type': 'application/ld+json' },
    });
  const target = 'https://www.e-rara.ch/i3f/v20/22142031/manifest';
  const res = await call(`/api/fetch?url=${encodeURIComponent(target)}&accept=application/json`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('x-proxied-from'), 'www.e-rara.ch');
  assert.match(res.headers.get('cache-control'), /max-age=\d+/);
  assert.match(upstreamCalls.at(-1).init.headers.accept, /application\/json/);

  const cached = await call(`/api/fetch?url=${encodeURIComponent(target)}`);
  assert.equal(cached.status, 200);
  assert.equal(upstreamCalls.length, 1, 'second identical request is served from the edge cache');
});

test('upstream failures surface as 502 instead of crashing the Worker', async () => {
  upstreamResponder = () => {
    throw new Error('network down');
  };
  const res = await call('/api/fetch?url=' + encodeURIComponent('https://www.e-rara.ch/i3f/v20/1/manifest'));
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, 'upstream_unreachable');
});

test('non-GET methods and unknown API paths return JSON errors', async () => {
  const post = await call('/api/records', { method: 'POST' });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get('allow'), 'GET, HEAD');
  const unknown = await call('/api/nope');
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error, 'not_found');
});

test('non-API requests fall through to the static assets binding', async () => {
  const res = await call('/app/main.js');
  assert.equal(res.status, 200);
});
