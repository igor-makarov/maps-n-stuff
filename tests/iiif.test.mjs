/**
 * Unit tests for public/app/iiif.js — the pure IIIF helpers behind the detail
 * viewer (parsing Presentation 2 and 3, image request URLs, view-box maths).
 *
 * The fixtures are *labelled* minimal manifests written by hand for these tests;
 * they are deliberately not presented as collection data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_OUTPUT_WIDTH,
  boundsForCanvas,
  clampView,
  coupledView,
  describeUpstreamError,
  eRaraTitleId,
  eRaraViewerUrl,
  formatCompareViews,
  formatViewParam,
  fullImageUrl,
  imageRequestUrl,
  labelText,
  panView,
  parseManifest,
  parseMetadata,
  parseCompareViews,
  parseViewParam,
  regionRequest,
  serviceId,
  sheetOptionLabel,
  sheetThumbUrl,
  extentToView,
  intersectExtents,
  viewForCanvas,
  viewToExtent,
  zoomPercent,
  zoomView,
} from '../public/app/iiif.js';

/* --------------------------------------------------------------- fixtures */

const V2 = {
  '@context': 'http://iiif.io/api/presentation/2/context.json',
  '@id': 'https://www.e-rara.ch/i3f/v20/999/manifest',
  '@type': 'sc:Manifest',
  label: 'Testblatt (Fixture)',
  attribution: 'e-rara, the platform for digitized rare books from Swiss institutions',
  license: 'http://creativecommons.org/publicdomain/mark/1.0/',
  seeAlso: { format: 'application/xml', '@id': 'https://www.e-rara.ch/oai?verb=GetRecord&metadataPrefix=mets&identifier=999' },
  metadata: [
    { label: 'Titel', value: 'Testblatt' },
    { label: 'Holding institution', value: 'Zentralbibliothek Zürich' },
  ],
  sequences: [
    {
      '@type': 'sc:Sequence',
      canvases: [
        {
          '@id': 'https://www.e-rara.ch/i3f/v20/999/canvas/1001',
          '@type': 'sc:Canvas',
          label: '[1]',
          width: 4000,
          height: 6000,
          images: [
            {
              '@type': 'oa:Annotation',
              resource: {
                '@id': 'https://www.e-rara.ch/download/webcache/1000/1001',
                '@type': 'dctypes:Image',
                format: 'image/jpeg',
                width: 1000,
                height: 1500,
                service: { '@id': 'https://www.e-rara.ch/i3f/v20/1001', profile: 'http://iiif.io/api/image/2/level2.json' },
              },
            },
          ],
        },
        {
          '@id': 'https://www.e-rara.ch/i3f/v20/999/canvas/1002',
          label: { de: ['Beiblatt'] },
          width: 4000,
          height: 3000,
          images: [{ resource: { 'service': [{ '@id': 'https://www.e-rara.ch/i3f/v20/1002/' }] } }],
        },
      ],
    },
  ],
};

const V3 = {
  '@context': 'http://iiif.io/api/presentation/3/context.json',
  id: 'https://example.org/iiif/3/abc/manifest',
  type: 'Manifest',
  label: { de: ['Blatt aus einem Kantonsatlas'], none: ['Sheet'] },
  items: [
    {
      id: 'https://example.org/iiif/3/abc/canvas/1',
      type: 'Canvas',
      width: 2000,
      height: 1500,
      items: [
        {
          id: 'https://example.org/iiif/3/abc/canvas/1/page',
          type: 'AnnotationPage',
          items: [
            {
              id: 'https://example.org/iiif/3/abc/annotation/1',
              type: 'Annotation',
              body: {
                id: 'https://example.org/iiif/3/abc/full/max/0/default.jpg',
                type: 'Image',
                width: 2000,
                height: 1500,
                service: [{ id: 'https://example.org/iiif/image/abc', type: 'ImageService3', profile: 'level2' }],
              },
            },
          ],
        },
      ],
      thumbnail: [{ id: 'https://example.org/iiif/image/abc/full/200,/0/default.jpg' }],
    },
  ],
};

