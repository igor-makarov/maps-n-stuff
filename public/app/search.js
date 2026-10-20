/**
 * Worldwide place search (combobox) on top of the Worker-proxied Nominatim
 * gazetteer (OpenStreetMap), with local catalogue matches when it is unavailable.
 * Falls back to a local title search when both are unreachable, and always says
 * which one answered.
 */

import { debounce, el, qs, setStatus } from './dom.js';
import { coversPoint, filterRecords, matchesQuery, recordCenter } from './records.js';
import { parsePoint, sanitisePoint } from './store.js';

const MIN_CHARS = 2;
// The initial view is the whole world, so the quick picks are world cities on
// several continents — not one canton's towns. Every entry is a documented
// gazetteer coordinate, not a guessed one.
export const QUICK_PLACES = [
  { label: 'Cairo', lat: 30.0444, lon: 31.2357, zoom: 11 },
  { label: 'Tokyo', lat: 35.6762, lon: 139.6503, zoom: 10 },
  { label: 'Mexico City', lat: 19.4326, lon: -99.1332, zoom: 10 },
  { label: 'São Paulo', lat: -23.5505, lon: -46.6333, zoom: 10 },
  { label: 'London', lat: 51.5072, lon: -0.1276, zoom: 10 },
];

/**
 * Record-title suggestions used when the worldwide gazetteer cannot answer
 * (Worker/upstream outage). Pure so it is unit-testable; the coordinates come
 * from `recordCenter`, which falls back to the documented extent — a missing
 * `geo` point must never produce a null map position.
 */
export function fallbackSuggestions(records, query, limit = 6) {
  const hits = (records ?? []).filter((record) => matchesQuery(record, query)).slice(0, limit);
  return hits.map((record) => {
    const center = recordCenter(record);
    return {
      label: record.title.length > 80 ? `${record.title.slice(0, 77)}…` : record.title,
      origin: 'record',
      lat: center?.lat ?? null,
      lon: center?.lon ?? null,
      bbox: record.extent ?? null,
      recordId: record.id,
    };
  });
}

/**
 * “Search the records too”: the big box is a place search, but a visitor who
 * types a title, a series, a library or a shelfmark expects map results — the
 * OldMapsOnline behaviour. This pure helper turns the query into ONE suggestion
 * that applies the existing keyword filter; the count is what the visitor will
 * actually see, because it runs the same filter pipeline with the current time,
 * provider, type and collection filters. Nothing is invented: zero matches means
 * no suggestion.
 */
export function datasetSuggestion(records, query, state = {}) {
  const text = String(query || '').trim();
  if (text.length < MIN_CHARS) return null;
  const count = filterRecords({ ...state, q: text }, records ?? []).length;
  if (count === 0) return null;
  const label = text.length > 60 ? `${text.slice(0, 57)}…` : text;
  return {
    kind: 'dataset',
    query: text,
    count,
    label: `Maps matching “${label}”`,
    origin: count === 1 ? '1 record' : `${count} records`,
  };
}

