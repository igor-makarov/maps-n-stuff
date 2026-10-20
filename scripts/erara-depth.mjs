#!/usr/bin/env node
/**
 * e-rara depth harvest (member 2, sourcing swarm 2026-10-20).
 *
 * Completes the explicitly public-domain map subset of e-rara's documented
 * OAI-PMH map set `landkarten`. Discovery is the institution's OAI feed; the
 * record itself is built from the item's IIIF Presentation 2 manifest (verbatim
 * title, imprint, holding library, shelfmark, stated Kartendaten bbox, thumbnail).
 *
 * Existing records are never replaced: only ids absent from the catalogue are
 * added, so a refresh cannot lose an earlier harvest or a teammate's work.
 *
 * Usage:
 *   node scripts/harvest-erara-depth.mjs --max-pages 40 --max-new 200
 *   node scripts/harvest-erara-depth.mjs --offline --dry-run
 *
 * The script is dependency-free, identifies itself, caches every upstream
 * response under .cache/erara-depth/ (git-ignored), retries 429/5xx with a short
 * backoff, and fetches manifests at most three at a time with a polite pause.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseBbox } from './fetch-records.mjs';
import { openImageRights } from '../src/worker/catalogue.js';

const UA = 'MeridianAtlas/1.0 (+https://github.com/igor-makarov/maps-n-stuff; e-rara depth harvest)';
const OAI = 'https://www.e-rara.ch/oai';
const CACHE = new URL('../.cache/erara-depth/', import.meta.url);
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const OFFLINE = args.includes('--offline');
const DRY = args.includes('--dry-run');
const OUT = resolve(arg('--out', 'public/data'));
const SET = arg('--set', 'landkarten');
const MAX_PAGES = Math.max(1, Number(arg('--max-pages', 40)) || 40);
const MAX_NEW = Math.max(0, Number(arg('--max-new', 200)) || 0);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (value) =>
  String(value ?? '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .trim();

function one(xml, tag) {
  const m = String(xml).match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : null;
}
function many(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => decode(m[1]));
}
function fields(xml) {
  const out = {};
  for (const m of String(xml).matchAll(/<dc:([a-zA-Z]+)[^>]*>([\s\S]*?)<\/dc:\1>/g)) {
    (out[m[1]] ??= []).push(decode(m[2]));
  }
  return out;
}
export function parseYear(value) {
  const m = String(value ?? '').match(/(1[4-9]\d{2}|20\d{2})/);
  return m ? Number(m[1]) : null;
}

/** One OAI-PMH <record> → the candidate shape the manifest reader expects. */
export function parseOaiRecord(record) {
  const f = fields(record);
  const identifier = one(record, 'identifier') || '';
  const titleId = identifier.split(':').pop();
  const types = f.type ?? [];
  const identifiers = f.identifier ?? [];
  return {
    titleId,
    title: (f.title ?? [])[0] ?? '',
    titles: f.title ?? [],
    creators: (f.creator ?? []).filter(Boolean),
    dates: f.date ?? [],
    year: parseYear((f.date ?? [])[0]),
    rights: (f.rights ?? [])[0] ?? '',
    doi: identifiers.find((i) => /^https:\/\/www\.e-rara\.ch\/doi\//.test(i)) ?? null,
    language: f.language ?? [],
    publisher: (f.publisher ?? [])[0] ?? '',
    description: f.description ?? [],
    setSpecs: many(record, 'setSpec'),
    isMap: types.includes('Map'),
  };
}

/** The image-rights gate. Only an explicit PDM/CC0/PD statement passes. */
export function eligibleRights(rights) {
  const value = String(rights ?? '').trim();
  if (!value) return false;
  if (/^PDM\s*1\.0$/i.test(value)) return true;
  return Boolean(openImageRights(value));
}

const CORPUS_INSTITUTION = {
  zuz: 'Zentralbibliothek Zürich',
  zut: 'ETH-Bibliothek Zürich',
  bes_1: 'Universitätsbibliothek Bern',
  gep_r: 'Bibliothèque de Genève',
};
const LANGUAGE_NAMES = {
  ger: 'German', deu: 'German', fre: 'French', fra: 'French', ita: 'Italian',
  lat: 'Latin', eng: 'English', spa: 'Spanish', por: 'Portuguese', dut: 'Dutch',
  nld: 'Dutch', swe: 'Swedish', dan: 'Danish', pol: 'Polish', cze: 'Czech',
  rus: 'Russian', hun: 'Hungarian', gre: 'Greek', heb: 'Hebrew', ara: 'Arabic',
};

function metaMap(manifest) {
  const out = {};
  for (const entry of manifest.metadata ?? []) {
    const key = entry.label || '';
    const value = typeof entry.value === 'string' ? entry.value : String(entry.value ?? '');
    if (!(key in out)) out[key] = value;
  }
  return out;
}

/**
 * Manifest + OAI candidate → catalogue record. Returns { record, reason }.
 * Nothing is inferred: missing title/rights/institution/thumbnail is withheld.
 */
export function recordFromManifest(manifest, candidate, { collection = 'e-rara — historical maps' } = {}) {
  const meta = metaMap(manifest);
  const rights = String(candidate.rights || manifest.license || manifest.rights || '').trim();
  if (!eligibleRights(rights)) return { record: null, reason: 'image rights are not an explicit PDM/CC0/public-domain statement' };
  const title = String(manifest.label || candidate.title || meta.Titel || '').trim();
  if (!title) return { record: null, reason: 'no title stated by the manifest' };
  const id = String(candidate.titleId || '');
  if (!/^\d+$/.test(id)) return { record: null, reason: 'no e-rara title id in the OAI record' };
  const thumb = manifest.thumbnail?.['@id'];
  if (!/^https:\/\/www\.e-rara\.ch\/i3f\//.test(String(thumb ?? ''))) return { record: null, reason: 'no e-rara IIIF thumbnail in the manifest' };
  const institutionField = String(meta['Besitzende Institution'] ?? '').trim();
  const institution = institutionField.replace(/\s*,.*$/, '').trim();
  const shelfmark = institutionField.includes(',') ? institutionField.slice(institutionField.indexOf(',') + 1).trim() : '';
  const corpus = (candidate.setSpecs ?? []).find((s) => CORPUS_INSTITUTION[s]) ?? null;
  const attributed = institution || (corpus ? CORPUS_INSTITUTION[corpus] : '');
  if (!attributed) return { record: null, reason: 'no holding library stated by the manifest or the OAI corpus' };
  const year = candidate.year ?? parseYear(meta.Impressum);
  const bbox = parseBbox(meta.Kartendaten);
  const canvases = manifest.sequences?.[0]?.canvases ?? manifest.items ?? [];
  const imageService = canvases[0]?.images?.[0]?.resource?.service?.['@id'] ?? null;
  const record = {
    id: `e-rara:${id}`,
    title,
    yearStart: year,
    yearEnd: year,
    depictedYearStart: null,
    depictedYearEnd: null,
    creators: candidate.creators?.length ? candidate.creators : [],
    providerId: 'e-rara',
    institution: attributed,
    rights,
    recordUrl: candidate.doi || `https://www.e-rara.ch/doi/10.3931/e-rara-${id}`,
    thumbnail: thumb,
    iiifManifest: `https://www.e-rara.ch/i3f/v20/${id}/manifest`,
    type: 'map',
    collection,
    metadataSource: `${OAI}?verb=GetRecord&metadataPrefix=oai_dc&identifier=${encodeURIComponent(`oai:www.e-rara.ch:${id}`)}`,
  };
  if (bbox) {
    const rounded = Object.fromEntries(Object.entries(bbox).map(([k, v]) => [k, Number(v.toFixed(5))]));
    record.extent = rounded;
    record.geo = {
      lat: Number(((rounded.south + rounded.north) / 2).toFixed(5)),
      lon: Number(((rounded.west + rounded.east) / 2).toFixed(5)),
    };
  }
  if (imageService) record.imageService = imageService;
  if (shelfmark) record.shelfmark = shelfmark;
  if (canvases.length) record.canvasCount = canvases.length;
  if (corpus) record.viewerUrl = `https://www.e-rara.ch/${corpus}/content/zoom/${id}`;
  if (meta.Impressum) record.imprint = meta.Impressum;
  const languages = (candidate.language ?? []).map((code) => LANGUAGE_NAMES[code] ?? code).filter(Boolean);
  if (languages.length) record.languages = [...new Set(languages)];
  return { record, reason: null };
}

/** Add only ids that are not already present; never replace an existing record. */
export function mergeRecords(recordsDoc, incoming) {
  const seen = new Set((recordsDoc.records ?? []).map((r) => r.id));
  const added = [];
  for (const record of incoming) {
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    recordsDoc.records.push(record);
    added.push(record);
  }
  return added;
}

function cacheFile(url, ext) {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 20);
  return new URL(`./${hash}.${ext}`, CACHE);
}

async function get(url, { as = 'text', timeout = 40000, attempts = 3 } = {}) {
  const ext = as === 'json' ? 'json' : 'xml';
  const file = cacheFile(url, ext);
  // Replay a cached response first: a bounded run that was interrupted resumes
  // instead of re-fetching everything. `--refresh` is deliberately absent, so a
  // fresh harvest needs a new cache directory or an explicit cache removal.
  try {
    const cached = await readFile(file, 'utf8');
    return as === 'json' ? JSON.parse(cached) : cached;
  } catch {
    if (OFFLINE) throw new Error(`offline cache miss: ${url}`);
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: as === 'json' ? 'application/json' : 'application/xml,text/xml,*/*' },
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status >= 500) && attempt < attempts) { await sleep(attempt * 1500); continue; }
        throw new Error(`${res.status} ${url}`);
      }
      const body = as === 'json' ? await res.json() : await res.text();
      await mkdir(CACHE, { recursive: true });
      await writeFile(file, as === 'json' ? JSON.stringify(body) : body);
      return body;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(attempt * 1200);
    }
  }
}

