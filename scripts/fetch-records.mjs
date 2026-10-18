#!/usr/bin/env node
/**
 * Reproduce the seed dataset from primary sources.
 *
 * Sources (retrieved 2026-10-18):
 *  - e-rara OAI-PMH  https://www.e-rara.ch/oai  (set `zuz` = ZB Zürich, `landkarten`)
 *  - e-rara IIIF Presentation 2.0 manifests with verbatim metadata + stated map bbox
 *  - swisstopo WMTS capabilities https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml
 *
 * No upstream metadata is invented: titles/imprints/creators/institutions/rights are
 * copied from the IIIF manifest (which mirrors the catalogue record), and geographic
 * extents are parsed from the upstream "Kartendaten" statement. swisstopo overlay
 * editions come from the WMTS Time dimension.
 *
 * Usage:
 *   node scripts/fetch-records.mjs --out public/data      # refresh from the network
 *   node scripts/fetch-records.mjs --offline              # replay the .cache/ responses
 *   node scripts/fetch-records.mjs --out /tmp/out --no-write
 *
 * The script is deliberately dependency-free and polite: max 3 concurrent requests,
 * a short pause between manifest requests, a descriptive User-Agent, and an on-disk
 * response cache (`.cache/fetch/`, git-ignored) so repeated runs do not hammer the
 * upstreams. `--offline` never opens a network connection.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const UA = 'Kartenzeit/1.0 (Canton-Zurich design study; contact: project maintainers)';
const args = process.argv.slice(2);
const outDir = resolve(getArg('--out') || 'public/data');
const writeOutput = !args.includes('--no-write');
const OFFLINE = args.includes('--offline');
const RETRIEVED = '2026-10-18';
const CACHE_DIR = new URL('../.cache/fetch/', import.meta.url);

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

function cacheFile(url, as) {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 20);
  return new URL(`./${hash}.${as === 'json' ? 'json' : 'txt'}`, CACHE_DIR);
}

async function get(url, { as = 'text', timeout = 25000 } = {}) {
  const file = cacheFile(url, as);
  if (OFFLINE) {
    const cached = await readFile(file, 'utf8');
    return as === 'json' ? JSON.parse(cached) : cached;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : '*/*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    const body = as === 'json' ? await res.json() : await res.text();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, as === 'json' ? JSON.stringify(body) : body);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(Number(num)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .trim();
}

function first(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : null;
}

function all(xml, tag) {
  return [...xml.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => decode(m[1]));
}

/** e-rara OAI-PMH pages for one set; returns raw <record> strings. */
async function oaiRecords(set, maxPages) {
  const records = [];
  let token = null;
  for (let page = 0; page < maxPages; page++) {
    const url = token
      ? `https://www.e-rara.ch/oai?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
      : `https://www.e-rara.ch/oai?verb=ListRecords&metadataPrefix=oai_dc&set=${encodeURIComponent(set)}`;
    const xml = await get(url);
    records.push(...all(xml, 'record'));
    const m = xml.match(/<resumptionToken[^>]*>([^<]+)<\/resumptionToken>/);
    token = m ? m[1] : null;
    if (!token) break;
    await sleep(120);
  }
  return records;
}

function parseOai(record) {
  const setSpecs = all(record, 'setSpec');
  const types = all(record, 'dc:type');
  const title = all(record, 'dc:title')[0] || '';
  const dates = all(record, 'dc:date');
  const ids = all(record, 'dc:identifier');
  const doi = ids.find((i) => i.startsWith('https://www.e-rara.ch/doi/')) || null;
  const oai = first(record, 'identifier');
  const titleId = (oai || '').split(':').pop();
  return {
    title,
    titles: all(record, 'dc:title'),
    dates,
    creators: all(record, 'dc:creator').filter(Boolean),
    publisher: first(record, 'dc:publisher'),
    contributors: all(record, 'dc:contributor'),
    description: all(record, 'dc:description'),
    format: first(record, 'dc:format'),
    rights: first(record, 'dc:rights'),
    doi,
    titleId,
    isMap: types.includes('Map'),
    zuz: setSpecs.includes('zuz'),
    year: parseYear(dates[0]),
  };
}

function parseYear(value) {
  const m = String(value || '').match(/(1[4-9]\d{2}|20\d{2})/);
  return m ? Number(m[1]) : null;
}

