/**
 * URL-backed application state + a tiny event bus (coordination/README.md D4).
 *
 *   const store = createStore({ defaults });
 *   store.getState()            -> { q, from, to, provider, type, collection, base, viewport, extents, at, place, lat, lon, zoom, selected, sheet, vv, view, sort, overlay, otime, cmp, cvv, csync, year, hv }
 *   store.update({ from: 1800 }) -> merge, sync URL, notify subscribers
 *   store.subscribe(fn)          -> fn(state, changedKeys); returns unsubscribe
 *   store.applyUrl()             -> re-read the URL (used by popstate)
 *
 * History: a change to a *deliberate* search/selection key (see
 * HISTORY_PUSH_KEYS) becomes a real history entry, so the browser's back and
 * forward buttons walk the way the user actually explored; continuous changes
 * (panning, zooming, dragging the year control, pinning records) only replace
 * the current entry, so one drag never floods the history. Repeated changes to
 * the same keys inside HISTORY_COALESCE_MS merge into the entry they started,
 * and a query that is still being edited (HISTORY_TEXT_KEYS) stays in its entry
 * even across a longer pause — one “back” undoes the whole typed search.
 * `popstate` re-reads the URL and notifies the modules exactly like an ordinary
 * update does, so every view follows the browser buttons.
 *
 *   const bus = createBus();
 *   bus.on('records:loaded', fn); bus.emit('records:loaded', { records });
 *
 * Everything is defensive: the module must also import cleanly in Node (tests)
 * where `window`/`history`/`location` may not exist.
 */

export const STATE_DEFAULTS = Object.freeze({
  q: '', // free-text filter over title/creator/place
  from: 1400, // include the earliest digitized maps
  to: 2026, // include the full catalogue, including early twentieth-century city maps
  provider: '', // providerId or '' for all
  type: '', // record type or '' for all
  collection: '', // upstream series/collection name or '' for all (facet from the data)
  base: '', // chosen worldwide basemap ('osm' | 'satellite'); '' = the default layer
  viewport: '', // '1' = only records inside the current map view
  extents: '', // '1' = draw the documented footprints of the filtered records on the map
  at: '', // "lat,lon" point filter: only records whose documented extent covers this point
  place: '', // selected place label
  lat: 20, // world view: the atlas opens worldwide, not in one canton
  lon: 0,
  zoom: 2,
  selected: '', // record id
  sheet: 1, // 1-based sheet/canvas of the open multi-sheet work (shareable)
  vv: '', // "x,y,w,h" visible region of that sheet in image pixels (shareable; '' = whole sheet)
  view: 'split', // 'split' | 'map' | 'list' | 'history' (the historical-borders view)
  sort: 'year-asc',
  overlay: '', // provider layer id of the comparison layer
  otime: '', // time value for that layer (YYYYMMDD where the layer is a Zeitreise layer)
  cmp: '', // comma-separated record ids pinned in the comparison list (max 4)
  cvv: '', // cut-outs of the comparison panes: "id@x,y,w,h" pairs, ";"-separated (shareable)
  csync: '1', // '1' = the comparison panes' cut-outs are coupled (the default), '0' = each pane moves alone
  year: 1900, // the History view's selected year (negative = BCE)
  hv: '', // History view's own map window "lat,lon,zoom" ('' = the world view); kept apart from the archive map's window
});

/** URL parameter names kept short for shareable links. */
export const PARAM = {
  q: 'q',
  from: 'from',
  to: 'to',
  provider: 'p',
  type: 't',
  collection: 'c',
  base: 'base',
  viewport: 'vp',
  extents: 'ex',
  at: 'at',
  place: 'place',
  lat: 'lat',
  lon: 'lon',
  zoom: 'z',
  selected: 'sel',
  sheet: 'sh',
  vv: 'vv',
  view: 'view',
  sort: 'sort',
  overlay: 'ov',
  otime: 'ot',
  cmp: 'cmp',
  cvv: 'cvv',
  csync: 'csync',
  year: 'year',
  hv: 'hv',
};

/**
 * One record id as the data contract writes it (`<providerId>:<recordId>`).
 * Used for the pinned comparison list and for the panes' cut-outs.
 */
const RECORD_ID = /^[a-z0-9][a-z0-9._-]{0,40}:[A-Za-z0-9][A-Za-z0-9._:-]{0,160}$/;
/** One `x,y,w,h` region as the viewer writes it; the same shape as `vv`. */
const VIEW_REGION = /^\d{1,6}(?:,\d{1,6}){3}$/;
/** The comparison holds at most four panes, so at most four cut-outs are kept. */
const MAX_COMPARE_VIEWS = 4;

