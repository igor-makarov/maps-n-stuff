/** Bounded searches of original collection APIs. Never infer image rights from public access. */
import { USER_AGENT } from "./allowlist.js";
const SIZE = 12;
const first = (value) => (Array.isArray(value) ? value[0] : value);
const words = (value) =>
  Array.isArray(value)
    ? value
        .flat(Infinity)
        .filter((x) => typeof x === "string")
        .join(" ")
    : String(value ?? "");
const text = (value) =>
  words(value)
    .replace(/<[^>]*>/g, "")
    .trim();
const year = (value) =>
  Number(text(value).match(/\b(?:1[0-9]{3}|20[0-9]{2})\b/)?.[0]) || null;
function https(value, hosts) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" &&
      hosts.includes(u.hostname) &&
      !u.port &&
      !u.username &&
      !u.password
      ? u.href
      : null;
  } catch {
    return null;
  }
}
export function openImageRights(value) {
  const statement = text(value);
  if (
    !statement ||
    /non[ -]?commercial|all rights reserved|permission (?:is )?required|not in the public domain|copyright undetermined|no known restrictions/i.test(
      statement,
    )
  )
    return null;
  if (
    /creativecommons\.org\/(?:publicdomain\/(?:mark|zero)\/1\.0|licenses\/by(?:-sa)?\/4\.0)/i.test(
      statement,
    ) ||
    /\b(?:is|are|in the|in) (?:the )?public domain\b/i.test(statement)
  )
    return statement;
  return null;
}
export function extentOf(value) {
  if (!value) return null;
  const west = Number(value.minX ?? value.west),
    east = Number(value.maxX ?? value.east),
    south = Number(value.minY ?? value.south),
    north = Number(value.maxY ?? value.north);
  return [west, east, south, north].every(Number.isFinite) &&
    west >= -180 &&
    east <= 180 &&
    south >= -90 &&
    north <= 90 &&
    west < east &&
    south < north
    ? { west, east, south, north }
    : null;
}
function recordBase({
  id,
  providerId,
  title,
  date,
  rights,
  recordUrl,
  thumbnail,
  institution,
  extent = null,
}) {
  const y = year(date);
  return {
    id,
    providerId,
    title: text(title),
    yearStart: y,
    yearEnd: y,
    depictedYearStart: null,
    depictedYearEnd: null,
    creators: [],
    rights,
    recordUrl,
    thumbnail,
    institution,
    type: "map",
    collection: `${institution} — live catalogue`,
    extent,
    geo: extent
      ? {
          lat: (extent.south + extent.north) / 2,
          lon: (extent.west + extent.east) / 2,
        }
      : null,
    geoNote:
      "Catalogue location is for discovery. No image alignment is inferred from a bounding box.",
    liveCatalogue: true,
  };
}
export function locRecord(data) {
  const d = data.item ?? data;
  const recordUrl = https(data.url ?? data.id ?? d.id, [
    "www.loc.gov",
    "loc.gov",
  ]);
  const id = recordUrl?.match(/\/item\/([^/]+)\//)?.[1];
  const rights = openImageRights([
    data.rights_advisory,
    d.rights_advisory,
    data.rights,
    d.rights,
    d.rights_information,
  ]);
  if (!id || !rights) return null;
  const image =
    (data.image_url ?? d.image_url ?? []).find((value) =>
      https(value, ["tile.loc.gov", "www.loc.gov"]),
    ) ?? null;
  const record = recordBase({
    id: `loc:${id}`,
    providerId: "loc",
    title: d.title ?? data.title,
    date: d.date ?? data.date,
    rights,
    recordUrl,
    thumbnail: image,
    institution: "Library of Congress",
  });
  const manifest = https(
    data.iiif_presentation_manifest ?? d.iiif_presentation_manifest,
    ["www.loc.gov"],
  );
  record.iiifManifest =
    manifest ?? `https://www.loc.gov/item/${id}/manifest.json`;
  record.creators = (d.contributor ?? d.creator ?? []).map?.(text) ?? [];
  record.subjectPlace = text(d.location ?? data.location);
  return record;
}
export function leventhalRecord(document) {
  const d = document.attributes ?? document;
  const rawId = text(document.id ?? d.id);
  if (!/^commonwealth:[a-z0-9]+$/.test(rawId)) return null;
  const rights = openImageRights([
    d.rights_ss,
    d.rights_statement_ss,
    d.license_ss,
    d.use_and_reproduction_ss,
    d.rights,
  ]);
  if (!rights) return null;
  const recordUrl = `https://collections.leventhalmap.org/search/${rawId}`;
  const record = recordBase({
    id: `leventhal:${rawId}`,
    providerId: "leventhal",
    title: first(
      d.title_info_primary_tsi ?? d.title_tsim ?? d.title_ssi ?? d.title,
    ),
    date: first(d.date_start_dtsi ?? d.date_tsim ?? d.date),
    rights,
    recordUrl,
    thumbnail: https(
      first(d.thumbnail_url_ss ?? d.thumbnail_url ?? d.thumbnail),
      ["collections.leventhalmap.org", "iiif.digitalcommonwealth.org"],
    ),
    institution: "Leventhal Map & Education Center / holding collection",
  });
  if (!record.title) return null;
  record.iiifManifest = `${recordUrl}/manifest`;
  return record;
}
export function usgsRecord(item) {
  const id = text(item.sourceId ?? item.id);
  if (!id || id.length > 120 || !item.title) return null;
  const source = https(item.metaUrl ?? item.metadataUrl ?? item.downloadURL, [
    "www.sciencebase.gov",
    "www.usgs.gov",
    "prd-tnm.s3.amazonaws.com",
    "ngmdb.usgs.gov",
  ]);
  if (!source) return null;
  const record = recordBase({
    id: `usgs:${id.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
    providerId: "usgs",
    title: item.title,
    date: item.publicationDate,
    rights:
      "USGS-produced historical topographic map, public domain. Retain source credits.",
    recordUrl: source,
    thumbnail: https(item.previewGraphicURL ?? item.thumbnail, [
      "prd-tnm.s3.amazonaws.com",
      "ngmdb.usgs.gov",
      "www.sciencebase.gov",
    ]),
    institution: "U.S. Geological Survey",
    extent: extentOf(item.boundingBox),
  });
  record.downloads = Object.entries(item.urls ?? {})
    .map(([label, url]) => ({
      label,
      url: https(url, ["prd-tnm.s3.amazonaws.com", "ngmdb.usgs.gov"]),
    }))
    .filter((value) => value.url);
  if (
    item.downloadURL &&
    https(item.downloadURL, ["prd-tnm.s3.amazonaws.com", "ngmdb.usgs.gov"])
  )
    record.downloads.push({
      label: "Original map files",
      url: item.downloadURL,
    });
  const geotiff = https(item.urls?.GeoTIFF, ["prd-tnm.s3.amazonaws.com"]);
  if (geotiff)
    record.georeference = {
      kind: "cog",
      url: geotiff,
      source,
      status: "provider-supplied",
      format: "GeoTIFF",
    };
  record.geoNote =
    "Catalogue extent is the USGS product footprint. The GeoTIFF carries its own pixel georeferencing; no transform is inferred from the bbox.";
  return record;
}
export const LIVE_PROVIDERS = [
  {
    id: "loc",
    name: "Library of Congress",
    homepage: "https://www.loc.gov/maps/",
    attribution: "Library of Congress / original holding collection",
    rights:
      "Only results carrying explicit compatible image-rights evidence are admitted.",
    api: { catalogue: "https://www.loc.gov/maps/?fo=json" },
  },
  {
    id: "leventhal",
    name: "Leventhal Map & Education Center",
    homepage: "https://collections.leventhalmap.org/",
    attribution:
      "Leventhal Map & Education Center at the Boston Public Library / original holding collection",
    rights:
      "Item-level public-domain or compatible licence required. Partner collections are checked separately.",
    api: { catalogue: "https://collections.leventhalmap.org/search.json" },
  },
  {
    id: "usgs",
    name: "USGS Historical Topographic Maps",
    homepage: "https://ngmdb.usgs.gov/topoview/",
    attribution: "U.S. Geological Survey",
    rights:
      "USGS-produced historical topographic maps are public domain; retain source credits.",
    api: {
      catalogue: "https://tnmaccess.nationalmap.gov/api/v1/products",
      terms: "https://www.usgs.gov/faqs/are-usgs-topographic-maps-copyrighted",
    },
  },
];
async function get(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Collection returned HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 8 * 1024 * 1024)
    throw new Error("Collection response exceeds the catalogue limit");
  return JSON.parse(body);
}
export async function catalogueResponse(request, ctx) {
  const query = new URL(request.url).searchParams;
  const source = query.get("source"),
    q = (query.get("q") ?? "").trim();
  const page = Math.max(1, Math.min(10000, Number(query.get("page")) || 1));
  if (
    !LIVE_PROVIDERS.some((value) => value.id === source) ||
    q.length < 2 ||
    q.length > 160
  )
    return Response.json(
      { error: "source_and_query_required" },
      { status: 400 },
    );
  const key = new Request(request.url);
  const cached = await caches.default.match(key);
  if (cached) return cached;
  let documents = [],
    records = [],
    total = null;
  try {
    if (source === "loc") {
      const url = new URL("https://www.loc.gov/maps/");
      for (const [k, v] of Object.entries({
        fo: "json",
        q,
        c: String(SIZE),
        sp: String(page),
      }))
        url.searchParams.set(k, v);
      const data = await get(url.href);
      documents = (data.results ?? []).slice(0, SIZE);
      total = data.pagination?.total ?? null;
      // Rights advisories are often only present on an item's own record.
      for (let i = 0; i < documents.length; i += 3) {
        const chunk = await Promise.all(
          documents.slice(i, i + 3).map(async (document) => {
            const ready = locRecord(document);
            if (ready) return ready;
            const item = https(document.id ?? document.url, ["www.loc.gov"]);
            if (!item || !/^\/item\/[^/]+\/$/.test(new URL(item).pathname))
              return null;
            try {
              const url = new URL(item);
              url.searchParams.set("fo", "json");
              return locRecord(await get(url.href));
            } catch {
              return null;
            }
          }),
        );
        records.push(...chunk.filter(Boolean));
      }
    } else if (source === "leventhal") {
      const url = new URL("https://collections.leventhalmap.org/search.json");
      for (const [k, v] of Object.entries({
        q,
        per_page: String(SIZE),
        page: String(page),
      }))
        url.searchParams.set(k, v);
      const data = await get(url.href);
      documents = (data.response?.docs ?? data.data ?? []).slice(0, SIZE);
      total = data.response?.numFound ?? data.meta?.pages?.total_count ?? null;
      records = documents.map(leventhalRecord).filter(Boolean);
    } else {
      const url = new URL("https://tnmaccess.nationalmap.gov/api/v1/products");
      for (const [k, v] of Object.entries({
        datasets: "Historical Topographic Maps",
        max: String(SIZE),
        offset: String((page - 1) * SIZE),
        outputFormat: "JSON",
      }))
        url.searchParams.set(k, v);
      const bbox = (query.get("bbox") ?? "").split(",").map(Number);
      if (
        bbox.length === 4 &&
        bbox.every(Number.isFinite) &&
        bbox[0] < bbox[2] &&
        bbox[1] < bbox[3] &&
        bbox[0] >= -180 &&
        bbox[2] <= 180 &&
        bbox[1] >= -90 &&
        bbox[3] <= 90
      )
        url.searchParams.set("bbox", bbox.join(","));
      const data = await get(url.href);
      documents = (data.items ?? []).slice(0, SIZE);
      total = data.total ?? null;
      records = documents.map(usgsRecord).filter(Boolean);
    }
    for (const record of records) {
      const recordKey = new Request(
        `${new URL(request.url).origin}/api/catalogue-record?id=${encodeURIComponent(record.id)}`,
      );
      ctx.waitUntil(
        caches.default.put(
          recordKey,
          Response.json(record, {
            headers: { "cache-control": "public, max-age=86400" },
          }),
        ),
      );
    }
    const response = Response.json(
      {
        source,
        query: q,
        page,
        total,
        records,
        examined: documents.length,
        withheld: documents.length - records.length,
        nextPage: documents.length === SIZE ? page + 1 : null,
        note: "Only rights-cleared results are added. An unlocated or unaligned scan is still eligible; an unknown image-rights statement is not treated as permission.",
      },
      { headers: { "cache-control": "public, max-age=600" } },
    );
    ctx.waitUntil(caches.default.put(key, response.clone()));
    return response;
  } catch {
    return Response.json(
      {
        error: "collection_unavailable",
        source,
        records: [],
        note: "The original collection is temporarily unavailable. The bundled global catalogue remains usable.",
      },
      { status: 502 },
    );
  }
}
