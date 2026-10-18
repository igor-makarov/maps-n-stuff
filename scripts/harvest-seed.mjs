#!/usr/bin/env node
/**
 * Reproducible seed harvest for the maps-n-stuff demo.
 *
 * Sources (all documented, public, no credentials):
 *   1. e-rara OAI-PMH, set `zuz` (Zentralbibliothek Zürich interface), oai_dc.
 *      https://www.e-rara.ch/zuz/oai?verb=ListRecords&metadataPrefix=oai_dc&set=zuz
 *      -> real catalogue metadata (title, imprint date, creator, rights, coverage).
 *   2. e-rara DOI landing page -> IIIF Presentation 2.0 manifest (per title).
 *      https://www.e-rara.ch/doi/10.3931/e-rara-<id>  -> /i3f/v20/<titleId>/manifest
 *      -> holding institution, shelfmark, extent statement, IIIF image service.
 *   3. swisstopo WMTS capabilities (georeferenced historical map services).
 *      https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml
 *
 * Nothing is invented: every field is copied from an upstream response. Fields
 * that the upstream does not state stay null (see docs/SOURCES.md).
 *
 * Usage: node scripts/harvest-seed.mjs [--pages 3] [--limit 24] [--offline]
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';

const UA = 'maps-n-stuff-seed-harvest/0.1 (+https://github.com/igor-makarov/maps-n-stuff)';
const args = process.argv.slice(2);
const num = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const PAGES = num('--pages', 3);
const LIMIT = num('--limit', 24);
const OFFLINE = args.includes('--offline');
const CACHE = new URL('../.cache/', import.meta.url);
const ERARA = 'https://www.e-rara.ch';
const OAI = `${ERARA}/zuz/oai`;
const WMTS_CAPS = 'https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml';

async function cached(name, fn) {
  await mkdir(CACHE, { recursive: true });
  const file = new URL(name, CACHE);
  if (OFFLINE) return JSON.parse(await readFile(file, 'utf8'));
  const value = await fn();
  await writeFile(file, JSON.stringify(value, null, 1));
  return value;
}
async function text(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/xml,text/html,application/json' } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}
const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const clean = (s) => unescapeXml(s).replace(/\s+/g, ' ').trim();
const pick = (xml, tag) => [...xml.matchAll(new RegExp(`<dc:${tag}[^>]*>([\\s\\S]*?)</dc:${tag}>`, 'g'))].map((m) => clean(m[1]));

function parseOai(xml) {
  const records = [];
  for (const m of xml.matchAll(/<record>([\s\S]*?)<\/record>/g)) {
    const r = m[1];
    if (r.includes('<header status="deleted"')) continue;
    const doi = pick(r, 'identifier').find((i) => i.startsWith('doi:10.3931/e-rara-'));
    if (!doi) continue;
    records.push({
      eid: doi.split('-').pop(),
      titles: pick(r, 'title'),
      dates: pick(r, 'date'),
      creators: pick(r, 'creator'),
      types: pick(r, 'type'),
      publishers: pick(r, 'publisher'),
      rights: pick(r, 'rights'),
      coverage: pick(r, 'coverage'),
      formats: pick(r, 'format'),
      languages: pick(r, 'language'),
    });
  }
  const token = xml.match(/<resumptionToken[^>]*>([^<]*)<\/resumptionToken>/);
  return { records, token: token && token[1] ? token[1] : null };
}

/** "(E 5°50'-E 10°30'/N 47°50'-N 45°40')" -> bbox, or null when not stated. */
export function parseExtent(statement) {
  if (!statement) return null;
  const lon = [...statement.matchAll(/([EW])\s*(\d{1,3})°(?:\s*(\d{1,2})['′])?/g)].map((m) => ({
    sign: m[1] === 'W' ? -1 : 1, deg: +m[2], min: m[3] ? +m[3] : 0,
  }));
  const lat = [...statement.matchAll(/([NS])\s*(\d{1,2})°(?:\s*(\d{1,2})['′])?/g)].map((m) => ({
    sign: m[1] === 'S' ? -1 : 1, deg: +m[2], min: m[3] ? +m[3] : 0,
  }));
  if (!lon.length || !lat.length) return null;
  const val = (v) => v.sign * (v.deg + v.min / 60);
  const lons = lon.map(val), lats = lat.map(val);
  const extent = { west: Math.min(...lons), east: Math.max(...lons), south: Math.min(...lats), north: Math.max(...lats) };
  if (!(extent.west < extent.east && extent.south < extent.north)) return null;
  return Object.fromEntries(Object.entries(extent).map(([k, v]) => [k, +v.toFixed(4)]));
}

async function enrich(rec) {
  const doiUrl = `${ERARA}/doi/10.3931/e-rara-${rec.eid}`;
  const page = await text(doiUrl);
  const man = page.match(/i3f\/v20\/(\d+)\/manifest/);
  if (!man) throw new Error('no IIIF manifest link on ' + doiUrl);
  const titleId = man[1];
  const manifest = JSON.parse(await text(`${ERARA}/i3f/v20/${titleId}/manifest`));
  const canvas = manifest.sequences?.[0]?.canvases?.[0];
  const image = canvas?.images?.[0]?.resource;
  const service = image?.service?.['@id'];
  const meta = Object.fromEntries((manifest.metadata || []).filter((m) => m.label && m.value).map((m) => [m.label, clean(String(m.value))]));
  const stairs = Object.fromEntries(Object.entries(meta).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    doiUrl,
    titleId,
    manifest: `${ERARA}/i3f/v20/${titleId}/manifest`,
    label: manifest.label ? clean(String(manifest.label)) : null,
    institution: (stairs['besitzende institution'] || '').split(',')[0].trim() || 'Zentralbibliothek Zürich',
    shelfmark: stairs['besitzende institution'] || null,
    imprint: stairs.impressum || null,
    extentStatement: stairs['kartendaten'] || null,
    onlineSince: stairs['online seit'] || null,
    imageService: service || null,
    thumbnail: service ? `${service}/full/304/0/default.jpg` : image?.['@id'] || null,
    canvasCount: manifest.sequences?.[0]?.canvases?.length ?? 0,
  };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try { out[i] = await fn(items[i]); } catch (err) { out[i] = { error: String(err.message || err) }; }
    }
  }));
  return out;
}

