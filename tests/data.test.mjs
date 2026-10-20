/**
 * Data contract tests (coordination/data-contract.md + coordination/README.md D4).
 *
 * These run offline against the committed seed data. They are the "source
 * registry is honest" gate: every identifier, date, right statement and image
 * URL in `public/data/*.json` must be present, well-formed and attributable to a
 * provider that the registry actually documents.
 *
 * Owner: zurich-maps-3 (`tests/**`). File name is distinct from
 * `tests/records.test.mjs` (zurich-maps-0, data-layer tests).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalogue } from '../scripts/catalogue.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = async (rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));

const catalogue = await readCatalogue(path.join(root, 'public/data'));
const recordsFile = catalogue.core;
const sourcesFile = await readJson('public/data/sources.json');
const overlaysFile = await readJson('public/data/overlays.json');

const records = catalogue.records;
const providers = sourcesFile.providers;
const overlays = overlaysFile.overlays;

const providerById = new Map(providers.map((p) => [p.id, p]));

/** Hosts the source registry documents as the primary endpoints for this app. */
const REGISTRY_HOSTS = new Set([
  'www.e-rara.ch',
  'purl.stanford.edu',
  'stacks.stanford.edu',
  'www.loc.gov',
  'tile.loc.gov',
  'collections.leventhalmap.org',
  'ark.digitalcommonwealth.org',
  'iiif.digitalcommonwealth.org',
  'www.sciencebase.gov',
  'prd-tnm.s3.amazonaws.com',
  'api3.geo.admin.ch',
  'wmts.geo.admin.ch',
  'data.geo.admin.ch',
  'map.geo.admin.ch',
  'www.swisstopo.admin.ch',
  'www.zb.uzh.ch',
  'www.doria.fi',
  'digital.slub-dresden.de',
  'nutzungshinweis.slub-dresden.de',
]);

/** Discovery-only aggregators: allowed in links in prose, never as a data source. */
const DISCOVERY_ONLY = ['oldmapsonline.org'];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

test('records.json is a documented, non-empty dataset', () => {
  assert.ok(Array.isArray(records) && records.length > 0, 'records.json needs at least one record');
  assert.ok(records.length >= 15, `seed collection is expected to stay useful (found ${records.length})`);
  assert.ok(recordsFile.generatedAt, 'generatedAt documents when the data was retrieved');
  assert.ok(!Number.isNaN(Date.parse(recordsFile.generatedAt)), 'generatedAt must be an ISO timestamp');
  assert.ok(typeof recordsFile.method === 'string' && recordsFile.method.length > 20, 'method documents how the data was harvested');
});

test('sources.json documents provenance, rights and retrieval date per provider', () => {
  assert.ok(Array.isArray(providers) && providers.length > 0);
  for (const provider of providers) {
    assert.ok(provider.id && /^[a-z0-9-]+$/.test(provider.id), `${provider.id}: id must be url-safe`);
    assert.ok(provider.name, `${provider.id}: name`);
    assert.ok(provider.rights, `${provider.id}: rights statement`);
    assert.ok(provider.attribution, `${provider.id}: attribution string`);
    const isFixture = /test|fixture/i.test(`${provider.name} ${provider.rights}`);
    if (!isFixture) {
      assert.ok(provider.homepage?.startsWith('https://'), `${provider.id}: https homepage`);
      assert.ok(provider.api && Object.keys(provider.api).length > 0, `${provider.id}: documented api endpoints`);
    }
  }
  assert.ok(!Number.isNaN(Date.parse(sourcesFile.generatedAt)), 'sources.json generatedAt');
});

