import assert from 'node:assert/strict';
import test from 'node:test';
import { eligibleRights, mergeRecords, parseOaiRecord, parseYear, recordFromManifest } from '../scripts/erara-depth.mjs';

const oai = `<record><header><identifier>oai:www.e-rara.ch:6484199</identifier><setSpec>zut</setSpec><setSpec>landkarten</setSpec></header><metadata><oai_dc:dc>
<dc:title>[Reisekarte der Schweiz]</dc:title><dc:creator>Keller, Heinrich</dc:creator>
<dc:date>1813</dc:date><dc:language>ger</dc:language><dc:rights>PDM 1.0</dc:rights>
<dc:identifier>https://www.e-rara.ch/doi/10.3931/e-rara-20661</dc:identifier><dc:type>Image</dc:type><dc:type>Map</dc:type>
</oai_dc:dc></metadata></record>`;

const manifest = {
  label: '[Reisekarte der Schweiz]',
  license: 'https://creativecommons.org/publicdomain/mark/1.0/deed.de',
  metadata: [
    { label: 'Impressum', value: '[Zürich] : [Fuessli & Comp.], [1813]' },
    { label: 'Kartendaten', value: "[Ca. 1:500 000] (E 5°57'-E 10°30'/N 47°48'-N 45°48')" },
    { label: 'Besitzende Institution', value: 'ETH-Bibliothek Zürich, Rar K 294' },
  ],
  thumbnail: { '@id': 'https://www.e-rara.ch/i3f/v21/6484202/full/304/0/default.jpg' },
  sequences: [{ canvases: [{ images: [{ resource: { service: { '@id': 'https://www.e-rara.ch/i3f/v20/6484201' } } }] }] }],
};

test('parses the e-rara OAI record verbatim', () => {
  const c = parseOaiRecord(oai);
  assert.equal(c.titleId, '6484199');
  assert.equal(c.title, '[Reisekarte der Schweiz]');
  assert.equal(c.year, 1813);
  assert.equal(c.doi, 'https://www.e-rara.ch/doi/10.3931/e-rara-20661');
  assert.equal(c.isMap, true);
  assert.deepEqual(c.setSpecs, ['zut', 'landkarten']);
});

test('only explicit public-domain rights pass the gate', () => {
  assert.equal(eligibleRights('PDM 1.0'), true);
  assert.equal(eligibleRights('https://creativecommons.org/publicdomain/zero/1.0/'), true);
  assert.equal(eligibleRights('No known copyright restrictions.'), false);
  assert.equal(eligibleRights('Rights status not evaluated.'), false);
  assert.equal(eligibleRights('In Copyright'), false);
  assert.equal(eligibleRights(''), false);
});

test('builds a record from the manifest, including its stated bbox', () => {
  const { record } = recordFromManifest(manifest, parseOaiRecord(oai));
  assert.equal(record.id, 'e-rara:6484199');
  assert.equal(record.institution, 'ETH-Bibliothek Zürich');
  assert.equal(record.shelfmark, 'Rar K 294');
  assert.equal(record.yearStart, 1813);
  assert.equal(record.extent.west, 5.95);
  assert.equal(record.extent.east, 10.5);
  assert.equal(record.extent.south, 45.8);
  assert.ok(record.geo.lat > 45 && record.geo.lat < 48);
  assert.equal(record.languages[0], 'German');
  assert.match(record.rights, /PDM/);
});

test('withholds a manifest without explicit rights or a stated institution', () => {
  assert.match(recordFromManifest({ ...manifest, license: 'All rights reserved' }, { ...parseOaiRecord(oai), rights: '' }).reason, /rights/);
  const noInstitution = { ...manifest, metadata: manifest.metadata.filter((m) => m.label !== 'Besitzende Institution') };
  assert.match(recordFromManifest(noInstitution, { ...parseOaiRecord(oai), setSpecs: [] }).reason, /holding library/);
});

test('deduplicates and never replaces an existing record', () => {
  const doc = { records: [{ id: 'e-rara:1', title: 'old' }] };
  const added = mergeRecords(doc, [
    { id: 'e-rara:1', title: 'replacement' },
    { id: 'e-rara:2', title: 'new' },
  ]);
  assert.deepEqual(added.map((r) => r.id), ['e-rara:2']);
  assert.equal(doc.records[0].title, 'old');
  assert.equal(doc.records.length, 2);
});

test('parses the publication year only when stated', () => {
  assert.equal(parseYear('1813'), 1813);
  assert.equal(parseYear('[zwischen 1800 und 1810?]'), 1800);
  assert.equal(parseYear('189u'), null);
  assert.equal(parseYear('undated'), null);
});

test('rewrites the cursor of an e-rara resumption token without touching its opaque state', async () => {
  const { cursorToken } = await import('../scripts/erara-depth.mjs');
  const token = '0x02b2fa923441d371c66feb4cd116b626-cursor_p_3D10_p_26set_p_3Dlandkarten_p_26metadataPrefix_p_3Doai_dc_p_26batch_size_p_3D11';
  const moved = cursorToken(token, 1440);
  assert.match(moved, /^0x02b2fa923441d371c66feb4cd116b626-/);
  assert.match(moved, /cursor_p_3D1440_p_26set_p_3Dlandkarten/);
  assert.equal(cursorToken('opaque-without-cursor', 10), null);
});

test('does not hide a restrictive statement behind an open one', () => {
  const candidate = parseOaiRecord(oai);
  const restricted = recordFromManifest({ ...manifest, license: 'All rights reserved' }, candidate);
  assert.equal(restricted.record, null);
  assert.match(restricted.reason, /manifest image rights/);
  const openBoth = recordFromManifest({ ...manifest, license: 'https://creativecommons.org/publicdomain/zero/1.0/' }, candidate);
  assert.equal(openBoth.record.rights, 'PDM 1.0');
  assert.match(openBoth.record.manifestRights, /zero\/1\.0/);
});

test('never synthesises a DOI from a title id', () => {
  const noDoi = { ...parseOaiRecord(oai), doi: null };
  const { record } = recordFromManifest(manifest, noDoi);
  assert.equal(record.recordUrl, 'https://www.e-rara.ch/zut/content/titleinfo/6484199');
  assert.doesNotMatch(record.recordUrl, /doi\.org/);
});

test('derives an IIIF thumbnail from the image service when the manifest omits one', () => {
  const { record } = recordFromManifest({ ...manifest, thumbnail: undefined }, parseOaiRecord(oai));
  assert.equal(record.thumbnail, 'https://www.e-rara.ch/i3f/v20/6484201/full/304/0/default.jpg');
  const noImage = recordFromManifest(
    { ...manifest, thumbnail: undefined, sequences: [] },
    parseOaiRecord(oai),
  );
  assert.equal(noImage.record, null);
  assert.match(noImage.reason, /preview or image service/);
});
