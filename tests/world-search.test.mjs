/**
 * Worldwide search + global basemap regression tests (redirect 2026-10-19).
 *
 * The product correction demands a worldwide initial map, a global basemap and
 * place search that answers outside Switzerland. These tests pin the three
 * pieces that can regress without a browser: the Nominatim mapping, the
 * Worker's allowlist, and the documented basemap defaults.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { ALLOWLIST, isAllowed } from '../src/worker/allowlist.js';
import {
  NOMINATIM_ATTRIBUTION,
  NOMINATIM_HOST,
  mapNominatimRecord,
  mapNominatimResults,
  maxZoomForBbox,
  nominatimUrl,
  searchPayload,
} from '../src/worker/geocode.js';
import { BASE_LAYERS, DEFAULT_BASE, WORLD, WORLD_BOUNDS, ZURICH, baseLayerFor, tileUrl } from '../public/app/map.js';
import { QUICK_PLACES } from '../public/app/search.js';
import { STATE_DEFAULTS } from '../public/app/store.js';

/* ------------------------------------------------------------- geocoder */

test('nominatimUrl: a documented, English, bounded search request', () => {
  const url = new URL(nominatimUrl('  Mexico City  '));
  assert.equal(url.hostname, NOMINATIM_HOST);
  assert.equal(url.pathname, '/search');
  assert.equal(url.searchParams.get('q'), 'Mexico City');
  assert.equal(url.searchParams.get('format'), 'jsonv2');
  assert.equal(url.searchParams.get('accept-language'), 'en');
  assert.equal(url.searchParams.get('limit'), '8');
  assert.equal(url.toString().includes('api_key'), false, 'no credential is ever sent');
  assert.equal(new URL(nominatimUrl('Cairo', { limit: 99 })).searchParams.get('limit'), '10', 'limit is capped');
  assert.equal(new URL(nominatimUrl('Cairo', { limit: 0 })).searchParams.get('limit'), '8', 'nonsense falls back');
  assert.equal(new URL(nominatimUrl('São Paulo')).searchParams.get('q'), 'São Paulo', 'unicode survives');
});

test('mapNominatimRecord: only published positions and boxes become suggestions', () => {
  const mapped = mapNominatimRecord({
    place_id: 1,
    display_name: 'Cairo, Egypt',
    name: 'Cairo',
    lat: '30.0443879',
    lon: '31.2357257',
    addresstype: 'city',
    type: 'city',
    boundingbox: ['29.7', '30.3', '31.0', '31.5'],
    importance: 0.9,
    osm_type: 'relation',
    osm_id: 42,
    licence: 'ODbL',
  });
  assert.equal(mapped.label, 'Cairo, Egypt');
  assert.equal(mapped.name, 'Cairo');
  assert.equal(mapped.origin, 'city');
  assert.equal(mapped.lat, 30.0443879);
  assert.equal(mapped.lon, 31.2357257);
  assert.deepEqual(mapped.bbox, { south: 29.7, north: 30.3, west: 31.0, east: 31.5 }, 'Nominatim box order is rotated into the app order');
  assert.equal(mapped.osmType, 'relation');
  assert.equal(mapped.osmId, '42');

  assert.equal(mapNominatimRecord({ display_name: 'Nowhere', lat: '91', lon: '0' }), null, 'out-of-range latitude is rejected');
  assert.equal(mapNominatimRecord({ display_name: 'Nowhere', lat: '10', lon: '181' }), null);
  const invertedBox = mapNominatimRecord({ display_name: 'Nowhere', lat: '10', lon: '10', boundingbox: ['1', '0', '5', '4'] });
  assert.equal(invertedBox.bbox, null, 'an inverted box is dropped, the point still works');
  const noBox = mapNominatimRecord({ display_name: 'Point', lat: '10', lon: '10' });
  assert.equal(noBox.bbox, null, 'a missing/invalid box stays missing');
  assert.equal(noBox.origin, null);
  assert.equal(mapNominatimRecord({ lat: '10', lon: '10' }), null, 'a suggestion without a label is not shown');
  assert.equal(mapNominatimRecord(null), null);
});

test('mapNominatimResults / searchPayload: deduped, bounded, honest about “nothing”', () => {
  const payload = [
    { display_name: 'Tokyo, Japan', lat: '35.68', lon: '139.76', addresstype: 'city', boundingbox: ['35.5', '35.9', '139.5', '139.9'] },
    { display_name: 'Tokyo, Japan', lat: '35.68', lon: '139.76', addresstype: 'city' },
    { display_name: 'Tokyo Station', lat: '35.681', lon: '139.767', addresstype: 'building' },
    { display_name: 'broken', lat: 'x', lon: 'y' },
    { display_name: 'Tokyo, Japan (other)', lat: '35.7', lon: '139.8' },
    { display_name: 'Tokyo, Japan (third)', lat: '35.9', lon: '139.9' },
  ];
  const mapped = mapNominatimResults(payload, { limit: 3 });
  assert.equal(mapped.length, 3);
  assert.equal(mapped[0].label, 'Tokyo, Japan');
  assert.equal(mapped[1].label, 'Tokyo Station');
  assert.equal(mapped[2].label, 'Tokyo, Japan (other)');

  const none = searchPayload([], { query: 'Xyzzy' });
  assert.equal(none.count, 0);
  assert.equal(none.source, 'OpenStreetMap (Nominatim)');
  assert.equal(none.attribution, NOMINATIM_ATTRIBUTION);
  assert.match(none.note, /No place/);
  assert.equal('note' in searchPayload(payload, { query: 'Tokyo' }), false, 'a successful answer has no excuse note');
});

