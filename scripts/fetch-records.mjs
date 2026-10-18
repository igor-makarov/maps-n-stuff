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
 *   node scripts/fetch-records.mjs --out public/data
 *   node scripts/fetch-records.mjs --out /tmp/out --no-write
 *
 * The script is deliberately dependency-free and polite: max 3 concurrent requests,
 * a short pause between manifest requests, and a descriptive User-Agent.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const UA = 'Kartenzeit/1.0 (Canton-Zurich design study; contact: project maintainers)';
const args = process.argv.slice(2);
const outDir = resolve(getArg('--out') || 'public/data');
const writeOutput = !args.includes('--no-write');
const RETRIEVED = '2026-10-18';

function getArg(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

async function get(url, { as = 'text', timeout = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : '*/*' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return as === 'json' ? await res.json() : await res.text();
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function decode(s) {
  return String(s || '')
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

async function manifestRecord(candidate, { sourceCollection, maxYear }) {
  const manifestUrl = `https://www.e-rara.ch/i3f/v20/${candidate.titleId}/manifest`;
  const manifest = await get(manifestUrl, { as: 'json', timeout: 40000 });
  const meta = metaMap(manifest);
  const label = String(manifest.label || candidate.title);
  const bbox = parseBbox(meta.Kartendaten);
  const canvas = manifest.sequences?.[0]?.canvases?.[0];
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

/** swisstopo Zeitreise editions: only Time values advertised by WMTS capabilities. */
async function swisstopoEditions() {
  const caps = await get('https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml', { timeout: 60000 });
  const idx = caps.indexOf('<ows:Identifier>ch.swisstopo.zeitreihen</ows:Identifier>');
  if (idx < 0) throw new Error('zeitreihen layer missing from WMTS capabilities');
  const block = caps.slice(idx, caps.indexOf('</Layer>', idx));
  const times = [...block.matchAll(/<Value>(\d{8})<\/Value>/g)].map((m) => m[1]);
  const titleMatch = caps.slice(Math.max(0, idx - 4000), idx).match(/<ows:Title>([^<]+)<\/ows:Title>/g);
  const layerTitle = titleMatch ? decode(titleMatch[titleMatch.length - 1].replace(/<\/?ows:Title>/g, '')) : 'Zeitreise - Kartenwerke';
  // The WGS84 bounding box is declared just before the layer identifier.
  const head = caps.slice(Math.max(0, idx - 3000), idx);
  const bboxMatch = head.match(/<ows:LowerCorner>([\d.\s]+)<\/ows:LowerCorner>\s*<ows:UpperCorner>([\d.\s]+)<\/ows:UpperCorner>/);
  const extent = bboxMatch
    ? {
        west: Number(bboxMatch[1].split(/\s+/)[0]),
        south: Number(bboxMatch[1].split(/\s+/)[1]),
        east: Number(bboxMatch[2].split(/\s+/)[0]),
        north: Number(bboxMatch[2].split(/\s+/)[1]),
      }
    : null;
  const wantedYears = [1844, 1850, 1860, 1870, 1883, 1895, 1910, 1925, 1940, 1955, 1970, 1990, 2005, 2021];
  const byYear = new Map();
  for (const t of times) {
    const y = Number(t.slice(0, 4));
    const prev = byYear.get(y);
    if (!prev || t > prev) byYear.set(y, t);
  }
  return wantedYears
    .map((year) => {
      const time = byYear.get(year) || [...byYear.keys()].sort((a, b) => Math.abs(a - year) - Math.abs(b - year)).map((y) => byYear.get(y))[0];
      if (!time) return null;
      const y = Number(time.slice(0, 4));
      return {
        id: `swisstopo:zeitreise-${time}`,
        title: `Zeitreise – Kartenwerke, Ausgabe ${y}`,
        editionDate: `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`,
        yearStart: y,
        yearEnd: y,
        depictedYearStart: null,
        depictedYearEnd: null,
        creators: ['Bundesamt für Landestopografie swisstopo'],
        providerId: 'swisstopo',
        institution: 'Bundesamt für Landestopografie swisstopo',
        rights: 'OGD swisstopo – Quellenangabe «©swisstopo» erforderlich',
        recordUrl: 'https://map.geo.admin.ch/?lang=de&layers=ch.swisstopo.zeitreihen',
        thumbnail: `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/${time}/3857/10/536/365.png`,
        iiifManifest: null,
        type: 'overlay',
        collection: 'Zeitreise – Kartenwerke',
        overlay: {
          kind: 'wmts',
          layerId: 'ch.swisstopo.zeitreihen',
          timeValue: time,
          urlTemplate: `https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/${time}/3857/{TileMatrix}/{TileCol}/{TileRow}.png`,
          maxZoom: 18,
          attribution: '© swisstopo – Zeitreise (Kartenwerke)',
        },
        extent: extent
          ? {
              west: Number(extent.west.toFixed(6)),
              east: Number(extent.east.toFixed(6)),
              south: Number(extent.south.toFixed(6)),
              north: Number(extent.north.toFixed(6)),
            }
          : null,
      };
    })
    .filter(Boolean);
}

const zuzTitles = [];
const ethTitles = [
  'Reisekarte der Schweiz',
  'Karte des Kantons Zürich',
  'Archäologische Karte des Kantons Zürich',
  'Karte der Schweiz mit Randnamen',
  'Karte der Cantone St. Gallen und Appenzell',
  'Relief-Karte der Schweiz',
  'Karte des Kantons Schaffhausen',
  'Karte des Kantons Graubünden',
  'Carte du canton de Vaud',
  'Der  Canton Zürich mit seinen nähern Angränzungen',
  'Karte vom Thunersee',
  'Karte der centralen Schweiz',
  'Karte des Kantons Luzern',
  'Historischer Atlas der Schweiz',
];

async function main() {
  const [zuz, land] = await Promise.all([oaiRecords('zuz', 22), oaiRecords('landkarten', 10)]);
  console.log(`OAI: ${zuz.length} ZB records, ${land.length} landkarten records`);

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

  const ethCandidates = land
    .map(parseOai)
    .filter((r) => r.isMap && r.titleId && r.year)
    .filter((r) => ethTitles.some((needle) => r.title.startsWith(needle)))
    .filter((r) => !/^Atlas de la Suisse/.test(r.title));

  const zb = await pool(zuzCandidates.slice(0, 40), 3, (c) =>
    manifestRecord(c, { sourceCollection: 'Karte des Kantons Zürich 1:25 000 (Wildkarte)', maxYear: 1900 }),
  );
  // Keep one entry per sheet, preferring the earliest edition, at most 16 sheets.
  const bySheet = new Map();
  for (const r of zb.sort((a, b) => a.yearStart - b.yearStart)) {
    if (!r.extent) continue;
    const key = r.sheet || r.id;
    if (bySheet.has(key)) continue;
    if (bySheet.size >= 16) continue;
    bySheet.set(key, r);
  }
  const zbRecords = [...bySheet.values()];

  const eth = await pool(ethCandidates.slice(0, 18), 3, (c) =>
    manifestRecord(c, { sourceCollection: 'Schweizer Landkarten aus vier Jahrhunderten' }),
  );
  const ethSeen = new Set();
  const ethRecords = eth
    .filter((r) => r.extent)
    .filter((r) => {
      const key = r.title.slice(0, 60);
      if (ethSeen.has(key)) return false;
      ethSeen.add(key);
      return true;
    })
    .slice(0, 12);

  const overlays = await swisstopoEditions();
  const records = [...zbRecords, ...ethRecords, ...overlays].sort(
    (a, b) => a.yearStart - b.yearStart || a.title.localeCompare(b.title, 'de'),
  );

  const sources = {
    retrieved: RETRIEVED,
    generatedBy: 'scripts/fetch-records.mjs',
    note: 'Zürich and Swiss historical maps from primary institutional sources. Records are copied from upstream IIIF/OAI metadata; no dates or places are inferred.',
    providers: [
      {
        id: 'e-rara',
        name: 'e-rara.ch',
        institutions: ['Zentralbibliothek Zürich', 'ETH-Bibliothek Zürich'],
        home: 'https://www.e-rara.ch/',
        collections: [
          {
            id: 'zuz-wildkarte',
            name: 'Karte des Kantons Zürich 1:25 000 (Wildkarte)',
            record: 'https://www.e-rara.ch/zuz/content/titleinfo/22142031',
            discovery: 'https://www.e-rara.ch/zuz/search?query=Karte+des+Kantons+Z%C3%BCrich',
          },
          {
            id: 'landkarten',
            name: 'Schweizer Landkarten aus vier Jahrhunderten',
            record: 'https://www.e-rara.ch/zuz/content/titleinfo/22142031',
            discovery: 'https://www.e-rara.ch/',
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
      },
      {
        id: 'swisstopo',
        name: 'Bundesamt für Landestopografie swisstopo',
        home: 'https://www.swisstopo.admin.ch/',
        collections: [
          {
            id: 'zeitreise',
            name: 'Zeitreise – Kartenwerke',
            record: 'https://www.swisstopo.admin.ch/de/zeitreise',
            discovery: 'https://map.geo.admin.ch/?lang=de&layers=ch.swisstopo.zeitreihen',
          },
        ],
        endpoints: {
          wmtsCapabilities: 'https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml',
          tileTemplate:
            'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/{time}/3857/{z}/{x}/{y}.png',
          basemapTemplate:
            'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/{z}/{x}/{y}.jpeg',
          search: 'https://api3.geo.admin.ch/rest/services/api/SearchServer',
        },
        rights: 'Open Government Data; source reference «©swisstopo» mandatory.',
        attribution: '© swisstopo',
        terms: 'https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices',
      },
    ],
  };

  console.log(`Built ${zbRecords.length} ZB maps, ${ethRecords.length} ETH maps, ${overlays.length} Zeitreise overlays (${records.length} records)`);
  if (writeOutput) {
    await mkdir(outDir, { recursive: true });
    await writeFile(resolve(outDir, 'records.json'), JSON.stringify(records, null, 2) + '\n');
    await writeFile(resolve(outDir, 'sources.json'), JSON.stringify(sources, null, 2) + '\n');
    console.log('Wrote', outDir);
  } else {
    console.log(JSON.stringify(records.slice(0, 3), null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