async function oaiPages(set, maxPages, onPage) {
  let token = null;
  for (let page = 0; page < maxPages; page += 1) {
    const url = token
      ? `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
      : `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=${encodeURIComponent(set)}`;
    const xml = await get(url);
    const records = many(xml, 'record');
    const tokenMatch = xml.match(/<resumptionToken[^>]*>([^<]+)<\/resumptionToken>/);
    token = tokenMatch ? tokenMatch[1] : null;
    await onPage(records, page);
    if (!token) break;
    await sleep(120);
  }
  return token;
}

async function main() {
  const recordsDoc = JSON.parse(await readFile(resolve(OUT, 'records.json'), 'utf8'));
  const sourcesDoc = JSON.parse(await readFile(resolve(OUT, 'sources.json'), 'utf8'));
  const existing = new Set((recordsDoc.records ?? []).map((r) => r.id));
  const stats = { pages: 0, oaiRecords: 0, maps: 0, eligible: 0, alreadyPresent: 0, manifestAttempts: 0, kept: 0, withheld: 0, errors: 0 };
  const skipped = [];
  const queue = [];

  await oaiPages(SET, MAX_PAGES, async (rawRecords, page) => {
    stats.pages = page + 1;
    for (const raw of rawRecords) {
      stats.oaiRecords += 1;
      const candidate = parseOaiRecord(raw);
      if (!candidate.isMap) continue;
      stats.maps += 1;
      if (!candidate.titleId || !candidate.title) continue;
      if (existing.has(`e-rara:${candidate.titleId}`)) { stats.alreadyPresent += 1; continue; }
      if (!eligibleRights(candidate.rights)) { stats.withheld += 1; skipped.push({ id: `e-rara:${candidate.titleId}`, title: candidate.title, reason: `image rights not explicit: "${candidate.rights || 'none'}"` }); continue; }
      stats.eligible += 1;
      if (queue.length < MAX_NEW) queue.push(candidate);
    }
    console.log(`OAI page ${page + 1}: ${rawRecords.length} records, queue ${queue.length}`);
  });

  const incoming = [];
  for (let i = 0; i < queue.length; i += 3) {
    const batch = queue.slice(i, i + 3);
    const results = await Promise.all(batch.map(async (candidate) => {
      stats.manifestAttempts += 1;
      try {
        const manifest = await get(`https://www.e-rara.ch/i3f/v20/${candidate.titleId}/manifest`, { as: 'json' });
        return recordFromManifest(manifest, candidate);
      } catch (err) {
        stats.errors += 1;
        return { record: null, reason: `manifest unavailable: ${String(err.message ?? err)}` };
      }
    }));
    for (const [j, result] of results.entries()) {
      if (result.record) incoming.push(result.record);
      else skipped.push({ id: `e-rara:${batch[j].titleId}`, title: batch[j].title, reason: result.reason });
    }
    await sleep(120);
  }

  const added = mergeRecords(recordsDoc, incoming);
  stats.kept = added.length;
  const now = new Date().toISOString();
  const rule = {
    set: SET,
    endpoint: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=${SET}`,
    manifest: 'https://www.e-rara.ch/i3f/v20/{titleId}/manifest',
    pagesRead: stats.pages,
    oaiRecords: stats.oaiRecords,
    mapRecords: stats.maps,
    eligibleNew: stats.eligible,
    alreadyPresent: stats.alreadyPresent,
    manifestAttempts: stats.manifestAttempts,
    added: stats.kept,
    withheldUnknownOrRestrictedRights: stats.withheld,
    manifestErrors: stats.errors,
    rule: 'Map records in the documented OAI set whose dc:rights is an explicit PDM 1.0 / CC0 / compatible public-domain statement; record built from the item IIIF manifest; existing ids preserved; no bbox, date or georeferencing requirement.',
    retrieved: now.slice(0, 10),
  };
  recordsDoc.selection = { ...(recordsDoc.selection ?? {}), 'e-rara:landkarten-depth': rule };
  recordsDoc.generatedAt = now;
  if (skipped.length) recordsDoc.skipped = [...(recordsDoc.skipped ?? []), ...skipped.slice(0, 200)];
  const source = sourcesDoc.providers.find((p) => p.id === 'e-rara');
  if (source) {
    source.depthHarvest = {
      ...rule,
      licence: 'PDM 1.0 per item (https://creativecommons.org/publicdomain/mark/1.0/); e-rara terms https://www.e-rara.ch/terms',
      attribution: 'e-rara.ch and the stated holding library',
      verificationExample: added[0]
        ? { id: added[0].id, recordUrl: added[0].recordUrl, iiifManifest: added[0].iiifManifest, thumbnail: added[0].thumbnail }
        : null,
    };
  }
  sourcesDoc.generatedAt = now;

  console.log(JSON.stringify({ ...stats, added: added.map((r) => r.id).slice(0, 12) }, null, 1));
  if (!DRY) {
    await writeFile(resolve(OUT, 'records.json'), `${JSON.stringify(recordsDoc, null, 2)}\n`);
    await writeFile(resolve(OUT, 'sources.json'), `${JSON.stringify(sourcesDoc, null, 2)}\n`);
    console.log('Wrote', OUT);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
