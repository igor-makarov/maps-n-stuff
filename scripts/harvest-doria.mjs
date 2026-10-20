#!/usr/bin/env node
/**
 * Doria (National Library of Finland) map harvest — sourcing swarm 2026-10-20.
 *
 * Doria is the National Library of Finland's institutional repository. The
 * documented OAI-PMH set `com_10024_109232` ("Kartat" / Maps) is the discovery
 * feed (1,663 records at retrieval). For every item the harvest combines three
 * documented OAI formats rather than scraping a search page:
 *
 *   oai_dc  title, creators, type, language, publisher, identifiers, rights
 *   mods    dateIssued and the per-item use/reproduction rights statement
 *   ore     the item's THUMBNAIL and ORIGINAL bitstreams
 *
 * Rights gate: an item is imported only when the Doria/MODS statements carry an
 * explicit Public Domain Mark or CC0 licence URL, or an explicit "Public domain"
 * statement with no restrictive statement in either record. Conflicting or
 * restrictive statements are withheld. Nothing is relabelled.
 *
 * The catalogue keeps the National Library of Finland as the holding
 * institution, the verbatim title/creators/publisher/language and the Doria
 * record + URN. Records live in their own shard (`/data/records/doria.json`).
 *
 * Usage:
 *   node scripts/harvest-doria.mjs                 # cached harvest, writes public/data
 *   node scripts/harvest-doria.mjs --refresh       # refetch all OAI pages
 *   node scripts/harvest-doria.mjs --no-write      # report only
 *   node scripts/harvest-doria.mjs --dry-run       # alias for --no-write
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shardPath, shardUrl } from './catalogue.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const value = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = resolve(value('out', resolve(ROOT, 'public/data')));
const CACHE = resolve(ROOT, '.cache/doria');
const REFRESH = has('refresh');
const WRITE = !has('no-write') && !has('dry-run');
const VERIFY_SAMPLE = Math.max(0, Number(value('verify', '30')) || 0);
const UA = 'maps-n-stuff/0.2 (+https://github.com/igor-makarov/maps-n-stuff; Doria map harvest)';
const OAI = 'https://www.doria.fi/oai/request';
const SET = 'com_10024_109232';
const RETRIEVED = '2026-10-20';
const SHARD = shardUrl('doria');
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

export function fieldValues(xml, name) {
  const out = [];
  for (const m of String(xml).matchAll(new RegExp(`<dc:${name}[^>]*>([\\s\\S]*?)</dc:${name}>`, 'g'))) {
    const v = plain(m[1]);
    if (v) out.push(v);
  }
  return out;
}

function modsValues(xml, name) {
  const out = [];
  for (const m of String(xml).matchAll(new RegExp(`<mods:${name}[^>]*>([\\s\\S]*?)</mods:${name}>`, 'g'))) {
    const v = plain(m[1]);
    if (v) out.push(v);
  }
  return out;
}

function recordsOf(xml) {
  return [...String(xml).matchAll(/<record>([\s\S]*?)<\/record>/g)].map((m) => m[1]);
}

export function identifierOf(record) {
  const m = String(record).match(/<identifier>(oai:www\.doria\.fi:10024\/\d+)<\/identifier>/);
  return m ? m[1].split('/').pop() : null;
}

function setSpecsOf(record) {
  return [...String(record).matchAll(/<setSpec>([^<]+)<\/setSpec>/g)].map((m) => decode(m[1]));
}

/** Parse one oai_dc record into the facts the importer needs. */
export function parseDc(record) {
  return {
    id: identifierOf(record),
    titles: fieldValues(record, 'title'),
    creators: fieldValues(record, 'creator'),
    dates: fieldValues(record, 'date'),
    types: fieldValues(record, 'type'),
    languages: fieldValues(record, 'language'),
    rights: fieldValues(record, 'rights'),
    publisher: fieldValues(record, 'publisher'),
    identifiers: fieldValues(record, 'identifier'),
    setSpecs: setSpecsOf(record),
  };
}

/** Parse one MODS record: dateIssued, access conditions and name parts. */
export function parseMods(record) {
  const access = modsValues(record, 'accessCondition');
  return {
    titles: modsValues(record, 'title'),
    names: modsValues(record, 'namePart'),
    dateIssued: modsValues(record, 'dateIssued'),
    access,
    dateAccessioned: modsValues(record, 'dateAccessioned'),
    dateAvailable: modsValues(record, 'dateAvailable'),
  };
}

