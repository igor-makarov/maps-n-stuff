import test from "node:test";
import assert from "node:assert/strict";
import {
  parseRange,
  rasterUrl,
  rasterResponse,
  MAX_RASTER_RANGE,
} from "../src/worker/raster.js";
const source = "https://stacks.stanford.edu/file/druid:ab123cd4567/map_cog.tif";
test("raster access permits only bounded ranges of institution-supplied GeoTIFFs", () => {
  assert.ok(rasterUrl(source));
  for (const url of [
    source + "?x=1",
    source.replace("stacks.stanford.edu", "evil.example"),
    source.replace("_cog.tif", ".zip"),
    source.replace("https:", "http:"),
  ])
    assert.equal(rasterUrl(url), null);
  assert.deepEqual(parseRange("bytes=10-99"), { start: 10, end: 99 });
  for (const value of [
    "bytes=1-",
    "bytes=-100",
    "bytes=10-9",
    "bytes=1-3,5-6",
    `bytes=0-${MAX_RASTER_RANGE}`,
  ])
    assert.equal(parseRange(value), null);
});
test("range proxy checks actual body length and caches separate truthful fragments", async () => {
  const original = globalThis.fetch,
    originalCaches = globalThis.caches;
  const cache = new Map(),
    pending = [];
  let calls = 0,
    oversized = false;
  globalThis.caches = {
    default: {
      match: async (r) => cache.get(r.url)?.clone(),
      put: async (r, res) => {
        assert.equal(res.status, 200);
        cache.set(r.url, res.clone());
      },
    },
  };
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, source);
    assert.equal(init.redirect, "manual");
    const [start, end] = init.headers.range.slice(6).split("-").map(Number);
    return new Response(new Uint8Array(end - start + 1 + (oversized ? 1 : 0)), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/10000` },
    });
  };
  const request = (range) =>
    new Request(
      `https://atlas.test/api/raster?url=${encodeURIComponent(source)}`,
      { headers: range ? { range } : {} },
    );
  const ctx = { waitUntil: (p) => pending.push(p) };
  try {
    assert.equal((await rasterResponse(request(), ctx)).status, 416);
    let res = await rasterResponse(request("bytes=0-9"), ctx);
    assert.equal(res.status, 206);
    assert.equal((await res.arrayBuffer()).byteLength, 10);
    await Promise.all(pending);
    res = await rasterResponse(request("bytes=0-9"), ctx);
    assert.equal(res.status, 206);
    assert.equal(calls, 1);
    await rasterResponse(request("bytes=10-19"), ctx);
    assert.equal(calls, 2);
    oversized = true;
    res = await rasterResponse(request("bytes=20-29"), ctx);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "oversized_source_range");
  } finally {
    globalThis.fetch = original;
    globalThis.caches = originalCaches;
  }
});