const TYPES = {
  string: ['q', 'provider', 'type', 'collection', 'base', 'viewport', 'extents', 'at', 'place', 'selected', 'view', 'sort', 'overlay', 'otime', 'cmp', 'vv', 'cvv', 'csync', 'hv'],
  number: ['from', 'to', 'lat', 'lon', 'zoom', 'sheet', 'year'],
};

/**
 * Keys whose change is a navigation step the user would want to undo with the
 * browser's back button: a search, a filter, a place or a selected record.
 * Every other key (pan/zoom, slider drags, the sheet or the visible cut-out of a
 * work, the footprint layer, the pinned comparison list, the view and sort
 * choices) only replaces the current entry.
 */
export const HISTORY_PUSH_KEYS = Object.freeze([
  'q',
  'from',
  'to',
  'provider',
  'type',
  'collection',
  'viewport',
  'at',
  'place',
  'selected',
]);

/** Repeated changes to the same keys inside this window replace instead of push. */
export const HISTORY_COALESCE_MS = 900;

/**
 * Keys whose change is *typed text*. A pause inside one query must not cut the
 * search into two history steps: the measured typing pace of a visitor can
 * exceed HISTORY_COALESCE_MS (and a busy main thread does it on its own), and
 * then “back” only undid the last keystroke instead of the whole search. A
 * change to these keys therefore stays in the entry as long as the new text is
 * a continuation of the text of that entry (see `isTypedContinuation`).
 */
export const HISTORY_TEXT_KEYS = Object.freeze(['q']);

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