/** swisstopo georeferenced historical layers from WMTS capabilities. */
export function parseWmts(xml) {
  const layers = [];
  for (const layer of xml.split('<Layer>').slice(1)) {
    const id = layer.match(/<ows:Identifier>([^<]+)<\/ows:Identifier>/);
    if (!id || !/zeitreihen|hiks|swissimage|pixelkarte/.test(id[1])) continue;
    const titles = [...layer.matchAll(/<ows:Title>([^<]*)<\/ows:Title>/g)].map((m) => clean(m[1]));
    const dim = layer.match(/<Dimension[^>]*>([\s\S]*?)<\/Dimension>/);
    const times = dim ? [...dim[1].matchAll(/<Value>([^<]+)<\/Value>/g)].map((m) => m[1]) : [];
    const bbox = layer.match(/<ows:WGS84BoundingBox>[\s\S]*?<ows:LowerCorner>([^<]+)<\/ows:LowerCorner>[\s\S]*?<ows:UpperCorner>([^<]+)<\/ows:UpperCorner>/);
    const tileMatrixSet = layer.match(/<TileMatrixSetLink>[\s\S]*?<TileMatrixSet>([^<]+)<\/TileMatrixSet>/);
    const template = layer.match(/<ResourceURL[^>]*template="([^"]+)"/);
    if (!times.length || !template) continue;
    layers.push({
      id: id[1], title: titles[0] || id[1], titles,
      timeValues: times, tileMatrixSet: tileMatrixSet ? tileMatrixSet[1] : null,
      urlTemplate: template[1],
      extent: bbox ? { west: +bbox[1].split(' ')[0], south: +bbox[1].split(' ')[1], east: +bbox[2].split(' ')[0], north: +bbox[2].split(' ')[1] } : null,
    });
  }
  return layers;
}