test('every record satisfies the D4 schema and points at a known provider', () => {
  const ids = new Set();
  for (const record of records) {
    const where = record?.id ?? '(record without id)';
    for (const field of ['title', 'providerId', 'institution', 'rights', 'recordUrl', 'type']) {
      assert.ok(typeof record[field] === 'string' && record[field].length > 0, `${where}: ${field} must be a non-empty string`);
    }
    assert.match(record.id, /^[a-z0-9-]+:.+$/, `${where}: id must be "<providerId>:<upstream id>"`);
    assert.ok(!ids.has(record.id), `${where}: duplicate id`);
    ids.add(record.id);
    assert.ok(providerById.has(record.providerId), `${where}: providerId ${record.providerId} missing from sources.json`);

    if (record.yearStart != null || record.yearEnd != null) {
    assert.ok(Number.isInteger(record.yearStart) && Number.isInteger(record.yearEnd), `${where}: integer publication years`);
    assert.ok(record.yearStart >= 1400 && record.yearEnd <= 2100, `${where}: publication years plausible`);
    assert.ok(record.yearStart <= record.yearEnd, `${where}: yearStart <= yearEnd`);
    }

    assert.ok(Array.isArray(record.creators), `${where}: creators array (may be empty)`);
    for (const key of ['depictedYearStart', 'depictedYearEnd']) {
      const value = record[key];
      assert.ok(value === null || value === undefined || Number.isInteger(value), `${where}: ${key} integer or null`);
    }
    if (record.depictedYearStart != null && record.depictedYearEnd != null) {
      assert.ok(record.depictedYearStart <= record.depictedYearEnd, `${where}: depicted start <= end`);
    }

    assert.ok(record.recordUrl.startsWith('https://'), `${where}: recordUrl must be https`);
    if (record.thumbnail) assert.ok(record.thumbnail.startsWith('https://'), `${where}: thumbnail must be https`);
    assert.ok(REGISTRY_HOSTS.has(hostOf(record.recordUrl)), `${where}: recordUrl host ${hostOf(record.recordUrl)} is not in the source registry`);
    if (record.thumbnail) assert.ok(REGISTRY_HOSTS.has(hostOf(record.thumbnail)), `${where}: thumbnail host ${hostOf(record.thumbnail)} is not in the source registry`);
    if (record.iiifManifest) {
      assert.ok(record.iiifManifest.startsWith('https://'), `${where}: iiifManifest must be https`);
      assert.ok(REGISTRY_HOSTS.has(hostOf(record.iiifManifest)), `${where}: iiifManifest host not in the source registry`);
    }

    for (const aggregator of DISCOVERY_ONLY) {
      assert.ok(!record.recordUrl.includes(aggregator), `${where}: recordUrl must link to the holding institution, not the aggregator`);
    }

    if (record.extent) {
      const { west, east, south, north } = record.extent;
      assert.ok([west, east, south, north].every(Number.isFinite), `${where}: extent must be numeric`);
      assert.ok(west < east && south < north, `${where}: extent bbox orientation`);
      assert.ok(west >= -180 && east <= 180 && south >= -90 && north <= 90, `${where}: extent inside WGS84`);
    }
    if (record.geo) {
      assert.ok(Number.isFinite(record.geo.lat) && Number.isFinite(record.geo.lon), `${where}: geo point numeric`);
      assert.ok(Math.abs(record.geo.lat) <= 90 && Math.abs(record.geo.lon) <= 180, `${where}: geo point inside WGS84`);
    }
  }
});

test('fixtures are labelled as fixtures and never mixed into the harvest silently', () => {
  for (const record of records) {
    const provider = providerById.get(record.providerId);
    const fixtureProvider = /test|fixture/i.test(`${provider?.name ?? ''} ${provider?.rights ?? ''}`);
    if (fixtureProvider) {
      assert.equal(record.fixture, true, `${record.id}: records on a fixture provider must set "fixture": true`);
    }
  }
});