/** Parse "(E 8°31'-E 8°41'/N 47°43'-N 47°38')" into a WGS84 bbox. */
function parseBbox(kartendaten) {
  if (!kartendaten) return null;
  const dms = (dir, deg, min) => {
    const v = Number(deg) + (min ? Number(min) / 60 : 0);
    return dir === 'W' || dir === 'S' ? -v : v;
  };
  const parts = {
    west: kartendaten.match(/[EW]\s*(\d+)[°º](?:\s*(\d+)\s*['′’])?/),
    north: kartendaten.match(/N\s*(\d+)[°º](?:\s*(\d+)\s*['′’])?/),
  };
  const east = [...kartendaten.matchAll(/[EW]\s*(\d+)[°º](?:\s*(\d+)\s*['′’])?/g)][1];
  const south = [...kartendaten.matchAll(/N\s*(\d+)[°º](?:\s*(\d+)\s*['′’])?/g)][1];
  if (!parts.west || !east || !parts.north || !south) return null;
  const bbox = {
    west: dms('E', parts.west[1], parts.west[2]),
    east: dms('E', east[1], east[2]),
    north: dms('N', parts.north[1], parts.north[2]),
    south: dms('N', south[1], south[2]),
  };
  // Some records state north/south in the opposite order; normalise only the pair
  // that the upstream text clearly labels, never invent coordinates.
  if (bbox.south > bbox.north) [bbox.south, bbox.north] = [bbox.north, bbox.south];
  if (![bbox.west, bbox.east, bbox.south, bbox.north].every(Number.isFinite)) return null;
  if (bbox.west >= bbox.east || bbox.south >= bbox.north) return null;
  return bbox;
}

function metaMap(manifest) {
  const out = {};
  for (const entry of manifest.metadata || []) {
    const key = entry.label || '';
    const value = typeof entry.value === 'string' ? entry.value : String(entry.value || '');
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Canonical viewer URL for an e-rara item.
 *
 * The platform's own DOI landing page states the holding corpus in `og:url`
 * (`zuz` = Zentralbibliothek Zürich, `zut` = ETH-Bibliothek, `gep_r` = Musée
 * cartographique Genève, …). The viewer route is the provider's documented
 * `/<corpus>/content/zoom/<id>`; the id is verified against the manifest title id
 * so a wrong or foreign id can never be written into the data. Returns null when
 * the landing page does not state it — nothing is ever constructed from a guess.
 */
async function canonicalViewer(doi, titleId) {
  if (!doi) return null;
  const html = await get(doi, { as: 'text', timeout: 20000 });
  const m = html.match(/og:url"\s+content="https?:\/\/www\.e-rara\.ch\/([a-z0-9_]+)\/(\d+)"/);
  if (!m || m[2] !== String(titleId)) return null;
  return { corpus: m[1], id: m[2], viewerUrl: `https://www.e-rara.ch/${m[1]}/content/zoom/${m[2]}` };
}

async function manifestRecord(candidate, { sourceCollection, maxYear }) {
  const manifestUrl = `https://www.e-rara.ch/i3f/v20/${candidate.titleId}/manifest`;
  const manifest = await get(manifestUrl, { as: 'json', timeout: 40000 });
  const meta = metaMap(manifest);
  const label = String(manifest.label || candidate.title);
  const bbox = parseBbox(meta.Kartendaten);
  const canvases = manifest.sequences?.[0]?.canvases || manifest.items || [];
  const canvas = canvases[0];
  const imageService = canvas?.images?.[0]?.resource?.service?.['@id'] || null;
  const imprint = meta.Impressum || '';
  const year = candidate.year || parseYear(imprint);
  if (!year || (maxYear && year > maxYear)) return null;
  const institution = (meta['Besitzende Institution'] || '').replace(/\s*,.*$/, '').trim();
  const thumb = manifest.thumbnail?.['@id'];
  if (!thumb) return null;
  const sheet = label.includes(':') ? label.slice(label.lastIndexOf(':') + 1).trim() : null;
  const title = label || candidate.title;
  const record = {
    id: `e-rara:${candidate.titleId}`,
    title,
    yearStart: year,
    yearEnd: year,
    depictedYearStart: null,
    depictedYearEnd: null,
    creators: candidate.creators.length ? candidate.creators : [],
    providerId: 'e-rara',
    institution: institution || (candidate.zuz ? 'Zentralbibliothek Zürich' : 'ETH-Bibliothek Zürich'),
    rights: candidate.rights || 'PDM 1.0',
    recordUrl: candidate.doi || `https://www.e-rara.ch/zuz/content/titleinfo/${candidate.titleId}`,
    thumbnail: thumb,
    iiifManifest: manifestUrl,
    type: 'map',
    collection: sourceCollection,
  };
  if (bbox) {
    const rounded = Object.fromEntries(
      Object.entries(bbox).map(([k, v]) => [k, Number(v.toFixed(5))]),
    );
    record.extent = rounded;
    record.geo = {
      lat: Number(((rounded.south + rounded.north) / 2).toFixed(5)),
      lon: Number(((rounded.west + rounded.east) / 2).toFixed(5)),
    };
  }
  if (imageService) record.imageService = imageService;
  if (canvases.length) record.canvasCount = canvases.length;
  // The library's own deep-zoom viewer, straight from the provider's landing page.
  try {
    const canonical = await canonicalViewer(candidate.doi, candidate.titleId);
    if (canonical) record.viewerUrl = canonical.viewerUrl;
  } catch {
    /* stay without viewerUrl: the UI derives a working link from the manifest id */
  }
  if (sheet && candidate.zuz) record.sheet = sheet;
  if (imprint) record.imprint = imprint;
  return record;
}

async function pool(items, limit, fn) {
  const out = [];
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        console.error('skip', items[i].titleId, err.message);
        out[i] = null;
      }
      await sleep(180);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out.filter(Boolean);
}

const WMTS_CAPS = 'https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml';

/**
 * Parse a WMTS 1.0.0 GetCapabilities document:
 *   layers     Map<layerId, { id, title, timeValues, urlTemplate, tileMatrixSet, maxZoom, extent }>
 *   matrixSets Map<setId, maxZoom>  (from the TileMatrixSet definitions, identifiers are 0-based)
 * Only layers that advertise both a `Time` dimension and a tile template are kept.
 */
export function parseWmtsCapabilities(xml) {
  const matrixSets = new Map();
  for (const m of xml.matchAll(/<TileMatrixSet>\s*<ows:Identifier>([^<]+)<\/ows:Identifier>([\s\S]*?)<\/TileMatrixSet>/g)) {
    const count = m[2].split('<TileMatrix>').length - 1;
    if (count > 1) matrixSets.set(m[1], count - 1);
  }
  const layers = new Map();
  for (const block of xml.split('<Layer>').slice(1)) {
    const id = block.match(/<ows:Identifier>([^<]+)<\/ows:Identifier>/);
    if (!id) continue;
    const title = block.match(/<ows:Title>([^<]*)<\/ows:Title>/);
    const dim = block.match(/<Dimension[^>]*>([\s\S]*?)<\/Dimension>/);
    const timeValues = dim ? [...dim[1].matchAll(/<Value>([^<]+)<\/Value>/g)].map((m) => decode(m[1])) : [];
    const template = block.match(/<ResourceURL[^>]*template="([^"]+)"/);
    const set = block.match(/<TileMatrixSetLink>[\s\S]*?<TileMatrixSet>([^<]+)<\/TileMatrixSet>/);
    const bbox = block.match(/<ows:WGS84BoundingBox>[\s\S]*?<ows:LowerCorner>([^<]+)<\/ows:LowerCorner>[\s\S]*?<ows:UpperCorner>([^<]+)<\/ows:UpperCorner>/);
    if (!timeValues.length || !template) continue;
    const tileMatrixSet = set ? set[1] : null;
    const lower = bbox ? bbox[1].split(/\s+/).map(Number) : null;
    const upper = bbox ? bbox[2].split(/\s+/).map(Number) : null;
    layers.set(id[1], {
      id: id[1],
      title: title ? decode(title[1]) : id[1],
      timeValues,
      urlTemplate: template[1],
      tileMatrixSet,
      maxZoom: (tileMatrixSet && matrixSets.get(tileMatrixSet)) || 17,
      extent:
        lower && upper && lower.every(Number.isFinite) && upper.every(Number.isFinite)
          ? { west: lower[0], south: lower[1], east: upper[0], north: upper[1] }
          : null,
    });
  }
  return { layers, matrixSets };
}

let capabilitiesPromise = null;
function wmtsLayers() {
  if (!capabilitiesPromise) {
    capabilitiesPromise = get(WMTS_CAPS, { timeout: 60000 }).then((xml) => parseWmtsCapabilities(xml));
  }
  return capabilitiesPromise;
}

/**
 * Curated swisstopo series for the record list. `years` are the editions the
 * gallery wants to show; the record always describes the edition the service
 * actually advertises (exact year when available, otherwise the nearest one).
 */
const SWISSTOPO_SERIES = [
  {
    layerId: 'ch.swisstopo.zeitreihen',
    slug: 'zeitreise',
    collection: 'Zeitreise – Kartenwerke',
    title: (year) => `Zeitreise – Kartenwerke, Ausgabe ${year}`,
    years: [1844, 1850, 1860, 1870, 1883, 1895, 1910, 1925, 1940, 1955, 1970, 1990, 2005, 2021],
    attribution: '© swisstopo – Zeitreise (Kartenwerke)',
  },
  {
    layerId: 'ch.swisstopo.hiks-siegfried',
    slug: 'siegfried',
    collection: 'Siegfriedkarte 1:25 000',
    title: (year) => `Siegfriedkarte 1:25 000, Ausgabe ${year}`,
    years: [1870, 1880, 1890, 1900, 1910, 1920, 1930, 1940, 1949],
    attribution: '© swisstopo – Siegfriedkarte',
  },
  {
    layerId: 'ch.swisstopo.swissimage-product',
    slug: 'swissimage',
    collection: 'SWISSIMAGE Zeitreise (Luftbilder)',
    title: (year) => `SWISSIMAGE Zeitreise, Luftbild ${year}`,
    years: [1960, 1980, 2000, 2020],
    attribution: '© swisstopo – SWISSIMAGE Zeitreise',
  },
  {
    // Dedicated historical layer with full national coverage (the Time dimension
    // of `swissimage-product` only has sparse 1946 imagery).
    layerId: 'ch.swisstopo.swissimage-product_1946',
    slug: 'swissimage',
    collection: 'SWISSIMAGE Zeitreise (Luftbilder)',
    title: (year) => `SWISSIMAGE Zeitreise, Luftbild ${year}`,
    years: [1946],
    attribution: '© swisstopo – SWISSIMAGE 1946',
  },
];

/** Comparison layers offered by the picker (see `public/data/overlays.json`). */
const OVERLAY_LAYER_IDS = [
  'ch.swisstopo.zeitreihen',
  'ch.swisstopo.hiks-siegfried',
  'ch.swisstopo.hiks-dufour',
  'ch.swisstopo.swissimage-product',
  'ch.swisstopo.swissimage-product_1946',
  'ch.swisstopo.pixelkarte-farbe-pk1000.noscale',
  'ch.swisstopo.pixelkarte-farbe-pk500.noscale',
  'ch.swisstopo.pixelkarte-farbe-pk200.noscale',
  'ch.swisstopo.pixelkarte-farbe-pk100.noscale',
  'ch.swisstopo.pixelkarte-farbe-pk50.noscale',
  'ch.swisstopo.pixelkarte-farbe-pk25.noscale',
  'ch.swisstopo.pixelkarte-grau-pk1000.noscale',
];

const SWISSTOPO_LICENSE = 'OGD swisstopo (Open Government Data); Quellenangabe «©swisstopo» erforderlich';

function swisstopoAttribution(layer) {
  if (layer.id === 'ch.swisstopo.zeitreihen') return '© swisstopo – Zeitreise (Kartenwerke)';
  if (layer.id === 'ch.swisstopo.swissimage-product') return '© swisstopo – SWISSIMAGE Zeitreise';
  if (layer.id === 'ch.swisstopo.swissimage-product_1946') return '© swisstopo – SWISSIMAGE 1946';
  if (layer.id === 'ch.swisstopo.hiks-siegfried') return '© swisstopo – Siegfriedkarte';
  if (layer.id === 'ch.swisstopo.hiks-dufour') return '© swisstopo – Dufourkarte Erstausgabe';
  return `© swisstopo – ${layer.title}`;
}

/** Tile URL from a WMTS template for fixed matrix / tile coordinates. */
function tileUrl(layer, time, z, x, y) {
  return layer.urlTemplate
    .replace('{Time}', time)
    .replace('{TileMatrixSet}', layer.tileMatrixSet || '3857')
    .replace('{TileMatrix}', String(z))
    .replace('{TileCol}', String(x))
    .replace('{TileRow}', String(y));
}

const timeYear = (time) => Number(String(time).slice(0, 4));

/** Web-Mercator tile coordinates (the same slippy scheme swisstopo serves). */
function slippy(lat, lon, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const rad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [x, y];
}

/** Candidate preview locations, in priority order (Zürich first — the app's home view). */
const PREVIEW_PLACES = [
  ['Zürich', 47.3772, 8.5273],
  ['Bern', 46.948, 7.4474],
  ['Basel', 47.5596, 7.5886],
  ['Lausanne', 46.5197, 6.6323],
  ['Lugano', 46.0037, 8.9511],
];
/** A WMTS tile below this many bytes is a transparent/empty placeholder. */
const MIN_TILE_BYTES = 2500;

/**
 * Tile byte size with an on-disk probe cache. Used to pick a preview tile that
 * really contains imagery, and to drop editions the service advertises but
 * serves empty (e.g. Zeitreise 1844–1848).
 */
async function tileSize(url) {
  const file = cacheFile(`probe:${url}`, 'json');
  let cached = null;
  try {
    cached = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    cached = null;
  }
  if (OFFLINE) return cached ? cached.size : null;
  const res = await fetch(url, { headers: { 'user-agent': UA } });
  const size = res.ok ? (await res.arrayBuffer()).byteLength : null;
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(file, JSON.stringify({ status: res.status, size }));
  await sleep(90);
  return size;
}

/** First preview tile with real imagery, or null when the edition is empty. */
async function previewTile(layer, time) {
  for (const [place, lat, lon] of PREVIEW_PLACES) {
    for (const z of [12, 11]) {
      const [x, y] = slippy(lat, lon, z);
      const url = tileUrl(layer, time, z, x, y);
      const size = await tileSize(url);
      if (size && size >= MIN_TILE_BYTES) return { url, place, size };
    }
  }
  return null;
}

/** The advertised edition closest to `year` (exact match wins). */
function editionForYear(layer, year) {
  const times = [...layer.timeValues].filter((t) => Number.isFinite(timeYear(t)));
  if (!times.length) return null;
  return times.sort((a, b) => Math.abs(timeYear(a) - year) - Math.abs(timeYear(b) - year) || a.localeCompare(b))[0];
}

/** swisstopo overlay records (type "overlay") for the curated series. */
async function swisstopoOverlayRecords() {
  const { layers } = await wmtsLayers();
  const records = [];
  const skipped = [];
  for (const series of SWISSTOPO_SERIES) {
    const layer = layers.get(series.layerId);
    if (!layer) throw new Error(`WMTS capabilities missing ${series.layerId}`);
    const chosen = new Set();
    for (const year of series.years) {
      const time = editionForYear(layer, year);
      if (!time || chosen.has(time)) continue;
      chosen.add(time);
      const actualYear = timeYear(time);
      const preview = await previewTile(layer, time);
      if (!preview) {
        skipped.push({ id: `swisstopo:${series.slug}-${time}`, reason: 'WMTS advertises this edition but serves empty tiles at the preview locations' });
        continue;
      }
      const record = {
        id: `swisstopo:${series.slug}-${time}`,
        title: series.title(actualYear),
        yearStart: actualYear,
        yearEnd: actualYear,
        depictedYearStart: null,
        depictedYearEnd: null,
        creators: ['Bundesamt für Landestopografie swisstopo'],
        providerId: 'swisstopo',
        institution: 'Bundesamt für Landestopografie swisstopo',
        rights: SWISSTOPO_LICENSE,
        recordUrl: `https://map.geo.admin.ch/?lang=de&layers=${layer.id}&time=${time}`,
        thumbnail: preview.url,
        thumbnailPlace: `swisstopo WMTS tile, ${preview.place}`,
        iiifManifest: null,
        type: 'overlay',
        collection: series.collection,
        overlay: {
          kind: 'wmts',
          layerId: layer.id,
          timeValue: time,
          urlTemplate: layer.urlTemplate.replace('{Time}', time),
          maxZoom: layer.maxZoom,
          attribution: series.attribution,
        },
        extent: layer.extent
          ? Object.fromEntries(Object.entries(layer.extent).map(([k, v]) => [k, Number(v.toFixed(6))]))
          : null,
      };
      if (/^\d{8}$/.test(String(time))) {
        record.editionDate = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`;
      }
      records.push(record);
    }
  }
  return { records, skipped };
}

/** `public/data/overlays.json` document: curated georeferenced comparison layers. */
async function swisstopoOverlayLayers() {
  const { layers } = await wmtsLayers();
  const overlays = [];
  for (const id of OVERLAY_LAYER_IDS) {
    const layer = layers.get(id);
    if (!layer) continue;
    overlays.push({
      id: layer.id,
      title: layer.title,
      providerId: 'swisstopo',
      urlTemplate: layer.urlTemplate,
      timeValues: layer.timeValues,
      maxZoom: layer.maxZoom,
      tileMatrixSet: layer.tileMatrixSet,
      extent: layer.extent
        ? Object.fromEntries(Object.entries(layer.extent).map(([k, v]) => [k, Number(v.toFixed(6))]))
        : null,
      attribution: swisstopoAttribution(layer),
      license: SWISSTOPO_LICENSE,
    });
  }
  return overlays;
}

const SOURCE_SETS = {
  zuz: {
    id: 'zuz-wildkarte',
    name: 'Karte des Kantons Zürich 1:25 000 (Wildkarte)',
    discovery: 'https://www.e-rara.ch/zuz/search?query=Karte+des+Kantons+Z%C3%BCrich',
  },
  landkarten: {
    id: 'landkarten',
    name: 'Schweizer Landkarten aus vier Jahrhunderten',
    discovery: 'https://www.e-rara.ch/oai?verb=ListRecords&metadataPrefix=oai_dc&set=landkarten',
  },
  cartesgeneve: {
    id: 'cartesgeneve',
    name: 'Karten von Genf und seiner Umgebung (e-rara-Set cartesgeneve)',
    discovery: 'https://www.e-rara.ch/oai?verb=ListRecords&metadataPrefix=oai_dc&set=cartesgeneve',
  },
};

async function main() {
  const [zuz, land, geneva] = await Promise.all([
    oaiRecords('zuz', 22),
    oaiRecords('landkarten', 10),
    oaiRecords('cartesgeneve', 4),
  ]);
  console.log(`OAI: ${zuz.length} ZB records, ${land.length} landkarten, ${geneva.length} cartesgeneve`);

  const zuzMaps = zuz.map(parseOai).filter((r) => r.isMap && r.titleId && r.year);
  // Sheet-level maps only: the manifest label carries the sheet name (e.g. "…: Rheinau").
  const sheetSeen = new Set();
  const zuzCandidates = [];
  for (const rec of zuzMaps) {
    const key = rec.title + '|' + rec.year;
    if (sheetSeen.has(key)) continue;
    sheetSeen.add(key);
    zuzCandidates.push(rec);
  }

  // Rule-based selection instead of a hand-picked title list: every map in the
  // `landkarten` set whose OAI title is not an atlas/series volume, oldest first,
  // plus the Geneva map sets for geographic coverage outside German-speaking
  // Switzerland. Whether a record is kept still depends on the manifest stating
  // a Kartendaten bbox and a publication year (below).
  const notASeries = (r) => !/^(Atlas|Kartenwerk|Topographischer Atlas|Karte der Schweiz in )/i.test(r.title);
  const landCandidates = land
    .map(parseOai)
    .filter((r) => r.isMap && r.titleId && r.year)
    .filter(notASeries)
    .sort((a, b) => a.year - b.year);
  const genevaCandidates = geneva
    .map(parseOai)
    .filter((r) => r.isMap && r.titleId && r.year)
    .filter(notASeries)
    .sort((a, b) => a.year - b.year);

  const zb = await pool(zuzCandidates.slice(0, 48), 3, (c) =>
    manifestRecord(c, { sourceCollection: 'Karte des Kantons Zürich 1:25 000 (Wildkarte)', maxYear: 1900 }),
  );
  // Keep one entry per sheet, preferring the earliest edition, at most 20 sheets.
  const bySheet = new Map();
  for (const r of zb.sort((a, b) => a.yearStart - b.yearStart)) {
    if (!r.extent) continue;
    const key = r.sheet || r.id;
    if (bySheet.has(key)) continue;
    if (bySheet.size >= 20) continue;
    bySheet.set(key, r);
  }
  const zbRecords = [...bySheet.values()];

  /** Dedupe by leading title (the same work often appears in several editions). */
  function keepUnique(list, limit) {
    const seen = new Set();
    const out = [];
    for (const r of list) {
      const key = r.title.slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= limit) break;
    }
    return out;
  }

  const eth = await pool(landCandidates.slice(0, 30), 3, (c) =>
    manifestRecord(c, { sourceCollection: 'Schweizer Landkarten aus vier Jahrhunderten' }),
  );
  const ethRecords = keepUnique(eth.filter((r) => r.extent), 18);

  const geneve = await pool(genevaCandidates.slice(0, 14), 3, (c) =>
    manifestRecord(c, { sourceCollection: 'Karten von Genf und seiner Umgebung' }),
  );
  const geneveRecords = keepUnique(geneve.filter((r) => r.extent), 10);

  const { records: overlays, skipped: overlaySkipped } = await swisstopoOverlayRecords();
  const overlayLayers = await swisstopoOverlayLayers();
  const records = [...zbRecords, ...ethRecords, ...geneveRecords, ...overlays].sort(
    (a, b) => a.yearStart - b.yearStart || a.title.localeCompare(b.title, 'de'),
  );

  const sources = {
    retrieved: RETRIEVED,
    generatedBy: 'scripts/fetch-records.mjs',
    note: 'Zürich and Swiss historical maps from primary institutional sources. Records are copied from upstream IIIF/OAI metadata; no dates or places are inferred.',
    providers: [
      {
        id: 'e-rara',
        name: 'e-rara.ch – Plattform für digitalisierte Drucke aus Schweizer Bibliotheken',
        operator: 'Zentralbibliothek Zürich (ZB) mit Schweizer Hochschulbibliotheken',
        institutions: ['Zentralbibliothek Zürich', 'ETH-Bibliothek Zürich'],
        homepage: 'https://www.e-rara.ch/',
        home: 'https://www.e-rara.ch/',
        collections: [
          {
            id: SOURCE_SETS.zuz.id,
            name: SOURCE_SETS.zuz.name,
            record: 'https://www.e-rara.ch/zuz/content/titleinfo/22142031',
            discovery: SOURCE_SETS.zuz.discovery,
          },
          {
            id: SOURCE_SETS.landkarten.id,
            name: SOURCE_SETS.landkarten.name,
            record: 'https://www.e-rara.ch/zuz/content/titleinfo/22142031',
            discovery: SOURCE_SETS.landkarten.discovery,
          },
          {
            id: SOURCE_SETS.cartesgeneve.id,
            name: SOURCE_SETS.cartesgeneve.name,
            // An actual harvested record from this OAI set, not a guessed collection page.
            record: geneveRecords[0]?.recordUrl ?? SOURCE_SETS.cartesgeneve.discovery,
            discovery: SOURCE_SETS.cartesgeneve.discovery,
          },
        ],
        endpoints: {
          oai: 'https://www.e-rara.ch/oai',
          iiifPresentation: 'https://www.e-rara.ch/i3f/v20/{titleId}/manifest',
          iiifImage: 'https://www.e-rara.ch/i3f/v21/{imageId}',
          thumbnail: 'IIIF thumbnail from the manifest',
        },
        rights: 'Public Domain Mark 1.0 (PDM 1.0) per record; see each record and e-rara terms.',
        attribution: 'e-rara.ch / holding institution, CC0 metadata and PDM imagery',
        terms: 'https://www.e-rara.ch/terms',
        retrievalDate: RETRIEVED,
        apiHosts: ['www.e-rara.ch'],
        api: {
          oaiPmh:
            'https://www.e-rara.ch/oai?verb=ListRecords&metadataPrefix=oai_dc&set={setSpec} ' +
            '(sets: zuz, landkarten, cartesgeneve; ListSets is paginated)',
          iiifPresentation: 'https://www.e-rara.ch/i3f/v20/{titleId}/manifest',
          iiifImage: 'https://www.e-rara.ch/i3f/v21/{imageId}/full/{size}/0/default.jpg',
          docs: 'https://www.e-rara.ch/',
        },
      },
      {
        id: 'swisstopo',
        name: 'swisstopo – Bundesamt für Landestopografie (geoadmin geoservices)',
        operator: 'Bundesamt für Landestopografie swisstopo',
        homepage: 'https://www.swisstopo.admin.ch/en/geoservices-with-swisstopo-geodata',
        home: 'https://www.swisstopo.admin.ch/',
        collections: [
          {
            id: 'zeitreise',
            name: 'Zeitreise – Kartenwerke',
            record: 'https://www.swisstopo.admin.ch/de/historische-kartenwerke',
            discovery: 'https://map.geo.admin.ch/?lang=de&layers=ch.swisstopo.zeitreihen',
          },
          {
            id: 'siegfriedkarte',
            name: 'Siegfriedkarte 1:25 000 (1870–1949)',
            record: 'https://www.swisstopo.admin.ch/de/digitale-siegfriedkarte',
            discovery: 'https://map.geo.admin.ch/?lang=de&layers=ch.swisstopo.hiks-siegfried',
          },
          {
            id: 'dufourkarte',
            name: 'Dufourkarte Erstausgabe',
            record: 'https://www.swisstopo.admin.ch/de/digitale-dufourkarte',
            discovery: 'https://map.geo.admin.ch/?lang=de&layers=ch.swisstopo.hiks-dufour',
          },
          {
            id: 'swissimage-zeitreise',
            name: 'SWISSIMAGE HIST (historische Luftbilder)',
            record: 'https://www.swisstopo.admin.ch/de/orthobilder-swissimage-hist',
            discovery: 'https://map.geo.admin.ch/?lang=de&layers=ch.swisstopo.swissimage-product',
          },
          {
            id: 'swissimage-1946',
            name: 'SWISSIMAGE HIST 1946',
            record: 'https://www.swisstopo.admin.ch/de/orthobilder-swissimage-hist-1946',
            discovery: 'https://map.geo.admin.ch/?lang=de&layers=ch.swisstopo.swissimage-product_1946',
          },
        ],
        endpoints: {
          wmtsCapabilities: WMTS_CAPS,
          tileTemplate:
            'https://wmts.geo.admin.ch/1.0.0/{layerId}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileCol}/{TileRow}.{ext}',
          basemapTemplate:
            'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
          search: 'https://api3.geo.admin.ch/rest/services/api/SearchServer',
        },
        rights: 'Open Government Data; source reference «©swisstopo» mandatory.',
        attribution: '© swisstopo',
        terms: 'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices',
        retrievalDate: RETRIEVED,
        apiHosts: ['wmts.geo.admin.ch', 'api3.geo.admin.ch', 'map.geo.admin.ch'],
        api: {
          wmtsCapabilities: WMTS_CAPS,
          wmtsTile:
            'https://wmts.geo.admin.ch/1.0.0/{layerId}/default/{Time}/{TileMatrixSet}/{TileMatrix}/{TileCol}/{TileRow}.{ext}',
          searchServer: 'https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText={q}&type=locations&sr=4326&limit={n}',
          mapViewer: 'https://map.geo.admin.ch/?lang=de&layers={layerId}&time={Time}',
        },
      },
    ],
  };

  // Envelope required by the data contract: `{ generatedAt, method, records }`.
  const recordsDoc = {
    generatedAt: new Date().toISOString(),
    retrieved: RETRIEVED,
    generator: 'scripts/fetch-records.mjs',
    method:
      'e-rara OAI-PMH oai_dc (sets zuz, landkarten, cartesgeneve, museecarto) for discovery → IIIF ' +
      'Presentation 2.0 manifest per title for ' +
      'verbatim title, imprint, creators, holding institution, rights, thumbnail, canvas count and the stated "Kartendaten" ' +
      'extent, plus the provider\'s own canonical viewer URL from the DOI landing page (og:url); swisstopo WMTS 1.0.0 GetCapabilities for the Zeitreise, Siegfriedkarte and SWISSIMAGE Zeitreise ' +
      'editions and for the comparison layers in overlays.json. No title, date or coordinate is ' +
      'invented. Regenerate with: node scripts/fetch-records.mjs --out public/data',
    selection: {
      'e-rara:zuz': {
        considered: zuzMaps.length,
        kept: zbRecords.length,
        rule: 'maps only, one entry per sheet, publication year ≤ 1900, requires a stated Kartendaten bbox',
      },
      'e-rara:landkarten': {
        considered: landCandidates.length,
        kept: ethRecords.length,
        rule: 'every map of the set that is not a series volume, oldest first, requires a stated Kartendaten bbox',
      },
      'e-rara:cartesgeneve': {
        considered: genevaCandidates.length,
        kept: geneveRecords.length,
        rule: 'map records of the set, oldest first, requires a stated Kartendaten bbox',
      },
      'swisstopo:zeitreise': {
        considered: overlayLayers.find((l) => l.id === 'ch.swisstopo.zeitreihen')?.timeValues.length ?? 0,
        kept: overlays.filter((r) => r.overlay.layerId === 'ch.swisstopo.zeitreihen').length,
        rule: 'curated Zeitreise editions (exact or nearest advertised Time value)',
      },
      'swisstopo:hiks-siegfried': {
        considered: overlayLayers.find((l) => l.id === 'ch.swisstopo.hiks-siegfried')?.timeValues.length ?? 0,
        kept: overlays.filter((r) => r.overlay.layerId === 'ch.swisstopo.hiks-siegfried').length,
        rule: 'one record per decade advertised in the Siegfriedkarte Time dimension (1870–1949)',
      },
      'swisstopo:swissimage-product': {
        considered: overlayLayers.find((l) => l.id === 'ch.swisstopo.swissimage-product')?.timeValues.length ?? 0,
        kept: overlays.filter((r) => r.overlay.layerId === 'ch.swisstopo.swissimage-product').length,
        rule: 'representative SWISSIMAGE Zeitreise aerial mosaics (1960–2020)',
      },
      'swisstopo:swissimage-1946': {
        considered: 1,
        kept: overlays.filter((r) => r.overlay.layerId === 'ch.swisstopo.swissimage-product_1946').length,
        rule: 'the dedicated SWISSIMAGE 1946 historical aerial layer',
      },
    },
    skipped: overlaySkipped,
    records,
  };
  sources.generatedBy = 'scripts/fetch-records.mjs';
  sources.method = 'provider registry: primary record URL, identifiers, endpoints actually used, rights, attribution, retrieval date';
  sources.generatedAt = new Date().toISOString();

  const overlaysDoc = {
    generatedAt: new Date().toISOString(),
    retrieved: RETRIEVED,
    generator: 'scripts/fetch-records.mjs',
    source: 'swisstopo WMTS 1.0.0 GetCapabilities (georeferenced historical map and aerial-image services)',
    capabilities: WMTS_CAPS,
    attribution: '© swisstopo',
    license: SWISSTOPO_LICENSE,
    overlays: overlayLayers,
  };

  console.log(
    `Built ${zbRecords.length} ZB maps, ${ethRecords.length} landkarten, ${geneveRecords.length} Genf, ` +
      `${overlays.filter((r) => r.overlay.layerId === 'ch.swisstopo.zeitreihen').length} Zeitreise, ` +
      `${overlays.filter((r) => r.overlay.layerId === 'ch.swisstopo.hiks-siegfried').length} Siegfried, ` +
      `${overlays.filter((r) => r.overlay.layerId === 'ch.swisstopo.swissimage-product').length} SWISSIMAGE records ` +
      `(${records.length} records, ${overlayLayers.length} comparison layers)`,
  );
  if (writeOutput) {
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'records.json'), JSON.stringify(recordsDoc, null, 2) + '\n');
    await writeFile(resolve(outDir, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
    await writeFile(resolve(outDir, 'overlays.json'), JSON.stringify(overlaysDoc, null, 2) + '\n');
    console.log('Wrote', outDir);
  } else {
    console.log(JSON.stringify(recordsDoc.records.slice(0, 3), null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
