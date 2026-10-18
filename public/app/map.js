/**
 * Interactive map: a dependency-free slippy map (Web Mercator, 256 px tiles)
 * fed by swisstopo WMTS geoservices, plus historical comparison layers.
 *
 * Deliberately small and explicit instead of vendoring a whole map library:
 *   - base: Landeskarte (swisstopo `ch.swisstopo.pixelkarte-farbe`)
 *   - comparison: any layer from /data/overlays.json (Zeitreise, Dufour, Siegfried, …)
 *   - markers: records with a documented point/bbox (public/app/records.js)
 *
 * Keyboard: the container is focusable; arrows pan, +/- zoom, Home = Zürich,
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

/** Base map: documented swisstopo WMTS tile template (CORS `*`, OGD). */
export const BASE_LAYER = {
  id: 'ch.swisstopo.pixelkarte-farbe',
  title: 'Landeskarte (swisstopo)',
  urlTemplate:
    'https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-farbe/default/current/3857/{TileMatrix}/{TileCol}/{TileRow}.jpeg',
  maxZoom: 18,
  attribution: '© swisstopo – Landeskarte',
};

export const ZURICH = { lat: 47.3769, lon: 8.5417, zoom: 12 };
export const SWITZERLAND = { west: 5.140242, east: 11.47757, south: 45.398181, north: 48.230651 };

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

/** Tile URL from a WMTS template with {TileMatrix}/{TileCol}/{TileRow}/{Time}. */
export function tileUrl(template, { z, x, y, time }) {
  return template
    .replace('{TileMatrix}', String(z))
    .replace('{TileCol}', String(x))
    .replace('{TileRow}', String(y))
    .replace('{Time}', encodeURIComponent(time ?? 'current'));
}