/* ------------------------------------------------------------------ labels */

test('labelText flattens strings, arrays and language maps', () => {
  assert.equal(labelText('[1]'), '[1]');
  assert.equal(labelText({ de: ['Beiblatt'] }), 'Beiblatt');
  assert.equal(labelText({ en: 'Sheet', de: ['Blatt'] }), 'Sheet', 'English is preferred');
  assert.equal(labelText({ fr: ['Feuille'] }), 'Feuille', 'falls back to the first language');
  assert.equal(labelText(undefined), null);
  assert.equal(labelText('   '), null, 'empty labels are null, not invented');
});

test('serviceId accepts object, array and string forms and strips slashes', () => {
  assert.equal(serviceId({ '@id': 'https://a.example/iiif/1/' }), 'https://a.example/iiif/1');
  assert.equal(serviceId([{ id: 'https://b.example/iiif/2' }]), 'https://b.example/iiif/2');
  assert.equal(serviceId('https://c.example/iiif/3'), 'https://c.example/iiif/3');
  assert.equal(serviceId([]), null);
  assert.equal(serviceId(null), null);
});

/* --------------------------------------------------------------- manifest */

test('parseManifest reads a Presentation 2.0 manifest (e-rara shape)', () => {
  const m = parseManifest(V2);
  assert.equal(m.version, 2);
  assert.equal(m.label, 'Testblatt (Fixture)');
  assert.match(m.license, /publicdomain/);
  assert.match(m.seeAlso, /metadataPrefix=mets/);
  assert.equal(m.metadata.length, 2);
  assert.equal(m.canvases.length, 2);

  const [first, second] = m.canvases;
  assert.equal(first.label, '[1]');
  assert.equal(first.width, 4000, 'canvas size is the full-resolution sheet');
  assert.equal(first.height, 6000);
  assert.equal(first.service, 'https://www.e-rara.ch/i3f/v20/1001');
  assert.equal(first.imageUrl, 'https://www.e-rara.ch/download/webcache/1000/1001', 'the provider derivative stays untouched');
  assert.equal(second.label, 'Beiblatt');
  assert.equal(second.service, 'https://www.e-rara.ch/i3f/v20/1002', 'array service form is supported');
  assert.equal(second.thumbnail, null, 'no thumbnail in the fixture → null, not a guess');
});

test('parseManifest reads a Presentation 3.0 manifest', () => {
  const m = parseManifest(V3);
  assert.equal(m.version, 3);
  assert.equal(m.label, 'Sheet');
  const [canvas] = m.canvases;
  assert.equal(canvas.service, 'https://example.org/iiif/image/abc');
  assert.equal(canvas.thumbnail, 'https://example.org/iiif/image/abc/full/200,/0/default.jpg');
  assert.equal(canvas.width, 2000);
});

test('parseManifest rejects things that are not usable manifests', () => {
  assert.throws(() => parseManifest(null), /No IIIF manifest/);
  assert.throws(() => parseManifest({ '@type': 'sc:Collection' }), /no image pages/);
  assert.throws(() => parseManifest({ sequences: [{ canvases: [] }] }), /no usable image pages/);
});

test('parseMetadata keeps verbatim pairs and drops incomplete rows', () => {
  assert.deepEqual(parseMetadata([{ label: 'Titel', value: 'X' }, { label: 'Leer', value: '' }, null]), [
    { label: 'Titel', value: 'X' },
  ]);
  assert.deepEqual(parseMetadata(null), []);
});

/* -------------------------------------------------------------- image URLs */

test('imageRequestUrl builds a regionByPx + sizeByW request', () => {
  const url = imageRequestUrl('https://www.e-rara.ch/i3f/v20/1001', { x: 120.4, y: 0, w: 800, h: 600 }, 900);
  assert.equal(url, 'https://www.e-rara.ch/i3f/v20/1001/120,0,800,600/900,/0/default.jpg');
});

