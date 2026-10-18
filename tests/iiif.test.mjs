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
  eRaraTitleId,
  eRaraViewerUrl,
  fullImageUrl,
  imageRequestUrl,
  labelText,
  panView,
  parseManifest,
  parseMetadata,
  regionRequest,
  serviceId,
  viewForCanvas,
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
    { label: 'Besitzende Institution', value: 'Zentralbibliothek Zürich' },
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
  assert.equal(labelText({ en: 'Sheet', de: ['Blatt'] }), 'Blatt', 'German is preferred');
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
  assert.equal(m.label, 'Blatt aus einem Kantonsatlas');
  const [canvas] = m.canvases;
  assert.equal(canvas.service, 'https://example.org/iiif/image/abc');
  assert.equal(canvas.thumbnail, 'https://example.org/iiif/image/abc/full/200,/0/default.jpg');
  assert.equal(canvas.width, 2000);
});

test('parseManifest rejects things that are not usable manifests', () => {
  assert.throws(() => parseManifest(null), /Kein IIIF-Manifest/);
  assert.throws(() => parseManifest({ '@type': 'sc:Collection' }), /ohne Bildseiten/);
  assert.throws(() => parseManifest({ sequences: [{ canvases: [] }] }), /ohne verwendbare Bildseiten/);
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
