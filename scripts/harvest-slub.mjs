#!/usr/bin/env node
/**
 * SLUB Dresden OAI-PMH map harvest — sourcing swarm 2026-10-20.
 *
 * SLUB Dresden publishes the documented OAI-PMH set `maps` ("Karten und
 * Ansichten") in `metadataPrefix=mets`. Every record carries the DFG-viewer
 * rights block (`dv:owner`, `dv:license`), a MODS use-and-reproduction
 * statement and a `slubarchiv:copyrightStatus`. This harvest admits only works
 * whose own metadata state the Public Domain Mark 1.0 (or an equivalent
 * `dv:license=pdm` with `copyrightStatus=publicdomain`); anything else is
 * withheld and counted. Nothing is relabelled and no licence is invented.
 *
 * The site policy behind those per-object statements is SLUB's
 * "Nutzungsbestimmungen für die Digitalen Sammlungen"
 * (https://nutzungshinweis.slub-dresden.de/), which states that digitised
 * objects whose copyright has expired are made available under the Public
 * Domain Mark 1.0 and asks for the source citation (SLUB Dresden, PURL,
 * licence). It is recorded on every entry; the METS metadata is reused with
 * that attribution and a link to the original record. No separate metadata
 * licence is asserted because SLUB does not publish one.
 *
 * The far larger Kartenforum / Deutsche Fotothek search index is NOT imported:
 * its public search index has no per-record rights field, so it remains a
 * research-only lane. Do not start a second SLUB OAI harvester.
 *
 * Usage:
 *   node scripts/harvest-slub.mjs                 # cached harvest, writes public/data
 *   node scripts/harvest-slub.mjs --refresh       # refetch all OAI pages
 *   node scripts/harvest-slub.mjs --no-write      # report only
 *   node scripts/harvest-slub.mjs --verify 20     # verification sample size
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCore, shardPath, shardUrl, writeShard } from './catalogue.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(value('out', resolve(ROOT, 'public/data')));
const CACHE = resolve(ROOT, '.cache/slub');
const REFRESH = has('refresh');
const WRITE = !has('no-write') && !has('dry-run');
const VERIFY_SAMPLE = Math.max(0, Number(value('verify', '24')) || 0);
const UA = 'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; SLUB map harvest)';
const OAI = 'https://digital.slub-dresden.de/oai/';
const SET = 'maps';
const RETRIEVED = '2026-10-20';
const SHARD = shardUrl('slub');
const POLICY = 'https://nutzungshinweis.slub-dresden.de/';
const OWNER = 'Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const decode = (text) =>
  String(text ?? '')
    .replace(/<!\[CDATA\[|\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .trim();

const plain = (text) => decode(String(text ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Decode an XML attribute value (entities only; tags never appear in attributes). */
const attr = (text) => decode(String(text ?? '').replace(/&amp;/g, '&'));

export function recordsOf(xml) {
  return [...String(xml).matchAll(/<record>([\s\S]*?)<\/record>/g)].map((m) => m[1]);
}

/** `oai:de:slub-dresden:db:id-285992066` → `285992066`. */
export function idOf(record) {
  const m = String(record).match(/<identifier>\s*oai:de:slub-dresden:db:id-([^<\s]+)\s*<\/identifier>/);
  return m ? decode(m[1]) : null;
}

function blocksOf(xml, tag) {
  return [...String(xml).matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => ({
    attrs: m[0].slice(0, m[0].indexOf('>') + 1),
    body: m[1],
  }));
}

const firstValue = (xml, tag) => {
  const first = blocksOf(xml, tag)[0];
  return first ? plain(first.body) : null;
};

/** MODS title and subtitle of the work itself (first titleInfo, not the series). */
export function titleOf(record) {
  const info = blocksOf(record, 'mods:titleInfo')[0];
  if (!info) return { title: '', subtitle: '' };
  return {
    title: firstValue(info.body, 'mods:title') ?? '',
    subtitle: firstValue(info.body, 'mods:subTitle') ?? '',
  };
}

const ROLE_SKIP = new Set(['own', 'len', 'dnr', 'bkd', 'fnd', 'pbl', 'prt']);
const HOLDER_NAMES = /^(?:sächsische landesbibliothek|slub dresden)/i;

