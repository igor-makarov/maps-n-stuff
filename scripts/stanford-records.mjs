/** Stanford's CC0 discovery metadata; image permission is checked separately per record. */
export const STANFORD_REPOSITORY =
  "https://github.com/OpenGeoMetadata/edu.stanford.purl";
export const STANFORD_REVISION = "ff804e306fb2f79ac837c5045c7e0d9acb1d979b";
const first = (value) => (Array.isArray(value) ? value[0] : value);
export function parseEnvelope(value) {
  const match = String(value ?? "").match(
    /^ENVELOPE\(\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*,\s*([\d.e+-]+)\s*\)$/i,
  );
  if (!match) return null;
  const [west, east, north, south] = match.slice(1).map(Number);
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
function safeUrl(value, hosts) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      hosts.includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export function stanfordRecord(metadata, sourcePath) {
  if (
    !metadata.gbl_resourceClass_sm?.includes("Maps") ||
    metadata.dct_accessRights_s !== "Public"
  )
    return null;
  const rights = (metadata.dct_rights_sm ?? []).join(" ");
  const rightsHolder = (metadata.dct_rightsHolder_sm ?? []).join(" ");
  const licence = (metadata.dct_license_sm ?? []).find((value) =>
    /^https?:\/\/creativecommons\.org\/publicdomain\/(mark|zero)\/1\.0\/?$/.test(
      value,
    ),
  );
  if (
    !licence ||
    !rights ||
    /non[ -]?commercial|all rights reserved|permission is required/i.test(
      `${rights} ${rightsHolder}`,
    )
  )
    return null;
  const druid = String(metadata.id ?? "").match(
    /^stanford-([a-z]{2}\d{3}[a-z]{2}\d{4})$/,
  )?.[1];
  if (!druid || !metadata.dct_title_s) return null;
  let refs;
  try {
    refs = JSON.parse(metadata.dct_references_s ?? "{}");
  } catch {
    return null;
  }
  const recordUrl = safeUrl(refs["http://schema.org/url"], [
    "purl.stanford.edu",
  ]);
  if (!recordUrl) return null;
  const issued = String(metadata.dct_issued_s ?? "");
  const statedYears = [...issued.matchAll(/\b(\d{4})\b/g)]
    .map((match) => Number(match[1]))
    .filter((year) => year > 0 && year <= 2100);
  const yearStart = statedYears[0] ?? null;
  const yearEnd = statedYears.at(-1) ?? null;
  const extent = parseEnvelope(metadata.dcat_bbox ?? metadata.locn_geometry);
  const thumbnail = safeUrl(refs["http://schema.org/thumbnailUrl"], [
    "stacks.stanford.edu",
  ]);
  const manifest = safeUrl(refs["http://iiif.io/api/presentation#manifest"], [
    "purl.stanford.edu",
  ]);
  const cog =
    metadata.gbl_georeferenced_b === true
      ? safeUrl(refs["https://github.com/cogeotiff/cog-spec"], [
          "stacks.stanford.edu",
        ])
      : null;
  const temporal = (metadata.dct_temporal_sm ?? []).find((value) =>
    /^\d{4}(?:[-/]\d{4})?$/.test(value),
  );
  const depicted = temporal?.split(/[-/]/).map(Number);
  const usableDepicted =
    depicted &&
    depicted[0] <= depicted.at(-1) &&
    (!yearEnd || depicted.at(-1) <= yearEnd);
  return {
    id: `stanford:${druid}`,
    title: metadata.dct_title_s,
    yearStart,
    yearEnd,
    publicationSource: issued || null,
    depictedYearStart: usableDepicted ? depicted[0] : null,
    depictedYearEnd: usableDepicted ? depicted.at(-1) : null,
    ...(usableDepicted
      ? { depictedSource: `Stanford catalogue temporal coverage: ${temporal}` }
      : {}),
    creators: metadata.dct_creator_sm ?? [],
    providerId: "stanford",
    institution: "Stanford University Libraries",
    rights,
    rightsUrl: licence.replace(/^http:/, "https:"),
    attribution: rights,
    recordUrl,
    viewerUrl: recordUrl,
    thumbnail,
    iiifManifest: manifest,
    languages: metadata.dct_language_sm ?? [],
    subjectPlace: (metadata.dct_spatial_sm ?? []).join("; "),
    type: "map",
    collection: cog
      ? "Stanford georeferenced historic maps"
      : "Stanford historic maps and atlases",
    extent,
    geo: extent
      ? {
          lat: (extent.south + extent.north) / 2,
          lon: (extent.west + extent.east) / 2,
        }
      : null,
    geoNote: cog
      ? "The collection supplies a georeferenced raster. The viewer reads its own CRS and pixel transformation; the catalogue box is only a search footprint."
      : "Catalogue coordinates describe discovery coverage when available. The scanned image has no verified overlay alignment in this catalogue.",
    ...(cog
      ? {
          georeference: {
            kind: "cog",
            url: cog,
            source: recordUrl,
            status: "provider-supplied",
          },
        }
      : {}),
    downloads: (refs["http://schema.org/downloadUrl"] ?? [])
      .map((value) =>
        typeof value === "string"
          ? { url: value, label: "Original files" }
          : value,
      )
      .filter((value) => safeUrl(value.url, ["stacks.stanford.edu"])),
    metadataSource: `${STANFORD_REPOSITORY}/blob/${STANFORD_REVISION}/${sourcePath}`,
    sourceModified: metadata.gbl_mdModified_dt ?? null,
    dateNote: cog
      ? "Publication year describes the digital raster dataset; the historical period is stated separately when documented."
      : null,
  };
}
export const STANFORD_PROVIDER = {
  id: "stanford",
  name: "Stanford University Libraries",
  operator: "Stanford University Libraries",
  homepage: "https://earthworks.stanford.edu/",
  attribution: "Stanford University Libraries / original collection",
  rights:
    "Metadata CC0 1.0. Only public map records with an explicit Public Domain Mark or CC0 image statement are included; original per-item rights are retained.",
  terms: `${STANFORD_REPOSITORY}/blob/${STANFORD_REVISION}/LICENSE`,
  api: {
    metadata: STANFORD_REPOSITORY,
    manifest: "https://purl.stanford.edu/{druid}/iiif3/manifest",
    images: "https://stacks.stanford.edu/image/iiif/",
    raster: "https://stacks.stanford.edu/file/druid:{druid}/{file}",
  },
  sourceRevision: STANFORD_REVISION,
};