test('overlays.json references provider-supplied COGs or documented historical WMTS templates', () => {
  assert.ok(Array.isArray(overlays) && overlays.length > 0);
  const wmtsHosts = new Set(['wmts.geo.admin.ch']);
  for (const overlay of overlays) {
    if (overlay.kind === 'cog') {
      assert.equal(overlay.providerId, 'stanford');
      assert.match(overlay.url, /^https:\/\/stacks\.stanford\.edu\/file\/druid:/);
      const record=records.find(value=>value.id===overlay.recordId);
      assert.equal(overlay.url,record?.georeference?.url);
      assert.ok(overlay.license && overlay.attribution);
      continue;
    }
    assert.match(overlay.id, /^ch\.swisstopo\./, `${overlay.id}: swisstopo layer id`);
    assert.ok(overlay.title, `${overlay.id}: title`);
    assert.ok(providerById.has(overlay.providerId), `${overlay.id}: providerId ${overlay.providerId}`);
    assert.ok(wmtsHosts.has(hostOf(overlay.urlTemplate)), `${overlay.id}: urlTemplate host must be the WMTS service`);
    for (const placeholder of ['{TileMatrix}', '{TileCol}', '{TileRow}']) {
      assert.ok(overlay.urlTemplate.includes(placeholder), `${overlay.id}: urlTemplate needs ${placeholder}`);
    }
    assert.ok(Array.isArray(overlay.timeValues) && overlay.timeValues.length > 0, `${overlay.id}: timeValues`);
    for (const time of overlay.timeValues) {
      // swisstopo `Time` is `current`, a year (`2026`) for annual mosaics, or a
      // revision date (`20211231`) for the Zeitreise series.
      assert.ok(
        time === 'current' || /^\d{4}$/.test(time) || /^\d{8}$/.test(time),
        `${overlay.id}: unexpected Time value ${time}`,
      );
    }
    assert.ok(overlay.attribution && overlay.license, `${overlay.id}: attribution + license required`);
    if (overlay.extent) {
      const { west, east, south, north } = overlay.extent;
      assert.ok(west < east && south < north, `${overlay.id}: extent orientation`);
      // Official swisstopo WMTS bbox for the 3857 matrix set (WMTSCapabilities.xml,
      // verified 2026-10-18). Map series legitimately cover more than the political
      // country outline, so assert containment in the advertised service extent.
      const SWISSTOPO_WMTS = { west: 5.140242, south: 45.398181, east: 11.47757, north: 48.230651 };
      assert.ok(
        west >= SWISSTOPO_WMTS.west - 0.001 && east <= SWISSTOPO_WMTS.east + 0.001,
        `${overlay.id}: extent must stay inside the advertised WMTS service extent`,
      );
      assert.ok(
        south >= SWISSTOPO_WMTS.south - 0.001 && north <= SWISSTOPO_WMTS.north + 0.001,
        `${overlay.id}: extent must stay inside the advertised WMTS service extent`,
      );
    }
  }
});

test('the global collection retains Swiss holdings and a usable time span', () => {
  const zurich = records.filter((r) => r.extent && r.extent.west < 8.9 && r.extent.east > 8.2 && r.extent.south < 47.6 && r.extent.north > 47.2);
  assert.ok(zurich.length >= 5, `expected several maps over the Zürich area, found ${zurich.length}`);
  const years = records.flatMap((r) => [r.yearStart, r.yearEnd]).filter(Number.isFinite);
  assert.ok(Math.max(...years) - Math.min(...years) >= 100, 'the time slider needs a usable span');
  const providersUsed = new Set(records.map((r) => r.providerId));
  assert.ok(providersUsed.size >= 1);
});

test('thumbnails are direct image services (IIIF) rather than HTML pages', () => {
  const withIiif = records.filter((r) => r.iiifManifest);
  assert.ok(withIiif.length >= 10, `expected a IIIF-backed majority, found ${withIiif.length}/${records.length}`);
  for (const record of withIiif) {
    if (!record.thumbnail) continue; // A missing thumbnail never excludes a rights-cleared scan.
    assert.ok(
      /default\.jpg|\/full\/|\.jpeg$/.test(record.thumbnail),
      `${record.id}: thumbnail should be a direct image derivative (${record.thumbnail})`,
    );
  }
});

test('international catalogue refreshes preserve existing maps and never infer footprints from place anchors', async () => {
  const { addInternationalMaps } = await import('../scripts/add-international-maps.mjs');
  const copy = structuredClone(recordsFile);
  const registry = structuredClone(sourcesFile);
  const originalMaps = copy.records.filter((record) => record.providerId !== 'loc');
  await addInternationalMaps(copy, registry);
  const first = structuredClone({ copy, registry });
  await addInternationalMaps(copy, registry);
  assert.deepEqual({ copy, registry }, first, 'repeated harvests must not duplicate maps or source entries');
  assert.deepEqual(copy.records.filter((record) => record.providerId !== 'loc'), originalMaps, 'a global refresh retains the existing collections');
  const international = copy.records.filter((record) => record.providerId === 'loc');
  assert.ok(international.some((record) => record.subjectPlace.includes('Egypt')));
  assert.ok(international.some((record) => record.subjectPlace.includes('Japan')));
  assert.ok(international.some((record) => record.subjectPlace.includes('Mexico')));
  assert.ok(international.some((record) => record.subjectPlace.includes('Brazil')));
  for (const record of international) {
    assert.equal(record.extent, null, 'an approximate place anchor is not a historical map boundary');
    assert.equal(record.depictedYearStart, null, 'publication dates do not establish depicted dates');
    assert.equal(new URL(record.metadataSource).host, 'www.loc.gov');
    if (record.geo) assert.match(record.geoNote, /Approximate place anchor/);
  }
});