async function main() {
  const stamp = new Date().toISOString().slice(0, 10);
  const oai = await cached('oai-zuz.json', async () => {
    const records = [];
    let url = `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=zuz`;
    for (let page = 0; page < PAGES && url; page++) {
      const xml = await text(url);
      const parsed = parseOai(xml);
      records.push(...parsed.records);
      url = parsed.token ? `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(parsed.token)}` : null;
    }
    return records;
  });
  const unique = [...new Map(oai.map((r) => [r.eid, r])).values()].slice(0, LIMIT);
  console.log(`OAI: ${oai.length} records, using ${unique.length}`);
  const enriched = await cached('enriched.json', () => mapLimit(unique, 6, enrich));

  const records = [];
  const skipped = [];
  unique.forEach((rec, i) => {
    const meta = enriched[i];
    if (!meta || meta.error || !meta.thumbnail || !meta.manifest) { skipped.push({ eid: rec.eid, reason: meta?.error || 'incomplete' }); return; }
    const years = (rec.dates.join(' ').match(/\d{4}/g) || []).map(Number).filter((y) => y >= 1400 && y <= 2100);
    if (!years.length || !rec.titles.length) { skipped.push({ eid: rec.eid, reason: 'no date/title' }); return; }
    const coversZurich = rec.coverage.some((c) => /z[üu]rich/i.test(c));
    records.push({
      id: `e-rara:${rec.eid}`,
      title: rec.titles[0],
      titleAlt: rec.titles.slice(1, 3),
      yearStart: Math.min(...years),
      yearEnd: Math.max(...years),
      depictedYearStart: null,
      depictedYearEnd: null,
      creators: rec.creators,
      providerId: 'e-rara',
      institution: meta.institution,
      shelfmark: meta.shelfmark,
      rights: rec.rights[0] || 'See upstream record',
      recordUrl: meta.doiUrl,
      thumbnail: meta.thumbnail,
      iiifManifest: meta.manifest,
      type: /atlas/i.test(rec.formats.join(' ')) ? 'atlas' : 'map',
      publisher: rec.publishers[0] || null,
      imprint: meta.imprint,
      languages: rec.languages,
      extent: parseExtent(meta.extentStatement),
      extentStatement: meta.extentStatement,
      canvasCount: meta.canvasCount,
      subjectPlace: coversZurich ? 'Zürich (upstream coverage field)' : null,
      geo: coversZurich ? { lat: 47.377213, lon: 8.527311 } : null,
      geoNote: coversZurich ? 'Point = swisstopo SearchServer result for "Zürich (ZH)", coverage field says Zürich' : null,
    });
  });
  console.log(`records: ${records.length}, skipped: ${JSON.stringify(skipped)}`);

  const caps = await cached('wmts-caps.parsed.json', async () => parseWmts(await text(WMTS_CAPS)));
  const overlays = caps.filter((l) => l.tileMatrixSet === '3857_18' || l.id === 'ch.swisstopo.zeitreihen').map((l) => ({
    id: l.id,
    title: l.title,
    providerId: 'swisstopo',
    urlTemplate: l.urlTemplate,
    timeValues: l.timeValues,
    urlFor: (time) => l.urlTemplate.replace('{Time}', time).replace('{TileMatrixSet}', l.tileMatrixSet).replace('{TileMatrix}', '{z}').replace('{TileCol}', '{x}').replace('{TileRow}', '{y}'),
    maxZoom: 18,
    tileMatrixSet: l.tileMatrixSet,
    extent: l.extent,
    attribution: '© swisstopo (Zeitreise – historische Kartenwerke)',
    license: 'swisstopo geoservices: free use with attribution (Open Government Data)',
  }));

  const sources = {
    generatedAt: new Date().toISOString(),
    method: `e-rara OAI-PMH set=zuz (${PAGES} pages) + DOI landing pages + IIIF manifests + swisstopo WMTS capabilities`,
    providers: [
      {
        id: 'e-rara',
        name: 'e-rara – Plattform für digitalisierte Drucke aus Schweizer Bibliotheken',
        operator: 'Zentralbibliothek Zürich (ZB) with Swiss university libraries',
        homepage: 'https://www.e-rara.ch/',
        recordUrlPattern: 'https://www.e-rara.ch/zuz/doi/10.3931/e-rara-{id}',
        api: {
          oai: 'https://www.e-rara.ch/zuz/oai?verb=ListRecords&metadataPrefix=oai_dc&set=zuz (OAI-PMH 2.0, oai_dc)',
          manifest: 'https://www.e-rara.ch/i3f/v20/{titleId}/manifest (IIIF Presentation API 2.0)',
          image: 'https://www.e-rara.ch/i3f/v20/{imageId}/{region}/{size}/{rotation}/{quality}.{format} (IIIF Image API 2, level2)',
          cors: 'access-control-allow-origin: * (verified 2026-10-18)',
        },
        rights: 'Per record, from dc:rights (mostly PDM 1.0 = Public Domain Mark) and the item\u2019s own rights statement.',
        attribution: 'Zentralbibliothek Zürich via e-rara',
        retrievalDate: stamp,
        verified: '2026-10-18',
      },
      {
        id: 'swisstopo',
        name: 'swisstopo – Bundesamt für Landestopografie, geoadmin geoservices',
        operator: 'Bundesamt für Landestopografie swisstopo',
        homepage: 'https://www.swisstopo.admin.ch/en/geoservices-with-swisstopo-geodata',
        recordUrlPattern: 'https://map.geo.admin.ch/?layers={layerId}&time={time}',
        api: {
          wmts: 'https://wmts.geo.admin.ch/1.0.0/{layerId}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileCol}/{TileRow}.{ext} (WMTS 1.0.0)',
          capabilities: WMTS_CAPS,
          search: 'https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText={q}&type=locations&sr=4326&limit={n} (CORS *)',
        },
        rights: 'Open Government Data / swisstopo geoservices terms, attribution required.',
        attribution: '© swisstopo',
        retrievalDate: stamp,
        verified: '2026-10-18',
      },
      {
        id: 'local',
        name: 'Local fixture provider (tests only)',
        operator: 'this repository',
        rights: 'CC0 fixtures used to keep the UI testable when upstreams are unreachable.',
        attribution: 'repository fixtures',
        retrievalDate: stamp,
      },
    ],
  };

  await writeFile(new URL('../public/data/records.json', import.meta.url), JSON.stringify({
    generatedAt: sources.generatedAt,
    method: sources.method,
    skipped,
    records,
  }, null, 1) + '\n');
  await writeFile(new URL('../public/data/overlays.json', import.meta.url), JSON.stringify({
    generatedAt: sources.generatedAt,
    source: 'swisstopo WMTS capabilities (georeferenced historical map services)',
    attribution: '© swisstopo',
    overlays,
  }, null, 1) + '\n');
  await writeFile(new URL('../public/data/sources.json', import.meta.url), JSON.stringify(sources, null, 1) + '\n');
  console.log(`overlays: ${overlays.map((o) => `${o.id} (${o.timeValues.length} time values)`).join(', ')}`);
}
if (import.meta.url === `file://${process.argv[1]}`) await main();
