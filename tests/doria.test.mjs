/**
 * Doria / National Library of Finland harvest regressions.
 *
 * The live feed is three OAI-PMH formats (oai_dc, mods, ore). These tests pin
 * the parser, the rights gate and the no-invention rules so a future refresh
 * cannot silently admit an uncleared scan or invent a date/extent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  englishSetName,
  parseDc,
  parseMods,
  parseOre,
  publicationYears,
  recordFrom,
  rightsGate,
} from '../scripts/harvest-doria.mjs';

const dcRecord = `<record><header><identifier>oai:www.doria.fi:10024/31270</identifier>
<setSpec>com_10024_109232</setSpec><setSpec>com_10024_97216</setSpec></header><metadata>
<oai_dc:dc><dc:title>Karta öfver slädfärden</dc:title><dc:creator>Nordenskiöld, Adolf Erik</dc:creator>
<dc:date>2014-11-25T13:23:21Z</dc:date><dc:date>1885</dc:date><dc:type>map</dc:type>
<dc:language>swe</dc:language><dc:publisher>[Stockholm]</dc:publisher>
<dc:rights>Public Domain</dc:rights><dc:rights>http://creativecommons.org/publicdomain/mark/1.0/deed.fi</dc:rights>
<dc:identifier>http://www.doria.fi/handle/10024/31270</dc:identifier>
<dc:identifier>URN:NBN:fi-fe201205105537</dc:identifier></oai_dc:dc></metadata></record>`;

const modsRecord = `<record><header><identifier>oai:www.doria.fi:10024/31270</identifier></header><metadata>
<mods:mods><mods:titleInfo><mods:title>Karta öfver slädfärden</mods:title></mods:titleInfo>
<mods:name><mods:namePart>Nordenskiöld, Adolf Erik</mods:namePart></mods:name>
<mods:originInfo><mods:dateIssued>1885</mods:dateIssued></mods:originInfo>
<mods:accessCondition type="useAndReproduction">http://creativecommons.org/publicdomain/mark/1.0/deed.fi</mods:accessCondition>
<mods:accessCondition type="useAndReproduction">Public Domain</mods:accessCondition>
<mods:extension><mods:dateAccessioned>2014-11-25T13:23:21Z</mods:dateAccessioned></mods:extension></mods:mods></metadata></record>`;

const oreRecord = `<record><header><identifier>oai:www.doria.fi:10024/31270</identifier></header><metadata>
<atom:entry><rdf:Description rdf:about="https://www.doria.fi/bitstream/10024/31270/2/Nord-ost_Land.jpg.jpg">
<dcterms:description>THUMBNAIL</dcterms:description></rdf:Description>
<rdf:Description rdf:about="https://www.doria.fi/bitstream/10024/31270/1/Nord-ost_Land.jpg">
<dcterms:description>ORIGINAL</dcterms:description></rdf:Description>
<rdf:Description rdf:about="https://www.doria.fi/bitstream/10024/31270/3/Nord-ost%20Land.tif">
<dcterms:description>ORIGINAL</dcterms:description></rdf:Description>
<atom:link rel="http://www.openarchives.org/ore/terms/aggregates" href="https://www.doria.fi/bitstream/10024/31270/1/Nord-ost_Land.jpg" type="image/jpeg" />
<atom:link rel="http://www.openarchives.org/ore/terms/aggregates" href="https://www.doria.fi/bitstream/10024/31270/3/Nord-ost%20Land.tif" type="image/tiff" />
</atom:entry></metadata></record>`;

test('Doria oai_dc/mods parsers keep the published facts', () => {
  const dc = parseDc(dcRecord);
  assert.equal(dc.id, '31270');
  assert.equal(dc.titles[0], 'Karta öfver slädfärden');
  assert.equal(dc.types[0], 'map');
  assert.deepEqual(dc.setSpecs, ['com_10024_109232', 'com_10024_97216']);
  const mods = parseMods(modsRecord);
  assert.equal(mods.dateIssued[0], '1885');
  assert.ok(mods.access.includes('Public Domain'));
});

test('Doria ORE parser separates thumbnails, images and PDF documents', () => {
  const ore = parseOre(oreRecord);
  assert.equal(ore.thumbnail, 'https://www.doria.fi/bitstream/10024/31270/2/Nord-ost_Land.jpg.jpg');
  assert.deepEqual(ore.bitstreams.map((b) => b.kind), ['THUMBNAIL', 'ORIGINAL', 'ORIGINAL']);
  assert.equal(ore.bitstreams.find((b) => b.kind === 'ORIGINAL' && b.url.endsWith('.jpg')).mime, 'image/jpeg');
  assert.equal(ore.bitstreams.find((b) => b.url.endsWith('.tif')).mime, 'image/tiff');
});

test('publicationYears keeps a narrow range and does not invent a depicted date', () => {
  assert.deepEqual(publicationYears('1885'), { start: 1885, end: 1885 });
  assert.deepEqual(publicationYears('1855-1856'), { start: 1855, end: 1856 });
  assert.equal(publicationYears('no date'), null);
  // A long list of unrelated years is not treated as one publication range.
  assert.deepEqual(publicationYears('2014 1885 1900 1930'), { start: 2014, end: 2014 });
});

test('rights gate accepts explicit PDM/CC0 but rejects restrictive or unknown statements', () => {
  assert.deepEqual(rightsGate(['Public Domain', 'http://creativecommons.org/publicdomain/mark/1.0/deed.fi']), {
    basis: 'pdm',
    licence: 'https://creativecommons.org/publicdomain/mark/1.0/',
    rights: ['Public Domain', 'http://creativecommons.org/publicdomain/mark/1.0/deed.fi'],
  });
  assert.equal(rightsGate(['Public Domain', 'https://creativecommons.org/publicdomain/zero/1.0/']).basis, 'cc0');
  assert.equal(rightsGate(['Public domain']).basis, 'public-domain-statement');
  assert.equal(rightsGate(['Public Domain', 'All rights reserved']).basis, null);
  assert.equal(rightsGate(['Copyright not evaluated']).basis, null);
  assert.equal(rightsGate([]).basis, null);
  // A CC0 URI on the same line does not cancel an explicit restriction.
  assert.equal(rightsGate(['https://creativecommons.org/publicdomain/zero/1.0/ ; All rights reserved.']).basis, null);
  assert.equal(rightsGate(['Public Domain ; This work is non-commercial; all rights reserved.']).basis, null);
});

test('a CC0 legal waiver is not mistaken for a restriction', () => {
  const waiver =
    'The National Library of Finland has dedicated the work to the public domain by waiving all rights worldwide under copyright law. ' +
    'http://creativecommons.org/publicdomain/zero/1.0/';
  assert.equal(rightsGate([waiver]).basis, 'cc0');
});

test('recordFrom retains verbatim metadata and admits PDF-only works through their preview', () => {
  const dc = parseDc(dcRecord);
  const mods = parseMods(modsRecord);
  const ore = parseOre(oreRecord);
  const { record } = recordFrom({ id: '31270', dc, mods, ore }, {
    sets: new Map([['com_10024_97216', 'fi=A. E. Nordenskiöldin karttakokoelma|en=The Nordenskiöld Map Collection|']]),
  });
  assert.equal(record.id, 'doria:31270');
  assert.equal(record.title, 'Karta öfver slädfärden');
  assert.equal(record.institution, 'National Library of Finland (Kansalliskirjasto)');
  assert.equal(record.collection, 'The Nordenskiöld Map Collection');
  assert.equal(record.rightsBasis, 'pdm');
  assert.equal(record.yearStart, 1885);
  assert.equal(record.thumbnail, 'https://www.doria.fi/bitstream/10024/31270/2/Nord-ost_Land.jpg.jpg');
  assert.equal(record.imageUrl, 'https://www.doria.fi/bitstream/10024/31270/1/Nord-ost_Land.jpg');
  assert.equal(record.geoNote.includes('no map extent'), true);
  assert.equal(record.extent, undefined);
  assert.equal(record.creators[0], 'Nordenskiöld, Adolf Erik');
});

test('recordFrom withholds non-maps, missing images and uncleared rights', () => {
  const base = { id: '31270', dc: parseDc(dcRecord), mods: parseMods(modsRecord), ore: parseOre(oreRecord) };
  assert.equal(recordFrom({ ...base, dc: { ...base.dc, types: ['image'] } }).record, null);
  assert.equal(recordFrom({ ...base, ore: { thumbnail: null, bitstreams: [] } }).record, null);
  assert.equal(recordFrom({ ...base, dc: { ...base.dc, rights: ['All rights reserved'] }, mods: { ...base.mods, access: [] } }).record, null);
  assert.equal(recordFrom({ ...base, dc: { ...base.dc, rights: ['Public Domain ; All rights reserved.'] } }).record, null);
});

test('a missing Doria thumbnail does not exclude a rights-cleared original scan', () => {
  const base = { id: '31270', dc: parseDc(dcRecord), mods: parseMods(modsRecord), ore: parseOre(oreRecord) };
  // An original JPEG is a truthful preview when the repository omits its thumbnail.
  const jpegOnly = recordFrom({ ...base, ore: { thumbnail: null, bitstreams: base.ore.bitstreams.filter((b) => b.url.endsWith('.jpg')) } }).record;
  assert.ok(jpegOnly);
  assert.equal(jpegOnly.thumbnail, 'https://www.doria.fi/bitstream/10024/31270/1/Nord-ost_Land.jpg');
  assert.equal(jpegOnly.imageUrl, jpegOnly.thumbnail);
  // A PDF-only work keeps its document link and no invented image thumbnail.
  const pdf = '<record><metadata><atom:entry><rdf:Description rdf:about="https://www.doria.fi/bitstream/10024/31270/4/map.pdf"><dcterms:description>ORIGINAL</dcterms:description></rdf:Description><atom:link rel="http://www.openarchives.org/ore/terms/aggregates" href="https://www.doria.fi/bitstream/10024/31270/4/map.pdf" type="application/pdf" /></atom:entry></metadata></record>';
  const pdfOnly = recordFrom({ ...base, ore: parseOre(pdf) }).record;
  assert.ok(pdfOnly);
  assert.equal(pdfOnly.thumbnail, undefined);
  assert.deepEqual(pdfOnly.documents, ['https://www.doria.fi/bitstream/10024/31270/4/map.pdf']);
});

test('englishSetName reads the official English set label', () => {
  assert.equal(englishSetName('fi=Kartat|sv=Kartor|en=Maps|'), 'Maps');
  assert.equal(englishSetName('fi=A. E. Nordenskiöldin karttakokoelma|sv=X|en=The Nordenskiöld Map Collection|'), 'The Nordenskiöld Map Collection');
  assert.equal(englishSetName('Kartat'), 'Kartat');
});
