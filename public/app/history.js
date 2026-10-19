/**
 * Historical borders view — the world-history map with a year control.
 *
 * Data: aourednik/historical-basemaps (GPL-3.0-or-later), harvested by
 * `scripts/harvest-history.mjs` into `public/data/history/`. One discrete
 * snapshot per published year; the nearest snapshot is drawn for a year in
 * between and the view always names the snapshot it represents — the dataset
 * has snapshots, not continuous validity ranges.
 *
 * The module is self-contained: it creates its own section inside `#main`, its
 * own map renderer (canvas, Web Mercator, no tiles — modern coastlines would be
 * a lie under historical borders) and its own controls. It shares the archive
 * shell's URL state through `store.js` (`view`, `year`, `hv`).
 *
 * Everything that does not touch the DOM is exported, so `node --test` can
 * check the projection, the snapshot resolution and the honesty rules.
 */

import { stateToQuery } from './store.js';

export const DATA_ROOT = '/data/history/';
export const INDEX_URL = `${DATA_ROOT}index.json`;
/** Border precision values of the dataset (0 = not stated). */
export const PRECISION_LABELS = Object.freeze({
  1: 'approximate (1/3)',
  2: 'moderately precise (2/3)',
  3: 'determined by international law (3/3)',
  0: 'not stated by the source',
});

/* ------------------------------------------------------------------ *
 * pure helpers                                                        *
 * ------------------------------------------------------------------ */

const YEAR_NUMBER = /^-?\d{1,6}$/;

/** Parse “1250 BCE”, “1250 BC”, “-1250”, “1900”, “1900 CE” into a number. */
export function parseYearInput(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const bce = /^(\d{1,6})\s*(bce|bc)$/i.exec(raw);
  if (bce) return -Number(bce[1]);
  const ce = /^(\d{1,6})\s*(ce|ad)$/i.exec(raw);
  if (ce) return Number(ce[1]);
  if (!YEAR_NUMBER.test(raw)) return null;
  return Number(raw);
}

/** “1250 BCE” / “1900 CE” — English, explicit about the era. */
export function formatYear(year) {
  const value = Number(year);
  if (!Number.isFinite(value)) return '—';
  return value < 0 ? `${Math.abs(value)} BCE` : `${value} CE`;
}

/**
 * The published snapshot closest to `year`. Ties go to the earlier snapshot (a
 * map drawn for 1500 should not silently jump to 1530 when 1492 is equally
 * close). Returns `{ snapshot, exact, distance, direction }`.
 */
export function nearestSnapshot(years, year) {
  if (!Array.isArray(years) || !years.length) return null;
  const wanted = Number(year);
  let best = years[0];
  let bestDistance = Infinity;
  for (const candidate of years) {
    const value = typeof candidate === 'number' ? candidate : Number(candidate?.year);
    if (!Number.isFinite(value)) continue;
    const distance = Math.abs(value - wanted);
    if (distance < bestDistance || (distance === bestDistance && value < best.year)) {
      best = typeof candidate === 'number' ? { year: candidate } : candidate;
      bestDistance = distance;
    }
  }
  const value = Number(best.year);
  return {
    year: value,
    snapshot: best,
    exact: bestDistance === 0,
    distance: bestDistance,
    direction: value === wanted ? 'exact' : value > wanted ? 'later' : 'earlier',
  };
}

/** Honest one-liner about which snapshot the map actually draws. */
export function snapshotNote(years, year) {
  const near = nearestSnapshot(years, year);
  if (!near) return 'No snapshots available.';
  if (near.exact) return `Snapshot ${formatYear(near.year)} — the selected year is published as its own map.`;
  return `Snapshot ${formatYear(near.year)} — the nearest published map, ${near.distance} ${near.distance === 1 ? 'year' : 'years'} ${near.direction === 'later' ? 'after' : 'before'} ${formatYear(year)}.`;
}

const MERCATOR_MAX_LAT = 85.05112878;

/** Web Mercator zoom that fits the whole world into `width` × `height`. */
export function fitWorldZoom({ width, height }, margin = 0.92) {
  const fit = Math.min(width / 256, height / 256);
  if (!Number.isFinite(fit) || fit <= 0) return 1;
  return Math.max(0, Math.log2(fit * margin));
}

const worldSize = (zoom) => 256 * 2 ** zoom;

/** Mercator y (pixels from the north pole) at a latitude. */
function mercatorY(lat, scale) {
  const clamped = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat));
  const rad = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * scale;
}

/** Inverse of `mercatorY`: latitude at a pixel y. */
function mercatorLat(y, scale) {
  const value = 1 - (2 * y) / scale;
  return (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * value));
}

/** Latitude/longitude → container pixels for a `{lat, lon, zoom}` view. */
export function projectPoint(lat, lon, view, size) {
  const scale = worldSize(view.zoom);
  const centerX = ((view.lon + 180) / 360) * scale;
  const centerY = mercatorY(view.lat, scale);
  return {
    x: ((lon + 180) / 360) * scale - centerX + size.width / 2,
    y: mercatorY(lat, scale) - centerY + size.height / 2,
  };
}

/** Container pixels → latitude/longitude (inverse of `projectPoint`). */
export function unprojectPoint(x, y, view, size) {
  const scale = worldSize(view.zoom);
  const centerX = ((view.lon + 180) / 360) * scale;
  const centerY = mercatorY(view.lat, scale);
  const worldX = x - size.width / 2 + centerX;
  const worldY = y - size.height / 2 + centerY;
  return { lon: (worldX / scale) * 360 - 180, lat: mercatorLat(worldY, scale) };
}