test('imageRequestUrl uses `full` for a whole sheet and clamps the width', () => {
  const bounds = boundsForCanvas(4000, 6000);
  assert.equal(
    imageRequestUrl('https://www.e-rara.ch/i3f/v20/1001', viewForCanvas(4000, 6000), 5000, { bounds }),
    `https://www.e-rara.ch/i3f/v20/1001/full/${MAX_OUTPUT_WIDTH},/0/default.jpg`,
  );
});

test('imageRequestUrl refuses incomplete views instead of producing a broken URL', () => {
  assert.equal(imageRequestUrl('https://x.example/iiif/1', { x: 0, y: 0, w: 0, h: 10 }, 500), null);
  assert.equal(imageRequestUrl(null, { x: 0, y: 0, w: 10, h: 10 }, 500), null);
});

test('regionRequest formats pixel regions and only uses full when told the bounds', () => {
  assert.equal(regionRequest({ x: 1.6, y: 2.2, w: 30, h: 40 }), '2,2,30,40');
  assert.equal(regionRequest({ x: -1, y: -1, w: 11, h: 11 }, { x: 0, y: 0, w: 10, h: 10 }), 'full');
  assert.equal(regionRequest(null), null);
});

test('fullImageUrl is a plain sizeByW request', () => {
  assert.equal(fullImageUrl('https://www.e-rara.ch/i3f/v20/1001', 304), 'https://www.e-rara.ch/i3f/v20/1001/full/304,/0/default.jpg');
});

test('sheetThumbUrl prefers the manifest thumbnail and derives from the image service otherwise', () => {
  assert.equal(
    sheetThumbUrl({ thumbnail: 'https://example.org/thumb.jpg', service: 'https://example.org/iiif/1' }),
    'https://example.org/thumb.jpg',
  );
  assert.equal(
    sheetThumbUrl({ service: 'https://www.e-rara.ch/i3f/v20/6507643/' }, 96),
    'https://www.e-rara.ch/i3f/v20/6507643/full/96,/0/default.jpg',
  );
  assert.equal(sheetThumbUrl({ label: 'ohne Bild' }), null, 'no thumbnail and no service -> null, nothing invented');
  assert.equal(sheetThumbUrl(null), null);
});

test('sheetOptionLabel names a sheet without repeating an upstream number label', () => {
  assert.equal(sheetOptionLabel({ label: '7' }, 6, 33), 'Sheet 7 of 33');
  assert.equal(sheetOptionLabel({ label: '[7]' }, 6, 33), 'Sheet 7 of 33', 'e-rara writes the sheet number as “[7]”');
  assert.equal(sheetOptionLabel({ label: 'Blatt 7' }, 6, 33), 'Sheet 7 of 33', 'the upstream “Blatt n” is the number again');
  assert.equal(sheetOptionLabel({}, 0, 1), 'Sheet 1 of 1', 'missing label -> the number alone');
  assert.equal(
    sheetOptionLabel({ label: 'Situation der Stadt Zürich' }, 2, 3),
    'Sheet 3 of 3 – Situation der Stadt Zürich',
    'a real upstream name is appended',
  );
  // Defensive: hostile or absent arguments must not produce “Blatt NaN”.
  assert.equal(sheetOptionLabel(null, 0, 0), 'Sheet 1 of 1');
  assert.equal(sheetOptionLabel({ label: '   ' }, 1, 'x'), 'Sheet 2 of 2');
  assert.equal(sheetOptionLabel({ label: 'x' }, -5, -1), 'Sheet 1 of 1 – x');
});

/* ----------------------------------------------------------------- view box */

test('clampView centres a letterboxed axis and clamps the other one', () => {
  const bounds = boundsForCanvas(1000, 1000);
  assert.deepEqual(clampView({ x: -50, y: -50, w: 500, h: 500 }, bounds), { x: 0, y: 0, w: 500, h: 500 });
  assert.deepEqual(clampView({ x: 900, y: 900, w: 500, h: 500 }, bounds), { x: 500, y: 500, w: 500, h: 500 });
  assert.deepEqual(clampView({ x: 10, y: 10, w: 4000, h: 200 }, bounds), { x: 0, y: 10, w: 1000, h: 200 });
});

