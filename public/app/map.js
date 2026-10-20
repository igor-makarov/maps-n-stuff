/**
 * Interactive map: a dependency-free slippy map (Web Mercator, 256 px tiles)
 * with a **worldwide** default basemap, plus historical comparison layers.
 *
 * Deliberately small and explicit instead of vendoring a whole map library:
 *   - base, worldwide: OpenStreetMap raster tiles (`tile.openstreetmap.org`) —
 *     the initial view is the whole world, not one canton
 *   - satellite: NASA's worldwide Blue Marble overview
 *   - comparison: georeferenced imagery from the original map collections
 *   - markers: records with a documented point/bbox (public/app/records.js)
 *
 * Keyboard: the container is focusable; arrows pan, +/- zoom, Home = the world,
 * End = fit results. The result list is the equivalent accessible interface.
 *
 * Coordination with the result list: hovering/focusing a marker shows a small
 * preview card and emits `record:preview`, so the matching row in the list
 * highlights (and the other way round) — the OldMapsOnline list/map behaviour.
 */

import { debounce, el, formatYearRange, qs } from './dom.js';
import { recordCenter } from './records.js';
import { parsePoint, sanitisePoint } from './store.js';

const TILE = 256;

/**
 * Worldwide reference layers. NASA GIBS supplies the Blue Marble overview;
 * its native resolution is advertised in the control and map hint. `key` is
 * the stable URL choice (for example `?base=satellite`).
 */
export const BASE_LAYERS = Object.freeze([
  {
    key: 'osm',
    id: 'openstreetmap',
    title: 'OpenStreetMap (worldwide)',
    chip: 'World',
    hint: 'The worldwide OpenStreetMap reference layer — the default view, everywhere on Earth.',
    maxZoom: 19,
    urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors (ODbL)',
    global: true,
  },
  {
    key: 'satellite',
    id: 'nasa-blue-marble',
    title: 'Satellite — NASA Blue Marble',
    chip: 'Satellite',
    hint: 'Worldwide NASA satellite mosaic from August 2004, about 500 m per source pixel. Zooming closer enlarges the overview imagery.',
    maxZoom: 8,
    urlTemplate: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    attribution: 'NASA Blue Marble / NASA EOSDIS GIBS',
    global: true,
    resolution: '500 m source imagery',
  },
]);

/** The base map of a fresh visit — also the fallback for an unknown key. */
export const DEFAULT_BASE = BASE_LAYERS[0]; // OpenStreetMap: worldwide by default

/** Kept for callers that only need the default layer. */
export const BASE_LAYER = DEFAULT_BASE;

/**
 * Resolve a `?base=` key to a layer. An empty or unknown key yields the default:
 * never an error, never a guessed layer.
 */
export function baseLayerFor(key) {
  const wanted = String(key ?? '')
    .trim()
    .toLowerCase();
  return BASE_LAYERS.find((layer) => layer.key === wanted) ?? DEFAULT_BASE;
}