/** Keep a view usable: zoom bounded, latitude in range, longitude wrapped. */
export function clampView(view, minZoom = 0, maxZoom = 9) {
  const zoom = Math.max(minZoom, Math.min(maxZoom, Number(view.zoom) || 0));
  const lat = Math.max(-MERCATOR_MAX_LAT + 1, Math.min(MERCATOR_MAX_LAT - 1, Number(view.lat) || 0));
  let lon = Number(view.lon) || 0;
  if (lon > 180 || lon < -180) lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat, lon, zoom };
}

/** Parse/serialise the shareable `hv=lat,lon,zoom` window. */
export function parseViewParam(value, fallback) {
  const match = /^(-?\d{1,3}(?:\.\d{1,4})?),(-?\d{1,3}(?:\.\d{1,4})?),(\d{1,2}(?:\.\d{1,2})?)$/.exec(String(value ?? ''));
  if (!match) return fallback;
  return clampView({ lat: Number(match[1]), lon: Number(match[2]), zoom: Number(match[3]) });
}

export function formatViewParam(view) {
  const clamped = clampView(view);
  return `${clamped.lat.toFixed(3)},${clamped.lon.toFixed(3)},${clamped.zoom.toFixed(2)}`;
}

/**
 * SVG path string for the compact snapshot geometry. `parts` is a list of flat
 * `[x0,y0,x1,y1,…]` millidegree rings; `project` maps `(lat, lon, offset)`
 * to container pixels (offset shifts whole worlds for the antimeridian wrap).
 */
export function ringsToPath(parts, project) {
  const commands = [];
  for (const ring of parts) {
    if (!Array.isArray(ring) || ring.length < 6) continue;
    let started = false;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      const point = project(ring[i + 1] / 1000, ring[i] / 1000);
      if (!point) continue;
      commands.push(`${started ? 'L' : 'M'}${point.x.toFixed(1)} ${point.y.toFixed(1)}`);
      started = true;
    }
    if (started) commands.push('Z');
  }
  return commands.join('');
}

/** Degrees bounding box of a feature `{parts}` or ring list. */
export function geometryBounds(parts) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (const ring of parts ?? []) {
    for (let i = 0; i + 1 < ring.length; i += 2) {
      const x = ring[i] / 1000;
      const y = ring[i + 1] / 1000;
      if (x < west) west = x;
      if (x > east) east = x;
      if (y < south) south = y;
      if (y > north) north = y;
    }
  }
  if (!Number.isFinite(west)) return null;
  return { west, east, south, north };
}

/** The ring with the largest degree-area, used for label anchors and zoom fits. */
export function largestRing(feature) {
  let best = null;
  let bestArea = -1;
  for (const ring of feature?.parts ?? []) {
    let area = 0;
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
    area = (maxX - minX) * (maxY - minY);
    if (area > bestArea) {
      bestArea = area;
      best = ring;
    }
  }
  return best;
}

/** Bounding box of the largest ring, in degrees. */
export function featureBounds(feature) {
  const ring = largestRing(feature);
  return ring ? geometryBounds([ring]) : null;
}

/** Stable fill colour per polity name (no dataset colour exists upstream). */
export function featureColor(name) {
  let hash = 0;
  const text = String(name ?? '');
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) % 100000;
  const hue = hash % 360;
  const saturation = 42 + (hash % 3) * 9;
  const lightness = 62 + ((hash >> 3) % 3) * 6;
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

/** How a border precision value is drawn (and described). */
export function precisionStyle(borderPrecision) {
  if (borderPrecision === 1) return { dashed: true, width: 1.4, label: PRECISION_LABELS[1] };
  if (borderPrecision === 2) return { dashed: false, width: 1, label: PRECISION_LABELS[2] };
  if (borderPrecision === 3) return { dashed: false, width: 1.2, label: PRECISION_LABELS[3] };
  return { dashed: true, width: 1.1, label: PRECISION_LABELS[0] };
}