test('zoomView keeps the anchor point fixed and respects the zoom limits', () => {
  const bounds = boundsForCanvas(1000, 1000);
  const view = { x: 0, y: 0, w: 1000, h: 1000 };
  const anchor = { x: 0.25, y: 0.5 };
  const zoomed = zoomView(view, 2, anchor, bounds);
  assert.equal(zoomed.w, 500);
  assert.equal(zoomed.x, 125, 'the anchored image point (250px) stays at 25 % of the new view');
  assert.equal(zoomed.y, 250);
  assert.ok(zoomed.x + 250 <= zoomed.x + zoomed.w, 'the anchor is inside the new view');

  const out = zoomView(view, 1000, anchor, bounds);
  assert.ok(out.w >= bounds.w * 0.04 - 0.001, 'a minimum region guards against absurd requests');
  const back = zoomView(out, 0.02, anchor, bounds);
  assert.equal(back.w, bounds.w, 'zooming out stops at the whole sheet');
});

test('panView moves by a fraction of the view and stops at the sheet edge', () => {
  const bounds = boundsForCanvas(1000, 1000);
  const view = { x: 0, y: 0, w: 500, h: 500 };
  assert.deepEqual(panView(view, 0.2, 0.1, bounds), { x: 100, y: 50, w: 500, h: 500 });
  assert.deepEqual(panView({ x: 450, y: 450, w: 500, h: 500 }, 0.5, 0.5, bounds), { x: 500, y: 500, w: 500, h: 500 });
});

test('zoomPercent reports the displayed resolution', () => {
  assert.equal(zoomPercent({ w: 1000 }, 1000), 100);
  assert.equal(zoomPercent({ w: 500 }, 1000), 200);
  assert.equal(zoomPercent(null, 1000), 0);
  assert.equal(zoomPercent({ w: 500 }, 0), 0);
});

/* ------------------------------------------------------- shareable region */

test('formatViewParam writes whole pixels and omits the default whole sheet', () => {
  const bounds = boundsForCanvas(3808, 5613);
  assert.equal(formatViewParam({ x: 0, y: 0, w: 3808, h: 5613 }, bounds), '', 'the whole sheet is the default, not a parameter');
  assert.equal(formatViewParam({ x: 1160.4, y: 2395.2, w: 1487, h: 824 }, bounds), '1160,2395,1487,824');
  assert.equal(formatViewParam({ x: 1, y: 0, w: 3807, h: 5613 }, bounds), '', 'one pixel of rounding is still the whole sheet');
  assert.equal(formatViewParam(null, bounds), '');
  assert.equal(formatViewParam({ x: 0, y: 0, w: 0, h: 100 }, bounds), '', 'an unusable view never reaches a shared link');
  assert.equal(formatViewParam({ x: 0, y: 0, w: 100, h: 100 }, null), '');
});

test('parseViewParam accepts only regions this viewer could have produced', () => {
  const bounds = boundsForCanvas(3808, 5613);
  assert.deepEqual(parseViewParam('1160,2395,1487,824', bounds), { x: 1160, y: 2395, w: 1487, h: 824 });
  assert.deepEqual(
    parseViewParam('3700,5500,1487,824', bounds),
    { x: 2321, y: 4789, w: 1487, h: 824 },
    'a region that only sits slightly outside the sheet is clamped, not rejected',
  );
  assert.equal(parseViewParam('', bounds), null, 'an empty value is not a region');
  assert.equal(parseViewParam('1,2,3', bounds), null, 'the shape is fixed');
  assert.equal(parseViewParam('a,b,c,d', bounds), null);
  assert.equal(parseViewParam('0,0,100000,100', bounds), null, 'wider than the sheet');
  assert.equal(parseViewParam('0,0,10,10', bounds), null, 'smaller than the deepest zoom');
  assert.equal(parseViewParam('-10,0,1000,1000', bounds), null, 'negative coordinates');
  assert.equal(parseViewParam('0,0,1000,1000', null), null, 'without a known sheet size nothing is applied');
});