test('the metadata-reuse-unresolved scopes are withheld from the shipped catalogue', async () => {
  const withheld = ['doria', 'leventhal', 'digitalcommonwealth'];
  for (const providerId of withheld) {
    assert.equal(
      records.some((record) => record.providerId === providerId),
      false,
      `${providerId}: unresolved metadata-reuse scope must not be in the shipped catalogue`,
    );
    assert.equal(
      recordsFile.shards.some((url) => url.endsWith(`/${providerId}.json`)),
      false,
      `${providerId}: shard must not be loaded`,
    );
    const provider = providerById.get(providerId);
    assert.equal(provider.bundled, false, `${providerId}: registry marks the scope not bundled`);
    assert.equal(provider.recordsBundled, 0);
    assert.equal(provider.status, 'withheld-metadata-rights');
    assert.equal(provider.metadataReuse.status, 'withheld');
    assert.match(provider.metadataReuse.decision, /no primary metadata-reuse licence|not established/i);
  }
  // Full harvested records stay in research/ for a future cleared restoration.
  const doria = await readJson('research/withheld/doria.json');
  const bpl = await readJson('research/withheld/leventhal.json');
  const partners = await readJson('research/withheld/digitalcommonwealth.json');
  assert.equal(doria.records.length, 1662);
  assert.equal(bpl.records.length, 10242);
  assert.equal(partners.records.length, 972);
  const ccBy = bpl.records.filter((record) => record.rightsBasis === 'cc-by');
  assert.equal(ccBy.length, 11);
  const sample = bpl.records.find((record) => record.id === 'leventhal:commonwealth:3f462s124');
  assert.ok(sample);
  assert.equal(sample.rightsPolicyUrl, 'https://www.digitalcommonwealth.org/copyright');
  for (const record of bpl.records) {
    assert.equal(record.rightsStatement, record.rights.replace(record.licenseStatement ?? '', '').trim(), `${record.id}: the verbatim rights statement is preserved`);
    assert.ok(record.licenseStatement, `${record.id}: the licence statement is preserved`);
    assert.match(record.metadataSource, /^https:\/\/collections\.leventhalmap\.org\/search\/commonwealth:[a-z0-9]+\.json$/);
    if (record.rightsBasis !== 'cc-by') {
      assert.equal(record.rightsUrl, undefined, `${record.id}: a no-known-copyright record must not gain an invented licence URI`);
    }
  }
  for (const record of ccBy) {
    assert.equal(record.rightsUrl, 'https://creativecommons.org/licenses/by/4.0/', `${record.id}: the item's stated licence URI`);
    assert.equal(record.licenseVersion, '4.0');
    assert.ok(record.attribution && record.attribution.length > 20, `${record.id}: the stated credit is retained`);
    assert.equal(record.rightsEvidenceSource, record.iiifManifest);
  }
});

test('the 2026-10-20 metadata-reuse decision is evidenced for shipped and withheld scopes', () => {
  const decisionNote = 'coordination/metadata-rights-decision-20261020.md';
  const withheld = ['doria', 'leventhal', 'digitalcommonwealth'];
  for (const id of withheld) {
    const provider = providerById.get(id);
    assert.equal(provider.bundled, false, `${id}: withheld scope is not bundled`);
    assert.equal(provider.metadataReuse?.status, 'withheld', `${id}: the scope stays withheld`);
    assert.equal(provider.metadataReuse.decisionNote, decisionNote, `${id}: the evidence note is linked`);
    assert.match(provider.metadataReuse.evidence, /https:\/\//, `${id}: a primary URL is retained`);
    assert.match(provider.metadataReuse.evidence, /not (?:a repository-wide metadata licence|a redistribution licence)/i, `${id}: the limit is explicit`);
  }
  const slub = providerById.get('slub').metadataReuse;
  assert.equal(slub?.status, 'basis-recorded', 'SLUB keeps the PDM basis the merged decision accepted');
  assert.equal(slub.decisionNote, decisionNote, 'SLUB links the evidence note');
  assert.ok(slub.primaryEvidence?.length >= 2, 'SLUB primary evidence is retained');
  for (const evidence of slub.primaryEvidence) {
    assert.match(evidence.url, /^https:\/\//, 'SLUB primary evidence URL');
    assert.ok(evidence.quote?.length > 20, 'SLUB primary evidence quote');
  }
  assert.ok(slub.limits?.length > 40, 'SLUB limits are explicit');
  const shipped = JSON.stringify(sourcesFile);
  assert.ok(!shipped.includes('unresolved-pending'), 'no provider metadata status stays unresolved');
});
