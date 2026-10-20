import { parseAnnotation } from "@allmaps/annotation";
import { USER_AGENT } from "./allowlist.js";
import { isAllowed } from "./allowlist.js";
import { loadCatalogue } from "./data.js";
import { parseManifest } from "../../public/app/iiif.js";

export function resourceMatches(record, resource) {
  try {
    const url = new URL(resource);
    if (url.protocol !== "https:" || url.username || url.password || url.port)
      return false;
    if (record.imageResources?.includes(resource)) return true;
    if (record.providerId === "stanford") {
      return (
        url.hostname === "stacks.stanford.edu" &&
        url.pathname.startsWith("/image/iiif/") &&
        decodeURIComponent(url.pathname).includes(
          `/${record.id.split(":")[1]}/`,
        )
      );
    }
    return (
      Boolean(record.imageService) &&
      resource.replace(/\/+$/, "") === record.imageService.replace(/\/+$/, "")
    );
  } catch {
    return false;
  }
}
export function alignmentLayers(annotation, record) {
  const maps = parseAnnotation(annotation);
  return maps.flatMap((map) => {
    const id = map.id?.match(/(?:^|\/maps\/)([a-f0-9]{16})(?:@|$)/)?.[1];
    if (
      !id ||
      !resourceMatches(record, map.resource.id) ||
      map.gcps.length < 3 ||
      map.resourceMask.length < 3
    )
      return [];
    const { width, height } = map.resource;
    if (!(width > 0 && height > 0)) return [];
    if (
      !map.gcps.every(
        (point) =>
          point.geo.every(Number.isFinite) &&
          point.resource.every(Number.isFinite) &&
          Math.abs(point.geo[0]) <= 180 &&
          Math.abs(point.geo[1]) <= 90 &&
          point.resource[0] >= 0 &&
          point.resource[0] <= width &&
          point.resource[1] >= 0 &&
          point.resource[1] <= height,
      )
    )
      return [];
    if (
      !map.resourceMask.every(
        (point) =>
          point.every(Number.isFinite) &&
          point[0] >= 0 &&
          point[0] <= width &&
          point[1] >= 0 &&
          point[1] <= height,
      )
    )
      return [];
    const [a, ...points] = map.gcps.map((point) => point.resource);
    const nonCollinear = points.some((b) =>
      points.some(
        (c) =>
          Math.abs(
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
          ) > 1,
      ),
    );
    if (!nonCollinear) return [];
    const [ga, ...geoPoints] = map.gcps.map((point) => point.geo);
    if (
      !geoPoints.some((b) =>
        geoPoints.some(
          (c) =>
            Math.abs(
              (b[0] - ga[0]) * (c[1] - ga[1]) - (b[1] - ga[1]) * (c[0] - ga[0]),
            ) > 1e-10,
        ),
      )
    )
      return [];
    return [
      {
        id: `allmaps-${id}`,
        kind: "xyz",
        providerId: record.providerId,
        recordId: record.id,
        title: record.title,
        urlTemplate: `https://allmaps.xyz/maps/${id}/{z}/{x}/{y}.png`,
        maxZoom: 20,
        annotation: `https://annotations.allmaps.org/maps/${id}`,
        controlPoints: map.gcps.length,
        attribution: `${record.institution}; georeferencing via Allmaps (CC0)`,
        license: record.rights,
        extent: record.extent ?? null,
        timeValues: [],
        historical: true,
        quality:
          "Community georeferencing; check alignment against identifiable landmarks.",
      },
    ];
  });
}
export async function georeferenceResponse(request, env, ctx) {
  const id = new URL(request.url).searchParams.get("record");
  if (!id || id.length > 160)
    return Response.json({ error: "record_required" }, { status: 400 });
  const cacheKey = new Request(request.url);
  const cached = await caches.default.match(cacheKey);
  if (cached) return cached;
  const { records } = await loadCatalogue(env, request);
  let record = records.find((value) => value.id === id);
  if (!record) {
    const cachedRecord = await caches.default.match(
      new Request(
        `${new URL(request.url).origin}/api/catalogue-record?id=${encodeURIComponent(id)}`,
      ),
    );
    if (cachedRecord) record = await cachedRecord.json();
  }
  if (!record)
    return Response.json({ error: "record_not_found" }, { status: 404 });
  if (record.georeference?.kind === "cog")
    return Response.json({
      record: id,
      native: record.georeference,
      layers: [],
    });
  const resource = record.iiifManifest || record.imageService;
  if (!resource)
    return Response.json({
      record: id,
      layers: [],
      note: "No IIIF resource is available for alignment lookup.",
    });
  if (
    !record.imageService &&
    record.providerId !== "stanford" &&
    record.iiifManifest
  ) {
    const manifestUrl = new URL(record.iiifManifest);
    if (isAllowed(manifestUrl)) {
      try {
        const response = await fetch(manifestUrl.href, {
          redirect: "error",
          headers: { accept: "application/json", "user-agent": USER_AGENT },
          signal: AbortSignal.timeout(12000),
        });
        if (response.ok)
          record.imageResources = parseManifest(await response.json())
            .canvases.flatMap((canvas) => [canvas.service, canvas.id])
            .filter(Boolean);
      } catch {
        /* Without source identity evidence an annotation will not be admitted. */
      }
    }
  }
  const upstream = new URL("https://annotations.allmaps.org/");
  upstream.searchParams.set("url", resource);
  const response = await fetch(upstream.href, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(12000),
  });
  if (response.status === 404)
    return Response.json({
      record: id,
      layers: [],
      note: "No reusable alignment was found. You can still browse the scan.",
    });
  if (!response.ok)
    return Response.json(
      { error: "alignment_service_unavailable" },
      { status: 502 },
    );
  let layers;
  try {
    layers = alignmentLayers(await response.json(), record);
  } catch {
    return Response.json({ error: "invalid_alignment_data" }, { status: 502 });
  }
  const result = Response.json(
    {
      record: id,
      layers,
      note: layers.length
        ? "Reusable alignment data found; image rights remain those of the original collection."
        : "No matching valid alignment found. You can still browse the scan.",
    },
    { headers: { "cache-control": "public, max-age=3600" } },
  );
  ctx.waitUntil(caches.default.put(cacheKey, result.clone()));
  return result;
}
