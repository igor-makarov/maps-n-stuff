/**
 * Place search (combobox) on top of the Worker-proxied swisstopo SearchServer.
 * Falls back to a local title search when the upstream is unreachable, and
 * always says which one answered.
 */

import { debounce, el, qs, setStatus } from './dom.js';
import { matchesQuery } from './records.js';

const MIN_CHARS = 2;
const QUICK = [
  { label: 'Zürich (ZH)', lat: 47.3769, lon: 8.5417, zoom: 12 },
  { label: 'Schweiz', lat: 46.8, lon: 8.23, zoom: 7 },
  { label: 'Basel (BS)', lat: 47.5596, lon: 7.5886, zoom: 12 },
  { label: 'Genf (GE)', lat: 46.2044, lon: 6.1432, zoom: 12 },
];

export function init(ctx) {
  const form = qs('#place-search');
  const input = qs('#place-input');
  const submit = qs('#place-submit');
  const list = qs('#place-suggestions');
  const status = qs('#place-status');
  if (!form || !input || !list) return;

  const state = { items: [], active: -1, controller: null, source: null };

  // `quickLinks` must be declared before the first render call: a `let` that is
  // still in its temporal dead zone threw here and killed the whole module
  // (found by scripts/browser-check.mjs, fixed 2026-10-18 / maps-3).
  let quickLinks = null;

  input.value = ctx.store.getState().place || '';
  renderQuickLinks();

  function renderQuickLinks() {
    if (!status) return;
    const wrap = el('span', { class: 'zh-quickranges', id: 'place-quick', role: 'group', 'aria-label': 'Schnellauswahl Orte' }, [
      el('span', { class: 'zh-hint', text: 'Schnellauswahl: ' }),
      ...QUICK.map((place) =>
        el('button', {
          class: 'zh-chip',
          type: 'button',
          onclick: () => choose({ ...place, origin: 'Schnellauswahl' }, { zoom: place.zoom }),
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
              el('span', { class: 'zh-suggestions__type', text: item.origin ? item.origin.replace(/^gg25$/, 'swisstopo') : source }),
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
    const targetZoom = zoom ?? zoomForBbox(place.bbox) ?? 12;
    input.value = place.label;
    ctx.store.update({ place: place.label, lat: place.lat, lon: place.lon, zoom: targetZoom });
    ctx.bus.emit('place:selected', { ...place, zoom: targetZoom, source: state.source });
    // A "Datensatz" suggestion is a record, not a gazetteer place: open it too.
    const record = place.recordId ? ctx.data.recordIndex?.get(place.recordId) : null;
    if (record) {
      ctx.store.update({ selected: record.id });
      ctx.bus.emit('record:selected', { record, source: 'search' });
    }
    setStatus(status, `Kartenausschnitt auf „${place.label}“ gesetzt (${place.lat.toFixed(4)}, ${place.lon.toFixed(4)}).`);
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

  function localFallback(query) {
    const records = ctx.data.records.filter((record) => matchesQuery(record, query)).slice(0, 6);
    if (records.length === 0) return [];
    return records.map((record) => ({
      label: record.title.length > 80 ? `${record.title.slice(0, 77)}…` : record.title,
      origin: 'Datensatz',
      lat: record.geo?.lat ?? null,
      lon: record.geo?.lon ?? null,
      bbox: record.extent ?? null,
      recordId: record.id,
    }));
  }

  async function suggest(query) {
    state.controller?.abort();
    state.controller = new AbortController();
    setStatus(status, 'Orte werden gesucht …');
    form.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch(`/api/search/places?q=${encodeURIComponent(query)}&limit=8`, { signal: state.controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const items = (data.results ?? []).filter((item) => item.lat !== null && item.lon !== null);
      if (items.length === 0) {
        const local = localFallback(query);
        open(local, 'lokal');
        setStatus(status, local.length > 0 ? 'Kein Ort gefunden – Titelvorschläge aus den Datensätzen:' : 'Kein Ort und kein Titeltreffer gefunden.');
        return;
      }
      open(items, data.source ?? 'swisstopo');
      setStatus(status, `${items.length} Ortsvorschläge (swisstopo). Mit ↓/↑ wählen, Enter bestätigen.`);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      const local = localFallback(query);
      open(local, 'lokal');
      setStatus(
        status,
        local.length > 0
          ? `Ortssuche nicht erreichbar (${err.message}) – Vorschläge aus den Datensätzen.`
          : `Ortssuche derzeit nicht erreichbar (${err.message}).`,
      );
    } finally {
      form.setAttribute('aria-busy', 'false');
    }
  }

  const onInput = debounce(() => {
    const query = input.value.trim();
    if (query.length < MIN_CHARS) {
      close();
      setStatus(status, 'Mindestens zwei Zeichen eingeben – oder eine Schnellauswahl nutzen.');
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

  // Keep the field in sync when another module changes the place (e.g. reset).
  ctx.store.subscribe((next, changed) => {
    if (changed.includes('place') && next.place && next.place !== input.value) input.value = next.place;
  });

  return { suggest, choose };
}