function safeWindow() {
  try {
    if (typeof window === 'undefined') return null;
    return window;
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

/**
 * Parse the point filter `"lat,lon"`; null when the value is not a real point.
 * Used by the map (crosshair), the result filter and the tests.
 */
export function parsePoint(value) {
  const parts = String(value ?? '').split(',');
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat: Math.max(-85, Math.min(85, lat)), lon: normaliseLon(lon) };
}

/** Canonical `"lat,lon"` for the URL/state; '' when there is no usable point. */
export function sanitisePoint(value) {
  const point = parsePoint(value);
  return point ? `${point.lat.toFixed(4)},${point.lon.toFixed(4)}` : '';
}

/** Wrap a longitude into [-180, 180] without drifting values that are already in range. */
export function normaliseLon(lon) {
  if (!Number.isFinite(lon)) return STATE_DEFAULTS.lon;
  if (lon >= -180 && lon <= 180) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Math.round(wrapped * 1e6) / 1e6;
}

/** Keep numeric state inside sane bounds so a hand-written URL cannot break the UI. */
export function sanitise(state) {
  const out = { ...state };
  const latitude = Number(out.lat);
  out.lat = out.lat != null && out.lat !== '' && Number.isFinite(latitude)
    ? Math.max(-85, Math.min(85, latitude)) : STATE_DEFAULTS.lat;
  out.lon = normaliseLon(Number(out.lon));
  out.zoom = Math.max(2, Math.min(18, Number(out.zoom) || STATE_DEFAULTS.zoom));
  const from = Number.isFinite(Number(out.from)) ? Number(out.from) : STATE_DEFAULTS.from;
  const to = Number.isFinite(Number(out.to)) ? Number(out.to) : STATE_DEFAULTS.to;
  out.from = Math.min(from, to);
  out.to = Math.max(from, to);
  if (!['split', 'map', 'list', 'history'].includes(out.view)) out.view = STATE_DEFAULTS.view;
  if (!['year-asc', 'year-desc', 'title'].includes(out.sort)) out.sort = STATE_DEFAULTS.sort;
  out.viewport = out.viewport === '1' || out.viewport === 'true' ? '1' : '';
  out.extents = out.extents === '1' || out.extents === 'true' ? '1' : '';
  out.at = sanitisePoint(out.at);
  out.q = String(out.q || '').slice(0, 200);
  out.place = String(out.place || '').slice(0, 200);
  // A collection name comes from the data (never invented) and from the URL, so
  // keep it short and printable; an unknown name simply yields no results.
  out.collection = String(out.collection || '').slice(0, 120);
  // Which Grundkarte the map draws (`?base=grau`). The map resolves the key and
  // falls back to the default layer, so only the shape has to be safe here.
  out.base = /^[a-z0-9-]{1,24}$/.test(String(out.base ?? '')) ? String(out.base) : '';
  // Which sheet of a multi-sheet work the detail viewer shows. The real canvas
  // count is only known after the manifest loads, so the hard bound stays wide;
  // detail.js clamps to the actual count and writes the corrected value back.
  out.sheet = Math.max(1, Math.min(999, Math.floor(Number(out.sheet) || 1)));
  // The visible region of the detail viewer, as "x,y,w,h" in image pixels. It is
  // hand-editable like every other parameter, so only the exact shape is kept;
  // the viewer checks it against the real sheet size and drops what does not fit.
  out.vv = /^\d{1,6}(,\d{1,6}){3}$/.test(String(out.vv ?? '')) ? String(out.vv) : '';
  // The compare list is a hand-editable URL value: keep only ids that match the
  // data contract "<providerId>:<record id>" (lower-case provider, safe value
  // characters) and never more than four of them.
  out.cmp = String(out.cmp || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => RECORD_ID.test(id))
    .slice(0, MAX_COMPARE_VIEWS)
    .join(',');
  // The cut-outs of the comparison panes, one `id@x,y,w,h` per pane that shows a
  // cut-out instead of the whole sheet. Keyed by record id (the pane order can
  // change), hand-editable like every other parameter, so only pairs matching
  // both contracts survive — capped at the four panes. Each region is checked
  // against the real sheet by the pane that restores it (`parseViewParam`).
  out.cvv = String(out.cvv || '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => {
      const at = pair.indexOf('@');
      return at > 0 && RECORD_ID.test(pair.slice(0, at)) && VIEW_REGION.test(pair.slice(at + 1));
    })
    .slice(0, MAX_COMPARE_VIEWS)
    .join(';');
  // Whether the comparison panes follow each other. Coupled is the documented
  // default and stays out of the URL; only the visitor's decision to uncouple is
  // shareable (`?csync=0`), so a comparison link reproduces the view it names.
  out.csync = out.csync === '0' || out.csync === 'false' ? '0' : '1';
  // The History view's year and its own map window. The dataset reaches from
  // 123000 BCE to 2010 CE, so the bound is wide but finite; the view snaps to
  // the nearest published snapshot and says which one it draws.
  out.year = Math.max(-130000, Math.min(2200, Math.round(Number(out.year) || STATE_DEFAULTS.year)));
  out.hv = /^-?\d{1,3}(?:\.\d{1,4})?,-?\d{1,3}(?:\.\d{1,4})?,\d{1,2}(?:\.\d{1,2})?$/.test(String(out.hv ?? '')) ? String(out.hv) : '';
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

export function createStore({
  initial = {},
  defaults = STATE_DEFAULTS,
  history = safeHistory(),
  location = safeLocation(),
  window: win = safeWindow(),
  now = () => Date.now(), // injectable clock: the coalescing window is testable
} = {}) {
  let state = sanitise({ ...defaults, ...initial, ...readStateFromUrl(location?.search ?? '', defaults) });
  const subscribers = new Set();
  let urlSync = Boolean(history && location);
  // Which URL the browser is on right now. Comparing against it keeps us from
  // writing an entry twice and from turning a no-op into a history step.
  let lastUrl = urlOf();
  let lastPushSignature = '';
  let lastPushAt = 0;
  let suppressPushUntil = 0;
  // The query text of the history entry we are on: a later keystroke that still
  // continues it is the same gesture, however long the pause in between was.
  let entryQ = String(state.q ?? '');
  // Flipped by the first pointer/key event; until then every URL write replaces.
  let userActed = false;
  const markUserAction = () => {
    userActed = true;
  };

  function urlOf() {
    if (!location) return '';
    return `${location.pathname || '/'}${location.search || ''}${location.hash || ''}`;
  }

  function notify(changedKeys) {
    for (const fn of subscribers) {
      try {
        fn(state, changedKeys);
      } catch (err) {
        console.error('[store] subscriber failed', err);
      }
    }
  }

  const signatureOf = (changedKeys) => [...changedKeys].sort().join(',');
  /**
   * Should this change open a new history entry? Only deliberate state changes
   * do, and never twice in a row for the same set of keys inside
   * HISTORY_COALESCE_MS — that is what keeps typing in the filter box from
   * leaving one entry per keystroke.
   *
   * Two guard rails:
   *  - `userActed` — the app repairs its own initial state after the data
   *    arrives (the year range is clamped to the years that exist), and that
   *    repair must land in the entry the visitor arrived on, not on top of it;
   *    otherwise the first press of “back” would stay inside the app.
   *  - `suppressPushUntil` — the same for writes right after a popstate.
   */
  /**
   * Is this change a continuation of the text in the current history entry?
   * Only for the typed keys, only for the same key set as the entry's push, and
   * only while the text really continues it in either direction: typing and
   * backspacing stay one step, a query rewritten from scratch (or one that
   * starts from an empty box) is a step of its own.
   */
  function isTypedContinuation(changedKeys) {
    if (changedKeys.length === 0) return false;
    if (!changedKeys.every((key) => HISTORY_TEXT_KEYS.includes(key))) return false;
    const before = entryQ;
    const after = String(state.q ?? '');
    if (before === '' || after === '') return false;
    return before.startsWith(after) || after.startsWith(before);
  }

  function shouldPush(changedKeys, stamp) {
    if (!userActed) return false;
    if (stamp < suppressPushUntil) return false;
    if (!changedKeys.some((key) => HISTORY_PUSH_KEYS.includes(key))) return false;
    const signature = signatureOf(changedKeys);
    if (signature !== lastPushSignature) return true;
    if (stamp - lastPushAt < HISTORY_COALESCE_MS) return false;
    // Same control, but the visitor kept editing the same query: still one step.
    return !isTypedContinuation(changedKeys);
  }

  function syncUrl(mode = 'auto', changedKeys = []) {
    if (!urlSync || !history || !location) return;
    const query = stateToQuery(state, defaults);
    const next = `${location.pathname || '/'}${query ? `?${query}` : ''}${location.hash || ''}`;
    if (next === lastUrl) return;
    const stamp = now();
    const push = mode === 'push' || (mode === 'auto' && shouldPush(changedKeys, stamp));
    try {
      if (push) history.pushState({ ...state }, '', next);
      else history.replaceState({ ...state }, '', next);
      // A gesture stays the same gesture as long as changes keep arriving: the
      // window is measured from the *last* change of this key set, not from the
      // entry it opened. Otherwise a long drag or a long word would push again
      // in the middle of the gesture.
      lastPushSignature = signatureOf(changedKeys);
      lastPushAt = stamp;
      entryQ = String(state.q ?? '');
      lastUrl = next;
    } catch {
      urlSync = false; // sandboxed iframe or file:// – keep working without URL sync
    }
  }

  function update(patch, { silent = false, history: mode = 'auto' } = {}) {
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
    syncUrl(mode, changed);
    if (!silent) notify(changed);
    return state;
  }

  /**
   * Read the state back out of the URL the browser just moved us to. Returns
   * the list of keys that really changed, so the caller can tell a real
   * navigation from a hash-only popstate. Modules need no extra wiring: they
   * receive the same `(state, changedKeys)` notification as from `update()`.
   */
  function applyUrl() {
    if (!location) return [];
    const parsed = readStateFromUrl(location.search || '', defaults);
    const changed = Object.keys(defaults).filter((key) => state[key] !== parsed[key]);
    lastUrl = urlOf();
    lastPushSignature = '';
    // The entry we just moved to owns its own query text; typing on from here
    // continues *that* search, not the one we left.
    entryQ = String(parsed.q ?? '');
    // A view that writes its clamped state back (for example a sheet number)
    // must not turn the entry we just navigated to into a second entry.
    suppressPushUntil = now() + HISTORY_COALESCE_MS;
    if (changed.length === 0) return [];
    state = parsed;
    notify(changed);
    return changed;
  }

  if (urlSync && typeof win?.addEventListener === 'function') {
    win.addEventListener('popstate', () => {
      applyUrl();
    });
    // The first real interaction separates “the app fixing up its own start-up
    // state” (replace) from what the visitor asked for (push). The `click`
    // listener is captured so that it is seen before the clicked control's own
    // handler, and a plain `click` event counts too — an activation that never
    // saw a pointer or a key (screen reader, `el.click()`) is still a user
    // decision.
    win.addEventListener('click', markUserAction, { capture: true, passive: true });
    for (const type of ['pointerdown', 'keydown', 'touchstart']) {
      win.addEventListener(type, markUserAction, { passive: true });
    }
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
    /** Back/forward handling and the tests call this. */
    applyUrl,
    setUrlSync(enabled) {
      urlSync = Boolean(enabled);
    },
  };
}