/** Parse one ORE record: the thumbnail and the original bitstreams. */
export function parseOre(record) {
  const blocks = [...String(record).matchAll(/<rdf:Description[^>]*rdf:about="([^"]+)"[^>]*>([\s\S]*?)<\/rdf:Description>/g)].map((m) => ({
    url: decode(m[1]),
    kind: plain((m[2].match(/<dcterms:description>([\s\S]*?)<\/dcterms:description>/) || [])[1]).toUpperCase(),
  }));
  const links = [...String(record).matchAll(/<atom:link[^>]*rel="http:\/\/www\.openarchives\.org\/ore\/terms\/aggregates"[^>]*>/g)].map((m) => m[0]);
  const mime = new Map();
  for (const link of links) {
    const href = link.match(/href="([^"]+)"/);
    const type = link.match(/type="([^"]+)"/);
    if (href && type) mime.set(decode(href[1]), decode(type[1]));
  }
  const bitstreams = blocks
    .filter((block) => block.kind === 'THUMBNAIL' || block.kind === 'ORIGINAL')
    .map((block) => ({ ...block, mime: mime.get(block.url) || null }));
  return {
    thumbnail: bitstreams.find((b) => b.kind === 'THUMBNAIL' && /^https:\/\//.test(b.url))?.url ?? null,
    bitstreams,
  };
}

/** All 4-digit years in a publication statement, in order, within the catalogue's range. */
export function publicationYears(text) {
  const years = [...String(text ?? '').matchAll(/\b(1[4-9]\d{2}|20\d{2})\b/g)].map((m) => Number(m[1]));
  if (!years.length) return null;
  if (years.length === 1) return { start: years[0], end: years[0] };
  const start = Math.min(...years);
  const end = Math.max(...years);
  if (end - start <= 10) return { start, end };
  return { start: years[0], end: years[0] };
}

const PDM = /creativecommons\.org\/publicdomain\/mark\/1\.0/i;
const CC0 = /creativecommons\.org\/publicdomain\/zero\/1\.0/i;
const PUBLIC_DOMAIN = /^(?:public domain|public-domain)$/i;
// A restriction is only a restriction when it is not part of an open licence's
// own legal text (the CC0 waiver says "under copyright law").
const RESTRICTIVE = /non[ -]?commercial|all rights reserved|permission (?:is )?required|in copyright|copyright (?:protected|reserved)|rights reserved|contact the (?:host|publisher)|not in the public domain|may be restricted|\b(?:is|are|remains|protected) under copyright\b|protected by copyright/i;

/**
 * Decide whether the per-item statements are an affirmative open-licence basis.
 * Returns { basis, licence, rights } or { basis: null, reason }.
 */
export function rightsGate(statements) {
  const rights = [...new Set((statements ?? []).map((s) => plain(s)).filter(Boolean))];
  if (!rights.length) return { basis: null, reason: 'no rights statement' };
  const open = rights.filter((s) => PDM.test(s) || CC0.test(s));
  if (!open.length && !rights.some((s) => PUBLIC_DOMAIN.test(s))) {
    return { basis: null, reason: `no explicit PDM/CC0/public-domain statement: ${rights.join(' | ')}` };
  }
  // An explicit restrictive statement that is not part of an open licence's
  // legal text makes the item ineligible, even if another line names CC0/PDM.
  for (const statement of rights) {
    if (!RESTRICTIVE.test(statement)) continue;
    // A restriction is never cancelled by an open URI elsewhere on the same
    // line. The only tolerated overlap is the open licence's own legal text,
    // which the RESTRICTIVE expression already excludes (e.g. CC0's "under
    // copyright law"). Genuine conflicts are withheld.
    return { basis: null, reason: `conflicting restrictive statement: ${statement}` };
  }
  if (open.some((s) => PDM.test(s))) {
    return {
      basis: 'pdm',
      licence: 'https://creativecommons.org/publicdomain/mark/1.0/',
      rights,
    };
  }
  if (open.some((s) => CC0.test(s))) {
    return {
      basis: 'cc0',
      licence: 'https://creativecommons.org/publicdomain/zero/1.0/',
      rights,
    };
  }
  return { basis: 'public-domain-statement', licence: null, rights };
}

