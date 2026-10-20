import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { usgsProductRecord, usgsExtent, usgsYear } from '../scripts/harvest-usgs.mjs';
import { rasterUrl } from '../src/worker/raster.js';
import { usgsRecord } from '../src/worker/catalogue.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const shard = JSON.parse(
  await readFile(path.join(root, 'public/data/records/usgs.json'), 'utf8'),
);

/** A real TNM Access product (fields trimmed to the ones the adapter reads). */
function product(overrides = {}) {
  return {
    sourceId: '5a8a22a4e4b00f54eb3bcf55',
    title: 'USGS 1:10000-scale Quadrangle for Adjuntas NE, PR 1947',
    metaUrl: 'https://www.sciencebase.gov/catalog/item/5a8a22a4e4b00f54eb3bcf55',
    publicationDate: '1947-01-01',
    lastUpdated: '2025-09-18T21:11:30.147-06:00',
    extent: '3.75 x 3.75 minute',
    format: 'GeoPDF, GeoTIFF',
    previewGraphicURL:
      'https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/PDF/PR/10000/PR_Adjuntas%20NE_361920_1947_10000_tn.jpg',
    urls: {
      GeoPDF:
        'https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/PDF/PR/10000/PR_Adjuntas%20NE_361920_1947_10000_geo.pdf',
      GeoTIFF:
        'https://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/GeoTIFF/PR/PR_Adjuntas%20NE_361920_1947_10000_geo.tif',
    },
    boundingBox: { minX: -66.6875, maxX: -66.625, minY: 18.1875, maxY: 18.25 },
    ...overrides,
  };
}

test('the USGS adapter keeps the original GeoTIFF as a provider-supplied raster', () => {
  const record = usgsProductRecord(product());
  assert.equal(record.id, 'usgs:5a8a22a4e4b00f54eb3bcf55');
  assert.equal(record.title, 'USGS 1:10000-scale Quadrangle for Adjuntas NE, PR 1947');
  assert.equal(record.yearStart, 1947);
  assert.equal(record.yearEnd, 1947);
  assert.equal(record.providerId, 'usgs');
  assert.equal(record.institution, 'U.S. Geological Survey');
  assert.equal(record.state, 'PR');
  assert.equal(record.scale, 10000);
  assert.match(record.rightsUrl, /copyrights-and-credits/);
  assert.match(record.rights, /Public Domain/);
  assert.deepEqual(record.extent, {
    west: -66.6875,
    east: -66.625,
    south: 18.1875,
    north: 18.25,
  });
  assert.equal(record.georeference.kind, 'cog');
  assert.equal(record.georeference.status, 'provider-supplied');
  assert.equal(
    record.georeference.url,
    product().urls.GeoTIFF,
    'the raster URL is the API-delivered GeoTIFF, not a constructed path',
  );
  assert.deepEqual(
    record.downloads.map((d) => d.label),
    ['GeoTIFF', 'GeoPDF'],
  );
  assert.match(record.geoNote, /footprint/);
});

test('a GeoPDF-only product is retained as a scan without an invented raster', () => {
  const record = usgsProductRecord(product({ urls: { GeoPDF: product().urls.GeoPDF } }));
  assert.equal(record.id, 'usgs:5a8a22a4e4b00f54eb3bcf55');
  assert.equal(record.format, 'GeoPDF');
  assert.equal(record.georeference, undefined);
  assert.deepEqual(record.downloads.map((d) => d.label), ['GeoPDF']);
  assert.equal(record.downloads[0].url, product().urls.GeoPDF);
  assert.match(record.geoNote, /GeoPDF/);
  assert.match(record.geoNote, /no pixel-to-ground transform/i);
});

test('the USGS gate never invents identity, dates or a download', () => {
  assert.equal(usgsProductRecord(product({ urls: {} })), null);
  assert.equal(usgsProductRecord(product({ sourceId: '../etc' })), null);
  assert.equal(usgsProductRecord(product({ title: '' })), null);
  assert.equal(
    usgsProductRecord(product({ metaUrl: 'https://evil.example/catalog/item/1' })),
    null,
  );
  assert.equal(
    usgsProductRecord(product({ urls: { GeoTIFF: 'http://prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/GeoTIFF/PR/x.tif' } })),
    null,
  );
  const undated = usgsProductRecord(product({ publicationDate: null }));
  assert.equal(undated.yearStart, undefined);
  assert.equal(undated.yearEnd, undefined);
  assert.equal(usgsYear('n.d.'), null);
  assert.equal(usgsExtent({ minX: 1, maxX: 1, minY: 2, maxY: 3 }), null);
});

test('the raster proxy permits only HTMC GeoTIFFs on the public USGS staging host', () => {
  const url = product().urls.GeoTIFF;
  assert.ok(rasterUrl(url));
  for (const value of [
    url.replace('prd-tnm.s3.amazonaws.com', 'evil.example'),
    url.replace('GeoTIFF', 'PDF').replace('.tif', '.pdf'),
    url.replace('https:', 'http:'),
    `${url}?x=1`,
    url.replace('/GeoTIFF/', '/GeoTIFF/../private/'),
    url.replace('/GeoTIFF/', '/other/'),
  ])
    assert.equal(rasterUrl(value), null, value);
});

