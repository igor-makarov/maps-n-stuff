/**
 * URL-backed application state + a tiny event bus (coordination/README.md D4).
 *
 *   const store = createStore({ defaults });
 *   store.getState()            -> { q, from, to, provider, type, place, lat, lon, zoom, selected, view, sort, overlay, otime }
 *   store.update({ from: 1800 }) -> merge, sync URL (replaceState), notify subscribers
 *   store.subscribe(fn)          -> fn(state, changedKeys); returns unsubscribe
 *
 *   const bus = createBus();
 *   bus.on('records:loaded', fn); bus.emit('records:loaded', { records });
 *
 * Everything is defensive: the module must also import cleanly in Node (tests)
 * where `window`/`history`/`location` may not exist.
 */

export const STATE_DEFAULTS = Object.freeze({
  q: '', // free-text filter over title/creator/place
  from: 1500, // publication year range filter
  to: 1900,
  provider: '', // providerId or '' for all
  type: '', // record type or '' for all
  place: '', // selected place label
  lat: 47.3769, // Zürich as the initial view (documented default, not a search result)
  lon: 8.5417,
  zoom: 12,
  selected: '', // record id
  view: 'split', // 'split' | 'map' | 'list'
  sort: 'year-asc',
  overlay: '', // swisstopo layer id of the comparison layer
  otime: '', // time value for that layer (YYYYMMDD where the layer is a Zeitreise layer)
});

/** URL parameter names kept short for shareable links. */
export const PARAM = {
  q: 'q',
  from: 'from',
  to: 'to',
  provider: 'p',
  type: 't',
  place: 'place',
  lat: 'lat',
  lon: 'lon',
  zoom: 'z',
  selected: 'sel',
  view: 'view',
  sort: 'sort',
  overlay: 'ov',
  otime: 'ot',
};

const TYPES = {
  string: ['q', 'provider', 'type', 'place', 'selected', 'view', 'sort', 'overlay', 'otime'],
  number: ['from', 'to', 'lat', 'lon', 'zoom'],
};

function coerce(key, value) {
  if (value === null || value === undefined || value === '') return STATE_DEFAULTS[key];
  if (TYPES.number.includes(key)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : STATE_DEFAULTS[key];
  }
  return String(value);
}

function safeHistory() {
  try {
    if (typeof window === 'undefined') return null;
    return window.history && typeof window.history.replaceState === 'function' ? window.history : null;
  } catch {
    return null;
  }
}

function safeLocation() {
  try {
    if (typeof window === 'undefined') return null;
    return window.location || null;
  } catch {
    return null;
  }
}

export function readStateFromUrl(search = (safeLocation()?.search ?? ''), defaults = STATE_DEFAULTS) {
  const params = new URLSearchParams(search);
  const state = { ...defaults };
  for (const [key, param] of Object.entries(PARAM)) {
    if (params.has(param)) {
      const raw = params.get(param);
      state[key] = raw === '' ? defaults[key] : coerce(key, raw);
    }
  }
  return sanitise(state);
}

/** Keep numeric state inside sane bounds so a hand-written URL cannot break the UI. */
export function sanitise(state) {
  const out = { ...state };
  out.lat = Math.max(-85, Math.min(85, Number(out.lat) || STATE_DEFAULTS.lat));
  out.lon = ((((Number(out.lon) || STATE_DEFAULTS.lon) + 180) % 360) + 360) % 360 - 180;
  out.zoom = Math.max(2, Math.min(18, Number(out.zoom) || STATE_DEFAULTS.zoom));
  const from = Number.isFinite(Number(out.from)) ? Number(out.from) : STATE_DEFAULTS.from;
  const to = Number.isFinite(Number(out.to)) ? Number(out.to) : STATE_DEFAULTS.to;
  out.from = Math.min(from, to);
  out.to = Math.max(from, to);
  if (!['split', 'map', 'list'].includes(out.view)) out.view = STATE_DEFAULTS.view;
  if (!['year-asc', 'year-desc', 'title'].includes(out.sort)) out.sort = STATE_DEFAULTS.sort;
  out.q = String(out.q || '').slice(0, 200);
  out.place = String(out.place || '').slice(0, 200);
  return out;
}

export function stateToQuery(state, defaults = STATE_DEFAULTS) {
  const params = new URLSearchParams();
  const current = sanitise({ ...defaults, ...state });
  for (const [key, param] of Object.entries(PARAM)) {
    const value = current[key];
    if (value === defaults[key]) continue;
    if (key === 'lat' || key === 'lon') params.set(param, Number(value).toFixed(4));
    else params.set(param, String(value));
  }
  return params.toString();
}

export function createBus() {
  const listeners = new Map();
  return {
    on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(fn);
      return () => listeners.get(name)?.delete(fn);
    },
    off(name, fn) {
      listeners.get(name)?.delete(fn);
    },
    emit(name, detail) {
      for (const fn of listeners.get(name) ?? []) {
        try {
          fn(detail);
        } catch (err) {
          // A broken module must not take the app down.
          console.error(`[bus] listener for "${name}" failed`, err);
        }
      }
    },
  };
}

export function createStore({ initial = {}, defaults = STATE_DEFAULTS, history = safeHistory(), location = safeLocation() } = {}) {
  let state = sanitise({ ...defaults, ...initial, ...readStateFromUrl(location?.search ?? '', defaults) });
  const subscribers = new Set();
  let urlSync = Boolean(history && location);
  let pending = null;

  function notify(changedKeys) {
    for (const fn of subscribers) {
      try {
        fn(state, changedKeys);
      } catch (err) {
        console.error('[store] subscriber failed', err);
      }
    }
  }

  function syncUrl() {
    if (!urlSync || !history || !location) return;
    const query = stateToQuery(state, defaults);
    const next = `${location.pathname || '/'}${query ? `?${query}` : ''}`;
    try {
      history.replaceState({ ...state }, '', next);
    } catch {
      urlSync = false; // sandboxed iframe or file:// – keep working without URL sync
    }
  }

  function update(patch, { silent = false } = {}) {
    const changed = [];
    const next = { ...state };
    for (const [key, value] of Object.entries(patch)) {
      if (!(key in defaults)) continue;
      const coerced = coerce(key, value);
      if (next[key] !== coerced) {
        next[key] = coerced;
        changed.push(key);
      }
    }
    state = sanitise(next);
    if (changed.length === 0) return state;
    syncUrl();
    if (!silent) notify(changed);
    return state;
  }

  return {
    getState: () => state,
    update,
    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    /** Used by tests and by the "reset" action. */
    replace(next, options) {
      return update({ ...defaults, ...next }, options);
    },
    setUrlSync(enabled) {
      urlSync = Boolean(enabled);
    },
  };
}