test('maxZoomForBbox: continents are wide, cities are close', () => {
  assert.ok(maxZoomForBbox({ west: -10, east: 40, south: 35, north: 70 }) <= 5);
  assert.ok(maxZoomForBbox({ west: 31.1, east: 31.4, south: 30, north: 30.2 }) >= 9);
  assert.equal(maxZoomForBbox(null), null);
  assert.equal(maxZoomForBbox({ west: 5, east: 5, south: 5, north: 5 }), null);
});

test('the Worker allowlist admits the worldwide gazetteer and nothing more', () => {
  assert.ok(ALLOWLIST.some((rule) => rule.host === NOMINATIM_HOST));
  assert.equal(isAllowed(new URL(`https://${NOMINATIM_HOST}/search?q=Cairo`)), true);
  assert.equal(isAllowed(new URL(`https://${NOMINATIM_HOST}/reverse?q=Cairo`)), false, 'only the documented search path');
  assert.equal(isAllowed(new URL(`https://nominatim.openstreetmap.org.evil.example/search?q=x`)), false);
  assert.equal(isAllowed(new URL('https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=Bern')), true, 'the Swiss fallback stays');
});

/* -------------------------------------------------------------- basemap */

test('the default basemap is global and the initial view is the world', () => {
  assert.equal(DEFAULT_BASE.key, 'osm');
  assert.equal(DEFAULT_BASE.global, true);
  assert.match(DEFAULT_BASE.urlTemplate, /tile\.openstreetmap\.org/);
  assert.match(DEFAULT_BASE.attribution, /OpenStreetMap/);
  assert.equal(baseLayerFor('').key, 'osm', 'an empty ?base= is the global default');
  assert.equal(baseLayerFor('nonsense').key, 'osm');
  assert.equal(baseLayerFor('farbe').key, 'farbe', 'the Swiss detail layer remains reachable');
  for (const layer of BASE_LAYERS) {
    assert.ok(layer.key && layer.title && layer.attribution && layer.maxZoom > 0);
    assert.equal(/^https:\/\//.test(layer.urlTemplate), true);
  }
  const swiss = BASE_LAYERS.filter((layer) => layer.coverage === 'Switzerland');
  assert.ok(swiss.length >= 2, 'Swiss coverage is labelled instead of implied');

  assert.deepEqual(WORLD, { lat: 20, lon: 0, zoom: 2 });
  assert.equal(MAP_DEFAULT().zoom <= 3, true, 'the app opens on a world view, not a city');
  assert.ok(WORLD_BOUNDS.west < -170 && WORLD_BOUNDS.east > 170);
  assert.ok(ZURICH.zoom >= 10, 'Zürich remains available as a deliberate jump, not as the default');
  assert.equal(STATE_DEFAULTS.lat, WORLD.lat);
  assert.equal(STATE_DEFAULTS.lon, WORLD.lon);
  assert.equal(STATE_DEFAULTS.zoom, WORLD.zoom);
});

function MAP_DEFAULT() {
  return { lat: STATE_DEFAULTS.lat, lon: STATE_DEFAULTS.lon, zoom: STATE_DEFAULTS.zoom };
}

test('tileUrl serves XYZ and WMTS templates from one renderer', () => {
  assert.equal(tileUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { z: 3, x: 4, y: 2 }), 'https://tile.openstreetmap.org/3/4/2.png');
  assert.equal(
    tileUrl('https://wmts.geo.admin.ch/1.0.0/x/default/{Time}/3857/{TileMatrix}/{TileCol}/{TileRow}.jpeg', { z: 5, x: 16, y: 11, time: '1900' }),
    'https://wmts.geo.admin.ch/1.0.0/x/default/1900/3857/5/16/11.jpeg',
  );
});

test('place search offers quick picks on several continents', () => {
  assert.ok(QUICK_PLACES.length >= 4);
  const labels = QUICK_PLACES.map((place) => place.label);
  for (const city of ['Cairo', 'Tokyo', 'Mexico City', 'São Paulo']) {
    assert.ok(labels.includes(city), `${city} is a quick pick`);
  }
  for (const place of QUICK_PLACES) {
    assert.ok(Math.abs(place.lat) <= 90 && Math.abs(place.lon) <= 180, `${place.label} has a real coordinate`);
    assert.ok(place.zoom >= 8 && place.zoom <= 14);
  }
  const continents = new Set(
    QUICK_PLACES.map((place) => (place.lon > -30 && place.lon < 60 ? (place.lat > 0 ? 'europe/africa' : 'africa') : place.lon >= 60 ? 'asia/oceania' : 'americas')),
  );
  assert.ok(continents.size >= 3, 'the quick picks are not one continent');
});