test('the live-search USGS record also exposes the GeoTIFF georeference', () => {
  const record = usgsRecord(product());
  assert.equal(record.id, 'usgs:5a8a22a4e4b00f54eb3bcf55');
  assert.equal(record.georeference.kind, 'cog');
  assert.equal(record.georeference.url, product().urls.GeoTIFF);
  assert.match(record.rights, /public domain/i);
  const footprintOnly = usgsRecord(product({ urls: {} }));
  assert.equal(footprintOnly.georeference, undefined);
});

test('the bundled USGS shard is provenance-complete and internally consistent', () => {
  assert.ok(Array.isArray(shard.records) && shard.records.length >= 5000);
  assert.equal(shard.providerId, 'usgs');
  const selection = shard.selection;
  assert.ok(selection.upstreamTotal >= 186000);
  assert.ok(selection.resumable.nextOffset >= 6000);
  assert.equal(selection.dateEvidence.titleEditionYearMismatches, 0);
  assert.ok(
    selection.dateEvidence.mergedRecordsChecked >= shard.records.length,
    'the date evidence covers the whole merged USGS range, not only this shard or the last slice',
  );
  assert.ok(selection.verification.previewOk >= 8);
  assert.ok(selection.verification.rasterRangeOk >= 8);
  assert.ok(selection.verification.rasterReadable >= 8);
  assert.ok(selection.verification.rasterCrsOk >= 8);
  assert.ok(selection.verification.pdfRangeOk >= 1);
  assert.ok(selection.verification.pdfMagic >= 1);
  assert.ok(selection.geopdfOnlyKept >= 1);
  const ids = new Set();
  for (const record of shard.records) {
    assert.match(record.id, /^usgs:[A-Za-z0-9._-]+$/);
    assert.ok(!ids.has(record.id), `duplicate ${record.id}`);
    ids.add(record.id);
    assert.equal(record.providerId, 'usgs');
    assert.equal(record.rightsUrl, selection.rightsBasis.includes('copyrights-and-credits') ? record.rightsUrl : null);
    assert.match(record.rightsUrl, /usgs\.gov\/information-policies/);
    assert.match(record.recordUrl, /^https:\/\/www\.sciencebase\.gov\/catalog\/item\//);
    if (record.georeference) {
      assert.equal(record.georeference.kind, 'cog');
      assert.equal(record.recordUrl, record.georeference.source);
      assert.ok(rasterUrl(record.georeference.url), record.id);
    } else {
      assert.equal(record.format, 'GeoPDF');
      assert.ok(
        record.downloads?.some(
          (download) =>
            download.label === 'GeoPDF' &&
            /^https:\/\/prd-tnm\.s3\.amazonaws\.com\/StagedProducts\/Maps\/HistoricalTopo\/PDF\/.+\.pdf$/.test(
              download.url,
            ),
        ),
        record.id,
      );
    }
    if (record.yearStart != null) {
      assert.ok(record.yearStart >= 1800 && record.yearStart <= 2100);
      const printed = record.title.match(/\b(1[5-9]\d{2}|20\d{2})\s*$/)?.[1];
      if (printed) assert.equal(Number(printed), record.yearStart);
    }
    if (record.extent)
      assert.ok(
        record.extent.west < record.extent.east &&
          record.extent.south < record.extent.north,
      );
  }
});

test('the USGS prefix is split across registered shards without duplicates', async () => {
  const core = JSON.parse(
    await readFile(path.join(root, 'public/data/records.json'), 'utf8'),
  );
  const urls = (core.shards ?? []).filter((url) =>
    /^\/data\/records\/usgs(?:-\d+)?\.json$/.test(url),
  );
  assert.deepEqual(urls, [
    '/data/records/usgs-2.json',
    '/data/records/usgs-3.json',
    '/data/records/usgs.json',
  ]);
  const ids = new Set();
  let total = 0;
  for (const url of urls) {
    const doc = JSON.parse(
      await readFile(path.join(root, 'public', url.replace(/^\//, '')), 'utf8'),
    );
    const bytes = Buffer.byteLength(JSON.stringify(doc));
    assert.ok(bytes < 24 * 1048576, `${url} is ${bytes} B`);
    for (const record of doc.records) {
      assert.ok(!ids.has(record.id), `duplicate ${record.id} in ${url}`);
      ids.add(record.id);
      assert.equal(record.providerId, 'usgs');
      if (record.georeference) {
        assert.equal(record.georeference.kind, 'cog');
        assert.ok(rasterUrl(record.georeference.url), record.id);
      } else {
        assert.equal(record.format, 'GeoPDF');
        assert.ok(record.downloads?.some((download) => download.label === 'GeoPDF'));
      }
    }
    total += doc.records.length;
  }
  assert.equal(core.selection['usgs:htmc'].totalAfterMerge, total);
  assert.equal(core.selection['usgs:htmc'].resumable.nextOffset, 24000);
  assert.equal(core.selection['usgs:htmc'].dateEvidence.mergedRecordsChecked, total);
});
