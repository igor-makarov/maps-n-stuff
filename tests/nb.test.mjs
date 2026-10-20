/**
 * National Library of Norway (Nasjonalbiblioteket) map-lane tests.
 *
 * The lane's contract is narrower than the API: only item-level Public Domain
 * objects with everywhere access are imported, and no extent/alignment is
 * inferred from a place string. These tests exercise the gate and the shipped
 * shard without weakening another provider's withheld-scope tests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCatalogue } from '../scripts/catalogue.mjs';
import { admitItem, apiUrl, nbRecord, publicationYear, YEAR_WINDOWS } from '../scripts/harvest-nb.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = async (rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));

const pdItem = {
  id: 'fixture-nb-pd',
  accessInfo: {
    accessAllowedFrom: 'EVERYWHERE',
    isDigital: true,
    isPublicDomain: true,
    license: 'publicdomain',
    viewability: 'ALL',
    accessInfoLastModified: '2026-01-02T03:04:05Z',
  },
  _links: {
    thumbnail_large: {
      href: 'https://www.nb.no/services/image/resolver/URN:NBN:no-nb_digikart_fixture_0001_F_01/full/0,200/0/native.jpg',
    },
  },
  metadata: {
    title: 'Kart over Christiania',
    creators: ['Münzer, Hieronymus', 'Münzer, Hieronymus'],
    languages: [{ code: 'nob' }],
    originInfo: { issued: '18500412', issuedUntouched: '[1850]' },
    originInfoTypes: [{ placeTerms: ['Christiania'], publisher: '[utgiver ikke identifisert]' }],
    geographic: { placeString: 'Norge - Oslo' },
    identifiers: { urn: 'URN:NBN:no-nb_digikart_fixture', oaiId: 'oai:nb.bibsys.no:fixture' },
    physicalDescription: { extent: '1 kart' },
    subject: { topics: ['Oslo'], geographics: ['Norge'] },
  },
};

test('publicationYear reads the first plausible catalogue year and rejects nonsense', () => {
  assert.equal(publicationYear('18500412'), 1850);
  assert.equal(publicationYear('[1482?]'), 1482);
  assert.equal(publicationYear('1945'), 1945);
  assert.equal(publicationYear('uten år'), null);
  assert.equal(publicationYear('999'), null);
  assert.equal(publicationYear('2101'), null);
});

test('the item-level Public Domain gate rejects copyrighted, on-site, and non-digital records', () => {
  assert.equal(admitItem(pdItem).ok, true);
  const copyrighted = structuredClone(pdItem);
  copyrighted.accessInfo.license = 'copyrighted';
  copyrighted.accessInfo.isPublicDomain = false;
  assert.deepEqual(admitItem(copyrighted), { ok: false, reason: 'not-public-domain' });

  const nc = structuredClone(pdItem);
  nc.accessInfo.license = 'ccbync';
  assert.deepEqual(admitItem(nc), { ok: false, reason: 'licence:ccbync' });

  const onSite = structuredClone(pdItem);
  onSite.accessInfo.accessAllowedFrom = 'NB';
  assert.deepEqual(admitItem(onSite), { ok: false, reason: 'access:NB' });

  const notDigital = structuredClone(pdItem);
  notDigital.accessInfo.isDigital = false;
  assert.deepEqual(admitItem(notDigital), { ok: false, reason: 'not-digital' });

  const untitled = structuredClone(pdItem);
  untitled.metadata.title = '';
  assert.deepEqual(admitItem(untitled), { ok: false, reason: 'no-title' });

  const deposit = structuredClone(pdItem);
  deposit.accessInfo.legalDepositReservationStatus = 'reserved';
  assert.deepEqual(admitItem(deposit), { ok: false, reason: 'legal-deposit-reservation' });
});

test('nbRecord keeps verbatim catalogue facts and does not invent extent or alignment', () => {
  const { record, reason } = nbRecord(pdItem);
  assert.equal(reason, undefined);
  assert.equal(record.id, 'nb:fixture-nb-pd');
  assert.equal(record.title, 'Kart over Christiania');
  assert.deepEqual(record.creators, ['Münzer, Hieronymus']);
  assert.equal(record.institution, 'National Library of Norway (Nasjonalbiblioteket)');
  assert.equal(record.yearStart, 1850);
  assert.equal(record.yearEnd, 1850);
  assert.equal(record.rightsBasis, 'publicdomain');
  assert.equal(record.rightsUrl, 'https://www.nb.no/lisens/#public-domain');
  assert.equal(record.recordUrl, 'https://www.nb.no/items/fixture-nb-pd');
  assert.equal(record.iiifManifest, 'https://api.nb.no/catalog/v1/iiif/fixture-nb-pd/manifest');
  assert.equal(record.thumbnail, pdItem._links.thumbnail_large.href);
  assert.equal(
    record.imageService,
    'https://www.nb.no/services/image/resolver/URN:NBN:no-nb_digikart_fixture_0001_F_01',
  );
  assert.equal(record.urn, 'URN:NBN:no-nb_digikart_fixture');
  assert.equal(record.place, 'Norge - Oslo ; Christiania');
  assert.equal(record.publisher, '[utgiver ikke identifisert]');
  assert.deepEqual(record.languages, ['nob']);
  assert.equal(record.extent, undefined);
  assert.equal(record.geo, undefined);
  assert.equal(record.georeference, undefined);
  assert.match(record.geoNote, /No map extent, projection, georeference or alignment/);
});

test('the API query uses documented filters and bounded year windows', () => {
  const url = new URL(apiUrl(YEAR_WINDOWS[0], 0));
  assert.equal(url.hostname, 'api.nb.no');
  assert.equal(url.pathname, '/catalog/v1/items');
  assert.deepEqual(url.searchParams.getAll('filter'), [
    'mediatype:kart',
    `year:[${YEAR_WINDOWS[0][0]} TO ${YEAR_WINDOWS[0][1]}]`,
  ]);
  assert.equal(url.searchParams.get('sort'), 'date,asc');
  assert.equal(url.searchParams.get('size'), '100');
  assert.ok(YEAR_WINDOWS.every(([from, to]) => from < to));
});

test('the bundled NB shard is provenance-complete, deduplicated and PD-only', async () => {
  const shard = await readJson('public/data/records/nb.json');
  const catalogue = await readCatalogue(path.join(root, 'public/data'));
  const records = catalogue.records.filter((record) => record.providerId === 'nb');
  assert.equal(records.length, shard.records.length);
  assert.ok(records.length > 1000, `expected a substantial PD import, found ${records.length}`);
  assert.equal(records.length, catalogue.core.selection['nb:kart'].kept);

  const ids = new Set();
  for (const record of records) {
    assert.match(record.id, /^nb:[0-9a-f]{32}$/);
    assert.ok(!ids.has(record.id), `${record.id}: duplicate`);
    ids.add(record.id);
    assert.equal(record.rightsBasis, 'publicdomain');
    assert.equal(record.rightsUrl, 'https://www.nb.no/lisens/#public-domain');
    assert.equal(record.institution, 'National Library of Norway (Nasjonalbiblioteket)');
    assert.ok(record.recordUrl.startsWith('https://www.nb.no/items/'));
    assert.ok(record.iiifManifest.startsWith('https://api.nb.no/catalog/v1/iiif/'));
    if (record.thumbnail) assert.ok(record.thumbnail.startsWith('https://www.nb.no/services/image/resolver/'));
    assert.equal(record.extent, undefined);
    assert.equal(record.georeference, undefined);
    if (record.yearStart != null) {
      assert.ok(record.yearStart >= 1400 && record.yearEnd <= 2026);
      assert.ok(record.yearStart <= record.yearEnd);
    }
  }
  assert.ok(ids.has('nb:35db84b72dbb743635fd966f9e5ac0d3'), 'stable verified example is retained');
  const example = records.find((record) => record.id === 'nb:35db84b72dbb743635fd966f9e5ac0d3');
  assert.equal(example.title, '[Kart over Europa]');
  assert.equal(example.yearStart, 1500);
  assert.ok(example.creators.includes('Münzer, Hieronymus'));
});

test('the NB provider records the item-level rights basis and withholds copyrighted scopes', async () => {
  const sources = await readJson('public/data/sources.json');
  const provider = sources.providers.find((entry) => entry.id === 'nb');
  assert.ok(provider);
  assert.equal(provider.metadataReuse.status, 'basis-recorded');
  assert.equal(provider.rightsPolicyUrl, undefined);
  assert.equal(provider.terms, 'https://www.nb.no/tilgang/lisens/');
  assert.match(provider.rights, /Item-level Public Domain only/);
  assert.ok(provider.api.documentation.startsWith('https://api.nb.no/'));
  assert.ok(Array.isArray(provider.verification) && provider.verification.length >= 8);
  assert.ok(provider.verification.every((sample) => sample.manifest?.license === 'https://www.nb.no/lisens/#public-domain'));
  assert.ok(provider.verification.every((sample) => sample.thumbnail?.jpeg === true));
});