export const WORLD = { lat: 20, lon: 0, zoom: 2 };
/** The whole world as a fitBounds() box (used when no result has a position). */
export const WORLD_BOUNDS = { west: -179.9, east: 179.9, south: -85, north: 85 };

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const s = Math.sin((Math.max(-85.05112878, Math.min(85.05112878, lat)) * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z;
};
export const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;
export const tileYToLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

/**
 * Tile URL from a template. Two documented shapes are supported:
 *  - WMTS (swisstopo): {TileMatrix}/{TileCol}/{TileRow}/{Time}
 *  - XYZ (OpenStreetMap): {z}/{x}/{y}
 */
export function tileUrl(template, { z, x, y, time }) {
  return template
    .replace('{TileMatrix}', String(z))
    .replace('{TileCol}', String(x))
    .replace('{TileRow}', String(y))
    .replace('{Time}', encodeURIComponent(time ?? 'current'))
    .replace('{z}', String(z))
    .replace('{x}', String(x))
    .replace('{y}', String(y));
}

/** Grid size (px) used to group markers that would overlap at the current zoom. */
export const CLUSTER_CELL = 56;

/**
 * Deepest zoom the base layers publish (see BASE_LAYERS) — and the zoom the
 * store clamps to. A cluster at this zoom cannot be split any further by
 * zooming, so it must offer another way to its records.
 */
export const MAX_ZOOM = 18;

/**
 * Group already projected pixel points into grid cells.
 *
 * Points are global pixel coordinates at one zoom level, so a cell key is
 * stable while panning: a cluster keeps its members and its count instead of
 * changing with the viewport. Pure, therefore unit-tested.
 */
export function clusterByCell(points, cellPx = CLUSTER_CELL) {
  const cells = new Map();
  for (const point of points ?? []) {
    const key = `${Math.floor(point.x / cellPx)}:${Math.floor(point.y / cellPx)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { key, x: 0, y: 0, count: 0, members: [] };
      cells.set(key, cell);
    }
    cell.x += point.x;
    cell.y += point.y;
    cell.count += 1;
    cell.members.push(point);
  }
  return [...cells.values()].map((cell) => ({ ...cell, x: cell.x / cell.count, y: cell.y / cell.count }));
}

/**
 * The documented anchor of a record as a comparable key (6 decimals ≈ 0.1 m).
 * Returns `''` for a record without any published point or extent.
 */
export function clusterAnchorKey(record) {
  const center = recordCenter(record);
  if (!center) return '';
  return `${Number(center.lat).toFixed(6)}:${Number(center.lon).toFixed(6)}`;
}

/**
 * Can zooming further separate this cluster into single markers?
 *
 * Usually yes: the cell shrinks with the zoom. Two cases provably cannot be
 * split, and both must not pretend otherwise:
 *
 *   - **point piles** — every member carries the *same* documented anchor (six
 *     Zürich Stadtpläne sit on 47.358330 / 8.533340 in the catalogue), so the
 *     pins keep sharing a cell at every zoom level;
 *   - the map is already at `MAX_ZOOM`.
 *
 * Pure, therefore unit-tested; `renderMarkers` uses it to decide whether a
 * cluster click zooms (the OldMapsOnline gesture) or opens the list of the
 * records behind the number.
 */
export function clusterCanSplit(members, zoom, maxZoom = MAX_ZOOM) {
  const list = [...(members ?? [])].filter((member) => member?.record);
  if (list.length < 2) return true;
  if (Math.round(Number(zoom) || 0) >= Number(maxZoom)) return false;
  const keys = list.map((member) => clusterAnchorKey(member.record));
  // An anchor that cannot be computed is never proof of a shared point.
  if (keys.some((key) => key === '')) return true;
  return new Set(keys).size > 1;
}

/**
 * The records behind a cluster, oldest first (then by title) — the order the
 * “Karten an diesem Punkt” list shows them in, so several editions of one place
 * read as a sequence instead of as an arbitrary set.
 */
export function clusterRecords(members) {
  return [...(members ?? [])]
    .map((member) => member?.record)
    .filter(Boolean)
    .sort(
      (a, b) =>
        Number(a.yearStart ?? 0) - Number(b.yearStart ?? 0) ||
        String(a.title ?? '').localeCompare(String(b.title ?? ''), 'en'),
    );
}

/**
 * Pixel rectangles for the documented extents of `records`, relative to a map
 * container of `size` ({ width, height }) showing `view` ({ lat, lon, zoom }).
 *
 * This is the geometry behind the “Ausschnitte” layer: it answers “which part of
 * the map does each filtered record actually claim to cover?”. Only the
 * documented extent is used — never an inferred or guessed footprint — and
 * records without an extent are counted (`withExtent`) so the caller can say so
 * honestly. Rectangles outside the visible box (plus a margin) are dropped, so
 * panning a large result set stays cheap.
 *
 * Records that share the same extent (the swisstopo series sheets all state
 * Switzerland) become ONE rectangle carrying every member id: drawing 27
 * identical outlines would only darken the map. Pure (no DOM), so it is unit
 * tested; `rects` is sorted largest-first and the caller paints in reverse so
 * more specific (smaller) footprints stay readable on top of country-wide ones.
 */
export function extentRects(records, view, size, { margin = 64, max = 500 } = {}) {
  const zoom = Math.max(2, Math.min(18, Math.round(Number(view?.zoom) || 12)));
  const width = Math.max(1, Number(size?.width) || 1);
  const height = Math.max(1, Number(size?.height) || 1);
  const originX = lonToTileX(Number(view?.lon) || 0, zoom) * TILE - width / 2;
  const originY = latToTileY(Number(view?.lat) || 0, zoom) * TILE - height / 2;
  const byGeometry = new Map();
  let withExtent = 0;
  let visible = 0;
  for (const record of records ?? []) {
    const extent = record?.extent;
    if (!extent) continue;
    const west = Number(extent.west);
    const east = Number(extent.east);
    const south = Number(extent.south);
    const north = Number(extent.north);
    if (![west, east, south, north].every(Number.isFinite)) continue;
    withExtent += 1;
    const x1 = lonToTileX(Math.min(west, east), zoom) * TILE - originX;
    const x2 = lonToTileX(Math.max(west, east), zoom) * TILE - originX;
    const y1 = latToTileY(Math.max(south, north), zoom) * TILE - originY;
    const y2 = latToTileY(Math.min(south, north), zoom) * TILE - originY;
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    const boxWidth = Math.abs(x2 - x1);
    const boxHeight = Math.abs(y2 - y1);
    if (left > width + margin || top > height + margin) continue;
    if (left + boxWidth < -margin || top + boxHeight < -margin) continue;
    visible += 1;
    const key = `${Math.round(left)}:${Math.round(top)}:${Math.round(boxWidth)}:${Math.round(boxHeight)}`;
    let area = byGeometry.get(key);
    if (!area) {
      area = { key, ids: [], left, top, width: boxWidth, height: boxHeight };
      byGeometry.set(key, area);
    }
    area.ids.push(record.id);
  }
  const list = [...byGeometry.values()];
  list.sort((a, b) => b.width * b.height - a.width * a.height);
  return { rects: list.slice(0, max), visible, areas: list.length, withExtent, filtered: (records ?? []).length };
}

/**
 * The pins a result set can really place: one point per record whose centre is
 * known, in the order of `records` — the list's order, which the pin number and
 * its aria-label repeat. `recordCenter` uses the record's published point or,
 * failing that, the centre of its documented extent; nothing is inferred.
 *
 * Nothing is capped either. The map used to slice the filtered set at 300
 * records, which would have dropped pins *silently* had a harvest pushed the
 * seed past that line; the DOM stays small anyway, because `clusterByCell`
 * draws at most one node per 56 px cell and only points inside the viewport get
 * an element. A record with no documented position at all cannot be pinned: it
 * is counted as `unplaced` so the status line can say how many, instead of
 * letting the map pretend it shows the whole filtered set.
 */
export function markerPoints(records, zoom) {
  const points = [];
  let unplaced = 0;
  for (const [index, record] of (records ?? []).entries()) {
    const center = recordCenter(record);
    if (!center) {
      unplaced += 1;
      continue;
    }
    points.push({
      id: record.id,
      record,
      index,
      x: lonToTileX(center.lon, zoom) * TILE,
      y: latToTileY(center.lat, zoom) * TILE,
    });
  }
  return { points, unplaced };
}

export function init(ctx) {
  const container = qs('[data-map]');
  if (!container) return;

  // The shell ships a <noscript>/fallback box; the real map replaces it.
  const fallback = qs('#map-fallback');
  if (fallback) fallback.remove();

  const state = {
    lat: ctx.store.getState().lat,
    lon: ctx.store.getState().lon,
    zoom: Math.round(ctx.store.getState().zoom),
    at: ctx.store.getState().at,
    extents: ctx.store.getState().extents,
    overlay: null,
    overlayTime: null,
    records: [],
    filtered: [],
    selected: '',
    visibleRecords: 0,
    unplacedRecords: 0,
  };

  // A shared point filter without an explicit view (?at=lat,lon, no lat/lon/z)
  // must show the filtered point instead of the default Zürich view with the
  // crosshair off-screen. A link that names lat/lon always wins (map click URLs
  // carry their own view).
  if (state.at && typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    const point = parsePoint(state.at);
    if (point && !params.has('lat') && !params.has('lon')) {
      state.lat = point.lat;
      state.lon = point.lon;
      state.zoom = Math.max(state.zoom, 12);
    }
  }

  container.setAttribute('tabindex', '0');
  container.setAttribute('role', 'region');
  container.setAttribute('aria-roledescription', 'Interactive map');
  container.setAttribute('aria-label', 'Historical map explorer. Arrow keys pan, plus and minus zoom, Home shows the world, End fits results, P filters to the map centre. Click the map to find maps covering that point.');

  const baseLayer = el('div', { class: 'map-layer map-layer--base', 'aria-hidden': 'true' });
  const overlayLayer = el('div', { class: 'map-layer map-layer--overlay', 'aria-hidden': 'true' });
  const footprintLayer = el('div', { class: 'map-layer map-layer--footprints', 'aria-hidden': 'true' });
  const shapeLayer = el('div', { class: 'map-layer map-layer--shapes', 'aria-hidden': 'true' });
  const markerLayer = el('div', { class: 'map-layer map-layer--markers' });
  const live = el('p', { class: 'visuallyhidden', role: 'status', 'aria-live': 'polite' });
  const badge = el('div', { class: 'map-badge' });
  const controls = el('div', { class: 'map-controls' }, [
    el('button', { class: 'zh-button zh-button--small', type: 'button', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(1) }, ['+']),
    el('button', { class: 'zh-button zh-button--small', type: 'button', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(-1) }, ['−']),
    el(
      'button',
      {
        class: 'zh-button zh-button--small',
        type: 'button',
        title: 'Fit all results',
        'aria-label': 'Fit all results',
        onclick: () => fitBounds(resultsBounds(), { maxZoom: 12 }),
      },
      ['⤢'],
    ),
    el(
      'button',
      {
        class: 'zh-button zh-button--small',
        type: 'button',
        title: 'Find maps covering the map centre (keyboard)',
        'aria-label': 'Find maps covering the map centre',
        onclick: () => setPoint(state.lat, state.lon, 'center'),
      },
      ['⌖'],
    ),
  ]);

  // Visual hover/focus card for a marker. Decorative: the marker's accessible
  // name and the result list already carry the same information.
  const preview = el('div', { class: 'map-preview', 'aria-hidden': 'true', hidden: true });

  /**
   * “Karten an diesem Punkt”: the list a cluster opens when zooming provably
   * cannot split it (see `clusterCanSplit`). It is the only route to the records
   * of a point pile — a mouse click on the map would set a point filter that
   * also returns everything else covering the place — so it is a real, focusable
   * dialog instead of the decorative hover card.
   */
  const clusterList = el('section', {
    class: 'map-cluster-list',
    role: 'dialog',
    'aria-modal': 'false',
    'aria-labelledby': 'map-cluster-list-title',
    tabindex: '-1',
    hidden: true,
  });

  container.replaceChildren(baseLayer, overlayLayer, footprintLayer, shapeLayer, markerLayer, controls, badge, preview, clusterList, live);

  const cache = new Map(); // tile key -> <img>
  const markers = new Map(); // record id -> <button>
  const footprints = new Map(); // record id -> footprint <div>
  const clusters = new Map(); // cell key -> { element, members, x, y }
  let lastOverlayKey = ''; // layer + edition currently displayed
  let activeBase = baseLayerFor(ctx.store.getState().base); // Grundkarte in the URL ('' = default)
  let previewId = ''; // record id whose preview card is visible

  const PREVIEW_WIDTH = 248;

  function hidePreview() {
    if (preview.hidden) return;
    preview.hidden = true;
    preview.replaceChildren();
    previewId = '';
    for (const [, marker] of markers) marker.classList.remove('is-preview');
    for (const [, node] of footprints) node.classList.remove('is-preview');
    for (const [, cluster] of clusters) cluster.element.classList.remove('is-preview');
  }

  /** Position a hover/focus card above a marker, clamped into the map. */
  function placeCard(node, marker, width = PREVIEW_WIDTH) {
    const mapRect = container.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const finalWidth = Math.min(width, Math.max(160, mapRect.width - 16));
    const left = Math.max(8, Math.min(mapRect.width - finalWidth - 8, markerRect.left - mapRect.left + markerRect.width / 2 - finalWidth / 2));
    node.style.width = `${finalWidth}px`;
    node.hidden = false;
    const height = node.offsetHeight;
    const above = markerRect.top - mapRect.top - height - 12;
    const below = markerRect.bottom - mapRect.top + 12;
    // Prefer above the marker; if that does not fit either, clamp into the box
    // (a tall list of six records must stay inside the map, not hang over it).
    const top = above >= 8 ? above : below + height <= mapRect.height - 8 ? below : Math.max(8, mapRect.height - height - 8);
    node.style.left = `${Math.round(left)}px`;
    node.style.top = `${Math.round(Math.min(top, Math.max(8, mapRect.height - height - 8)))}px`;
  }

  function placePreview(marker, width = PREVIEW_WIDTH) {
    placeCard(preview, marker, width);
  }

  function showPreview(record, marker) {
    if (!record) return;
    previewId = record.id;
    preview.replaceChildren(
      record.thumbnail
        ? el('img', { class: 'map-preview__thumb', src: record.thumbnail, alt: '', loading: 'lazy', decoding: 'async' })
        : el('span', { class: 'map-preview__thumb map-preview__thumb--missing', text: '🗺', 'aria-hidden': 'true' }),
      el('div', { class: 'map-preview__body' }, [
        el('span', { class: 'map-preview__year', text: formatYearRange(record.yearStart, record.yearEnd) }),
        el('span', { class: 'map-preview__title', text: record.title }),
        el('span', { class: 'map-preview__meta', text: record.institution || '' }),
      ]),
    );
    placePreview(marker);
    for (const [id, node] of markers) node.classList.toggle('is-preview', id === record.id);
  }

  /** Hover/focus card for a cluster: which maps are behind the number. */
  function showClusterPreview(cluster, marker) {
    if (!cluster) return;
    previewId = '';
    const titles = cluster.members.slice(0, 3).map((member) => member.record.title);
    const canSplit = clusterCanSplit(cluster.members, state.zoom);
    preview.replaceChildren(
      el('span', { class: 'map-preview__thumb map-preview__thumb--missing', text: '🗺', 'aria-hidden': 'true' }),
      el('div', { class: 'map-preview__body' }, [
        el('span', { class: 'map-preview__year', text: `${cluster.members.length} maps` }),
        ...titles.map((title) => el('span', { class: 'map-preview__title', text: title })),
        el('span', {
          class: 'map-preview__meta',
          text: canSplit
            ? `${cluster.members.length > titles.length ? '… ' : ''}Click to zoom in.`
            : `Click to browse these ${cluster.members.length} maps at the same location.`,
        }),
      ]),
    );
    placePreview(marker, 320);
    for (const [, node] of clusters) node.element.classList.toggle('is-preview', node === cluster);
  }

  /** The cluster whose list is open (`null` when closed) and the button to return focus to. */
  let listedCluster = null;

  function closeClusterList({ restoreFocus = false } = {}) {
    if (clusterList.hidden) return;
    const anchor = listedCluster?.element ?? null;
    clusterList.hidden = true;
    clusterList.replaceChildren();
    listedCluster = null;
    anchor?.classList.remove('is-preview');
    if (restoreFocus && anchor?.isConnected) anchor.focus();
  }

  /**
   * Open the record list of a point pile and move focus to its first row, so a
   * keyboard user reaches the hidden records with Enter and Escape gets back out
   * (no focus trap: Tab simply leaves the dialog).
   */
  function openClusterList(cluster, marker) {
    if (!cluster) return;
    const records = clusterRecords(cluster.members);
    if (records.length === 0) return;
    listedCluster = cluster;
    const title = `Maps at this location (${records.length})`;
    const hint =
      state.zoom >= MAX_ZOOM
        ? 'These maps share the same catalogue location. Choose a title from the list.'
        : 'These maps share the same catalogue location. Choose a title to see its details.';
    const rows = records.map((record) =>
      el(
        'button',
        {
          class: 'map-cluster-list__item',
          type: 'button',
          'data-record-id': record.id,
          onclick: () => chooseRecord(record),
        },
        [
          el('span', { class: 'map-cluster-list__year', text: formatYearRange(record.yearStart, record.yearEnd) }),
          el('span', { class: 'map-cluster-list__name', text: record.title }),
          el('span', {
            class: 'map-cluster-list__meta',
            text: [record.institution, record.creators?.[0]].filter(Boolean).join(' · '),
          }),
        ],
      ),
    );
    clusterList.replaceChildren(
      el('div', { class: 'map-cluster-list__head' }, [
        el('h3', { class: 'map-cluster-list__title', id: 'map-cluster-list-title', text: title }),
        el(
          'button',
          {
            class: 'map-cluster-list__close',
            type: 'button',
            'aria-label': 'Close list',
            onclick: () => closeClusterList({ restoreFocus: true }),
          },
          ['✕'],
        ),
      ]),
      el('p', { class: 'map-cluster-list__hint', text: hint }),
      el('ol', { class: 'map-cluster-list__items' }, rows.map((row) => el('li', {}, [row]))),
      state.zoom < MAX_ZOOM
        ? el('div', { class: 'map-cluster-list__foot' }, [
            el(
              'button',
              {
                class: 'zh-button zh-button--ghost zh-button--small',
                type: 'button',
                onclick: () => {
                  const target = listedCluster;
                  closeClusterList({ restoreFocus: true });
                  zoomToCluster(target);
                },
              },
              ['Zoom in anyway'],
            ),
          ])
        : null,
      el('p', {
        class: 'visuallyhidden',
        text: `${title}. ${hint}`,
      }),
    );
    placeCard(clusterList, marker, 320);
    clusterList.scrollTop = 0;
    hidePreview();
    // Keep the pin highlighted while its list is open, so the visitor can see
    // which pile the list belongs to.
    cluster.element.classList.add('is-preview');
    rows[0]?.focus();
  }

  /** A record chosen from the cluster list: same path as a marker click. */
  function chooseRecord(record) {
    closeClusterList();
    ctx.bus.emit('record:preview', { id: null });
    ctx.store.update({ selected: record.id });
    ctx.bus.emit('record:selected', { record, source: 'map-point-list' });
  }

  // Escape leaves the list and puts focus back on the cluster it came from; the
  // event is stopped so a global Escape handler (the detail panel) does not also
  // close something the visitor did not mean to close.
  clusterList.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeClusterList({ restoreFocus: true });
  });

  function templateFor(layer, time) {
    return layer.urlTemplate.replace('{Time}', encodeURIComponent(time ?? layer.timeValues?.[0] ?? 'current'));
  }

  function render() {
    hidePreview();
    closeClusterList();
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;
    const z = state.zoom;
    const scale = 2 ** z;
    const centerX = lonToTileX(state.lon, z) * TILE;
    const centerY = latToTileY(state.lat, z) * TILE;
    const originX = centerX - w / 2;
    const originY = centerY - h / 2;

    // The base layer id is part of the cache key: switching the Grundkarte must
    // never reuse a tile of the previous one.
    renderTiles(baseLayer, cache, `base:${activeBase.key}`, activeBase.urlTemplate, null, originX, originY, w, h, z, activeBase.maxZoom);
    if (state.overlay) {
      // Switching the layer or its edition replaces the overlay completely; the
      // old tiles stay in the cache (bounded) but must leave the DOM, otherwise
      // they paint over the newly requested edition.
      const overlayKey = `${state.overlay.id}@${state.overlayTime ?? ''}`;
      if (overlayKey !== lastOverlayKey) {
        overlayLayer.replaceChildren();
        lastOverlayKey = overlayKey;
      }
      renderTiles(
        overlayLayer,
        cache,
        `ov:${state.overlay.id}`,
        state.overlay.urlTemplate,
        state.overlayTime,
        originX,
        originY,
        w,
        h,
        z,
        Number(state.overlay.maxZoom ?? 18),
      );
    } else {
      overlayLayer.replaceChildren();
      lastOverlayKey = '';
    }
    renderMarkers(originX, originY, w, h, z);
    renderFootprints();
    renderExtent(originX, originY, z);
    renderPoint(originX, originY, z);
    updateBadge();
    updateVisibleCount();
    updateLive();
    ctx.bus.emit('map:rendered', { lat: state.lat, lon: state.lon, zoom: state.zoom });
  }

  function renderTiles(layerEl, tileCache, kind, template, time, originX, originY, w, h, z, maxZoom) {
    const role = kind.startsWith('ov:') ? 'overlay' : 'base';
    const tileZ = Math.min(z, Number.isFinite(maxZoom) ? maxZoom : 18);
    const scale = 2 ** tileZ;
    const visible = new Set();
    const x0 = Math.floor(originX / TILE);
    const x1 = Math.floor((originX + w - 1) / TILE);
    const y0 = Math.max(0, Math.floor(originY / TILE));
    const y1 = Math.min(scale - 1, Math.floor((originY + h - 1) / TILE));

    for (let x = x0; x <= x1; x += 1) {
      const wrapped = ((x % scale) + scale) % scale;
      for (let y = y0; y <= y1; y += 1) {
        // The Time dimension is part of the cache key – otherwise switching the
        // edition of a Zeitreise layer kept showing the previously loaded tiles.
        const key = `${kind}/${time ?? 'now'}/${tileZ}/${wrapped}/${y}`;
        visible.add(key);
        let img = tileCache.get(key);
        if (!img) {
          img = document.createElement('img');
          img.className = role === 'base' ? 'map-tile' : 'map-tile map-overlay-tile';
          img.alt = '';
          img.decoding = 'async';
          img.src = tileUrl(template, { z: tileZ, x: wrapped, y, time });
          img.addEventListener('error', () => {
            img.dataset.failed = 'true';
            img.style.visibility = 'hidden';
          });
          tileCache.set(key, img);
          layerEl.append(img);
          // keep the cache bounded
          if (tileCache.size > 240) {
            const [oldKey, oldImg] = tileCache.entries().next().value;
            if (oldKey !== key) {
              oldImg.remove();
              tileCache.delete(oldKey);
            }
          }
        } else if (img.parentElement !== layerEl) {
          // A cached tile that was detached (different zoom/pan) must be put
          // back before it can paint again.
          layerEl.append(img);
        }
        img.style.transform = `translate3d(${x * TILE - originX}px, ${y * TILE - originY}px, 0)`;
      }
    }
    // Detach every tile that is not part of the current view of this layer –
    // regardless of the cache size. Previously, tiles from an older zoom level
    // stayed in the DOM with their old transform and painted over the new tiles
    // (very visible after “Treffer einpassen” zoomed to the whole country).
    // They stay in the cache Map for reuse and are re-attached on demand.
    for (const [key, img] of tileCache) {
      if (!key.startsWith(`${kind}/`)) continue;
      if (!visible.has(key) && img.parentElement === layerEl) img.remove();
    }
  }

  function renderMarkers(originX, originY, w, h, z) {
    const selectedId = state.selected;
    const { points, unplaced } = markerPoints(state.filtered, z);
    state.unplacedRecords = unplaced;

    const inside = (x, y) => x >= 0 && y >= 0 && x <= w && y <= h;
    // Honest status line: records whose anchor is in the viewport, clustered or not.
    state.visibleRecords = points.filter((point) => inside(point.x - originX, point.y - originY)).length;

    const wantedMarkers = new Set();
    const wantedClusters = new Set();

    const ensureMarker = (point) => {
      const x = point.x - originX;
      const y = point.y - originY;
      // Only markers whose anchor is inside the viewport: a pin fully outside
      // the clipping container would be invisible while still being counted.
      if (!inside(x, y)) return;
      const { record } = point;
      wantedMarkers.add(record.id);
      let marker = markers.get(record.id);
      if (!marker) {
        marker = el('button', {
          class: 'map-marker',
          type: 'button',
          onclick: () => {
            hidePreview();
            ctx.bus.emit('record:preview', { id: null });
            ctx.store.update({ selected: record.id });
            ctx.bus.emit('record:selected', { record, source: 'map' });
          },
        });
        // Hover/focus: preview card + cross-highlight in the result list. The
        // list emits the same event, so both directions meet in the bus.
        marker.addEventListener('pointerenter', () => {
          showPreview(record, marker);
          ctx.bus.emit('record:preview', { id: record.id });
        });
        marker.addEventListener('pointerleave', () => {
          // Keep the card for a keyboard user who merely moved the mouse away.
          if (document.activeElement === marker) return;
          hidePreview();
          ctx.bus.emit('record:preview', { id: null });
        });
        marker.addEventListener('focus', () => {
          showPreview(record, marker);
          ctx.bus.emit('record:preview', { id: record.id });
        });
        marker.addEventListener('blur', () => {
          if (marker.matches(':hover')) return;
          hidePreview();
          ctx.bus.emit('record:preview', { id: null });
        });
        markers.set(record.id, marker);
        markerLayer.append(marker);
      }
      const selected = selectedId === record.id;
      marker.textContent = String(point.index + 1);
      marker.dataset.id = record.id;
      marker.title = record.title;
      marker.setAttribute('aria-label', `${point.index + 1}. ${record.title} – Open details`);
      marker.classList.toggle('is-selected', selected);
      // Inline transform wins over the class rule, so the selected scale has to
      // be part of the inline transform.
      marker.style.transform = `translate3d(${x}px, ${y}px, 0)${selected ? ' scale(1.25)' : ''}`;
    };

    const ensureCluster = (key, members, cx, cy) => {
      const x = cx - originX;
      const y = cy - originY;
      if (!inside(x, y)) return;
      wantedClusters.add(key);
      let cluster = clusters.get(key);
      if (!cluster) {
        const element = el('button', { class: 'map-marker map-cluster', type: 'button' });
        cluster = { element, members, x, y, px: cx, py: cy, key };
        element.addEventListener('click', () => activateCluster(clusters.get(key)));
        element.addEventListener('pointerenter', () => {
          if (listedCluster) return; // an open record list must not be swapped away
          showClusterPreview(clusters.get(key), element);
          ctx.bus.emit('record:preview', { id: null });
        });
        element.addEventListener('pointerleave', () => {
          if (document.activeElement === element || listedCluster) return;
          hidePreview();
        });
        element.addEventListener('focus', () => {
          if (listedCluster) return;
          showClusterPreview(clusters.get(key), element);
        });
        element.addEventListener('blur', () => {
          if (element.matches(':hover') || listedCluster) return;
          hidePreview();
        });
        clusters.set(key, cluster);
        markerLayer.append(element);
      }
      cluster.members = members;
      cluster.x = x;
      cluster.y = y;
      // Global pixels are kept separately: `x`/`y` are viewport-relative and
      // must not be used to re-centre the map.
      cluster.px = cx;
      cluster.py = cy;
      const titles = members.slice(0, 3).map((member) => member.record.title);
      const canSplit = clusterCanSplit(members, z);
      cluster.element.textContent = String(members.length);
      cluster.element.dataset.count = String(members.length);
      cluster.element.dataset.action = canSplit ? 'zoom' : 'list';
      cluster.element.title = canSplit
        ? `${members.length} maps: ${titles.join(' · ')}${members.length > titles.length ? ' …' : ''}`
        : `${members.length} maps at the same location: ${titles.join(' · ')}${members.length > titles.length ? ' …' : ''}`;
      cluster.element.setAttribute(
        'aria-label',
        canSplit
          ? `${members.length} maps in this area. Zoom in to explore. Includes: ${titles.join('; ')}${members.length > titles.length ? ' …' : ''}`
          : `${members.length} maps at the same location. Open list. Includes: ${titles.join('; ')}${members.length > titles.length ? ' …' : ''}`,
      );
      cluster.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    };

    for (const cell of clusterByCell(points)) {
      // The selected record always gets its own pin, even inside a cluster.
      const selectedMember = cell.members.find((member) => member.id === selectedId) ?? null;
      const rest = cell.members.filter((member) => member !== selectedMember);
      if (selectedMember) ensureMarker(selectedMember);
      if (rest.length === 1) ensureMarker(rest[0]);
      else if (rest.length > 1) {
        const cx = rest.reduce((sum, member) => sum + member.x, 0) / rest.length;
        const cy = rest.reduce((sum, member) => sum + member.y, 0) / rest.length;
        ensureCluster(cell.key, rest, cx, cy);
      }
    }

    for (const [id, marker] of markers) {
      if (!wantedMarkers.has(id)) {
        if (id === previewId) hidePreview();
        marker.remove();
        markers.delete(id);
      }
    }
    for (const [key, cluster] of clusters) {
      if (!wantedClusters.has(key)) {
        cluster.element.classList.remove('is-preview');
        cluster.element.remove();
        clusters.delete(key);
      }
    }
  }

  /** Two (three for big clusters) steps closer to a cluster's centre. */
  function zoomToCluster(cluster) {
    if (!cluster || cluster.members.length === 0) return;
    hidePreview();
    closeClusterList();
    state.lon = tileXToLon(cluster.px / TILE, state.zoom);
    state.lat = tileYToLat(cluster.py / TILE, state.zoom);
    state.zoom = Math.max(2, Math.min(MAX_ZOOM, state.zoom + (cluster.members.length > 8 ? 3 : 2)));
    render();
    push();
  }

  /**
   * What a click (or Enter) on a cluster does. Zooming in is the OldMapsOnline
   * gesture and stays the default; it only gives way to the record list when
   * `clusterCanSplit` proves that the members share one documented point (or the
   * map is already at MAX_ZOOM) — otherwise those records would stay behind the
   * number forever.
   */
  function activateCluster(cluster) {
    if (!cluster) return;
    if (clusterCanSplit(cluster.members, state.zoom)) zoomToCluster(cluster);
    else openClusterList(cluster, cluster.element);
  }

  /**
   * “Ausschnitte”: draw the documented extent of every filtered record.
   *
   * The layer answers the question the point filter asks — “which maps claim to
   * cover this place?” — and makes the viewport filter visible. It is purely
   * visual (pointer-events: none) so a map click keeps setting the point filter;
   * the result list stays the accessible way to select a record. Existing
   * elements are reused, so panning/zooming only rewrites transforms.
   */
  function renderFootprints() {
    const on = state.extents === '1';
    const info = on
      ? extentRects(state.filtered, { lat: state.lat, lon: state.lon, zoom: state.zoom }, { width: container.clientWidth || 640, height: container.clientHeight || 420 })
      : { rects: [], visible: 0, areas: 0, withExtent: 0, filtered: state.filtered.length };
    const wanted = new Set();
    for (const [rank, rect] of info.rects.entries()) {
      wanted.add(rect.key);
      let node = footprints.get(rect.key);
      if (!node) {
        node = el('div', { class: 'map-footprint' });
        node.dataset.recordIds = rect.ids.join(' ');
        footprints.set(rect.key, node);
        footprintLayer.append(node);
      }
      node.style.transform = `translate3d(${Math.round(rect.left)}px, ${Math.round(rect.top)}px, 0)`;
      node.style.width = `${Math.max(1, Math.round(rect.width))}px`;
      node.style.height = `${Math.max(1, Math.round(rect.height))}px`;
      // Larger footprints sit below smaller ones (rank 0 = largest) and repeat
      // the number of records that share exactly this extent.
      node.style.zIndex = String(Math.max(1, 400 - rank));
      node.classList.toggle('is-selected', rect.ids.includes(state.selected));
      node.classList.toggle('is-preview', rect.ids.includes(previewId));
    }
    for (const [key, node] of footprints) {
      if (!wanted.has(key)) {
        node.remove();
        footprints.delete(key);
      }
    }
    updateExtentCount(info, on);
  }

  /**
   * Honest status line for the footprint layer: how many of the filtered records
   * state an extent at all, and how many distinct rectangles the view shows.
   */
  function updateExtentCount(info, on) {
    const host = qs('#map-extent-count');
    if (!host) return;
    if (!on || info.filtered === 0) {
      host.textContent = '';
      return;
    }
    const parts = [`Footprints: ${info.withExtent} of ${info.filtered} filtered maps with documented extents`];
    parts.push(info.areas < info.visible ? `${info.visible} in view, grouped into ${info.areas} areas` : `${info.visible} in view`);
    if (info.rects.length < info.areas) parts.push(`showing the ${info.rects.length} largest areas`);
    host.textContent = `${parts.join(' · ')}.`;
  }

  /** The visible chips, the URL and the inline link are views of one switch. */
  function syncExtentChip() {
    const on = state.extents === '1';
    for (const chip of document.querySelectorAll('[data-map-cmd="extents"]')) {
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      // The chip states the action; the inline link in the hint keeps its label.
      if (chip.dataset.mapCmdLabel !== 'fixed') chip.textContent = on ? 'Hide footprints' : 'Show footprints';
    }
  }

  /* ---------------- Grundkarte (base map) ---------------- */

  const baseSwitch = qs('#base-layer-switch');

  /**
   * The base-map chips are built from BASE_LAYERS, so the control cannot drift
   * from the layers the renderer actually knows. One `aria-pressed` chip is on,
   * and the accessible name repeats the action: “Basemap: <layer>”.
   */
  function syncBaseChips() {
    if (!baseSwitch) return;
    if (baseSwitch.childElementCount === 0) {
      baseSwitch.replaceChildren(
        ...BASE_LAYERS.map((layer) =>
          el(
            'button',
            {
              class: 'zh-chip',
              type: 'button',
              'data-base-key': layer.key, // the switch is handled here, not by the generic data-map-cmd loop
              title: `${layer.hint} (${layer.id})`,
              'aria-pressed': 'false',
              onclick: () => ctx.store.update({ base: layer.key === DEFAULT_BASE.key ? '' : layer.key }),
            },
            [layer.chip],
          ),
        ),
      );
    }
    for (const chip of baseSwitch.querySelectorAll('[data-base-key]')) {
      const layer = baseLayerFor(chip.dataset.baseKey);
      const on = layer.key === activeBase.key;
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
      // Toggle-button pattern: `aria-pressed` carries the state, so the
      // accessible name only says what the switch controls.
      chip.setAttribute('aria-label', `Basemap: ${layer.title}${layer.coverage ? ` (${layer.coverage} only)` : ' (worldwide)'}`);
    }
  }

  /**
   * Switch the base map. The tiles of the previous layer are dropped from the
   * DOM (the cache keeps them keyed by layer, so switching back is cheap), and
   * nothing else in the view moves: markers, footprints and the point filter
   * keep their positions because pan/zoom did not change.
   */
  function setBase(key) {
    const next = baseLayerFor(key);
    if (next.key === activeBase.key) {
      syncBaseChips();
      return;
    }
    activeBase = next;
    baseLayer.replaceChildren();
    syncBaseChips();
    render();
  }

  function renderExtent(originX, originY, z) {
    shapeLayer.replaceChildren();
    const record = ctx.data.recordIndex?.get(state.selected) ?? state.records.find((r) => r.id === state.selected);
    if (!record?.extent) return;
    const { west, east, south, north } = record.extent;
    const x1 = lonToTileX(west, z) * TILE - originX;
    const x2 = lonToTileX(east, z) * TILE - originX;
    const y1 = latToTileY(north, z) * TILE - originY;
    const y2 = latToTileY(south, z) * TILE - originY;
    if (![x1, x2, y1, y2].every(Number.isFinite) || x2 - x1 > container.clientWidth * 200) return;
    shapeLayer.append(
      el('div', {
        class: 'map-extent',
        style: `left:${Math.min(x1, x2)}px; top:${Math.min(y1, y2)}px; width:${Math.abs(x2 - x1)}px; height:${Math.abs(y2 - y1)}px`,
      }),
    );
  }

  /** Crosshair for the active point filter; rendered on top of the selected extent. */
  function renderPoint(originX, originY, z) {
    const point = parsePoint(state.at);
    if (!point) return;
    const x = lonToTileX(point.lon, z) * TILE - originX;
    const y = latToTileY(point.lat, z) * TILE - originY;
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < -24 || y < -24 || x > w + 24 || y > h + 24) return;
    shapeLayer.append(
      el('div', {
        class: 'map-point',
        'data-at': state.at,
        'aria-hidden': 'true',
        title: `Point filter: ${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}°`,
        style: `transform: translate3d(${x}px, ${y}px, 0)`,
      }),
    );
  }

  function updateBadge() {
    const items = [
      el('span', { class: 'zh-tag', text: activeBase.attribution }),
      state.overlay ? el('span', { class: 'zh-tag zh-tag--solid', text: `${state.overlay.title}${state.overlayTime ? ` · ${formatTime(state.overlayTime)}` : ''}` }) : null,
    ].filter(Boolean);
    badge.replaceChildren(...items);
    const extra = qs('#map-attribution-extra');
    if (extra) {
      extra.textContent = state.overlay
        ? `Overlay: ${state.overlay.title} (${state.overlay.attribution ?? 'see original source'})`
        : (activeBase.resolution ? `Satellite detail: ${activeBase.resolution}; imagery is enlarged at closer zooms.` : '');
    }
  }

  function updateLive() {
    live.textContent = `Map centre: ${state.lat.toFixed(3)}° latitude, ${state.lon.toFixed(3)}° longitude, zoom ${state.zoom}.`;
  }

  /** Tell the user how many of the filtered records are pins in this viewport. */
  function updateVisibleCount() {
    const host = qs('#map-visible-count');
    if (!host) return;
    const visible = state.visibleRecords ?? 0;
    const total = state.filtered.length;
    // Records without any documented position can never become a pin; say so
    // rather than letting the counts read as if the map showed everything.
    const unplaced = state.unplacedRecords ?? 0;
    const unplacedNote = unplaced > 0 ? ` · ${unplaced} without a documented location.` : '';
    host.textContent =
      total === 0
        ? ''
        : visible === 0
          ? `No filtered maps in this view. Use “Fit results” to find them.${unplacedNote}`
          : `${visible} of ${total} filtered maps in this view.${unplacedNote}`;
  }

  const push = debounce(() => {
    ctx.store.update({ lat: state.lat, lon: state.lon, zoom: state.zoom });
    ctx.bus.emit('map:moved', { lat: state.lat, lon: state.lon, zoom: state.zoom, bounds: currentBounds() });
  }, 220);

  function currentBounds() {
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;
    const scale = 2 ** state.zoom;
    const cx = lonToTileX(state.lon, state.zoom);
    const cy = latToTileY(state.lat, state.zoom);
    return {
      west: tileXToLon(cx - w / 2 / TILE, state.zoom),
      east: tileXToLon(cx + w / 2 / TILE, state.zoom),
      north: tileYToLat(cy - h / 2 / TILE, state.zoom),
      south: tileYToLat(cy + h / 2 / TILE, state.zoom),
    };
  }

  function zoomBy(delta, clientX, clientY) {
    const next = Math.max(2, Math.min(18, state.zoom + delta));
    if (next === state.zoom) return;
    if (clientX === undefined) {
      state.zoom = next;
    } else {
      // Keep the geo position under the cursor stable.
      const rect = container.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      const cx = lonToTileX(state.lon, state.zoom) * TILE;
      const cy = latToTileY(state.lat, state.zoom) * TILE;
      const offsetX = clientX - rect.left - w / 2;
      const offsetY = clientY - rect.top - h / 2;
      const lonAtCursor = tileXToLon((cx + offsetX) / TILE, state.zoom);
      const latAtCursor = tileYToLat((cy + offsetY) / TILE, state.zoom);
      state.zoom = next;
      const ncx = lonToTileX(lonAtCursor, next) * TILE;
      const ncy = latToTileY(latAtCursor, next) * TILE;
      state.lon = tileXToLon((ncx - offsetX) / TILE, next);
      state.lat = tileYToLat((ncy - offsetY) / TILE, next);
    }
    render();
    push();
  }

  function panByPixels(dx, dy) {
    const cx = lonToTileX(state.lon, state.zoom) * TILE - dx;
    const cy = latToTileY(state.lat, state.zoom) * TILE - dy;
    state.lon = tileXToLon(cx / TILE, state.zoom);
    state.lat = tileYToLat(cy / TILE, state.zoom);
    render();
    push();
  }

  /**
   * Point filter: only records whose documented extent covers this point stay in
   * the result list. The map only writes state (shareable, one source of truth);
   * results.js renders the chip and filters.
   */
  function setPoint(lat, lon, source = 'map') {
    const at = sanitisePoint(`${lat},${lon}`);
    if (!at) return;
    ctx.store.update({ at });
    ctx.bus.emit('point:selected', { at, source });
  }

  /** Client coordinates -> geo point -> point filter. Used by a real map click. */
  function setPointFromClient(clientX, clientY) {
    const rect = container.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return;
    const cx = lonToTileX(state.lon, state.zoom) * TILE;
    const cy = latToTileY(state.lat, state.zoom) * TILE;
    const lon = tileXToLon((cx + (clientX - rect.left) - rect.width / 2) / TILE, state.zoom);
    const lat = tileYToLat((cy + (clientY - rect.top) - rect.height / 2) / TILE, state.zoom);
    setPoint(lat, lon, 'map-click');
  }

  function fitBounds(bounds, { padding = 48, maxZoom = 15 } = {}) {
    if (!bounds) return;
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;
    const lonSpan = Math.max(0.0005, bounds.east - bounds.west);
    const latSpan = Math.max(0.0005, bounds.north - bounds.south);
    const zx = Math.log2(((w - padding * 2) / TILE) * (360 / lonSpan));
    const zy = Math.log2(((h - padding * 2) / TILE) * (360 / latSpan));
    state.zoom = Math.max(2, Math.min(maxZoom, Math.min(18, Math.floor(Math.min(zx, zy)))));
    state.lat = Math.max(-85, Math.min(85, (bounds.south + bounds.north) / 2));
    state.lon = ((bounds.west + bounds.east) / 2 + 540) % 360 - 180;
    render();
    push();
  }

  function setOverlay(layer, time) {
    state.overlay = layer?.kind === 'cog' ? null : (layer ?? null);
    state.overlayTime = time ?? null;
    render();
  }

  function formatTime(value) {
    const text = String(value);
    if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    if (/^\d{4}$/.test(text)) return text;
    return text === 'current' ? 'current' : text;
  }

  /* ---------------- interaction ---------------- */

  let dragging = null;
  const DRAG_THRESHOLD = 4; // px: below this a pointer gesture is a click, not a pan
  container.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, a, select, input')) return;
    // Clicks on the “Karten an diesem Punkt” list are picks, not map gestures.
    if (event.target.closest('.map-cluster-list')) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    dragging = { startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
    container.classList.add('is-dragging');
    container.setPointerCapture?.(event.pointerId);
  });
  container.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const dx = event.clientX - dragging.x;
    const dy = event.clientY - dragging.y;
    if (!dragging.moved && Math.hypot(event.clientX - dragging.startX, event.clientY - dragging.startY) > DRAG_THRESHOLD) {
      dragging.moved = true;
    }
    dragging = { ...dragging, x: event.clientX, y: event.clientY };
    const cx = lonToTileX(state.lon, state.zoom) * TILE - dx;
    const cy = latToTileY(state.lat, state.zoom) * TILE - dy;
    state.lon = tileXToLon(cx / TILE, state.zoom);
    state.lat = tileYToLat(cy / TILE, state.zoom);
    render();
    push();
  });
  const endDrag = (event, { allowClick = false } = {}) => {
    if (!dragging) return;
    const wasClick = allowClick && !dragging.moved;
    dragging = null;
    container.classList.remove('is-dragging');
    push.flush();
    // A click that did not pan the map selects the point under the pointer for
    // the point filter (OldMapsOnline's “browse maps at this place” gesture).
    if (wasClick && event && !event.target?.closest?.('.map-cluster-list')) setPointFromClient(event.clientX, event.clientY);
  };
  container.addEventListener('pointerup', (event) => endDrag(event, { allowClick: true }));
  container.addEventListener('pointercancel', () => endDrag());
  container.addEventListener('lostpointercapture', () => endDrag());

  container.addEventListener(
    'wheel',
    (event) => {
      // A wheel gesture inside the record list scrolls the list, it does not zoom.
      if (event.target.closest?.('.map-cluster-list')) return;
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
    },
    { passive: false },
  );

  container.addEventListener('dblclick', (event) => {
    if (event.target.closest('button, .map-cluster-list')) return;
    zoomBy(1, event.clientX, event.clientY);
  });

  container.addEventListener('keydown', (event) => {
    // Arrow keys only move the map while the map region itself has focus; on a
    // marker button they would move the button's anchor out from under the user.
    if (event.target !== container) return;
    const step = event.shiftKey ? 160 : 60;
    const keys = {
      ArrowLeft: () => panByPixels(-step, 0),
      ArrowRight: () => panByPixels(step, 0),
      ArrowUp: () => panByPixels(0, -step),
      ArrowDown: () => panByPixels(0, step),
      '+': () => zoomBy(1),
      '=': () => zoomBy(1),
      '-': () => zoomBy(-1),
      _: () => zoomBy(-1),
      Home: () => {
        Object.assign(state, { ...WORLD });
        render();
        push();
      },
      End: () => fitBounds(resultsBounds(), { maxZoom: 12 }),
      p: () => setPoint(state.lat, state.lon, 'keyboard'),
      P: () => setPoint(state.lat, state.lon, 'keyboard'),
    };
    const action = keys[event.key];
    if (!action) return;
    event.preventDefault();
    action();
  });

  for (const button of document.querySelectorAll('[data-map-cmd]')) {
    button.addEventListener('click', () => {
      const cmd = button.dataset.mapCmd;
      if (cmd === 'in') zoomBy(1);
      if (cmd === 'out') zoomBy(-1);
      if (cmd === 'world') {
        Object.assign(state, { ...WORLD });
        render();
        push();
      }
      if (cmd === 'fitresults') fitBounds(resultsBounds(), { maxZoom: 12 });
      if (cmd === 'point') setPoint(state.lat, state.lon, 'button');
      // “Ausschnitte”: the switch lives in the store, so the chip, the URL
      // (?ex=1) and every other module see the same state.
      if (cmd === 'extents') ctx.store.update({ extents: state.extents === '1' ? '' : '1' });
    });
  }

  const resultsBounds = () => {
    const boxes = state.filtered.map((r) => r.extent).filter(Boolean);
    if (boxes.length === 0) {
      const points = state.filtered.map(recordCenter).filter(Boolean);
      if (points.length === 0) return WORLD_BOUNDS;
      return {
        west: Math.min(...points.map((p) => p.lon)) - 0.2,
        east: Math.max(...points.map((p) => p.lon)) + 0.2,
        south: Math.min(...points.map((p) => p.lat)) - 0.2,
        north: Math.max(...points.map((p) => p.lat)) + 0.2,
      };
    }
    return {
      west: Math.min(...boxes.map((b) => b.west)),
      east: Math.max(...boxes.map((b) => b.east)),
      south: Math.min(...boxes.map((b) => b.south)),
      north: Math.max(...boxes.map((b) => b.north)),
    };
  };

  /* ---------------- store / bus wiring ---------------- */

  ctx.store.subscribe((next, changed) => {
    if (changed.includes('at') && next.at !== state.at) {
      state.at = next.at;
      render();
    }
    if (changed.includes('extents') && next.extents !== state.extents) {
      state.extents = next.extents;
      syncExtentChip();
      render();
    }
    if (changed.includes('base') && baseLayerFor(next.base).key !== activeBase.key) setBase(next.base);
    const interesting = changed.filter((key) => ['lat', 'lon', 'zoom'].includes(key));
    if (interesting.length === 0) return;
    if (Math.abs(next.lat - state.lat) < 1e-6 && Math.abs(next.lon - state.lon) < 1e-6 && Math.round(next.zoom) === state.zoom) return;
    state.lat = next.lat;
    state.lon = next.lon;
    state.zoom = Math.round(next.zoom);
    render();
  });

  ctx.bus.on('records:loaded', ({ records }) => {
    state.records = records;
    render();
  });
  ctx.bus.on('records:filtered', ({ records }) => {
    state.filtered = records;
    render();
  });
  ctx.bus.on('record:selected', ({ record }) => {
    state.selected = record?.id ?? '';
    const center = recordCenter(record);
    if (center) {
      const rect = container.getBoundingClientRect();
      const x = lonToTileX(center.lon, state.zoom) * TILE - (lonToTileX(state.lon, state.zoom) * TILE - rect.width / 2);
      const y = latToTileY(center.lat, state.zoom) * TILE - (latToTileY(state.lat, state.zoom) * TILE - rect.height / 2);
      const margin = 60;
      if (x < margin || y < margin || x > rect.width - margin || y > rect.height - margin) {
        state.lat = center.lat;
        state.lon = center.lon;
        state.zoom = Math.max(state.zoom, 10);
        render();
        push();
        return;
      }
    }
    render();
  });
  ctx.bus.on('record:deselected', () => {
    state.selected = '';
    render();
  });
  // Hovering/focusing a row in the result list highlights the matching marker
  // or the cluster that contains it.
  ctx.bus.on('record:preview', ({ id }) => {
    for (const [markerId, marker] of markers) marker.classList.toggle('is-preview', Boolean(id) && markerId === id);
    for (const [, node] of footprints) {
      node.classList.toggle('is-preview', Boolean(id) && (node.dataset.recordIds ?? '').split(' ').includes(id));
    }
    for (const [, cluster] of clusters) {
      cluster.element.classList.toggle('is-preview', Boolean(id) && cluster.members.some((member) => member.id === id));
    }
  });
  ctx.bus.on('place:selected', ({ lat, lon, zoom }) => {
    state.lat = lat;
    state.lon = lon;
    state.zoom = Math.max(4, Math.min(18, Math.round(zoom ?? 12)));
    render();
    push.flush();
  });
  ctx.bus.on('overlay:changed', ({ layer, time }) => setOverlay(layer, time));
  ctx.bus.on('overlay:time', ({ time }) => {
    state.overlayTime = time;
    render();
  });
  ctx.bus.on('overlay:opacity', ({ opacity }) => {
    overlayLayer.style.opacity = String(Math.max(0.1, Math.min(1, Number(opacity) || 0.85)));
  });
  ctx.bus.on('view:fit', ({ bounds }) => fitBounds(bounds, { maxZoom: 12 }));

  const resize = debounce(() => render(), 120);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(container);
  else window.addEventListener('resize', resize);

  syncExtentChip();
  syncBaseChips();
  render();

  ctx.map = {
    render,
    fitBounds,
    zoomBy,
    setPoint,
    setOverlay,
    setBase,
    setExtents: (on) => ctx.store.update({ extents: on ? '1' : '' }),
    getView: () => ({ ...state, base: activeBase.key }),
    baseLayers: BASE_LAYERS,
    getBase: () => activeBase,
    getMarkers: () => ({
      individual: markers.size,
      clusters: clusters.size,
      clustered: [...clusters.values()].reduce((sum, cluster) => sum + cluster.members.length, 0),
    }),
    currentBounds,
    resultsBounds,
    baseLayer: BASE_LAYER,
  };
  return ctx.map;
}