/** `fi=Kartat|sv=Kartor|en=Maps|` → `Maps`; raw names pass through. */
export function englishSetName(name) {
  const value = String(name ?? '').trim();
  const match = value.match(/(?:^|\|)en=([^|]+)/);
  return plain((match ? match[1] : value).replace(/^[a-z]{2}=/i, ''));
}

const GENERIC_SETS = /^(?:maps?|kartat|kartor|kansalliskirjasto|national library of finland|nationalbiblioteket)$/i;

/**
 * Build a catalogue record from the three parsed OAI formats. Returns
 * { record, reason }; every required field must come from the upstream record.
 */
export function recordFrom(item, { sets = new Map(), retrieved = RETRIEVED } = {}) {
  const { id, dc, mods, ore } = item;
  if (!/^\d+$/.test(String(id))) return { record: null, reason: 'no Doria handle id' };
  if (!(dc?.types ?? []).some((t) => /\bmap\b|kartta/i.test(t))) return { record: null, reason: 'not typed as a map' };
  const gate = rightsGate([...(dc?.rights ?? []), ...(mods?.access ?? [])]);
  if (!gate.basis) return { record: null, reason: gate.reason };
  const title = (dc?.titles ?? [])[0] || (mods?.titles ?? [])[0] || '';
  if (!title) return { record: null, reason: 'no title stated by Doria' };
  const bitstreams = ore?.bitstreams ?? [];
  const images = bitstreams.filter((b) => b.kind === 'ORIGINAL' && /^https:\/\//.test(b.url) && /^image\//i.test(b.mime ?? ''));
  const documents = bitstreams.filter((b) => b.kind === 'ORIGINAL' && /^https:\/\//.test(b.url) && !/^image\//i.test(b.mime ?? ''));
  if (!images.length && !documents.length) return { record: null, reason: 'no original bitstream' };
  // A preview is optional: a rights-cleared scan without a Doria thumbnail stays
  // eligible. A real original image is a truthful preview; a PDF-only item keeps
  // no thumbnail and is still admitted with its document link.
  const thumbnail = ore?.thumbnail ?? (images.find((b) => /^image\/jpe?g$/i.test(b.mime ?? '')) ?? images[0])?.url ?? undefined;
  const accessioned = new Set([...(mods?.dateAccessioned ?? []), ...(mods?.dateAvailable ?? [])].map((d) => String(d).trim()));
  const issuedText = (mods?.dateIssued ?? [])[0] ?? null;
  let years = publicationYears(issuedText);
  if (!years) {
    const fallback = [...(dc?.dates ?? [])].reverse().find((date) => !accessioned.has(String(date).trim()));
    years = publicationYears(fallback);
  }
  const collectionNames = [...new Set((dc?.setSpecs ?? []).map((spec) => englishSetName(sets.get(spec))).filter((name) => name && !GENERIC_SETS.test(name)))];
  const collection = collectionNames.join(' / ') || 'Kartat (Maps)';
  const creatorNames = (dc?.creators ?? []).length ? dc.creators : (mods?.names ?? []);
  const record = {
    id: `doria:${id}`,
    title,
    creators: [...new Set(creatorNames.map((name) => plain(name)).filter(Boolean))],
    providerId: 'doria',
    institution: 'National Library of Finland (Kansalliskirjasto)',
    collection,
    rights: gate.rights.join(' ; '),
    rightsBasis: gate.basis,
    rightsUrl: gate.licence ?? undefined,
    rightsNote:
      gate.basis === 'public-domain-statement'
        ? 'The Doria item record states “Public domain”; it does not publish a PDM/CC0 licence URL. The item page and URN are retained as evidence.'
        : undefined,
    recordUrl: `https://www.doria.fi/handle/10024/${id}`,
    thumbnail,
    imageUrl: (images.find((b) => /^image\/jpe?g$/i.test(b.mime ?? '')) ?? images[0])?.url ?? undefined,
    images: images.map((b) => b.url),
    documents: documents.map((b) => b.url),
    type: 'map',
    publisher: (dc?.publisher ?? []).join(' ; '),
    languages: dc?.languages ?? [],
    urn: (dc?.identifiers ?? []).find((value) => /^URN:/i.test(value)),
    metadataSource: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=${SET}`,
    retrieved,
    geoNote: 'Doria publishes no map extent for this sheet; no place anchor or boundary is inferred.',
  };
  if (years) {
    record.yearStart = years.start;
    record.yearEnd = years.end;
  }
  for (const key of Object.keys(record)) {
    const v = record[key];
    if (key === 'creators') continue;
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) delete record[key];
  }
  if (!Array.isArray(record.creators)) record.creators = [];
  if (record.thumbnail && !/^https:\/\//.test(record.thumbnail)) return { record: null, reason: 'insecure thumbnail' };
  return { record };
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
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, body);
        return body;
      }
      last = new Error(`${res.status} ${url}`);
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      last = error;
    }
    await sleep(800 * attempt);
  }
  throw last;
}

/** Read a whole OAI format, following and caching resumption tokens. */
export async function readOai(format) {
  let token = null;
  let page = 0;
  let total = null;
  const records = new Map();
  while (true) {
    const url = token
      ? `${OAI}?verb=ListRecords&resumptionToken=${encodeURIComponent(token)}`
      : `${OAI}?verb=ListRecords&metadataPrefix=${format}&set=${SET}`;
    const key = `${format}/page-${page}`;
    const xml = await cachedXml(url, key);
    for (const record of recordsOf(xml)) {
      const id = identifierOf(record);
      if (id) records.set(id, record);
    }
    if (total == null) {
      const match = xml.match(/completeListSize="(\d+)"/);
      total = match ? Number(match[1]) : null;
    }
    const tokenMatch = xml.match(/<resumptionToken[^>]*>([^<]*)<\/resumptionToken>/);
    const next = tokenMatch?.[1]?.trim();
    if (!next) break;
    token = next;
    page += 1;
    await sleep(150);
  }
  return { records, pages: page + 1, total };
}

async function readSetNames() {
  const file = resolve(CACHE, 'sets.xml');
  let xml;
  if (!REFRESH) {
    try {
      xml = await readFile(file, 'utf8');
    } catch {}
  }
  if (!xml) {
    const res = await fetch(`${OAI}?verb=ListSets`, { headers: { accept: 'application/xml', 'user-agent': UA } });
    if (!res.ok) throw new Error(`${res.status} ListSets`);
    xml = await res.text();
    await mkdir(CACHE, { recursive: true });
    await writeFile(file, xml);
  }
  const sets = new Map();
  for (const m of xml.matchAll(/<set>([\s\S]*?)<\/set>/g)) {
    const spec = (m[1].match(/<setSpec>([^<]+)<\/setSpec>/) || [])[1];
    const name = (m[1].match(/<setName>([^<]+)<\/setName>/) || [])[1];
    if (spec && name) sets.set(decode(spec), decode(name));
  }
  return sets;
}

async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
      await sleep(80);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function head(url) {
  try {
    const res = await fetch(url, { headers: { accept: 'image/*,application/pdf', range: 'bytes=0-2047', 'user-agent': UA } });
    const body = await res.arrayBuffer();
    return {
      status: res.status,
      type: res.headers.get('content-type'),
      bytes: body.byteLength,
      length: Number(res.headers.get('content-length') || 0),
    };
  } catch (error) {
    return { status: 0, error: String(error.message) };
  }
}

async function verify(records) {
  if (!VERIFY_SAMPLE) return { sample: 0 };
  const step = Math.max(1, Math.floor(records.length / VERIFY_SAMPLE));
  const sample = [];
  for (let i = 0; i < records.length && sample.length < VERIFY_SAMPLE; i += step) sample.push(records[i]);
  const results = await pool(sample, 4, async (record) => {
    const [thumb, image, page] = await Promise.all([
      head(record.thumbnail),
      head(record.imageUrl || record.thumbnail),
      fetch(record.recordUrl, { headers: { 'user-agent': UA } }).then(async (res) => ({ status: res.status, type: res.headers.get('content-type') })).catch((error) => ({ status: 0, error: String(error.message) })),
    ]);
    return {
      id: record.id,
      thumbnail: thumb.status,
      thumbnailType: thumb.type,
      image: image.status,
      imageType: image.type,
      record: page.status,
    };
  });
  const okImage = (result) => (result.thumbnail === 200 || result.thumbnail === 206) && /^image\//.test(result.thumbnailType ?? '');
  const okOriginal = (result) => (result.image === 200 || result.image === 206) && /^(?:image\/|application\/pdf)/.test(result.imageType ?? '');
  return {
    retrieved: RETRIEVED,
    sample: results.length,
    thumbnailOk: results.filter(okImage).length,
    originalOk: results.filter(okOriginal).length,
    recordOk: results.filter((result) => result.record === 200).length,
    examples: results.slice(0, 5),
  };
}

async function main() {
  const [dc, mods, ore, sets] = await Promise.all([readOai('oai_dc'), readOai('mods'), readOai('ore'), readSetNames()]);
  console.log(`Doria OAI set ${SET}: ${dc.total} records (${dc.pages} oai_dc pages, ${mods.pages} mods, ${ore.pages} ore)`);
  const ids = new Set([...dc.records.keys()]);
  for (const id of mods.records.keys()) ids.add(id);
  for (const id of ore.records.keys()) ids.add(id);
  const records = [];
  const withheld = {};
  const basis = {};
  const seen = new Set();
  for (const id of [...ids].sort((a, b) => Number(a) - Number(b))) {
    const item = { id, dc: dc.records.has(id) ? parseDc(dc.records.get(id)) : null, mods: mods.records.has(id) ? parseMods(mods.records.get(id)) : null, ore: ore.records.has(id) ? parseOre(ore.records.get(id)) : null };
    const { record, reason } = recordFrom(item, { sets });
    if (!record) {
      const key = reason.includes('rights') || reason.includes('licence') || reason.includes('restrictive') ? `rights: ${reason}` : reason;
      withheld[key] = (withheld[key] || 0) + 1;
      continue;
    }
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    records.push(record);
    basis[record.rightsBasis] = (basis[record.rightsBasis] || 0) + 1;
  }
  if (!records.length) throw new Error('No eligible Doria records; leaving the catalogue unchanged.');
  records.sort((a, b) => (a.yearStart ?? Infinity) - (b.yearStart ?? Infinity) || a.id.localeCompare(b.id));
  const dated = records.filter((r) => r.yearStart != null);
  console.log(`Eligible Doria records: ${records.length} of ${ids.size}`);
  console.log('Rights bases:', basis);
  console.log('Dates:', dated.length, 'undated:', records.length - dated.length, 'range:', dated.length ? `${Math.min(...dated.map((r) => r.yearStart))}–${Math.max(...dated.map((r) => r.yearEnd))}` : 'none');
  console.log('Multi-image works:', records.filter((r) => (r.images?.length ?? 0) > 1).length, 'PDF-only originals:', records.filter((r) => !r.imageUrl).length);
  console.log('Withheld:', Object.fromEntries(Object.entries(withheld).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  const verification = await verify(records);
  console.log('Verification sample:', verification);
  const selection = {
    source: 'Doria — National Library of Finland (Kansalliskirjasto)',
    endpoint: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=${SET}`,
    sets: [
      { id: SET, name: 'Kartat / Maps', discovery: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=${SET}` },
      { id: 'com_10024_97216', name: 'The Nordenskiöld Map Collection', discovery: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=com_10024_97216` },
      { id: 'com_10024_78800', name: 'Maps and Atlases of Finland', discovery: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=com_10024_78800` },
    ],
    metadataPrefixes: ['oai_dc', 'mods', 'ore'],
    considered: ids.size,
    kept: records.length,
    shard: SHARD,
    rightsBasis: basis,
    withheld,
    rule:
      'Every item in Doria’s documented OAI-PMH Maps set (com_10024_109232) is a candidate. It is imported only when oai_dc type includes map, the Doria/MODS statements carry an explicit Public Domain Mark or CC0 licence URL or an explicit “Public domain” statement, no separate restrictive statement appears in either record, and ORE publishes a thumbnail plus an original bitstream. Titles, creators, publisher, language, URN and the Doria handle are retained verbatim; no date, extent, creator or rights statement is inferred.',
    metadataReuse: {
      "status": "basis-recorded",
      "decided": "2026-10-20T12:16Z",
      "basis": "The National Library of Finland supplies each admitted item with a CC0 1.0 / Public Domain use-and-reproduction condition and publishes the description through the documented OAI-PMH interface (oai_dc, mods, ore). The redistributed fields are the factual description of the item (title, creator, date, publisher, language, URN, handle). No separate metadata licence is published and none is asserted; the CC0/PDM condition is not relabelled as a metadata licence.",
      "primaryEvidence": [
        {
          "url": "https://www.doria.fi/oai/request?verb=GetRecord&metadataPrefix=mods&identifier=oai:www.doria.fi:10024/84494",
          "retrieved": "2026-10-20",
          "quote": "<mods:accessCondition type=\"useAndReproduction\">http://creativecommons.org/publicdomain/zero/1.0/</mods:accessCondition> and <mods:accessCondition type=\"useAndReproduction\">Public Domain</mods:accessCondition>"
        },
        {
          "url": "https://www.doria.fi/page/terms",
          "retrieved": "2026-10-20",
          "quote": "HTTP 200 but the body contains only the unfilled template placeholders StaticPageBodyHead / StaticPageBodyPara; no repository-wide metadata licence or bulk-redistribution grant is published."
        }
      ],
      "limits": "Only items whose own statement is PDM, CC0 or plain public domain are admitted; restrictive or conflicting statements are withheld with the verbatim wording retained. Attribution, the Doria handle and the URN stay on every record.",
      "decisionNote": "coordination/metadata-rights-decision-20261020.md"
    },
    verification,
    retrieved: RETRIEVED,
  };
  const generatedAt = new Date().toISOString();
  const method =
    'Doria (National Library of Finland) OAI-PMH Maps set com_10024_109232, combining oai_dc discovery, MODS date/rights and ORE bitstreams; rights-gated and published as a catalogue shard.';
  const provider = {
    id: 'doria',
    name: 'Doria — National Library of Finland map collections',
    operator: 'National Library of Finland (Kansalliskirjasto)',
    homepage: 'https://www.doria.fi/',
    home: 'https://www.doria.fi/',
    institutions: ['National Library of Finland (Kansalliskirjasto)'],
    rights:
      'Per-item rights: Public Domain Mark, CC0, or an explicit “Public domain” statement. The verbatim Doria/MODS statements are retained on every record; restrictive or conflicting statements are withheld.',
    attribution: 'National Library of Finland / Doria',
    retrieved: RETRIEVED,
    terms: 'https://www.doria.fi/page/terms',
    api: {
      discovery: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=${SET}`,
      sets: `${OAI}?verb=ListSets`,
      formats: ['oai_dc', 'mods', 'ore'],
      record: 'https://www.doria.fi/handle/10024/{id}',
      bitstream: 'https://www.doria.fi/bitstream/10024/{id}/{sequence}/{name}',
      documentation: 'https://www.doria.fi/',
    },
    apiHosts: ['www.doria.fi'],
    method,
    metadataReuse: selection.metadataReuse,
    collections: [
      { id: 'kartat', name: 'Kartat / Maps (National Library of Finland)', discovery: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=${SET}` },
      { id: 'nordenskiold', name: 'The Nordenskiöld Map Collection', discovery: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=com_10024_97216` },
      { id: 'suomen-karttoja', name: 'Maps and Atlases of Finland', discovery: `${OAI}?verb=ListRecords&metadataPrefix=oai_dc&set=com_10024_78800` },
    ],
    verification,
  };
  const corePath = resolve(OUT, 'records.json');
  const sourcesPath = resolve(OUT, 'sources.json');
  const core = JSON.parse(await readFile(corePath, 'utf8'));
  const sources = JSON.parse(await readFile(sourcesPath, 'utf8'));
  core.shards = [...new Set([...(core.shards ?? []), SHARD])].sort();
  core.records = (core.records ?? []).filter((record) => record.providerId !== 'doria');
  core.generatedAt = generatedAt;
  core.retrieved = RETRIEVED;
  core.method = `${core.method ? `${core.method} ` : ''}${method}`;
  core.selection ??= {};
  core.selection['doria:maps'] = selection;
  sources.providers = [...sources.providers.filter((source) => source.id !== 'doria'), provider];
  sources.generatedAt = generatedAt;
  const shardDoc = { generatedAt, retrieved: RETRIEVED, providerId: 'doria', method, selection, records };
  const coreBytes = Buffer.byteLength(JSON.stringify(core, null, 2));
  const shardBytes = Buffer.byteLength(JSON.stringify(shardDoc));
  console.log(`Catalogue would be ${core.records.length} core + ${records.length} Doria records; core ${(coreBytes / 1024 / 1024).toFixed(2)} MiB, shard ${(shardBytes / 1024 / 1024).toFixed(2)} MiB`);
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