/** Personal/corporate creators from MODS, excluding the holding library roles. */
export function creatorsOf(record) {
  const out = [];
  for (const block of blocksOf(record, 'mods:name')) {
    const roles = [...block.body.matchAll(/<mods:roleTerm[^>]*>([^<]+)<\/mods:roleTerm>/g)].map((m) => plain(m[1]).toLowerCase());
    if (roles.length && roles.every((role) => ROLE_SKIP.has(role))) continue;
    const display = firstValue(block.body, 'mods:displayForm');
    if (display && HOLDER_NAMES.test(display)) continue;
    const parts = blocksOf(block.body, 'mods:namePart');
    const family = parts.filter((part) => /type="family"/.test(part.attrs)).map((part) => plain(part.body)).join(' ');
    const given = parts.filter((part) => /type="given"/.test(part.attrs)).map((part) => plain(part.body)).join(' ');
    const untyped = parts.filter((part) => !/type="/.test(part.attrs)).map((part) => plain(part.body)).join(' ');
    const name = display || [family, given].filter(Boolean).join(', ') || untyped;
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** All 4-digit years in a publication statement. */
export function publicationYears(text) {
  const years = [...String(text ?? '').matchAll(/\b(1[4-9]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return null;
  return { start: Math.min(...years), end: Math.max(...years) };
}

/** MODS dateIssued, honouring point="start"/point="end". */
export function issuedYears(record) {
  const values = [];
  for (const block of blocksOf(record, 'mods:dateIssued')) {
    const point = (block.attrs.match(/point="([^"]+)"/) || [])[1];
    const years = [...plain(block.body).matchAll(/\b(1[4-9]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
    if (!years.length) continue;
    if (point === 'start') values.push({ point: 'start', year: years[0] });
    else if (point === 'end') values.push({ point: 'end', year: years[years.length - 1] });
    else values.push({ point: null, year: years[0] });
  }
  if (!values.length) return null;
  const start = values.find((v) => v.point === 'start')?.year ?? Math.min(...values.map((v) => v.year));
  const end = values.find((v) => v.point === 'end')?.year ?? Math.max(...values.map((v) => v.year));
  return start <= end ? { start, end } : { start: end, end: start };
}

const PDM = /creativecommons\.org\/publicdomain\/mark\/1\.0/i;
const CC0 = /creativecommons\.org\/publicdomain\/zero\/1\.0/i;
const PUBLIC_DOMAIN_STATUS = /^(?:public\s*domain|publicdomain|pdm)$/i;
// A restriction only counts outside the legal text of an open licence.
const RESTRICTIVE = /all rights reserved|rechte vorbehalten|in copyright|urheberrechtsschutz|non[ -]?commercial|nicht kommerziell|permission required|rights reserved|contact the (?:host|publisher)/i;

/**
 * Rights evidence from the item's own METS:
 *   MODS accessCondition type="use and reproduction" (text + xlink:href)
 *   slubarchiv:copyrightStatus
 *   dv:license
 * Returns { basis, licence, statements, reason }. Only an affirmative Public
 * Domain Mark is admitted; restricted or conflicting records are withheld.
 */
export function rightsGate({ useStatements = [], copyrightStatus = [], viewerLicences = [] } = {}) {
  const statements = [
    ...useStatements.map((s) => String(s.href ? `${s.text} <${s.href}>` : s.text).trim()),
    ...copyrightStatus.map((s) => `copyrightStatus: ${s}`),
    ...viewerLicences.map((s) => `dv:license: ${s}`),
  ].filter(Boolean);
  const pdm = useStatements.some((s) => PDM.test(s.text ?? '') || PDM.test(s.href ?? ''));
  const cc0 = useStatements.some((s) => CC0.test(s.text ?? '') || CC0.test(s.href ?? ''));
  const statusPD = copyrightStatus.some((s) => PUBLIC_DOMAIN_STATUS.test(String(s).trim()));
  const viewerPDM = viewerLicences.some((s) => /^pdm$/i.test(String(s).trim()));
  if (!pdm && !cc0 && !(statusPD && viewerPDM)) {
    return { basis: null, statements, reason: `no affirmative Public Domain Mark / PDM licence: ${statements.join(' | ') || 'no rights statement'}` };
  }
  for (const statement of statements) {
    // A restrictive phrase sharing a line with an open-licence URI is a genuine
    // conflict; reject it instead of selecting the permissive half.
    if (!RESTRICTIVE.test(statement)) continue;
    return { basis: null, statements, reason: `conflicting restrictive statement: ${statement}` };
  }
  if (pdm || (statusPD && viewerPDM)) {
    return { basis: 'pdm', licence: 'https://creativecommons.org/publicdomain/mark/1.0/', statements };
  }
  return { basis: 'cc0', licence: 'https://creativecommons.org/publicdomain/zero/1.0/', statements };
}

function fileGroup(record, use) {
  const m = String(record).match(new RegExp(`<mets:fileGrp[^>]*USE="${use}"[^>]*>([\\s\\S]*?)</mets:fileGrp>`));
  if (!m) return [];
  return [...m[1].matchAll(/<mets:FLocat[^>]*xlink:href="([^"]+)"/g)].map((x) => decode(x[1])).filter((url) => /^https:\/\//.test(url));
}

function identifier(record, type) {
  const m = String(record).match(new RegExp(`<mods:identifier[^>]*type="${type}"[^>]*>([^<]+)</mods:identifier>`));
  return m ? decode(m[1]) : null;
}

function presentationUrl(record) {
  const m = String(record).match(/<dv:presentation>\s*([^<\s]+)\s*<\/dv:presentation>/);
  if (m && /^https:\/\//.test(decode(m[1]))) return decode(m[1]);
  const purl = identifier(record, 'purl');
  return purl ? purl.replace(/^http:\/\//, 'https://') : null;
}

/**
 * Build one catalogue record from a METS record. Returns { record, reason };
 * every field is transcribed from the item's own metadata.
 */
export function recordFrom(record, { retrieved = RETRIEVED } = {}) {
  const id = idOf(record);
  if (!id) return { record: null, reason: 'no SLUB digital id' };
  const { title, subtitle } = titleOf(record);
  if (!title) return { record: null, reason: 'no MODS title' };
  const useStatements = blocksOf(record, 'mods:accessCondition')
    .filter((block) => /type="use and reproduction"/.test(block.attrs))
    .map((block) => ({ text: plain(block.body), href: attr((block.attrs.match(/xlink:href="([^"]+)"/) || [])[1] ?? '') }));
  const copyrightStatus = [...String(record).matchAll(/<slubarchiv:copyrightStatus>\s*([^<]+)\s*<\/slubarchiv:copyrightStatus>/g)].map((m) => decode(m[1]));
  const viewerLicences = [...String(record).matchAll(/<dv:license>\s*([^<]+)\s*<\/dv:license>/g)].map((m) => decode(m[1]));
  const gate = rightsGate({ useStatements, copyrightStatus, viewerLicences });
  if (!gate.basis) return { record: null, reason: gate.reason };
  const thumbs = fileGroup(record, 'THUMBS');
  const previews = fileGroup(record, 'DEFAULT');
  const originals = fileGroup(record, 'ORIGINAL');
  const documents = fileGroup(record, 'DOWNLOAD');
  if (!originals.length) return { record: null, reason: 'no original scan bitstream' };
  const url = presentationUrl(record);
  if (!url) return { record: null, reason: 'no presentation or PURL identifier' };
  const years = issuedYears(record);
  const publishers = blocksOf(record, 'mods:publisher').map((b) => plain(b.body)).filter(Boolean);
  const places = blocksOf(record, 'mods:placeTerm').map((b) => plain(b.body)).filter(Boolean);
  const languages = blocksOf(record, 'mods:languageTerm').map((b) => plain(b.body)).filter(Boolean);
  const extent = firstValue(record, 'mods:extent');
  const shelfmark = firstValue(record, 'mods:shelfLocator');
  const urn = identifier(record, 'urn');
  const dfgOwner = plain((String(record).match(/<dv:owner>\s*([\s\S]*?)\s*<\/dv:owner>/) || [])[1] ?? '');
  const record_ = {
    id: `slub:${id}`,
    title,
    subtitle: subtitle || undefined,
    creators: creatorsOf(record),
    providerId: 'slub',
    institution: dfgOwner && !/^slub/i.test(dfgOwner) ? dfgOwner : 'SLUB Dresden',
    collection: 'Karten und Ansichten (SLUB Dresden)',
    originalCollection: 'Karten und Ansichten',
    rights: gate.statements.join(' ; '),
    rightsBasis: gate.basis,
    rightsUrl: gate.licence,
    rightsPolicyUrl: POLICY,
    rightsNote:
      'The item’s DFG-viewer and MODS metadata state the Public Domain Mark 1.0 (or an equivalent PDM licence with copyrightStatus publicdomain). SLUB’s digital-collections terms ask for the source citation; image rights are the per-object statement.',
    attribution: `SLUB Dresden, ${url} (Public Domain Mark 1.0)`,
    recordUrl: url,
    viewerUrl: url,
    thumbnail: thumbs[0] ?? previews[0],
    imageUrl: originals[0],
    imageCount: originals.length,
    pageCount: originals.length,
    documents: documents.slice(0, 2),
    type: 'map',
    publisher: publishers.join(' ; ') || undefined,
    place: places[0] || undefined,
    languages,
    shelfmark: shelfmark || undefined,
    physicalExtent: extent || undefined,
    urn: urn || undefined,
    metadataSource: `${OAI}?verb=GetRecord&metadataPrefix=mets&identifier=${encodeURIComponent(`oai:de:slub-dresden:db:id-${id}`)}`,
    sourceSet: SET,
    retrieved,
    geoNote:
      'SLUB publishes no map extent for this work; no place anchor, boundary or alignment is inferred. The original scan opens from the record page.',
  };
  if (years) {
    record_.yearStart = years.start;
    record_.yearEnd = years.end;
  }
  if (originals.length > 1) {
    record_.images = originals.slice(0, 8);
    record_.imageNote = `The work has ${originals.length} digitised pages; the first eight original JPEG links are listed and the record page opens the complete viewer.`;
  }
  for (const key of Object.keys(record_)) {
    const v = record_[key];
    if (key === 'creators') continue;
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete record_[key];
  }
  if (!Array.isArray(record_.creators)) record_.creators = [];
  if (!/^https:\/\//.test(record_.recordUrl)) return { record: null, reason: 'insecure record URL' };
  if (record_.thumbnail && !/^https:\/\//.test(record_.thumbnail)) return { record: null, reason: 'insecure thumbnail' };
  return { record: record_ };
}

async function cachedXml(url, key, { attempts = 4 } = {}) {
  const file = resolve(CACHE, `${key}.xml`);
  if (!REFRESH) {
    try {
      return await readFile(file, 'utf8');
    } catch {}
  }
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/xml', 'user-agent': UA } });
      if (res.ok) {
        const body = await res.text();
        if (!/<OAI-PMH/.test(body)) throw new Error(`not an OAI-PMH response: ${url}`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
        return body;
      }
      last = new Error(`${res.status} ${url}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      last = error;
    }
    await sleep(900 * attempt);
  }
  throw last;
}

/** Read the whole documented METS set, following and caching resumption tokens. */
export async function readOai() {
  let token = null;
  let page = 0;
  let total = null;
  const records = new Map();
  while (true) {
    const url = token
      ? `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
      : `${OAI}?verb=ListRecords&metadataPrefix=mets&set=${SET}`;
    const xml = await cachedXml(url, `page-${page}`);
    for (const record of recordsOf(xml)) {
      const id = idOf(record);
      if (id) records.set(id, record);
    }
    if (total == null) {
      const match = xml.match(/completeListSize="(\d+)"/);
      total = match ? Number(match[1]) : null;
    }
    const next = (xml.match(/<resumptionToken[^>]*>([^<]*)<\/resumptionToken>/) || [])[1]?.trim();
    if (!next) break;
    token = next;
    page += 1;
    await sleep(250);
  }
  return { records, pages: page + 1, total };
}

async function head(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'image/*,application/pdf', range: 'bytes=0-2047', 'user-agent': UA } });
    await res.arrayBuffer();
    return { status: res.status, type: res.headers.get('content-type'), length: Number(res.headers.get('content-length') || 0) };
  } catch (error) {
    return { status: 0, error: String(error.message) };
  }
}

async function verify(records) {
  if (!VERIFY_SAMPLE || !records.length) return { sample: 0 };
  const step = Math.max(1, Math.floor(records.length / VERIFY_SAMPLE));
  const sample = [];
  for (let i = 0; i < records.length && sample.length < VERIFY_SAMPLE; i += step) sample.push(records[i]);
  const results = [];
  for (const record of sample) {
    const [thumb, image, page] = await Promise.all([
      record.thumbnail ? head(record.thumbnail) : { status: 0, type: null },
      head(record.imageUrl),
      fetch(record.recordUrl, { headers: { 'user-agent': UA } })
        .then(async (res) => ({ status: res.status, type: res.headers.get('content-type') }))
        .catch((error) => ({ status: 0, error: String(error.message) })),
    ]);
    results.push({
      id: record.id,
      thumbnail: thumb.status,
      thumbnailType: thumb.type,
      image: image.status,
      imageType: image.type,
      record: page.status,
    });
    await sleep(120);
  }
  const okThumb = (r) => (r.thumbnail === 200 || r.thumbnail === 206) && /^image\//.test(r.thumbnailType ?? '');
  const okImage = (r) => (r.image === 200 || r.image === 206) && /^image\//.test(r.imageType ?? '');
  return {
    retrieved: RETRIEVED,
    sample: results.length,
    thumbnailOk: results.filter(okThumb).length,
    originalOk: results.filter(okImage).length,
    recordOk: results.filter((r) => r.record === 200).length,
    examples: results.slice(0, 5),
  };
}

async function main() {
  const { records: xmlRecords, pages, total } = await readOai();
  console.log(`SLUB OAI set ${SET}: ${total ?? '?'} records reported, ${xmlRecords.size} fetched in ${pages} pages`);
  const records = [];
  const withheld = {};
  const basis = {};
  for (const id of [...xmlRecords.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    const { record, reason } = recordFrom(xmlRecords.get(id));
    if (!record) {
      const key = /rights|licence|restrictive|Public Domain/i.test(reason) ? `rights: ${reason}` : reason;
      withheld[key] = (withheld[key] || 0) + 1;
      continue;
    }
    records.push(record);
    basis[record.rightsBasis] = (basis[record.rightsBasis] || 0) + 1;
  }
  if (!records.length) throw new Error('No eligible SLUB records; leaving the catalogue unchanged.');
  records.sort((a, b) => (a.yearStart ?? Infinity) - (b.yearStart ?? Infinity) || a.id.localeCompare(b.id));
  const dated = records.filter((r) => r.yearStart != null);
  console.log(`Eligible SLUB records: ${records.length} of ${xmlRecords.size}`);
  console.log('Rights bases:', basis);
  console.log('Dates:', dated.length, 'undated:', records.length - dated.length, 'range:', dated.length ? `${Math.min(...dated.map((r) => r.yearStart))}–${Math.max(...dated.map((r) => r.yearEnd))}` : 'none');
  console.log('Works with more than one page:', records.filter((r) => (r.imageCount ?? 0) > 1).length);
  console.log('Withheld:', Object.fromEntries(Object.entries(withheld).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  const verification = await verify(records);
  console.log('Verification sample:', verification);
  const selection = {
    source: 'SLUB Dresden — Karten und Ansichten',
    endpoint: `${OAI}?verb=ListRecords&metadataPrefix=mets&set=${SET}`,
    set: { id: SET, name: 'Karten und Ansichten' },
    metadataPrefix: 'mets',
    considered: xmlRecords.size,
    reportedByFeed: total,
    kept: records.length,
    shard: SHARD,
    rightsBasis: basis,
    withheld,
    rule:
      'Every record in the documented SLUB OAI-PMH set maps is a candidate. It is admitted only when the item’s own METS states the Public Domain Mark 1.0 (MODS use-and-reproduction href/text, or dv:license=pdm with slubarchiv:copyrightStatus=publicdomain) and carries no separate restrictive statement. The first THUMBS/DEFAULT/ORIGINAL bitstreams become the preview/original links; no IIIF service, extent, place or alignment is invented.',
    policy: {
      url: POLICY,
      statement:
        'SLUB’s digital-collections terms state that digitised objects whose copyright has expired are made available under the Public Domain Mark 1.0 and require the source citation (SLUB Dresden, PURL/URN, licence). Per-object statements are retained on every entry. SLUB does not publish a separate metadata licence; metadata is reused with attribution and a link to each original record.',
    },
    verification,
    retrieved: RETRIEVED,
  };
  const generatedAt = new Date().toISOString();
  const method =
    'SLUB Dresden OAI-PMH set maps in METS: per-object MODS/DFG-viewer Public Domain Mark gate, original JPEG/PDF bitstreams and a resumable shard.';
  const provider = {
    id: 'slub',
    name: 'SLUB Dresden — Karten und Ansichten',
    operator: 'Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden (SLUB)',
    homepage: 'https://digital.slub-dresden.de/',
    home: 'https://digital.slub-dresden.de/',
    institutions: ['SLUB Dresden'],
    rights:
      'Per-object Public Domain Mark 1.0 (MODS use-and-reproduction and DFG-viewer dv:license), corroborated by slubarchiv:copyrightStatus=publicdomain. Restrictive or unstated records are withheld; the verbatim statements stay on each record.',
    attribution: 'SLUB Dresden, digital.slub-dresden.de',
    terms: POLICY,
    retrieved: RETRIEVED,
    api: {
      discovery: `${OAI}?verb=ListRecords&metadataPrefix=mets&set=${SET}`,
      sets: `${OAI}?verb=ListSets`,
      formats: ['mets'],
      record: 'https://digital.slub-dresden.de/id{id}',
      oaiRecord: `${OAI}?verb=GetRecord&metadataPrefix=mets&identifier={oaiId}`,
      documentation: 'https://digital.slub-dresden.de/',
    },
    apiHosts: ['digital.slub-dresden.de', 'nutzungshinweis.slub-dresden.de'],
    method,
    collections: [
      { id: SET, name: 'Karten und Ansichten', discovery: `${OAI}?verb=ListRecords&metadataPrefix=mets&set=${SET}` },
    ],
    verification,
  };
  const corePath = resolve(OUT, 'records.json');
  const sourcesPath = resolve(OUT, 'sources.json');
  const core = await readCore(OUT);
  const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  core.shards = [...new Set([...(core.shards ?? []), SHARD])].sort();
  core.records = (core.records ?? []).filter((record) => record.providerId !== 'slub');
  core.generatedAt = generatedAt;
  core.retrieved = RETRIEVED;
  const priorMethod = String(core.method ?? '').split(method).join(' ').replace(/\s+/g, ' ').trim();
  core.method = priorMethod ? `${priorMethod} ${method}` : method;
  core.selection ??= {};
  core.selection['slub:maps'] = selection;
  sources.providers = [...sources.providers.filter((source) => source.id !== 'slub'), provider].sort((a, b) => a.id.localeCompare(b.id));
  sources.generatedAt = generatedAt;
  const shardDoc = { generatedAt, retrieved: RETRIEVED, providerId: 'slub', method, selection, records };
  const coreBytes = Buffer.byteLength(JSON.stringify(core, null, 2));
  const shardBytes = Buffer.byteLength(JSON.stringify(shardDoc));
  console.log(`Catalogue would be ${core.records.length} core + ${records.length} SLUB records; core ${(coreBytes / 1024 / 1024).toFixed(2)} MiB, shard ${(shardBytes / 1024 / 1024).toFixed(2)} MiB`);
  if (coreBytes > 24 * 1024 * 1024 || shardBytes > 24 * 1024 * 1024) throw new Error('A catalogue asset exceeds 24 MiB; split it before writing.');
  if (WRITE) {
    await mkdir(dirname(shardPath(OUT, SHARD)), { recursive: true });
    await writeFile(shardPath(OUT, SHARD), `${JSON.stringify(shardDoc)}\n`);
    await writeFile(corePath, `${JSON.stringify(core, null, 2)}\n`);
    await writeFile(sourcesPath, `${JSON.stringify(sources, null, 2)}\n`);
    console.log('Wrote', corePath, 'and', shardPath(OUT, SHARD));
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