test('a formatted region round-trips through parseViewParam at every zoom step', () => {
  const bounds = boundsForCanvas(3808, 5613);
  let view = viewForCanvas(bounds.w, bounds.h);
  for (let i = 0; i < 30; i += 1) {
    view = zoomView(view, 1.6, { x: 0.4, y: 0.6 }, bounds, { aspect: 1.4 });
    const param = formatViewParam(view, bounds);
    if (!param) continue;
    const restored = parseViewParam(param, bounds);
    assert.ok(restored, `step ${i}: ${param} must round-trip`);
    assert.ok(Math.abs(restored.w - view.w) < 1.5 && Math.abs(restored.x - view.x) < 1.5, `step ${i}: geometry survives rounding`);
  }
});

/* ----------------------------------------------------------------- metadata */

test('eRaraViewerUrl is derived only from a canonical e-rara URL', () => {
  assert.equal(
    eRaraViewerUrl({ recordUrl: 'https://www.e-rara.ch/zuz/content/titleinfo/22142031' }),
    'https://www.e-rara.ch/zuz/content/zoom/22142031',
  );
  assert.equal(
    eRaraViewerUrl({ recordUrl: 'https://www.e-rara.ch/zut/content/pageview/6507643' }),
    'https://www.e-rara.ch/zut/content/zoom/6507643',
  );
  assert.equal(
    eRaraViewerUrl({ recordUrl: 'https://doi.org/10.3931/e-rara-20964' }),
    null,
    'a DOI-only record without any e-rara id gets no viewer link',
  );
  assert.equal(
    eRaraViewerUrl({ recordUrl: 'https://doi.org/10.3931/e-rara-20964', iiifManifest: 'https://www.e-rara.ch/i3f/v20/6507640/manifest' }),
    'https://www.e-rara.ch/zut/content/zoom/6507640',
    'the title id from the manifest is enough: e-rara routes any corpus prefix to the right library',
  );
  assert.equal(
    eRaraViewerUrl({ id: 'e-rara:22142031', recordUrl: 'https://doi.org/10.3931/e-rara-1' }),
    'https://www.e-rara.ch/zut/content/zoom/22142031',
    'the record id carries the same title id',
  );
  assert.equal(
    eRaraViewerUrl({ viewerUrl: 'https://www.e-rara.ch/zuz/content/zoom/999', recordUrl: 'https://doi.org/10.3931/e-rara-1' }),
    'https://www.e-rara.ch/zuz/content/zoom/999',
    'a harvested viewerUrl wins',
  );
  assert.equal(eRaraViewerUrl({}), null);
});

test('eRaraTitleId extracts the title id from a manifest URL', () => {
  assert.equal(eRaraTitleId('https://www.e-rara.ch/i3f/v20/6507640/manifest'), '6507640');
  assert.equal(eRaraTitleId('https://www.e-rara.ch/i3f/v20/6507640'), null);
  assert.equal(eRaraTitleId(null), null);
});

test('zoomView can reshape the region to the stage aspect (cover instead of bars)', () => {
  const bounds = boundsForCanvas(4000, 6000); // portrait sheet
  const view = viewForCanvas(4000, 6000);
  const zoomed = zoomView(view, 2, { x: 0.5, y: 0.5 }, bounds, { aspect: 1.5 });
  assert.ok(Math.abs(zoomed.w / zoomed.h - 1.5) < 0.001, 'region matches the stage aspect');
  assert.ok(zoomed.w <= bounds.w && zoomed.h <= bounds.h, 'and stays inside the sheet');
  assert.equal(zoomed.x, 1000, 'a centred zoom stays centred (4000 - 2000)/2');

  // A very wide stage cannot ask for pixels left/right of the sheet.
  const wide = zoomView(view, 1, { x: 0.5, y: 0.5 }, bounds, { aspect: 8 });
  assert.equal(wide.w, bounds.w);
  assert.ok(wide.h <= bounds.h);
  assert.ok(Math.abs(wide.w / wide.h - 8) < 0.001);
});

