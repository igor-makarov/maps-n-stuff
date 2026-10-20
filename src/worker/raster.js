/** Bounded byte-range access to institution-supplied COGs. Never a general file proxy. */
import { USER_AGENT } from "./allowlist.js";
export const MAX_RASTER_RANGE = 8 * 1024 * 1024;
export function rasterUrl(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    if (
      url.hostname === "stacks.stanford.edu" &&
      /^\/file\/druid:[a-z]{2}\d{3}[a-z]{2}\d{4}\/[^/]{1,200}_cog\.tif$/i.test(
        url.pathname,
      )
    )
      return url;
    // USGS Historical Topographic Map Collection GeoTIFFs: only the public
    // HTMC staging prefix, with no traversal and a .tif suffix. The same
    // bounded range contract applies; nothing here is a general file proxy.
    const usgs = decodeURIComponent(url.pathname);
    if (
      url.hostname === "prd-tnm.s3.amazonaws.com" &&
      /^\/StagedProducts\/Maps\/HistoricalTopo\/GeoTIFF\/[^/]+(?:\/[^/]+)*\.tif$/i.test(
        usgs,
      ) &&
      !usgs.includes("..") &&
      !usgs.includes("//")
    )
      return url;
    return null;
  } catch {
    return null;
  }
}
export function parseRange(value) {
  const match = String(value ?? "").match(/^bytes=(\d{1,15})-(\d{1,15})$/);
  if (!match) return null;
  const [start, end] = match.slice(1).map(Number);
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    end >= start &&
    end - start + 1 <= MAX_RASTER_RANGE
    ? { start, end }
    : null;
}
export async function rasterResponse(request, ctx) {
  const target = rasterUrl(new URL(request.url).searchParams.get("url"));
  if (!target)
    return Response.json({ error: "raster_not_allowed" }, { status: 403 });
  const range = parseRange(request.headers.get("range"));
  if (request.method !== "HEAD" && !range)
    return Response.json(
      { error: "bounded_byte_range_required" },
      { status: 416 },
    );
  const key = new Request(
    `${new URL(request.url).origin}/api/raster?url=${encodeURIComponent(target.href)}&range=${range?.start ?? "head"}-${range?.end ?? ""}`,
  );
  // Cache full byte fragments as 200; reconstruct the truthful 206 on reads.
  const hit =
    request.method === "HEAD" ? null : await caches.default.match(key);
  if (hit) return new Response(hit.body, { status: 206, headers: hit.headers });
  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      // The Workers fetch implementation does not implement `error`; `manual`
      // plus an explicit 3xx rejection preserves the "never follow a redirect"
      // rule for this narrow file proxy.
      redirect: "manual",
      headers: {
        "user-agent": USER_AGENT,
        ...(range ? { range: `bytes=${range.start}-${range.end}` } : {}),
      },
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return Response.json(
      { error: "raster_source_unavailable" },
      { status: 502 },
    );
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    return Response.json(
      { error: "raster_redirect_not_allowed" },
      { status: 502 },
    );
  }
  if (request.method !== "HEAD" && upstream.status !== 206) {
    await upstream.body?.cancel();
    return Response.json(
      { error: "source_does_not_support_byte_ranges" },
      { status: 502 },
    );
  }
  if (!upstream.ok)
    return Response.json(
      { error: "raster_source_unavailable", upstreamStatus: upstream.status },
      { status: 502 },
    );
  const headers = new Headers({
    "content-type": "image/tiff",
    "cache-control": "public, max-age=86400",
    "accept-ranges": "bytes",
  });
  for (const name of ["content-range", "etag", "last-modified"])
    if (upstream.headers.has(name))
      headers.set(name, upstream.headers.get(name));
  if (request.method === "HEAD") {
    if (upstream.headers.has("content-length"))
      headers.set("content-length", upstream.headers.get("content-length"));
    return new Response(null, { headers });
  }
  const returned = upstream.headers
    .get("content-range")
    ?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
  if (
    !returned ||
    Number(returned[1]) !== range.start ||
    Number(returned[2]) > range.end
  ) {
    await upstream.body?.cancel();
    return Response.json(
      { error: "invalid_source_byte_range" },
      { status: 502 },
    );
  }
  const length = Number(returned[2]) - Number(returned[1]) + 1;
  if (length < 1 || length > MAX_RASTER_RANGE) {
    await upstream.body?.cancel();
    return new Response(null, { status: 502 });
  }
  // Enforce the bound while streaming, even if an upstream lies in its headers.
  const reader = upstream.body.getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > length) {
      await reader.cancel();
      return Response.json(
        { error: "oversized_source_range" },
        { status: 502 },
      );
    }
    parts.push(value);
  }
  if (size !== length)
    return Response.json({ error: "truncated_source_range" }, { status: 502 });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  const response = new Response(bytes, { status: 206, headers });
  ctx.waitUntil(
    caches.default.put(key, new Response(bytes, { status: 200, headers })),
  );
  return response;
}