export function init(ctx) {
  const form = qs('#place-search');
  const input = qs('#place-input');
  const submit = qs('#place-submit');
  const list = qs('#place-suggestions');
  const status = qs('#place-status');
  if (!form || !input || !list) return;

  const state = { items: [], active: -1, controller: null, source: null };

  let quickLinks = null;
  // The last place the user chose; when it has a position, offer the point
  // filter (“browse the maps that cover this place”, the OldMapsOnline step).
  let chosenPlace = null;
  const actionWrap = el('div', { class: 'zh-quickranges', id: 'place-action', hidden: true });
  if (status?.after) status.after(actionWrap);
  if (status) {
    const initialAt = parsePoint(ctx.store.getState().at);
    if (initialAt && ctx.store.getState().place) chosenPlace = { label: ctx.store.getState().place, lat: initialAt.lat, lon: initialAt.lon };
  }

  input.value = ctx.store.getState().place || '';
  renderQuickLinks();
  renderPlaceAction();

  /** Records in the current filters whose documented extent covers the place. */
  function countAtPoint(point) {
    if (!point) return 0;
    return filterRecords(ctx.store.getState(), ctx.data.records).filter((record) => coversPoint(record, point.lat, point.lon)).length;
  }

  /** The chip under the search status: one click filters the list to this place. */
  function renderPlaceAction() {
    if (!actionWrap) return;
    const point = chosenPlacePoint();
    if (!point) {
      actionWrap.hidden = true;
      actionWrap.replaceChildren();
      return;
    }
    const active = ctx.store.getState().at === sanitisePoint(`${point.lat},${point.lon}`);
    const count = countAtPoint(point);
    const label = chosenPlace.label.length > 42 ? `${chosenPlace.label.slice(0, 39)}…` : chosenPlace.label;
    const button = el('button', {
      class: 'zh-chip zh-chip--action',
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      title: active
        ? 'Remove the point filter; the whole collection in the current period applies again.'
        : 'Show only records whose documented map extent contains this place.',
      onclick: () => ctx.store.update({ at: active ? '' : sanitisePoint(`${point.lat},${point.lon}`) }),
    }, [count === 0 ? `Maps at this place — none in this period (${label})` : `Maps at this place (${count}): ${label}`]);
    actionWrap.replaceChildren(button);
    actionWrap.hidden = false;
  }

  function chosenPlacePoint() {
    if (!chosenPlace) return null;
    if (Number.isFinite(chosenPlace.lat) && Number.isFinite(chosenPlace.lon)) return { lat: chosenPlace.lat, lon: chosenPlace.lon };
    const bbox = chosenPlace.bbox;
    if (bbox && [bbox.west, bbox.east, bbox.south, bbox.north].every(Number.isFinite)) {
      return { lat: (bbox.south + bbox.north) / 2, lon: (bbox.west + bbox.east) / 2 };
    }
    return null;
  }

  function renderQuickLinks() {
    if (!status) return;
    const wrap = el('span', { class: 'zh-quickranges', id: 'place-quick', role: 'group', 'aria-label': 'Quick place picks' }, [
      el('span', { class: 'zh-hint', text: 'Quick picks: ' }),
      ...QUICK_PLACES.map((place) =>
        el('button', {
          class: 'zh-chip',
          type: 'button',
          onclick: () => choose({ ...place, origin: 'quick pick' }, { zoom: place.zoom }),
        }, [place.label]),
      ),
    ]);
    if (quickLinks?.isConnected) quickLinks.replaceWith(wrap);
    else status.after(wrap);
    quickLinks = wrap;
  }

  function close() {
    list.hidden = true;
    list.replaceChildren();
    state.items = [];
    state.active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function uniquePlaces(items) {
    const seen = new Set();
    return items.filter((item) => {
      const key = `${String(item.label).toLowerCase()}|${item.lat?.toFixed?.(3) ?? ''}|${item.lon?.toFixed?.(3) ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function open(items, source) {
    const unique = uniquePlaces(items);
    state.items = unique;
    state.source = source;
    state.active = unique.length > 0 ? 0 : -1;
    list.replaceChildren(
      ...unique.map((item, index) =>
        el('li', { role: 'none' }, [
          el(
            'button',
            {
              type: 'button',
              role: 'option',
              id: `place-option-${index}`,
              'aria-selected': index === 0 ? 'true' : 'false',
              onclick: () => choose(item),
              onmousemove: () => setActive(index),
            },
            [
              el('span', { text: item.label }),
              el('span', { class: 'zh-suggestions__type', text: item.origin || source }),
            ],
          ),
        ]),
      ),
    );
    list.hidden = unique.length === 0;
    input.setAttribute('aria-expanded', unique.length > 0 ? 'true' : 'false');
    updateActive();
  }

  function setActive(index) {
    state.active = index;
    for (const [i, node] of [...list.querySelectorAll('button')].entries()) {
      const selected = i === index;
      node.setAttribute('aria-selected', selected ? 'true' : 'false');
      if (selected) input.setAttribute('aria-activedescendant', node.id);
    }
  }

  function updateActive() {
    if (state.active >= 0) setActive(state.active);
    else input.removeAttribute('aria-activedescendant');
  }

  function choose(place, { zoom } = {}) {
    // “Karten zum Stichwort …”: the search box offers the same keyword filter the
    // sidebar uses. Nothing is opened; the result list and the map follow the
    // store, and the status line states how many rows the filter really leaves.
    if (place?.kind === 'dataset') {
      ctx.store.update({ q: place.query, ...(ctx.store.getState().view === 'history' ? { view: 'split' } : {}) });
      const left = filterRecords({ ...ctx.store.getState(), q: place.query }, ctx.data.records).length;
      setStatus(
        status,
        left === 0
          ? `No record matches “${place.query}” in the current time range.`
          : `Map search: ${left} record${left === 1 ? '' : 's'} matching “${place.query}” — the list is filtered accordingly.`,
      );
      input.value = place.query;
      close();
      return;
    }
    const targetZoom = zoom ?? zoomForBbox(place.bbox) ?? 12;
    const hasPoint = Number.isFinite(place.lat) && Number.isFinite(place.lon);
    chosenPlace = { label: place.label, lat: place.lat, lon: place.lon, bbox: place.bbox ?? null };
    renderPlaceAction();
    input.value = place.label;
    if (hasPoint) {
      ctx.store.update({ place: place.label, lat: place.lat, lon: place.lon, zoom: targetZoom });
      ctx.bus.emit('place:selected', { ...place, zoom: targetZoom, source: state.source });
    } else if (place.bbox) {
      // Fallback suggestions come from records; a record without a published
      // point still has a documented extent, so fit that instead of writing a
      // null coordinate into the map state (which used to throw here).
      ctx.store.update({ place: place.label });
      ctx.bus.emit('view:fit', { bounds: place.bbox });
    } else {
      ctx.store.update({ place: place.label });
    }
    // A "Datensatz" suggestion is a record, not a gazetteer place: open it too.
    const record = place.recordId ? ctx.data.recordIndex?.get(place.recordId) : null;
    if (record) {
      ctx.store.update({ selected: record.id });
      ctx.bus.emit('record:selected', { record, source: 'search' });
    }
    setStatus(
      status,
      hasPoint
        ? `Map view set to “${place.label}” (${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}).`
        : place.bbox
          ? `Map fitted to “${place.label}”.`
          : `“${place.label}” selected.`,
    );
    close();
  }

  function zoomForBbox(bbox) {
    if (!bbox) return null;
    const span = Math.max(bbox.east - bbox.west, bbox.north - bbox.south);
    if (!Number.isFinite(span) || span <= 0) return 14;
    if (span > 20) return 4;
    if (span > 5) return 7;
    if (span > 1) return 9;
    if (span > 0.25) return 11;
    if (span > 0.05) return 13;
    return 15;
  }

  const localFallback = (query) => fallbackSuggestions(ctx.data.records, query);

  /** Turn network failures into a short, English status message. */
  function errorReason(err) {
    const message = String(err?.message ?? err ?? '');
    const http = message.match(/\bHTTP (\d{3})\b/);
    if (http) return `HTTP ${http[1]}`;
    if (/failed to fetch|networkerror|network error|load failed|err_/i.test(message)) return 'network error';
    return message.slice(0, 80) || 'unknown error';
  }

  async function suggest(query) {
    state.controller?.abort();
    state.controller = new AbortController();
    setStatus(status, 'Searching places …');
    form.setAttribute('aria-busy', 'true');
    // The record search always joins the list (last, so a real place stays the
    // default choice); it is the only suggestion when no place matches.
    const records = datasetSuggestion(ctx.data.records, query, ctx.store.getState());
    try {
      const res = await fetch(`/api/search/places?q=${encodeURIComponent(query)}&limit=8`, { signal: state.controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.results ?? []).filter((item) => item.lat !== null && item.lon !== null);
      if (items.length === 0) {
        const local = localFallback(query);
        const combined = records ? [records, ...local] : local;
        open(combined, 'local collection');
        setStatus(status, statusText([], records, local));
        return;
      }
      open(records ? [...items, records] : items, data.source ?? 'OpenStreetMap');
      setStatus(status, statusText(items, records, []));
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const local = localFallback(query);
      const combined = records ? [records, ...local] : local;
      open(combined, 'local collection');
      setStatus(
        status,
        local.length > 0 || records
          ? `Place search unavailable (${errorReason(err)}) — suggestions from the collection.`
          : `Place search is currently unavailable (${errorReason(err)}).`,
      );
    } finally {
      form.setAttribute('aria-busy', 'false');
    }
  }

  /**
   * One honest sentence about what the list offers: places found, record matches,
   * or neither. Counts come from the suggestions that are really shown.
   */
  function statusText(places, records, local) {
    if (places.length === 0 && !records && local.length === 0) return 'No place and no title match found.';
    const parts = [];
    if (places.length > 0) parts.push(`${places.length} place suggestion${places.length === 1 ? '' : 's'}`);
    else parts.push('No place suggestion');
    if (records) parts.push(`${records.origin} for “${records.query}”`);
    else if (local.length > 0) parts.push(`${local.length} title suggestion${local.length === 1 ? '' : 's'} from the collection`);
    return `${parts.join(' · ')}. Use ↓/↑ to choose, Enter to confirm.`;
  }

  const onInput = debounce(() => {
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      close();
      setStatus(status, 'Type at least two characters — or use a quick pick.');
      return;
    }
    suggest(query);
  }, 260);

  input.addEventListener('input', onInput);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' && !list.hidden) {
      event.preventDefault();
      setActive(Math.min(state.items.length - 1, state.active + 1));
    } else if (event.key === 'ArrowUp' && !list.hidden) {
      event.preventDefault();
      setActive(Math.max(0, state.active - 1));
    } else if (event.key === 'Home' && !list.hidden) {
      event.preventDefault();
      setActive(0);
    } else if (event.key === 'End' && !list.hidden) {
      event.preventDefault();
      setActive(state.items.length - 1);
    } else if (event.key === 'Enter') {
      if (!list.hidden && state.active >= 0 && state.items[state.active]) {
        event.preventDefault();
        choose(state.items[state.active]);
      } else {
        event.preventDefault();
        onInput.flush();
      }
    } else if (event.key === 'Escape') {
      close();
    }
  });

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!list.hidden && state.items[state.active]) {
      choose(state.items[state.active]);
      return;
    }
    const query = input.value.trim();
    if (query.length >= MIN_CHARS) onInput.flush();
  });

  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) close();
  });

  submit?.setAttribute('type', 'submit');

  // Keep the field in sync when another module changes the place (e.g. reset),
  // and re-count the “Karten an diesem Ort” chip when the filters change.
  ctx.store.subscribe((next, changed) => {
    if (changed.includes('place') && next.place && next.place !== input.value) input.value = next.place;
    if (changed.some((key) => ['from', 'to', 'q', 'provider', 'type', 'collection', 'at'].includes(key))) renderPlaceAction();
  });

  return { suggest, choose };
}