test('describeUpstreamError turns developer strings into an actionable sentence', () => {
  // Browser-level network failures never reach the visible UI as English text.
  const offline = describeUpstreamError(new TypeError('Failed to fetch / Failed to fetch'));
  assert.match(offline, /Preview unavailable/);
  assert.match(offline, /connect/);
  assert.doesNotMatch(offline, /Failed to fetch|TypeError/);

  // A proxy HTTP status is reported with its number (that is useful, not raw).
  const proxy = describeUpstreamError(new Error('Proxy HTTP 502 / HTTP 502'));
  assert.match(proxy, /HTTP 502/);
  assert.doesNotMatch(proxy, /Proxy/);

  // Our own manifest messages are German and precise — they are passed through.
  const manifest = describeUpstreamError(new Error('IIIF manifest has no image pages (no items or sequences).'));
  assert.match(manifest, /no image pages/);

  // Unknown upstream text is not echoed (it may be English developer prose).
  const unknown = describeUpstreamError(new Error('something odd happened in the proxy layer'));
  assert.doesNotMatch(unknown, /something odd/);
  assert.match(unknown, /unexpected/);

  assert.match(describeUpstreamError(null), /unknown error/);
});

/* ------------------------------------------------ coupling by documented extent */

/** A labelled fixture extent: Zürich city plans state roughly this box. */
const CITY_EXTENT = { west: 8.5, east: 8.55, north: 47.38, south: 47.35 };

test('viewToExtent maps the sheet linearly onto the documented extent', () => {
  const bounds = boundsForCanvas(1000, 500);
  // Whole sheet -> whole extent.
  assert.deepEqual(viewToExtent({ x: 0, y: 0, w: 1000, h: 500 }, bounds, CITY_EXTENT), CITY_EXTENT);
  // Right half of the sheet -> eastern half of the box; y grows southwards.
  const right = viewToExtent({ x: 500, y: 0, w: 500, h: 500 }, bounds, CITY_EXTENT);
  assert.equal(right.west, 8.525);
  assert.equal(right.east, 8.55);
  assert.equal(right.north, 47.38);
  // Bottom-left quarter -> south-west corner (north of the box is smaller).
  const corner = viewToExtent({ x: 0, y: 250, w: 500, h: 250 }, bounds, CITY_EXTENT);
  assert.equal(corner.west, 8.5);
  assert.equal(corner.east, 8.525);
  assert.equal(corner.north, 47.365);
  assert.equal(corner.south, 47.35);
});

test('extentToView is the inverse of viewToExtent', () => {
  const bounds = boundsForCanvas(3808, 5613);
  const view = { x: 1160, y: 2395, w: 1487, h: 824 };
  const geo = viewToExtent(view, bounds, CITY_EXTENT);
  const back = extentToView(geo, bounds, CITY_EXTENT);
  assert.ok(Math.abs(back.x - view.x) < 0.001 && Math.abs(back.y - view.y) < 0.001, 'position round-trips');
  assert.ok(Math.abs(back.w - view.w) < 0.001 && Math.abs(back.h - view.h) < 0.001, 'size round-trips');
});

test('extentToView clamps a box that reaches beyond the sheet instead of inventing one', () => {
  const bounds = boundsForCanvas(1000, 500);
  const wider = extentToView({ west: 8.0, east: 9.0, north: 48, south: 47 }, bounds, CITY_EXTENT);
  assert.deepEqual(wider, { x: 0, y: 0, w: 1000, h: 500 });
  // A tiny box still yields the deepest zoom the viewer allows (MIN_REGION_FRACTION).
  const tiny = extentToView({ west: 8.5001, east: 8.5002, north: 47.3502, south: 47.3501 }, bounds, CITY_EXTENT);
  assert.equal(tiny.w, 40);
  assert.equal(tiny.h, 20);
});