/** Grid size (px) used to group markers that would overlap at the current zoom. */
export const CLUSTER_CELL = 56;

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
    overlay: null,
    overlayTime: null,
    records: [],
    filtered: [],
    selected: '',
    visibleRecords: 0,
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
  container.setAttribute('aria-roledescription', 'Interaktive Karte');
  container.setAttribute('aria-label', 'Karte historischer Kartenwerke; Pfeiltasten verschieben, Plus und Minus zoomen, Home zeigt Zürich, Ende passt alle Treffer ein, P filtert auf die Kartenmitte. Ein Klick auf die Karte filtert die Treffer auf den angeklickten Punkt.');

  const baseLayer = el('div', { class: 'map-layer map-layer--base', 'aria-hidden': 'true' });
  const overlayLayer = el('div', { class: 'map-layer map-layer--overlay', 'aria-hidden': 'true' });
  const shapeLayer = el('div', { class: 'map-layer map-layer--shapes', 'aria-hidden': 'true' });
  const markerLayer = el('div', { class: 'map-layer map-layer--markers' });
  const live = el('p', { class: 'visuallyhidden', role: 'status', 'aria-live': 'polite' });
  const badge = el('div', { class: 'map-badge' });
  const controls = el('div', { class: 'map-controls' }, [
    el('button', { class: 'zh-button zh-button--small', type: 'button', title: 'Hineinzoomen', 'aria-label': 'Hineinzoomen', onclick: () => zoomBy(1) }, ['+']),
    el('button', { class: 'zh-button zh-button--small', type: 'button', title: 'Herauszoomen', 'aria-label': 'Herauszoomen', onclick: () => zoomBy(-1) }, ['−']),
    el(
      'button',
      {
        class: 'zh-button zh-button--small',
        type: 'button',
        title: 'Alle Treffer einpassen',
        'aria-label': 'Alle Treffer einpassen',
        onclick: () => fitBounds(resultsBounds(), { maxZoom: 12 }),
      },
      ['⤢'],
    ),
    el(
      'button',
      {
        class: 'zh-button zh-button--small',
        type: 'button',
        title: 'Punktfilter auf die Kartenmitte setzen (ohne Maus)',
        'aria-label': 'Punktfilter auf die Kartenmitte setzen',
        onclick: () => setPoint(state.lat, state.lon, 'center'),
      },
      ['⌖'],
    ),
  ]);

  // Visual hover/focus card for a marker. Decorative: the marker's accessible
  // name and the result list already carry the same information.
  const preview = el('div', { class: 'map-preview', 'aria-hidden': 'true', hidden: true });

  container.replaceChildren(baseLayer, overlayLayer, shapeLayer, markerLayer, controls, badge, preview, live);

  const cache = new Map(); // tile key -> <img>
  const markers = new Map(); // record id -> <button>
  const clusters = new Map(); // cell key -> { element, members, x, y }
  let lastOverlayKey = ''; // layer + edition currently displayed
  let previewId = ''; // record id whose preview card is visible

  const PREVIEW_WIDTH = 248;

  function hidePreview() {
    if (preview.hidden) return;
    preview.hidden = true;
    preview.replaceChildren();
    previewId = '';
    for (const [, marker] of markers) marker.classList.remove('is-preview');
    for (const [, cluster] of clusters) cluster.element.classList.remove('is-preview');
  }

  /** Position the hover/focus card above a marker, clamped into the map. */
  function placePreview(marker, width = PREVIEW_WIDTH) {
    const mapRect = container.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const finalWidth = Math.min(width, Math.max(160, mapRect.width - 16));
    const left = Math.max(8, Math.min(mapRect.width - finalWidth - 8, markerRect.left - mapRect.left + markerRect.width / 2 - finalWidth / 2));
    preview.style.width = `${finalWidth}px`;
    preview.hidden = false;
    const topAbove = markerRect.top - mapRect.top - preview.offsetHeight - 12;
    preview.style.left = `${Math.round(left)}px`;
    preview.style.top = `${Math.round(topAbove >= 8 ? topAbove : markerRect.bottom - mapRect.top + 12)}px`;
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
    preview.replaceChildren(
      el('span', { class: 'map-preview__thumb map-preview__thumb--missing', text: '🗺', 'aria-hidden': 'true' }),
      el('div', { class: 'map-preview__body' }, [
        el('span', { class: 'map-preview__year', text: `${cluster.members.length} Karten` }),
        ...titles.map((title) => el('span', { class: 'map-preview__title', text: title })),
        el('span', {
          class: 'map-preview__meta',
          text: `${cluster.members.length > titles.length ? '… ' : ''}Klicken vergrössert die Ansicht.`,
        }),
      ]),
    );
    placePreview(marker, 320);
    for (const [, node] of clusters) node.element.classList.toggle('is-preview', node === cluster);
  }

  function templateFor(layer, time) {
    return layer.urlTemplate.replace('{Time}', encodeURIComponent(time ?? layer.timeValues?.[0] ?? 'current'));
  }

  function render() {
    hidePreview();
    const w = container.clientWidth || 640;
    const h = container.clientHeight || 420;
    const z = state.zoom;
    const scale = 2 ** z;
    const centerX = lonToTileX(state.lon, z) * TILE;
    const centerY = latToTileY(state.lat, z) * TILE;
    const originX = centerX - w / 2;
    const originY = centerY - h / 2;

    renderTiles(baseLayer, cache, 'base', BASE_LAYER.urlTemplate, null, originX, originY, w, h, z, scale);
    if (state.overlay) {
      // Switching the layer or its edition replaces the overlay completely; the
      // old tiles stay in the cache (bounded) but must leave the DOM, otherwise
      // they paint over the newly requested edition.
      const overlayKey = `${state.overlay.id}@${state.overlayTime ?? ''}`;
      if (overlayKey !== lastOverlayKey) {
        overlayLayer.replaceChildren();
        lastOverlayKey = overlayKey;
      }
      renderTiles(overlayLayer, cache, `ov:${state.overlay.id}`, state.overlay.urlTemplate, state.overlayTime, originX, originY, w, h, z, scale);
    } else {
      overlayLayer.replaceChildren();
      lastOverlayKey = '';
    }
    renderMarkers(originX, originY, w, h, z);
    renderExtent(originX, originY, z);
    renderPoint(originX, originY, z);
    updateBadge();
    updateVisibleCount();
    updateLive();
  }

  function renderTiles(layerEl, tileCache, kind, template, time, originX, originY, w, h, z, scale) {
    const maxZoom = kind === 'base' ? BASE_LAYER.maxZoom : Number(state.overlay?.maxZoom ?? 18);
    const tileZ = Math.min(z, maxZoom);
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
          img.className = kind === 'base' ? 'map-tile' : 'map-tile map-overlay-tile';
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
    const points = [];
    state.filtered.slice(0, 300).forEach((record, index) => {
      const center = recordCenter(record);
      if (!center) return;
      points.push({
        id: record.id,
        record,
        index,
        x: lonToTileX(center.lon, z) * TILE,
        y: latToTileY(center.lat, z) * TILE,
      });
    });

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
      marker.setAttribute('aria-label', `${point.index + 1}. ${record.title} – Details öffnen`);
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
        element.addEventListener('click', () => zoomIntoCluster(clusters.get(key)));
        element.addEventListener('pointerenter', () => {
          showClusterPreview(clusters.get(key), element);
          ctx.bus.emit('record:preview', { id: null });
        });
        element.addEventListener('pointerleave', () => {
          if (document.activeElement === element) return;
          hidePreview();
        });
        element.addEventListener('focus', () => showClusterPreview(clusters.get(key), element));
        element.addEventListener('blur', () => {
          if (element.matches(':hover')) return;
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
      cluster.element.textContent = String(members.length);
      cluster.element.dataset.count = String(members.length);
      cluster.element.title = `${members.length} Karten: ${titles.join(' · ')}${members.length > titles.length ? ' …' : ''}`;
      cluster.element.setAttribute(
        'aria-label',
        `${members.length} Karten in diesem Bereich – Ansicht vergrössern. Enthält: ${titles.join('; ')}${members.length > titles.length ? ' …' : ''}`,
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

  /** Clicking a cluster zooms two steps further into its centre. */
  function zoomIntoCluster(cluster) {
    if (!cluster || cluster.members.length === 0) return;
    hidePreview();
    state.lon = tileXToLon(cluster.px / TILE, state.zoom);
    state.lat = tileYToLat(cluster.py / TILE, state.zoom);
    state.zoom = Math.max(2, Math.min(18, state.zoom + (cluster.members.length > 8 ? 3 : 2)));
    render();
    push();
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
        title: `Punktfilter: ${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}°`,
        style: `transform: translate3d(${x}px, ${y}px, 0)`,
      }),
    );
  }

  function updateBadge() {
    const items = [
      el('span', { class: 'zh-tag', text: BASE_LAYER.attribution }),
      state.overlay ? el('span', { class: 'zh-tag zh-tag--solid', text: `${state.overlay.title}${state.overlayTime ? ` · ${formatTime(state.overlayTime)}` : ''}` }) : null,
    ].filter(Boolean);
    badge.replaceChildren(...items);
    const extra = qs('#map-attribution-extra');
    if (extra) {
      extra.textContent = state.overlay
        ? `Ebene: ${state.overlay.title} (${state.overlay.attribution ?? '© swisstopo'})`
        : '';
    }
  }

  function updateLive() {
    live.textContent = `Kartenausschnitt: ${state.lat.toFixed(3)}° N, ${state.lon.toFixed(3)}° O, Zoomstufe ${state.zoom}.`;
  }

  /** Tell the user how many of the filtered records are pins in this viewport. */
  function updateVisibleCount() {
    const host = qs('#map-visible-count');
    if (!host) return;
    const visible = state.visibleRecords ?? 0;
    const total = state.filtered.length;
    host.textContent =
      total === 0
        ? ''
        : visible === 0
          ? 'Keine der gefilterten Karten liegen in diesem Ausschnitt – «Treffer einpassen» zeigt sie.'
          : `${visible} von ${total} gefilterten Karten in diesem Ausschnitt.`;
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
    state.overlay = layer ?? null;
    state.overlayTime = time ?? null;
    render();
  }

  function formatTime(value) {
    const text = String(value);
    if (/^\d{8}$/.test(text)) return `${text.slice(6, 8)}.${text.slice(4, 6)}.${text.slice(0, 4)}`;
    if (/^\d{4}$/.test(text)) return text;
    return text === 'current' ? 'aktuell' : text;
  }

  /* ---------------- interaction ---------------- */

  let dragging = null;
  const DRAG_THRESHOLD = 4; // px: below this a pointer gesture is a click, not a pan
  container.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, a, select, input')) return;
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
    if (wasClick && event) setPointFromClient(event.clientX, event.clientY);
  };
  container.addEventListener('pointerup', (event) => endDrag(event, { allowClick: true }));
  container.addEventListener('pointercancel', () => endDrag());
  container.addEventListener('lostpointercapture', () => endDrag());

  container.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? 1 : -1, event.clientX, event.clientY);
    },
    { passive: false },
  );

  container.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
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
        Object.assign(state, { ...ZURICH, zoom: 12 });
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
      if (cmd === 'zurich') {
        Object.assign(state, { ...ZURICH });
        state.zoom = 12;
        render();
        push();
      }
      if (cmd === 'fitswitzerland') fitBounds(SWITZERLAND, { maxZoom: 8 });
      if (cmd === 'fitresults') fitBounds(resultsBounds(), { maxZoom: 12 });
      if (cmd === 'point') setPoint(state.lat, state.lon, 'button');
    });
  }

  const resultsBounds = () => {
    const boxes = state.filtered.map((r) => r.extent).filter(Boolean);
    if (boxes.length === 0) {
      const points = state.filtered.map(recordCenter).filter(Boolean);
      if (points.length === 0) return SWITZERLAND;
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

  render();

  ctx.map = {
    render,
    fitBounds,
    zoomBy,
    setPoint,
    setOverlay,
    getView: () => ({ ...state }),
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