/** Ray casting over the flat millidegree rings; point in degrees. */
export function pointInFeature(feature, lat, lon) {
  const x = lon * 1000;
  const y = lat * 1000;
  const bounds = geometryBounds(feature?.parts);
  if (!bounds) return false;
  if (lon < bounds.west - 0.001 || lon > bounds.east + 0.001 || lat < bounds.south - 0.001 || lat > bounds.north + 0.001) return false;
  let inside = false;
  for (const ring of feature.parts) {
    for (let i = 0, j = ring.length - 2; i + 1 < ring.length; j = i, i += 2) {
      const xi = ring[i];
      const yi = ring[i + 1];
      const xj = ring[j];
      const yj = ring[j + 1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

/**
 * Country/polity names matching a query across all snapshots, from the
 * catalogue the harvest writes: `[[year, [names…]], …]`.
 */
export function searchPolities(catalogue, query, limit = 12) {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle.length < 2) return [];
  const hits = new Map();
  for (const entry of catalogue ?? []) {
    const [year, names] = entry;
    for (const name of names ?? []) {
      const lower = name.toLowerCase();
      if (!lower.includes(needle)) continue;
      if (!hits.has(name)) hits.set(name, { name, years: [] });
      hits.get(name).years.push(year);
    }
  }
  return [...hits.values()]
    .map((hit) => ({ ...hit, years: hit.years.sort((a, b) => Math.abs(a) - Math.abs(b)) }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** The catalogue year nearest to `year` that lists `name` (exact name first). */
export function yearWithPolity(catalogue, name, year) {
  const wanted = String(name ?? '').toLowerCase();
  let best = null;
  for (const [entryYear, names] of catalogue ?? []) {
    const match = (names ?? []).some((candidate) => candidate.toLowerCase() === wanted);
    if (!match) continue;
    if (best === null || Math.abs(entryYear - year) < Math.abs(best - year)) best = entryYear;
  }
  return best;
}

/* ------------------------------------------------------------------ *
 * DOM view                                                            *
 * ------------------------------------------------------------------ */

const VIEW_MIN_ZOOM = 0;
const VIEW_MAX_ZOOM = 9;
const LABEL_MIN_AREA_PX = 2400;
const MAX_LABELS = 70;

export function init(ctx) {
  const { store, dom } = ctx;
  const el = dom.el;
  const doc = document;
  const section = el('section', { class: 'hz', id: 'history-view', hidden: true, 'aria-labelledby': 'hz-heading' });
  const main = doc.getElementById('main');
  if (!main) return {};

  /* --- chrome ------------------------------------------------------ */
  const modebar = el('nav', { class: 'app-modebar', 'aria-label': 'Atlas views' });
  const mapsLink = el('a', { class: 'app-modebar__link', href: '/' }, 'Maps');
  const historyLink = el('a', { class: 'app-modebar__link', href: '/?view=history' }, 'Borders through time');
  modebar.append(mapsLink, historyLink);
  main.prepend(modebar);

  const heading = el('h2', { class: 'zh-heading zh-heading--2', id: 'hz-heading' }, 'Historical borders of the world');
  const lead = el(
    'p',
    { class: 'hz__lead' },
    'Political borders change. Pick a year to draw the world as the historical-basemaps dataset records it — the represented snapshot is always named, because the source publishes discrete maps, not continuous borders.',
  );
  const status = el('p', { class: 'hz__status', id: 'hz-status', role: 'status', 'aria-live': 'polite' }, 'Loading the snapshot index …');
  const header = el('header', { class: 'hz__head' }, heading, lead, status);

  const canvas = el('canvas', {
    class: 'hz__canvas',
    id: 'hz-canvas',
    tabindex: '0',
    role: 'img',
    'aria-label': 'World map of historical borders for the selected year',
  });
  const hover = el('p', { class: 'hz__hover', role: 'status', 'aria-live': 'off', hidden: true });
  const zoomIn = el('button', { class: 'zh-button zh-button--small zh-button--ghost hz__zoom', type: 'button', 'data-hz': 'zoom-in' }, 'Zoom in');
  const zoomOut = el('button', { class: 'zh-button zh-button--small zh-button--ghost hz__zoom', type: 'button', 'data-hz': 'zoom-out' }, 'Zoom out');
  const zoomReset = el('button', { class: 'zh-button zh-button--small zh-button--ghost hz__zoom', type: 'button', 'data-hz': 'zoom-reset' }, 'Whole world');
  const labelsToggle = el('input', { type: 'checkbox', id: 'hz-labels', checked: true });
  const labelsLabel = el('label', { class: 'hz__toggle', for: 'hz-labels' }, labelsToggle, el('span', {}, 'Labels'));
  const controls = el('div', { class: 'hz__controls' }, zoomIn, zoomOut, zoomReset, labelsLabel);
  const keyboardHint = el(
    'p',
    { class: 'hz__hint' },
    'Drag to pan, scroll or + / − to zoom, arrow keys to move, Home for the whole world. Tab to the year control or the polity list for keyboard-only browsing.',
  );
  const legend = el(
    'ul',
    { class: 'hz__legend' },
    el('li', { class: 'hz__legend-item hz__legend-item--solid' }, 'Solid border: moderately precise or set by international law'),
    el('li', { class: 'hz__legend-item hz__legend-item--dashed' }, 'Dashed border: approximate or not stated by the source'),
  );
  const loading = el('p', { class: 'hz__loading', id: 'hz-loading' }, 'Loading snapshot …');
  const error = el('div', { class: 'hz__error', id: 'hz-error', role: 'alert', hidden: true });
  const errorRetry = el('button', { class: 'zh-button zh-button--small', type: 'button', 'data-hz': 'retry' }, 'Try again');
  error.append(el('span', { class: 'hz__error-text' }, 'The snapshot could not be loaded.'), errorRetry);
  const mapwrap = el('div', { class: 'hz__mapwrap' }, canvas, controls, hover, legend, keyboardHint, loading, error);

  /* --- details panel ---------------------------------------------- */
  const details = el('aside', { class: 'hz__panel', id: 'hz-details', hidden: true, 'aria-labelledby': 'hz-details-title' });
  const detailsTitle = el('h3', { class: 'zh-heading zh-heading--4', id: 'hz-details-title' }, 'Details');
  const detailsBody = el('dl', { class: 'hz__facts' });
  const detailsSource = el('p', { class: 'hz__source-line' });
  const detailsClose = el('button', { class: 'zh-button zh-button--small zh-button--ghost hz__panel-close', type: 'button', 'data-hz': 'close-details' }, 'Close');
  details.append(el('div', { class: 'hz__panel-head' }, detailsTitle, detailsClose), detailsBody, detailsSource);

  const body = el('div', { class: 'hz__body' }, mapwrap, details);

  /* --- timeline ---------------------------------------------------- */
  const prev = el('button', { class: 'zh-button zh-button--small zh-button--ghost', type: 'button', 'data-hz': 'prev' }, '← Earlier snapshot');
  const next = el('button', { class: 'zh-button zh-button--small zh-button--ghost', type: 'button', 'data-hz': 'next' }, 'Later snapshot →');
  const play = el('button', { class: 'zh-button zh-button--small', type: 'button', 'data-hz': 'play', 'aria-pressed': 'false' }, 'Play');
  const range = el('input', { class: 'hz__range', type: 'range', id: 'hz-range', min: '0', max: '0', step: '1', value: '0', 'aria-label': 'Published snapshot' });
  const yearInput = el('input', { class: 'zh-input hz__year', type: 'text', id: 'hz-year-input', inputmode: 'numeric', size: '9', 'aria-describedby': 'hz-year-hint' });
  const yearApply = el('button', { class: 'zh-button zh-button--small', type: 'button', 'data-hz': 'apply-year' }, 'Show year');
  const yearForm = el(
    'form',
    { class: 'hz__yearform', id: 'hz-year-form' },
    el('label', { class: 'hz__yearlabel', for: 'hz-year-input' }, 'Year'),
    yearInput,
    yearApply,
    el('span', { class: 'hz__yearhint', id: 'hz-year-hint' }, 'negative = BCE, e.g. -1000 or 1000 BCE'),
  );
  const note = el('p', { class: 'hz__note', id: 'hz-note' }, '');
  const timeline = el('div', { class: 'hz__timeline' }, el('div', { class: 'hz__timeline-row' }, prev, play, next), range, el('div', { class: 'hz__timeline-row hz__timeline-row--form' }, yearForm, note));

  /* --- polity search ---------------------------------------------- */
  const politySelect = el('select', { class: 'zh-input hz__polity', id: 'hz-polity', 'aria-label': 'Polity or region in this snapshot' });
  const searchInput = el('input', { class: 'zh-input', type: 'search', id: 'hz-search', placeholder: 'Find a polity across all snapshots, e.g. “Prussia”', 'aria-label': 'Search polities across snapshots', 'aria-describedby': 'hz-search-hint' });
  const searchResults = el('ul', { class: 'hz__search-results', id: 'hz-search-results', 'aria-label': 'Polity search results' });
  const searchHint = el('p', { class: 'hz__yearhint', id: 'hz-search-hint' }, 'Searches the names the dataset publishes for its 54 snapshots.');
  const search = el(
    'div',
    { class: 'hz__search' },
    el('div', { class: 'hz__search-row' }, searchInput, politySelect),
    searchHint,
    searchResults,
  );

  const sourceNote = el('p', { class: 'hz__source' });
  section.append(header, body, timeline, search, sourceNote);
  main.append(section);
  loadStylesheet('/styles/history.css');

  /* --- state ------------------------------------------------------- */
  const state = {
    index: null,
    catalogue: null,
    years: [],
    features: [],
    featuresByYear: new Map(),
    selected: null,
    view: null,
    size: { width: 800, height: 520 },
    loadingYear: null,
    playing: null,
    labels: true,
    pointer: null,
  };

  function publishView() {
    if (!state.view || !state.index) return;
    store.update({ hv: formatViewParam(state.view) });
  }

  function currentViewFromState() {
    const fallback = clampView({ lat: 20, lon: 0, zoom: fitWorldZoom(state.size) });
    return parseViewParam(store.getState().hv, fallback);
  }

  /* --- rendering ---------------------------------------------------- */
  const context = canvas.getContext('2d');

  function resize() {
    const rect = mapwrap.getBoundingClientRect();
    const width = Math.max(320, Math.round(rect.width || mapwrap.clientWidth || state.size.width));
    const height = Math.max(280, Math.round(rect.height || mapwrap.clientHeight || state.size.height));
    state.size = { width, height };
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!state.view) state.view = currentViewFromState();
    draw();
  }

  const project = (lat, lon, offset = 0) => {
    const point = projectPoint(lat, lon, state.view, state.size);
    return { ...point, x: point.x + offset * worldSize(state.view.zoom) };
  };
  const toScreen = (lat, lon, offset = 0) => project(lat, lon, offset);

  function draw() {
    if (!context || !state.size.width) return;
    const { width, height } = state.size;
    context.save();
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#f4f6f8';
    context.fillRect(0, 0, width, height);
    drawGraticule();
    const worldWidth = worldSize(state.view.zoom);
    const offsets = [-1, 0, 1].filter((offset) => {
      const left = -offset * worldWidth;
      return left < width + worldWidth && left + worldWidth > -width;
    });
    const visible = visibleFeatures();
    for (const feature of visible) {
      for (const offset of offsets) {
        drawFeature(feature, offset);
      }
    }
    if (state.labels) drawLabels(visible);
    context.restore();
  }

  function drawGraticule() {
    const { width, height } = state.size;
    context.save();
    context.strokeStyle = 'rgba(0, 64, 124, 0.14)';
    context.lineWidth = 1;
    context.setLineDash([2, 4]);
    for (let lon = -180; lon < 180; lon += 30) {
      context.beginPath();
      for (let lat = -80; lat <= 80; lat += 5) {
        const point = toScreen(lat, lon);
        if (lat === -80) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      context.beginPath();
      for (let lon = -180; lon <= 180; lon += 5) {
        const point = toScreen(lat, lon);
        if (lon === -180) context.moveTo(point.x, point.y);
        else context.lineTo(point.x, point.y);
      }
      context.stroke();
    }
    context.restore();
  }

  function visibleFeatures() {
    if (!state.view) return [];
    const { width, height } = state.size;
    const bounds = {
      west: unprojectPoint(0, 0, state.view, state.size).lon - 2,
      east: unprojectPoint(width, 0, state.view, state.size).lon + 2,
      north: unprojectPoint(0, 0, state.view, state.size).lat + 2,
      south: unprojectPoint(0, height, state.view, state.size).lat - 2,
    };
    return state.features.filter((feature) => {
      const box = feature.bounds;
      if (!box) return false;
      if (box.north < bounds.south || box.south > bounds.north) return false;
      // Longitude: the view may span the whole world (then everything is in),
      // otherwise the feature's box must overlap one wrapped copy of the window.
      const span = bounds.east - bounds.west;
      if (span >= 360) return true;
      const shift = Math.round(((bounds.west + bounds.east) / 2 - (box.west + box.east) / 2) / 360) * 360;
      const west = box.west + shift;
      const east = box.east + shift;
      return east >= bounds.west && west <= bounds.east;
    });
  }

  function drawFeature(feature, offset) {
    const path = feature.path(offset);
    if (!path) return;
    const selected = state.selected === feature;
    context.save();
    context.beginPath();
    context.fillStyle = feature.color;
    context.globalAlpha = selected ? 0.95 : 0.72;
    context.fill(path);
    context.globalAlpha = 1;
    context.lineWidth = (selected ? 2.2 : feature.style.width);
    context.strokeStyle = selected ? '#0b2b4a' : '#26415c';
    context.setLineDash(feature.style.dashed ? [5, 4] : []);
    context.stroke(path);
    if (selected) {
      context.strokeStyle = '#00407c';
      context.lineWidth = 3.4;
      context.globalAlpha = 0.35;
      context.stroke(path);
    }
    context.restore();
  }

  function drawLabels(features) {
    const drawn = [];
    const occupied = [];
    context.save();
    context.font = '600 12px InterRegular, Inter, Helvetica, Arial, sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const candidates = features
      .map((feature) => {
        const ring = feature.labelRing;
        if (!ring) return null;
        const area = ring.areaPx(state.view, state.size);
        return area >= LABEL_MIN_AREA_PX ? { feature, area } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.area - a.area)
      .slice(0, MAX_LABELS * 2);
    for (const candidate of candidates) {
      if (drawn.length >= MAX_LABELS) break;
      const anchor = candidate.feature.labelRing.anchor(state.view, state.size);
      if (!anchor) continue;
      const inside = anchor.x >= 4 && anchor.x <= state.size.width - 4 && anchor.y >= 4 && anchor.y <= state.size.height - 4;
      if (!inside) continue;
      const width = context.measureText(candidate.feature.name).width + 10;
      const box = { x: anchor.x - width / 2, y: anchor.y - 9, w: width, h: 18 };
      if (occupied.some((other) => box.x < other.x + other.w && box.x + box.w > other.x && box.y < other.y + other.h && box.y + box.h > other.y)) continue;
      occupied.push(box);
      drawn.push(candidate.feature);
      context.lineWidth = 3;
      context.strokeStyle = 'rgba(255,255,255,0.9)';
      context.strokeText(candidate.feature.name, anchor.x, anchor.y);
      context.fillStyle = '#1b2b3a';
      context.fillText(candidate.feature.name, anchor.x, anchor.y);
    }
    context.restore();
  }

  /* --- snapshot loading -------------------------------------------- */
  async function loadIndex() {
    if (state.index) return state.index;
    const response = await fetch(INDEX_URL, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`index: HTTP ${response.status}`);
    state.index = await response.json();
    state.years = (state.index.years ?? []).map((entry) => entry.year).sort((a, b) => a - b);
    if (!state.years.length) throw new Error('no snapshots in the index');
    range.max = String(state.years.length - 1);
    updateSourceNote();
    renderTimeline();
    return state.index;
  }

  async function loadCatalogue() {
    if (state.catalogue) return state.catalogue;
    const response = await fetch(`${DATA_ROOT}catalogue.json`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`catalogue: HTTP ${response.status}`);
    const payload = await response.json();
    state.catalogue = payload.years ?? [];
    searchHint.textContent = `Searches ${state.catalogue.length} snapshots, ${formatYear(state.years[0])} – ${formatYear(state.years[state.years.length - 1])}.`;
    return state.catalogue;
  }

  function prepare(feature, view, size) {
    const bounds = geometryBounds(feature.parts);
    const styled = {
      ...feature,
      bounds,
      color: featureColor(feature.name),
      style: precisionStyle(feature.borderPrecision),
      cache: new Map(),
    };
    styled.path = (offset = 0) => {
      const v = state.view;
      const s = state.size;
      const key = `${offset}|${v.lat.toFixed(3)}|${v.lon.toFixed(3)}|${v.zoom.toFixed(2)}|${s.width}x${s.height}`;
      if (!styled.cache.has(key)) {
        if (styled.cache.size > 8) styled.cache.clear();
        styled.cache.set(key, ringsToPath(styled.parts, (lat, lon) => project(lat, lon, offset)));
      }
      return styled.cache.get(key);
    };
    const ring = largestRing(feature);
    styled.labelRing = ring
      ? {
          anchor: (v, s) => ringAnchor(ring, v, s),
          areaPx: (v, s) => ringAreaPx(ring, v, s),
        }
      : null;
    return styled;
  }

  function ringAnchor(ring, view, size) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
    // Midpoint in degrees, then projected — a label anchor, not a centroid.
    return projectPoint((minY + maxY) / 2000, (minX + maxX) / 2000, view, size);
  }

  function ringAreaPx(ring, view, size) {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i + 1 < ring.length; i += 2) {
      minX = Math.min(minX, ring[i]);
      maxX = Math.max(maxX, ring[i]);
      minY = Math.min(minY, ring[i + 1]);
      maxY = Math.max(maxY, ring[i + 1]);
    }
    const topLeft = projectPoint(maxY / 1000, minX / 1000, view, size);
    const bottomRight = projectPoint(minY / 1000, maxX / 1000, view, size);
    return Math.abs((bottomRight.x - topLeft.x) * (bottomRight.y - topLeft.y));
  }

  async function loadSnapshot(year) {
    const near = nearestSnapshot(state.years, year);
    if (!near) throw new Error('no snapshots');
    const entry = state.index.years.find((candidate) => candidate.year === near.year);
    if (!entry) throw new Error(`snapshot ${near.year} missing from the index`);
    if (state.featuresByYear.has(entry.year)) return state.featuresByYear.get(entry.year);
    if (state.loadingYear !== entry.year) {
      state.loadingYear = entry.year;
      loading.hidden = false;
      loading.textContent = `Loading the ${formatYear(entry.year)} snapshot …`;
      error.hidden = true;
    }
    const response = await fetch(`${DATA_ROOT}${entry.file}`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`snapshot ${entry.year}: HTTP ${response.status}`);
    const payload = await response.json();
    const features = (payload.features ?? []).map((feature) => prepare(feature, state.view, state.size));
    state.featuresByYear.set(entry.year, features);
    return features;
  }

  async function showYear(year) {
    setStatus(`Preparing ${formatYear(year)} …`);
    let features;
    try {
      await loadIndex();
      features = await loadSnapshot(year);
    } catch (err) {
      loading.hidden = true;
      error.hidden = false;
      error.querySelector('.hz__error-text').textContent = `The snapshot for ${formatYear(year)} could not be loaded (${err.message}).`;
      setStatus(`Could not load ${formatYear(year)}.`);
      return;
    }
    error.hidden = true;
    loading.hidden = true;
    state.features = features;
    const near = nearestSnapshot(state.years, year);
    state.selected = null;
    details.hidden = true;
    state.loadedYear = near.year;
    if (canvas) canvas.setAttribute('aria-label', `World map of historical borders in ${formatYear(near.year)}`);
    populatePolities(features);
    renderTimeline();
    draw();
    setStatus(`${features.length} polities and regions drawn.`);
    note.textContent = snapshotNote(state.years, year);
    yearInput.value = formatYear(year);
    if (store.getState().year !== year) store.update({ year }); // year is a replace-in-place key, like a slider drag
  }

  function setStatus(text) {
    status.textContent = text;
  }

  function renderTimeline() {
    if (!state.years.length) return;
    const year = store.getState().year;
    const index = state.years.indexOf(state.loadedYear ?? nearestSnapshot(state.years, year)?.year);
    range.value = String(Math.max(0, index));
    range.setAttribute('aria-valuetext', `${formatYear(state.years[Math.max(0, index)])} — ${state.years.length} published snapshots`);
    prev.disabled = index <= 0;
    next.disabled = index >= state.years.length - 1;
  }

  function populatePolities(features) {
    const options = [el('option', { value: '' }, `All ${features.length} polities and regions`)];
    features
      .map((feature, i) => ({ feature, i }))
      .sort((a, b) => a.feature.name.localeCompare(b.feature.name))
      .forEach(({ feature, i }) => options.push(el('option', { value: String(i) }, feature.name)));
    politySelect.replaceChildren(...options);
  }

  function showDetails(feature) {
    if (!feature) {
      details.hidden = true;
      state.selected = null;
      draw();
      return;
    }
    state.selected = feature;
    const near = nearestSnapshot(state.years, store.getState().year);
    const border = feature.style.label;
    detailsTitle.textContent = feature.name;
    const facts = [
      ['Polity or region', feature.name],
      ['Sovereignty as recorded', feature.subject && feature.subject !== feature.name ? feature.subject : '—'],
      feature.partOf ? ['Part of', feature.partOf] : null,
      ['Border precision', border],
      ['Drawn snapshot', formatYear(near.year)],
      ['Coverage in snapshot', `${state.features.length} polities and regions`],
    ].filter(Boolean);
    detailsBody.replaceChildren(
      ...facts.flatMap(([term, value]) => [el('dt', {}, term), el('dd', {}, value)]),
    );
    const entry = state.index?.years.find((candidate) => candidate.year === near.year);
    detailsSource.replaceChildren(
      el('span', {}, 'Source: '),
      el('a', { href: state.index.repository, target: '_blank', rel: 'noreferrer' }, 'historical-basemaps'),
      el('span', {}, ` by André Ourednik and contributors (verifiable link to the fragment used: `),
      el(
        'a',
        {
          href: `${state.index.homepage}/blob/${state.index.commit}/${entry?.upstream ?? ''}`,
          target: '_blank',
          rel: 'noreferrer',
        },
        entry?.upstream ?? 'source file',
      ),
      el('span', {}, `, ${state.index.license}). `),
      el('span', {}, 'Snapshots are discrete maps, not continuous border records; borders before 1648 are conceptual and approximate.'),
    );
    details.hidden = false;
    draw();
  }

  function updateSourceNote() {
    const index = state.index;
    if (!index) return;
    sourceNote.replaceChildren(
      el('span', {}, 'Borders: '),
      el('a', { href: index.repository, target: '_blank', rel: 'noreferrer' }, 'historical-basemaps'),
      el(
        'span',
        {},
        ` © André Ourednik and contributors, ${index.license} · snapshot index from ${formatYear(index.coverage.firstYear)} to ${formatYear(index.coverage.lastYear)} (${index.coverage.snapshots} maps) · harvested ${String(index.retrievedAt).slice(0, 10)} from commit ${index.commitShort} · simplified for world-scale display (Douglas–Peucker ${index.simplification.toleranceDeg}°, integer millidegrees).`,
      ),
    );
  }

  /* --- interactions ------------------------------------------------ */
  function zoomBy(delta, anchor) {
    const size = state.size;
    const point = anchor ?? { x: size.width / 2, y: size.height / 2 };
    const before = unprojectPoint(point.x, point.y, state.view, size);
    const zoom = clampView({ ...state.view, zoom: state.view.zoom + delta }, VIEW_MIN_ZOOM, VIEW_MAX_ZOOM).zoom;
    if (zoom === state.view.zoom) return;
    // Keep the point under the cursor where it was: solve for the new centre.
    const scale = worldSize(zoom);
    const anchorX = ((before.lon + 180) / 360) * scale;
    const anchorY = mercatorY(before.lat, scale);
    state.view = clampView(
      {
        zoom,
        lon: ((anchorX - (point.x - size.width / 2)) / scale) * 360 - 180,
        lat: mercatorLat(anchorY - (point.y - size.height / 2), scale),
      },
      VIEW_MIN_ZOOM,
      VIEW_MAX_ZOOM,
    );
    afterViewChange();
  }

  function panBy(dx, dy) {
    const scale = worldSize(state.view.zoom);
    state.view = clampView(
      {
        ...state.view,
        lon: state.view.lon - (dx / scale) * 360,
        lat: mercatorLat(mercatorY(state.view.lat, scale) - dy, scale),
      },
      VIEW_MIN_ZOOM,
      VIEW_MAX_ZOOM,
    );
    afterViewChange();
  }

  let viewTimer = null;
  function afterViewChange() {
    draw();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(publishView, 250);
  }

  canvas.addEventListener('wheel', (event) => {
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    zoomBy(event.deltaY < 0 ? 0.35 : -0.35, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }, { passive: false });

  canvas.addEventListener('pointerdown', (event) => {
    canvas.setPointerCapture(event.pointerId);
    state.pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  });
  canvas.addEventListener('pointermove', (event) => {
    const rect = canvas.getBoundingClientRect();
    if (state.pointer && state.pointer.id === event.pointerId) {
      const dx = event.clientX - state.pointer.x;
      const dy = event.clientY - state.pointer.y;
      if (Math.abs(dx) + Math.abs(dy) > 2) state.pointer.moved = true;
      panBy(dx, dy);
      state.pointer.x = event.clientX;
      state.pointer.y = event.clientY;
      return;
    }
    const feature = featureAt(event.clientX - rect.left, event.clientY - rect.top);
    hover.hidden = !feature;
    if (feature) {
      hover.textContent = `${feature.name} — ${formatYear(state.loadedYear)}`;
      hover.style.left = `${event.clientX - rect.left + 12}px`;
      hover.style.top = `${event.clientY - rect.top + 12}px`;
    }
  });
  const endPointer = (event) => {
    if (state.pointer && state.pointer.id === event.pointerId) canvas.releasePointerCapture?.(event.pointerId);
    state.pointer = null;
  };
  canvas.addEventListener('pointerup', (event) => {
    const rect = canvas.getBoundingClientRect();
    const wasDrag = state.pointer?.moved;
    endPointer(event);
    if (!wasDrag) {
      const feature = featureAt(event.clientX - rect.left, event.clientY - rect.top);
      showDetails(feature);
    }
  });
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => {
    hover.hidden = true;
  });

  canvas.addEventListener('keydown', (event) => {
    const step = 60;
    if (event.key === 'ArrowLeft') panBy(step, 0);
    else if (event.key === 'ArrowRight') panBy(-step, 0);
    else if (event.key === 'ArrowUp') panBy(0, step);
    else if (event.key === 'ArrowDown') panBy(0, -step);
    else if (event.key === '+' || event.key === '=') zoomBy(0.5);
    else if (event.key === '-' || event.key === '_') zoomBy(-0.5);
    else if (event.key === 'Home') resetView();
    else return;
    event.preventDefault();
  });

  function featureAt(x, y) {
    if (!state.view) return null;
    const point = unprojectPoint(x, y, state.view, state.size);
    for (let i = state.features.length - 1; i >= 0; i -= 1) {
      if (pointInFeature(state.features[i], point.lat, point.lon)) return state.features[i];
    }
    return null;
  }

  function resetView() {
    state.view = clampView({ lat: 20, lon: 0, zoom: fitWorldZoom(state.size) }, VIEW_MIN_ZOOM, VIEW_MAX_ZOOM);
    afterViewChange();
    publishView();
  }

  function focusFeature(feature) {
    const bounds = featureBounds(feature);
    if (!bounds) return;
    const lonSpan = Math.max(2, (bounds.east - bounds.west) * 1.4);
    const latSpan = Math.max(2, (bounds.north - bounds.south) * 1.6);
    const zoom = clampView(
      {
        lat: (bounds.south + bounds.north) / 2,
        lon: (bounds.west + bounds.east) / 2,
        zoom: Math.min(VIEW_MAX_ZOOM, Math.log2(state.size.width / 256) - Math.log2(lonSpan / 360), Math.log2(state.size.height / 256) - Math.log2(latSpan / 180)),
      },
      VIEW_MIN_ZOOM,
      VIEW_MAX_ZOOM,
    );
    state.view = zoom;
    showDetails(feature);
    afterViewChange();
    publishView();
  }

  /* --- controls ---------------------------------------------------- */
  zoomIn.addEventListener('click', () => zoomBy(0.75));
  zoomOut.addEventListener('click', () => zoomBy(-0.75));
  zoomReset.addEventListener('click', resetView);
  labelsToggle.addEventListener('change', () => {
    state.labels = labelsToggle.checked;
    draw();
  });
  errorRetry.addEventListener('click', () => showYear(store.getState().year));
  detailsClose.addEventListener('click', () => showDetails(null));
  prev.addEventListener('click', () => {
    const near = nearestSnapshot(state.years, store.getState().year);
    const i = state.years.indexOf(near.year);
    if (i > 0) showYear(state.years[i - 1]);
  });
  next.addEventListener('click', () => {
    const near = nearestSnapshot(state.years, store.getState().year);
    const i = state.years.indexOf(near.year);
    if (i >= 0 && i < state.years.length - 1) showYear(state.years[i + 1]);
  });
  range.addEventListener('input', () => {
    const value = state.years[Number(range.value)];
    if (Number.isFinite(value)) showYear(value);
  });
  yearForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const parsed = parseYearInput(yearInput.value);
    if (parsed === null) {
      yearInput.setAttribute('aria-invalid', 'true');
      note.textContent = 'Enter a year as a number, or with BCE/CE, e.g. 1200 BCE, -1000, 1900.';
      return;
    }
    yearInput.removeAttribute('aria-invalid');
    showYear(parsed);
  });
  play.addEventListener('click', togglePlay);
  function togglePlay() {
    if (state.playing) {
      clearInterval(state.playing);
      state.playing = null;
      play.textContent = 'Play';
      play.setAttribute('aria-pressed', 'false');
      return;
    }
    state.playing = setInterval(() => {
      const near = nearestSnapshot(state.years, store.getState().year);
      const i = state.years.indexOf(near.year);
      const nextYear = state.years[(i + 1) % state.years.length];
      showYear(nextYear);
    }, 1400);
    play.textContent = 'Pause';
    play.setAttribute('aria-pressed', 'true');
  }

  politySelect.addEventListener('change', () => {
    const index = Number(politySelect.value);
    if (!Number.isInteger(index) || index < 0 || index >= state.features.length) {
      showDetails(null);
      return;
    }
    focusFeature(state.features[index]);
  });

  let searchTimer = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runPolitySearch, 200);
  });
  async function runPolitySearch() {
    const query = searchInput.value.trim();
    if (query.length < 2) {
      searchResults.replaceChildren();
      return;
    }
    try {
      await loadCatalogue();
    } catch (err) {
      searchResults.replaceChildren(el('li', { class: 'hz__search-empty' }, `Polity search unavailable (${err.message}).`));
      return;
    }
    const hits = searchPolities(state.catalogue, query);
    if (!hits.length) {
      searchResults.replaceChildren(el('li', { class: 'hz__search-empty' }, `No polity matching “${query}”.`));
      return;
    }
    searchResults.replaceChildren(
      ...hits.map((hit) =>
        el(
          'li',
          {},
          el(
            'button',
            {
              class: 'hz__search-hit',
              type: 'button',
              onclick: () => jumpToPolity(hit.name),
            },
            el('span', { class: 'hz__search-name' }, hit.name),
            el('span', { class: 'hz__search-years' }, `${hit.years.length} snapshot${hit.years.length === 1 ? '' : 's'}: ${hit.years.slice(0, 6).map(formatYear).join(', ')}${hit.years.length > 6 ? ' …' : ''}`),
          ),
        ),
      ),
    );
  }

  async function jumpToPolity(name) {
    const near = nearestSnapshot(state.years, store.getState().year);
    const year = yearWithPolity(state.catalogue, name, near.year) ?? near.year;
    await showYear(year);
    const feature = state.features.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (feature) focusFeature(feature);
    searchResults.replaceChildren();
    searchInput.value = name;
  }

  /* --- store wiring ------------------------------------------------ */
  function applyMode(view) {
    const active = view === 'history';
    const changed = section.hidden === active;
    section.hidden = !active;
    doc.body.classList.toggle('app-mode-history', active);
    if (active) {
      historyLink.setAttribute('aria-current', 'page');
      mapsLink.setAttribute('aria-current', 'false');
    } else {
      historyLink.setAttribute('aria-current', 'false');
      mapsLink.setAttribute('aria-current', 'page');
    }
    if (!active) return;
    if (changed) {
      // Fonts/metrics need a layout pass before the canvas can size itself.
      requestAnimationFrame(() => {
        resize();
        showYear(store.getState().year);
      });
    }
  }

  function applyView() {
    const current = store.getState();
    const mapsQuery = stateToQuery({ ...current, view: 'split', selected: '', sheet: 1, vv: '' });
    mapsLink.href = mapsQuery ? `/?${mapsQuery}` : '/';
    const historyQuery = stateToQuery({ ...current, view: 'history' });
    historyLink.href = `/?${historyQuery}`;
    applyMode(current.view);
  }

  store.subscribe((state, changed) => {
    if (changed.includes('view')) applyMode(state.view);
    if (changed.includes('hv') && state.view === 'history') {
      const next = parseViewParam(state.hv, state.view ?? currentViewFromState());
      if (state.view && (Math.abs(next.lat - state.view.lat) > 1e-4 || Math.abs(next.lon - state.view.lon) > 1e-4 || Math.abs(next.zoom - state.view.zoom) > 1e-3)) {
        state.view = next;
        draw();
      }
    }
    if (changed.includes('year') && state.view === 'history') {
      const near = nearestSnapshot(state.years, state.year);
      if (near && near.year !== state.loadedYear) showYear(state.year);
      else if (!near) showYear(state.year); // the index is not loaded yet
    }
    if (changed.includes('view')) applyView();
  });

  window.addEventListener('resize', () => {
    if (store.getState().view === 'history') resize();
  });

  let lastWidth = 0;
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver((entries) => {
      if (store.getState().view !== 'history') return;
      const width = entries[0]?.contentRect?.width ?? 0;
      if (Math.abs(width - lastWidth) < 2) return;
      lastWidth = width;
      resize();
    }).observe(mapwrap);
  }

  applyView();
  if (store.getState().view === 'history') {
    requestAnimationFrame(() => {
      resize();
      showYear(store.getState().year);
    });
  } else {
    // Keep the index cold until the visitor opens the History view; the module
    // still renders its chrome so the mode switch is usable immediately.
    setStatus('Pick a year to draw the world as the dataset recorded it.');
  }

  return {
    showYear,
    draw,
    state,
    nearestSnapshot: (year) => nearestSnapshot(state.years, year),
  };
}

/** Inject the view's stylesheet once (the shell does not know about the view). */
function loadStylesheet(href) {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`link[rel="stylesheet"][href="${href}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  document.head.append(link);
}