test('the coupling helpers refuse unusable input instead of guessing coordinates', () => {
  const bounds = boundsForCanvas(1000, 500);
  for (const bad of [null, undefined, {}, { west: 8.5, east: 8.5, north: 47.4, south: 47.3 }, { west: 9, east: 8, north: 47.4, south: 47.3 }, { west: 8.5, east: 8.6, north: 47.3, south: 47.4 }, { west: NaN, east: 8.6, north: 47.4, south: 47.3 }, { west: -200, east: 8.6, north: 47.4, south: 47.3 }]) {
    assert.equal(viewToExtent({ x: 0, y: 0, w: 100, h: 100 }, bounds, bad), null, `extent ${JSON.stringify(bad)}`);
    assert.equal(extentToView({ west: 8.5, east: 8.52, north: 47.36, south: 47.35 }, bounds, bad), null);
    assert.equal(coupledView({ west: 8.5, east: 8.52, north: 47.36, south: 47.35 }, bounds, bad), null);
  }
  assert.equal(viewToExtent({ x: 0, y: 0, w: 0, h: 100 }, bounds, CITY_EXTENT), null);
  assert.equal(viewToExtent({ x: 0, y: Number.NaN, w: 100, h: 100 }, bounds, CITY_EXTENT), null);
  assert.equal(viewToExtent({ x: 0, y: 0, w: 100, h: 100 }, { x: 0, y: 0, w: 0, h: 0 }, CITY_EXTENT), null);
  assert.equal(extentToView({ west: 8.5, east: 8.52, north: 47.36, south: 47.35 }, null, CITY_EXTENT), null);
  assert.equal(coupledView(null, bounds, CITY_EXTENT), null);
  assert.equal(coupledView(CITY_EXTENT, bounds, null), null);
  assert.equal(coupledView(CITY_EXTENT, null, CITY_EXTENT), null);
});

test('intersectExtents returns only the area two stated extents really share', () => {
  const europe = { west: -25, east: 60, north: 72, south: 34 };
  const switzerland = { west: 5.95, east: 10.5, north: 47.81, south: 45.82 };
  assert.deepEqual(intersectExtents(europe, switzerland), switzerland, 'the smaller box inside the larger one');
  assert.deepEqual(intersectExtents(switzerland, europe), switzerland, 'order does not matter');
  assert.deepEqual(
    intersectExtents({ west: 8, east: 12, north: 48, south: 46 }, { west: 10, east: 14, north: 50, south: 47 }),
    { west: 10, east: 12, south: 47, north: 48 },
    'the shared rectangle of two overlapping boxes'
  );
  assert.equal(intersectExtents(europe, { west: 100, east: 110, north: 10, south: 0 }), null, 'disjoint boxes');
  assert.equal(
    intersectExtents({ west: 8, east: 9, north: 48, south: 47 }, { west: 9, east: 10, north: 48, south: 47 }),
    null,
    'boxes that only touch along an edge share no area'
  );
  assert.equal(intersectExtents({ west: 9, east: 8, north: 48, south: 47 }, CITY_EXTENT), null, 'an unusable box');
});

test('coupledView shows the shared area — and names it when a sheet does not reach', () => {
  const world = { west: -180, east: 180, north: 90, south: -90 };
  const bounds = boundsForCanvas(1000, 500);

  // The box lies entirely inside the partner's stated extent: the whole box.
  const inside = coupledView(CITY_EXTENT, bounds, { west: 8, east: 9, north: 48, south: 47 });
  assert.equal(inside.coverage, 'full');
  assert.deepEqual(inside.view, extentToView(CITY_EXTENT, bounds, { west: 8, east: 9, north: 48, south: 47 }));

  // The box reaches beyond the sheet: only the shared part is shown, and the
  // caller can say so — the clamped variant would have shown 8.5…8.55 as if the
  // sheet documented the whole of 8…9.
  const partial = coupledView({ west: 8, east: 9, north: 48, south: 47 }, bounds, CITY_EXTENT);
  assert.equal(partial.coverage, 'partial');
  assert.equal(partial.view.x, 0, 'the shared part starts at the sheet edge');
  assert.equal(partial.view.y, 0);
  assert.equal(partial.view.w, 1000, 'and reaches the opposite edge');
  assert.equal(partial.view.h, 500);

  // The measured case: a zoomed-out world sheet whose cut-out (the tropics) does
  // not touch the Zürich sheet at all. Nothing to show — and no invented region.
  const elsewhere = coupledView({ west: -70, east: 70, north: 32, south: -32 }, bounds, CITY_EXTENT);
  assert.deepEqual(elsewhere, { view: null, coverage: 'outside' });
  assert.equal(
    coupledView(world, bounds, CITY_EXTENT).coverage,
    'partial',
    'the whole world meets a Zürich sheet in the Zürich box'
  );
});

/* ----------------------------------- cut-outs of several sheets at once */

test('the comparison cut-outs round-trip as id@region pairs', () => {
  const entries = [
    ['e-rara:8602401', '1160,2395,1487,824'],
    ['e-rara:8751735', ''],
  ];
  assert.equal(formatCompareViews(entries), 'e-rara:8602401@1160,2395,1487,824', 'the whole sheet stays out of the link');
  const parsed = parseCompareViews(formatCompareViews(entries));
  assert.deepEqual([...parsed], [['e-rara:8602401', '1160,2395,1487,824']]);
  assert.equal(parseCompareViews('').size, 0, 'no value means no cut-outs');
  assert.equal(parseCompareViews(null).size, 0);
});

test('the comparison cut-outs are keyed by record id, not by position', () => {
  // The pane order follows the record that was clicked first; a link must
  // survive that order changing.
  const value = formatCompareViews([
    ['e-rara:8751735', '10,20,30,40'],
    ['e-rara:8602401', '50,60,70,80'],
  ]);
  const views = parseCompareViews(value);
  assert.equal(views.get('e-rara:8602401'), '50,60,70,80');
  assert.equal(views.get('e-rara:8751735'), '10,20,30,40');
});

test('hostile or sloppy cut-out values yield fewer entries, never a throw', () => {
  assert.equal(formatCompareViews(null), '');
  assert.equal(formatCompareViews([['not an id', '1,2,3,4']]), '', 'an id outside the data contract is dropped');
  assert.equal(formatCompareViews([['e-rara:1', 'whole sheet']]), '', 'a region the viewer could not produce is dropped');
  assert.equal(formatCompareViews([['e-rara:1', '1,2,3,4'], ['e-rara:1', '5,6,7,8']]), 'e-rara:1@1,2,3,4', 'one region per record');
  const capped = formatCompareViews([1, 2, 3, 4, 5, 6].map((n) => [`e-rara:${n}`, `${n},2,3,4`]));
  assert.equal(capped.split(';').length, 4, 'never more pairs than the comparison has panes');

  const parsed = parseCompareViews('<script>@1,2,3,4;e-rara:1@x,2,3,4;e-rara:2@1,2,3,4,,;../../etc/passwd@1,2,3,4;e-rara:3@1,2,3,4');
  assert.deepEqual([...parsed], [['e-rara:3', '1,2,3,4']], 'only the pair matching both contracts survives');
  assert.equal(parseCompareViews('e-rara:1@-1,2,3,4').size, 0, 'negative coordinates are not a region');
  assert.equal(parseCompareViews('e-rara:1@1,2,3,4'.repeat(1) + ';' + Array(20).fill('e-rara:2@1,2,3,4').join(';')).size <= 4, true);
});

test('parseCompareViews keeps the last pair of a duplicated id and respects the pane limit', () => {
  assert.deepEqual([...parseCompareViews('e-rara:1@1,2,3,4;e-rara:1@5,6,7,8')], [['e-rara:1', '5,6,7,8']]);
  const many = Array.from({ length: 9 }, (_, i) => `e-rara:${i + 1}@1,2,3,4`).join(';');
  assert.equal(parseCompareViews(many).size, 4);
  assert.equal(formatCompareViews([[ 'e-rara:1', '1,2,3,4' ], [ 'e-rara:2', '2,2,3,4' ], [ 'e-rara:3', '3,2,3,4' ], [ 'e-rara:4', '4,2,3,4' ], [ 'e-rara:5', '5,2,3,4' ]]), 'e-rara:1@1,2,3,4;e-rara:2@2,2,3,4;e-rara:3@3,2,3,4;e-rara:4@4,2,3,4');
});
