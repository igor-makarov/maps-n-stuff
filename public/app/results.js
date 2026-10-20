/**
 * Filters (time, collection, type, keyword), the comparison-layer picker and
 * the result list. Emits `records:filtered` so the map stays in sync.
 */

import { debounce, el, formatYearRange, qs, setStatus } from './dom.js';
import { coversPoint, facets, filterRecords, matchesQuery, overlapsRange, recordsInBounds, sortRecords } from './records.js';
import { STATE_DEFAULTS, parsePoint } from './store.js';

const TYPE_LABELS = {
  map: 'Map',
  atlas: 'Atlas / map series',
  sheet: 'Map sheet',
  overlay: 'Georeferenced overlay',
};

const SCALE_MAX = 1000; // slider resolution for the year range

/** The split layout whose map column is sticky; below it the page scrolls the
 *  map away, so a pin selection must not move the page there. */
const REVEAL_MIN_WIDTH = 1024;

/** How long a row that was brought into view stays marked. */
export const REVEAL_HIGHLIGHT_MS = 2200;

/** Readable band of the viewport: nothing sticky is above the list, and the
 *  floating “Nach oben” control sits in the bottom-right corner. */
const REVEAL_BAND = { top: 8, bottom: 24, gap: 8 };

/**
 * How far the window has to scroll so `row` is fully inside the readable band,
 * or 0 when it already is. Pure, so the rule is unit tested rather than
 * eyeballed: `row` and `view` are rectangles in viewport coordinates (exactly
 * what `getBoundingClientRect()` returns), the result is the delta for
 * `window.scrollBy({ top })` — negative scrolls up.
 *
 * A row taller than the band is aligned to the band's top instead, because the
 * title (what identifies the row) is at the top, not the bottom.
 */
export function revealScrollDelta(row, view, { top = 0, bottom = 0, gap = 8 } = {}) {
  if (!row || !view) return 0;
  const bandTop = Math.max(0, top);
  const bandBottom = Math.max(bandTop, view.height - Math.max(0, bottom));
  const height = row.bottom - row.top;
  if (bandBottom <= bandTop) return 0;
  if (height >= bandBottom - bandTop) {
    if (row.top >= bandTop && row.top <= bandBottom) return 0;
    return Math.round(bandTop + gap - row.top);
  }
  if (row.bottom > bandBottom) return Math.round(row.bottom - bandBottom + gap);
  if (row.top < bandTop) return -Math.round(bandTop - row.top + gap);
  return 0;
}

/**
 * What the list's live region says when the selection was made somewhere else
 * (a pin, a point pile, a related sheet, a comparison pane): the visitor who
 * never looks at the list still has to learn that it moved with the selection,
 * which row it is and how many rows exist. Pure, so the wording — including the
 * 1-based row number and the two different not-in-list cases — is unit tested.
 *
 * `index` is the 0-based position in the current result list, `total` its
 * length. `revealed` is `revealRow()`'s answer: it is only mentioned when the
 * page really scrolled (below 1024 px it deliberately does not).
 */
export function selectionAnnouncement({ index = -1, total = 0, title = '', revealed = false } = {}) {
  const name = String(title ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const count = `${Number.isInteger(total) && total > 0 ? total : 0} results`;
  if (Number.isInteger(index) && index >= 0 && index < total) {
    return `${count}. Row ${index + 1} of ${total} selected${name ? `: ${name}` : ''}.${
      revealed ? ' The list scrolled to this row.' : ''
    }`;
  }
  if (!name) return '';
  return `${count}. Selected: ${name}. This record is outside the current results.`;
}

export function init(ctx) {
  const listEl = qs('#result-list');
  const stateEl = qs('#results-state');
  const countEl = qs('#result-count');
  const liveEl = qs('#results-live');
  const sortEl = qs('#sort-select');
  const textEl = qs('#text-filter');
  const yearFrom = qs('#year-from');
  const yearTo = qs('#year-to');
  const yearFill = qs('#year-fill');
  const providerWrap = qs('#provider-filters');
  const typeWrap = qs('#type-filters');
  const overlayEl = qs('#overlay-select');
  const overlayTimeWrap = qs('#overlay-time-field');
  const overlayTime = qs('#overlay-time');
  const overlayTimeOut = qs('#overlay-time-output');
  const overlayOpacity = qs('#overlay-opacity');
  const overlayOpacityOut = qs('#overlay-opacity-output');
  const overlayOpacityField = qs('#overlay-opacity-field');
  const viewportEl = qs('#viewport-filter');
  const viewportCount = qs('#viewport-count');
  const collectionEl = qs('#collection-filter');
  const facetHint = qs('#facet-hint');
  const pointFilterEl = qs('#point-filter');
  const pointFilterText = qs('#point-filter-text');
  const pointFilterClear = qs('#point-filter-clear');
  const overlayNote = qs('#overlay-note');
  const resetEl = qs('#reset-filters');

  if (!listEl || !countEl) return;

  let records = ctx.data.records;
  const years = ctx.data.years;
  const { providers, types } = facets(records);
  let lastFiltered = [];
  let viewBounds = null;

  /* ---------- controls ---------- */

  const setYearBounds = () => {
    if (yearFrom) {
      yearFrom.min = String(years.min);
      yearFrom.max = String(years.max);
    }
    if (yearTo) {
      yearTo.min = String(years.min);
      yearTo.max = String(years.max);
    }
  };
  for (const chip of document.querySelectorAll('[data-range]')) {
    chip.addEventListener('click', () => {
      const value = chip.dataset.range;
      if (value === 'all') ctx.store.update({ from: years.min, to: years.max });
      else {
        const [from, to] = value.split('-').map(year => clampYear(year, years));
        ctx.store.update({ from, to });
      }
    });
  }

  // Counts live in the DOM so they can follow the current period without
  // rebuilding the inputs (rebuilding them would drop keyboard focus).
  const facetLabels = new Map(); // "provider:e-rara" -> the label span

  const buildCheckboxes = (wrap, entries, key) => {
    if (!wrap) return;
    const stateKey = key === 'providers' ? 'provider' : 'type';
    wrap.replaceChildren(
      ...[...entries.entries()].map(([value, count]) => {
        const id = `${key}-${value}`;
        const input = el('input', {
          type: 'checkbox',
          id,
          value,
          onchange: () => ctx.store.update({ [stateKey]: input.checked ? value : '' }),
        });
        input.checked = ctx.store.getState()[stateKey] === value;
        const display = stateKey === 'type' ? TYPE_LABELS[value] ?? value : ctx.data.sources.find((source) => source.id === value)?.name ?? value;
        const label = el('span', { text: `${display} (${count})` });
        facetLabels.set(`${stateKey}:${value}`, label);
        return el('label', { class: 'zh-check', for: id }, [input, label]);
      }),
    );
  };

  buildCheckboxes(providerWrap, providers, 'providers');
  buildCheckboxes(typeWrap, types, 'types');

  /* ---------- collection ("Map series") facet ---------- */

  let collectionNames = [...facets(records).collections.keys()].sort((a, b) => a.localeCompare(b, 'en'));
  const collectionOptions = new Map(); // collection name -> { option, unknown }

  function buildCollectionOptions() {
    if (!collectionEl) return;
    const counts = facets(records).collections;
    const nodes = [el('option', { value: '', text: 'All collections' })];
    for (const name of collectionNames) {
      const option = el('option', {
        value: name,
        text: `${name} (${counts.get(name) ?? 0})`,
        dataset: { count: String(counts.get(name) ?? 0) },
      });
      collectionOptions.set(name, { option, unknown: false });
      nodes.push(option);
    }
    collectionEl.replaceChildren(...nodes);
  }
  collectionEl?.addEventListener('change', () => ctx.store.update({ collection: collectionEl.value }));
  buildCollectionOptions();

  // A collection name from a hand-written URL may not be in the seed data: keep
  // it selectable so the filter is visible and can be cleared honestly.
  function ensureCollectionOption(name) {
    if (!collectionEl || !name || collectionOptions.has(name)) return;
    const option = el('option', { value: name, text: `${name} (not in the catalogue)`, dataset: { count: '0', unknown: '1' } });
    collectionOptions.set(name, { option, unknown: true });
    collectionEl.append(option);
  }

  /** Counts per facet for the records inside the current period, keyword and point. */
  function syncFacetCounts(state) {
    const point = parsePoint(state.at);
    const scoped = records.filter(
      (record) =>
        overlapsRange(record, state.from, state.to) &&
        matchesQuery(record, state.q) &&
        (!point || coversPoint(record, point.lat, point.lon)),
    );
    const counts = facets(scoped);
    const countOf = (map, name) => map.get(name) ?? 0;
    for (const [key, node] of facetLabels) {
      const separator = key.indexOf(':');
      const dimension = key.slice(0, separator);
      const name = key.slice(separator + 1);
      const display = dimension === 'type' ? TYPE_LABELS[name] ?? name : ctx.data.sources.find((source) => source.id === name)?.name ?? name;
      node.textContent = `${display} (${countOf(dimension === 'provider' ? counts.providers : counts.types, name)})`;
    }
    for (const [name, entry] of collectionOptions) {
      const count = countOf(counts.collections, name);
      entry.option.dataset.count = String(count);
      entry.option.textContent = entry.unknown ? `${name} (not in the catalogue)` : `${name} (${count})`;
    }
    if (facetHint) {
      facetHint.textContent = `${scoped.length} of ${records.length} records published in ${state.from}–${state.to}${
        state.q ? ` matching “${state.q}”` : ''
      }${point ? ` covering ${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}°` : ''}. Counts reflect the current filters.`;
    }
  }

  sortEl?.addEventListener('change', () => ctx.store.update({ sort: sortEl.value }));
  textEl?.addEventListener(
    'input',
    debounce(() => ctx.store.update({ q: textEl.value.trim() }), 200),
  );
  // One debounced commit that reads *both* fields: a shared debounce used to
  // drop the first patch when a user edited "von" and "bis" in quick succession.
  const commitYears = debounce(() => {
    if (!yearFrom || !yearTo) return;
    ctx.store.update({ from: clampYear(yearFrom.value, years), to: clampYear(yearTo.value, years) });
  }, 250);
  yearFrom?.addEventListener('input', commitYears);
  yearTo?.addEventListener('input', commitYears);

  resetEl?.addEventListener('click', resetFilters);
  pointFilterClear?.addEventListener('click', () => ctx.store.update({ at: '' }));

  /**
   * The active point filter, stated above the list: what it means, how many
   * records it keeps, and one button to remove only this filter.
   */
  function renderPointFilter(point, count) {
    if (!pointFilterEl) return;
    if (!point) {
      pointFilterEl.hidden = true;
      if (pointFilterText) pointFilterText.replaceChildren();
      return;
    }
    pointFilterEl.hidden = false;
    if (pointFilterText) {
      pointFilterText.replaceChildren(
        el('strong', { text: `Maps at this location (${count})` }),
        el('span', {
          text: ` — maps whose documented extent covers ${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}°.`,
        }),
      );
    }
    if (pointFilterClear) {
      pointFilterClear.setAttribute('aria-label', `Clear location filter at ${point.lat.toFixed(4)}°, ${point.lon.toFixed(4)}°`);
    }
  }

  /** One definition for the filter reset: toolbar button and empty state.
   *  Restores the initial view, clamped to the available publication years. */
  function resetFilters() {
    ctx.store.update({
      from: Math.max(years.min, STATE_DEFAULTS.from),
      to: Math.min(years.max, STATE_DEFAULTS.to),
      provider: STATE_DEFAULTS.provider,
      type: STATE_DEFAULTS.type,
      collection: STATE_DEFAULTS.collection,
      at: STATE_DEFAULTS.at,
      q: STATE_DEFAULTS.q,
      selected: STATE_DEFAULTS.selected,
      overlay: STATE_DEFAULTS.overlay,
      otime: STATE_DEFAULTS.otime,
      viewport: STATE_DEFAULTS.viewport,
    });
  }

  viewportEl?.addEventListener('change', () => ctx.store.update({ viewport: viewportEl.checked ? '1' : '' }));
  overlayOpacity?.addEventListener('input', () => {
    const percent = Number(overlayOpacity.value);
    if (overlayOpacityOut) overlayOpacityOut.textContent = `${percent} %`;
    ctx.bus.emit('overlay:opacity', { opacity: percent / 100 });
  });

  /* ---------- comparison layers (swisstopo WMTS) ---------- */

  const layers = (ctx.data.overlays ?? []).filter(
    // "…swissimage-product.metadata" is a tile-pyramid division layer, not map imagery.
    (layer) => !/\.metadata$/.test(layer.id),
  );
  const isHistorical = (layer) => layer.historical !== false;

  /** Editions ascending: slider left = oldest, and the default is a historical one. */
  const editionsOf = (layer) => [...(layer?.timeValues ?? [])].sort();

  /** Publication year encoded in an edition value (`YYYYMMDD`, `YYYY`, …). */
  const editionYear = (value) => {
    const match = String(value ?? '').match(/^(\d{4})/);
    return match ? Number(match[1]) : null;
  };

  /**
   * The edition that best matches a publication year: the newest edition that is
   * not later than the year, else the oldest one. Never invents an edition.
   */
  function editionForYear(layer, year) {
    const values = editionsOf(layer);
    if (values.length === 0) return '';
    let best = values.find((value) => editionYear(value) !== null) ?? values[0];
    for (const value of values) {
      const valueYear = editionYear(value);
      if (valueYear !== null && valueYear <= Number(year) && editionYear(best) !== null) best = value;
    }
    return best;
  }
  if (overlayEl && layers.length > 0) {
    const historical = layers.filter(isHistorical).sort((a, b) => a.title.localeCompare(b.title, 'en'));
    const modern = layers.filter((l) => !isHistorical(l)).sort((a, b) => a.title.localeCompare(b.title, 'en'));
    overlayEl.replaceChildren(
      el('option', { value: '', text: 'No overlay' }),
      el('optgroup', { label: 'Historical maps and imagery' }, historical.map((l) => el('option', { value: l.id, text: l.title }))),
      el('optgroup', { label: 'Other regional layers' }, modern.map((l) => el('option', { value: l.id, text: l.title }))),
    );
    overlayEl.addEventListener('change', () => {
      const layer = layers.find((l) => l.id === overlayEl.value) ?? null;
      const edition = editionForYear(layer, ctx.store.getState().to);
      ctx.store.update({ overlay: layer?.id ?? '', otime: edition });
      applyOverlay(layer, edition);
    });
  }

  ctx.bus.on('overlay:added', ({ layer }) => {
    if (!layers.some(value => value.id === layer.id)) {
      layers.push(layer);
      overlayEl?.append(el('option', { value: layer.id, text: `${layer.title} — reusable alignment` }));
    }
  });

  // Explicit "match the time filter" action: choosing an edition is a user
  // decision, so nothing changes behind their back.
  const syncButton = el('button', {
    class: 'zh-chip zh-chip--action',
    type: 'button',
    id: 'overlay-sync-year',
    onclick: () => {
      const state = ctx.store.getState();
      const layer = layers.find((l) => l.id === state.overlay);
      if (!layer) return;
      setEdition(layer, editionForYear(layer, state.to));
      if (overlayNote) {
        setStatus(overlayNote, `Edition ${formatTime(ctx.store.getState().otime)} selected for the period up to ${state.to}.`);
      }
    },
  }, ['Match edition to the year filter']);
  overlayTimeWrap?.append(syncButton);

  /** Move the edition slider + store + map to one edition value. */
  function setEdition(layer, value) {
    const values = editionsOf(layer);
    if (!value || values.length === 0) return;
    if (overlayTime && values.length > 1) overlayTime.value = String(Math.max(0, values.indexOf(value)));
    updateTimeOutput(layer, value);
    ctx.store.update({ otime: value });
    ctx.bus.emit('overlay:time', { time: value, layer });
  }

  function applyOverlay(layer, time) {
    if (!layer) {
      ctx.bus.emit('overlay:changed', { layer: null, time: null });
      if (overlayTimeWrap) overlayTimeWrap.hidden = true;
      if (overlayOpacityField) overlayOpacityField.hidden = true;
      if (overlayNote) overlayNote.textContent = 'Choose an aligned historical map. Coverage and attribution depend on the original collection.';
      return;
    }
    if (overlayOpacityField) overlayOpacityField.hidden = false;
    overlayOpacity?.dispatchEvent(new Event('input'));
    const values = editionsOf(layer);
    syncButton.hidden = values.length <= 1;
    syncButton.textContent = `Edition for ${ctx.store.getState().to}`;
    if (overlayTimeWrap && overlayTime && values.length > 1) {
      overlayTimeWrap.hidden = false;
      overlayTime.min = '0';
      overlayTime.max = String(values.length - 1);
      const index = Math.max(0, values.indexOf(time ?? ctx.store.getState().otime));
      overlayTime.value = String(index);
      updateTimeOutput(layer, values[index]);
    } else if (overlayTimeWrap) {
      overlayTimeWrap.hidden = true;
    }
    if (overlayNote) {
      overlayNote.textContent = `${layer.title} – ${values.length > 1 ? `${values.length} editions` : 'one edition'}; ${
        layer.license ?? 'See original source terms'
      }.`;
    }
    ctx.bus.emit('overlay:changed', { layer, time: time ?? values[0] ?? 'current' });
  }

  function updateTimeOutput(layer, value) {
    if (!overlayTimeOut) return;
    overlayTimeOut.textContent = value ? `${formatTime(value)} (${layer.id})` : '';
  }

  overlayTime?.addEventListener(
    'input',
    debounce(() => {
      const layer = layers.find((l) => l.id === ctx.store.getState().overlay);
      const values = editionsOf(layer);
      const value = values[Number(overlayTime.value)];
      if (!value) return;
      updateTimeOutput(layer, value);
      ctx.store.update({ otime: value });
      ctx.bus.emit('overlay:time', { time: value, layer });
    }, 120),
  );

  function formatTime(value) {
    const text = String(value ?? '');
    if (/^\d{8}$/.test(text)) return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
    return text === 'current' ? 'current' : text;
  }

  /* ---------- result list ---------- */

  function thumb(record) {
    if (!record.thumbnail) return el('span', { class: 'zh-result__thumb zh-result__thumb--missing', 'aria-hidden': 'true', text: '🗺' });
    const img = el('img', {
      class: 'zh-result__thumb',
      loading: 'lazy',
      decoding: 'async',
      alt: '',
      src: record.thumbnail,
    });
    img.addEventListener('error', () => {
      img.removeAttribute('src');
      img.classList.add('zh-result__thumb--missing');
      img.alt = 'No preview available';
      img.replaceWith(el('span', { class: 'zh-result__thumb zh-result__thumb--missing', 'aria-hidden': 'true', text: '🗺' }));
    });
    return img;
  }

  function renderItem(record, index) {
    const button = el(
      'button',
      {
        class: 'zh-result',
        type: 'button',
        id: `result-${record.id.replace(/[^\w-]/g, '_')}`,
        'data-record-id': record.id,
        'aria-current': ctx.store.getState().selected === record.id ? 'true' : 'false',
        onclick: () => select(record),
      },
      [
        thumb(record),
        el('span', { class: 'zh-result__body' }, [
          el('span', { class: 'zh-result__meta' }, [
            el('span', { class: 'zh-result__year', text: formatYearRange(record.yearStart, record.yearEnd) }),
            el('span', { text: `No. ${index + 1}` }),
            record.type ? el('span', { class: 'zh-tag', text: TYPE_LABELS[record.type] ?? record.type }) : null,
          ]),
          el('span', { class: 'zh-result__title', text: record.title }),
          el('span', { class: 'zh-result__meta' }, [
            el('span', { text: record.creators?.length ? record.creators.join(', ') : 'Creator not stated' }),
          ]),
          el('span', { class: 'zh-result__meta' }, [
            el('span', { text: record.institution }),
            record.extent ? el('span', { class: 'zh-tag zh-tag--green', text: 'Extent documented' }) : el('span', { class: 'zh-tag', text: 'Extent not stated' }),
            record.georeference || record.overlay ? el('span', { class: 'zh-tag zh-tag--turquoise', text: record.georeference ? 'Georeferenced raster' : 'Aligned map layer' }) : el('span', { class: 'zh-tag', text: 'Scan; alignment not verified' }),
          ]),
        ]),
      ],
    );
    return el('li', {}, [button]);
  }

  const showIndex = (index) => `No. ${index + 1}`;

  function select(record) {
    ctx.store.update({ selected: record.id });
    ctx.bus.emit('record:selected', { record, source: 'list' });
  }

  /* ---------- bringing a selection made elsewhere into view ---------- */

  let revealTimer = null;

  const rowButton = (id) => {
    if (!id) return null;
    for (const item of listEl.children) {
      const button = item.querySelector('button.zh-result');
      if (button?.dataset.recordId === id) return button;
    }
    return null;
  };

  /**
   * Bring the row of a record selected somewhere else (a pin, a point pile, a
   * related sheet) into view and mark it for a moment. At 199 records a pin's
   * row can be screens away from the map; without this the map click looked
   * like it had only opened the panel.
   *
   * Restricted to the desktop split layout: there `.app-mapwrap` is sticky, so
   * the page can move while the map stays in view, whereas on a phone the same
   * scroll would carry the visitor away from the map they just used. A
   * selection made *in* the list never moves the page — the row is already
   * where the visitor is looking.
   */
  function revealRow(id) {
    if (!id || typeof window === 'undefined') return false;
    if (!window.matchMedia?.(`(min-width: ${REVEAL_MIN_WIDTH}px)`)?.matches) return false;
    let button = rowButton(id);
    if (!button) { const index = lastFiltered.findIndex(record => record.id === id); if (index >= visibleLimit) { visibleLimit = index + 1; render(lastFiltered); render.flush(lastFiltered); button = rowButton(id); } }
    if (!button) return false;
    const delta = revealScrollDelta(button.getBoundingClientRect(), { height: window.innerHeight }, REVEAL_BAND);
    // `behavior: 'instant'` on purpose: the canton stylesheet sets
    // `scroll-behavior: smooth`, and a long smooth scroll is still travelling
    // when the visitor starts the next interaction.
    if (delta !== 0) window.scrollBy({ top: delta, left: 0, behavior: 'instant' });
    for (const node of listEl.querySelectorAll('.zh-result.is-revealed')) node.classList.remove('is-revealed');
    button.classList.add('is-revealed');
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => button.classList.remove('is-revealed'), REVEAL_HIGHLIGHT_MS);
    return true;
  }

  let visibleLimit = 100;
  let lastFilterKey = '';
  const moreButton = el('button', { class: 'zh-button zh-button--ghost', type: 'button', id: 'results-more', hidden: true, onclick: () => { visibleLimit += 100; render(lastFiltered); } }, ['Show 100 more maps']);
  listEl.after(moreButton);
  let items = [];
  const render = debounce((filtered) => {
    const filterKey = JSON.stringify([ctx.store.getState().q, ctx.store.getState().from, ctx.store.getState().to, ctx.store.getState().provider, ctx.store.getState().type, ctx.store.getState().collection, ctx.store.getState().at, ctx.store.getState().sort, ctx.store.getState().viewport, filtered.length]);
    if (filterKey !== lastFilterKey) visibleLimit = 100;
    lastFilterKey = filterKey;
    lastFiltered = filtered;
    items = filtered;
    moreButton.hidden = filtered.length <= visibleLimit;
    moreButton.textContent = `Show more maps (${Math.min(visibleLimit, filtered.length)} of ${filtered.length} shown)`;
    if (filtered.length === 0) {
      listEl.replaceChildren();
      if (stateEl) {
        const state = ctx.store.getState();
        stateEl.hidden = false;
        stateEl.className = 'zh-state zh-state--empty';
        stateEl.replaceChildren(
          el('span', { class: 'zh-state__title', text: 'No maps match these filters' }),
          el('span', {
            text: state.at
              ? 'No catalogued maps cover this point in the selected period. Try a wider period, clear the location filter, or reset all filters.'
              : 'Try a wider period, another collection, or a different keyword. You can also reset all filters.',
          }),
          state.at
            ? el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', onclick: () => ctx.store.update({ at: '' }) }, [
                'Clear location filter',
              ])
            : null,
          el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', onclick: resetFilters }, ['Reset all filters']),
        );
      }
    } else {
      if (stateEl) stateEl.hidden = true;
      listEl.replaceChildren(...filtered.slice(0, visibleLimit).map((record, index) => renderItem(record, index)));
    }
    updateCount(filtered);
    // A hover/focus preview survives a re-render of the list.
    if (previewRow) {
      for (const button of listEl.querySelectorAll('button.zh-result')) {
        if (button.dataset.recordId === previewRow) button.classList.add('is-preview');
      }
    }
  }, 40);

  function updateCount(filtered) {
    const state = ctx.store.getState();
    const parts = [`${filtered.length} of ${records.length} records`, `${state.from}–${state.to}`];
    if (state.provider) parts.push(ctx.data.sources.find(source => source.id === state.provider)?.name ?? state.provider);
    if (state.type) parts.push(TYPE_LABELS[state.type] ?? state.type);
    if (state.collection) parts.push(state.collection);
    if (state.q) parts.push(`“${state.q}”`);
    if (state.at) parts.push('At selected location');
    if (state.viewport === '1') parts.push('In current map view');
    countEl.textContent = parts.join(' · ');
    if (liveEl) liveEl.textContent = `${filtered.length} results. ${filtered[0] ? `First result: ${filtered[0].title}.` : ''}`;
  }

  function apply() {
    const state = ctx.store.getState();
    let filtered = sortRecords(filterRecords(state, records), state.sort);
    const point = parsePoint(state.at);
    if (point) filtered = filtered.filter((record) => coversPoint(record, point.lat, point.lon));
    let outsideCount = 0;
    if (state.viewport === '1') {
      const allInBounds = new Set(recordsInBounds(filtered, viewBounds).map((r) => r.id));
      outsideCount = filtered.length - allInBounds.size;
      filtered = filtered.filter((record) => allInBounds.has(record.id));
    }
    if (viewportEl && viewportEl.checked !== (state.viewport === '1')) viewportEl.checked = state.viewport === '1';
    renderPointFilter(point, filtered.length);
    if (viewportCount) {
      viewportCount.textContent =
        state.viewport === '1'                 ? outsideCount > 0
            ? `${outsideCount} more results are outside this view.`
            : 'All results are in this view.'
          : '';
    }
    if (textEl && textEl.value !== state.q) textEl.value = state.q;
    if (sortEl && sortEl.value !== state.sort) sortEl.value = state.sort;
    if (collectionEl) {
      ensureCollectionOption(state.collection);
      if (collectionEl.value !== state.collection) collectionEl.value = state.collection;
    }
    syncFacetCounts(state);
    refreshHistogramCounts(state);
    updateHistogram(state);
    if (yearFrom && document.activeElement !== yearFrom) yearFrom.value = String(state.from);
    if (yearTo && document.activeElement !== yearTo) yearTo.value = String(state.to);
    if (yearFill) {
      const span = Math.max(1, years.max - years.min);
      const left = ((state.from - years.min) / span) * 100;
      const right = 100 - ((state.to - years.min) / span) * 100;
      yearFill.style.left = `${Math.max(0, Math.min(100, left))}%`;
      yearFill.style.right = `${Math.max(0, Math.min(100, right))}%`;
    }
    if (overlayEl && overlayEl.value !== state.overlay) {
      overlayEl.value = state.overlay;
      const layer = layers.find((l) => l.id === state.overlay) ?? null;
      applyOverlay(layer, state.otime || editionsOf(layer)[0]);
    }
    for (const input of document.querySelectorAll('#provider-filters input')) input.checked = input.value === state.provider;
    for (const input of document.querySelectorAll('#type-filters input')) input.checked = input.value === state.type;
    for (const item of listEl.children) {
      const button = item.querySelector('button');
      button?.setAttribute('aria-current', button?.id === `result-${state.selected.replace(/[^\w-]/g, '_')}` ? 'true' : 'false');
    }
    ctx.bus.emit('records:filtered', { records: filtered, state });
    render(filtered);
  }

  // Cross-highlighting with the map: hovering or focusing a row highlights its
  // marker, and a hovered marker highlights the row (bus event from map.js).
  let previewRow = null;
  const previewTarget = (node) => node?.closest?.('button.zh-result') ?? null;
  const announcePreview = (id) => {
    if (previewRow === id) return; // pointerover fires per child; do not spam the bus
    previewRow = id; // remembered so a later render can be reconciled
    for (const button of listEl.querySelectorAll('button.zh-result')) button.classList.toggle('is-preview', Boolean(id) && button.dataset.recordId === id);
    ctx.bus.emit('record:preview', { id: id ?? null });
  };
  listEl.addEventListener('pointerover', (event) => {
    const button = previewTarget(event.target);
    if (button) announcePreview(button.dataset.recordId);
  });
  listEl.addEventListener('pointerout', (event) => {
    if (event.relatedTarget && listEl.contains(event.relatedTarget)) return;
    announcePreview(null);
  });
  listEl.addEventListener('focusin', (event) => {
    const button = previewTarget(event.target);
    if (button) announcePreview(button.dataset.recordId);
  });
  listEl.addEventListener('focusout', (event) => {
    if (event.relatedTarget && listEl.contains(event.relatedTarget)) return;
    announcePreview(null);
  });
  ctx.bus.on('record:preview', ({ id }) => {
    // Came from the map: reflect it in the list without echoing the event back.
    for (const button of listEl.querySelectorAll('button.zh-result')) button.classList.toggle('is-preview', Boolean(id) && button.dataset.recordId === id);
  });

  // Keyboard navigation inside the list (the map is optional; the list is not).
  listEl.addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...listEl.querySelectorAll('button.zh-result')];
    const current = buttons.indexOf(document.activeElement);
    if (current === -1 && event.key !== 'Home' && event.key !== 'End') return;
    event.preventDefault();
    const next =
      event.key === 'ArrowDown' ? Math.min(buttons.length - 1, current + 1)
      : event.key === 'ArrowUp' ? Math.max(0, current - 1)
      : event.key === 'Home' ? 0
      : buttons.length - 1;
    buttons[next]?.focus();
    buttons[next]?.scrollIntoView({ block: 'nearest' });
  });

  ctx.bus.on('record:selected', ({ record, source }) => {
    // Came from the map (pin or point pile), a related sheet or a comparison
    // pane: mirror the selection in the list, which is its accessible twin.
    if (source === 'list' || !record?.id) return;
    const index = items.findIndex((item) => item.id === record.id);
    const revealed = revealRow(record.id);
    // The list is visually silent for a visitor who cannot see the scroll:
    // `#results-live` is the `role="status"` line that says the same thing.
    if (liveEl) liveEl.textContent = selectionAnnouncement({ index, total: items.length, title: record.title, revealed });
  });

  // The time slider can only express years that exist in the data: clamp a state
  // that came from the defaults or from a hand-written URL before rendering it.
  function clampYearsToData() {
    const state = ctx.store.getState();
    const patch = {};
    const from = clampYear(state.from, years), to = clampYear(state.to, years);
    if (state.from !== from) patch.from = from;
    if (state.to !== to) patch.to = to;
    if (Object.keys(patch).length > 0) ctx.store.update(patch);
  }

  ctx.bus.on('records:loaded', () => {
    records = ctx.data.records;
    Object.assign(years, ctx.data.years);
    setYearBounds();
    const nextFacets = facets(records);
    buildCheckboxes(providerWrap, nextFacets.providers, 'providers');
    buildCheckboxes(typeWrap, nextFacets.types, 'types');
    collectionNames = [...nextFacets.collections.keys()].sort((a,b) => a.localeCompare(b,'en'));
    collectionOptions.clear();
    buildCollectionOptions();
    clampYearsToData();
    histogramBins = histogramBinsFor(years.min, years.max);
    buildHistogram();
    apply();
  });
  ctx.bus.on('map:moved', ({ bounds }) => {
    viewBounds = bounds;
    if (ctx.store.getState().viewport === '1') apply();
  });
  ctx.store.subscribe((next, changed) => {
    if (changed.some((key) => ['from', 'to'].includes(key)) && !syncButton.hidden) {
      syncButton.textContent = `Edition for ${next.to}`;
    }
    if (changed.some((key) => ['from', 'to', 'provider', 'type', 'collection', 'at', 'q', 'sort', 'overlay', 'otime', 'viewport'].includes(key))) apply();
    else if (changed.includes('selected')) {
      for (const item of listEl.children) {
        const button = item.querySelector('button');
        button?.setAttribute('aria-current', button?.id === `result-${ctx.store.getState().selected.replace(/[^\w-]/g, '_')}` ? 'true' : 'false');
      }
    }
  });

  /* ---------- decade histogram above the year slider ---------- */

  const histogramEl = qs('#year-histogram');
  const histogramScale = qs('#year-histogram-scale');
  const histogramHint = qs('#year-histogram-hint');
  // The hint is the drag preview while a range is being brushed.
  const HISTOGRAM_HINT = histogramHint?.textContent ?? '';

  // The chart's *structure* is fixed — one bin per decade the seed spans — so a
  // filter change or a brush never reflows it and keyboard focus stays put.
  // Only the counts, the labels and the bar heights are rewritten.
  let histogramBins = histogramBinsFor(years.min, years.max);
  const histogramButtons = () => [...(histogramEl?.querySelectorAll('button') ?? [])];

  /** The records the bars count: every active filter *except* the period itself,
   *  so the chart shows what widening the range would bring back (facet logic). */
  function histogramScope(state) {
    let scoped = filterRecords({ ...state, from: -Infinity, to: Infinity }, records);
    const point = parsePoint(state.at);
    if (point) scoped = scoped.filter((record) => coversPoint(record, point.lat, point.lon));
    if (state.viewport === '1' && viewBounds) {
      const inBounds = new Set(recordsInBounds(scoped, viewBounds).map((record) => record.id));
      scoped = scoped.filter((record) => inBounds.has(record.id));
    }
    return scoped;
  }

  /** The state range a clicked bin or a brushed span of bins stands for. */
  function selectBins(lo, hi) {
    const range = brushYears(histogramBins, lo, hi, years.min, years.max);
    if (range) ctx.store.update(range);
  }

  function buildHistogram() {
    if (!histogramEl) return;
    histogramEl.replaceChildren(
      ...histogramBins.map((bin, index) =>
        el(
          'button',
          {
            class: 'zh-histogram__bin',
            type: 'button',
            tabindex: '-1',
            'data-start': bin.start,
            'data-end': bin.end,
            'data-count': '0',
            onclick: () => {
              if (Date.now() < brushGuardUntil) return; // the click that follows a drag
              selectBins(index, index);
            },
          },
          [el('span', { class: 'zh-histogram__bar' })],
        ),
      ),
    );
    histogramScale?.replaceChildren(el('span', { text: String(years.min) }), el('span', { text: String(years.max) }));
    const first = histogramEl.querySelector('button');
    if (first) first.tabIndex = 0;
    refreshHistogramCounts(ctx.store.getState());
  }

  /** Rewrite counts, accessible names and bar heights for the current filter scope. */
  function refreshHistogramCounts(state) {
    if (!histogramEl) return;
    const buttons = histogramButtons();
    if (buttons.length === 0) return;
    const scope = histogramScope(state);
    const undated = scope.filter(record => !Number.isFinite(record.yearStart ?? record.yearEnd)).length;
    const counts = countHistogramBins(histogramBins, scope, years.min, years.max);
    const busiest = Math.max(1, ...counts.values());
    let total = 0;
    buttons.forEach((button, index) => {
      const bin = histogramBins[index];
      const count = counts.get(bin.start) ?? 0;
      total += count;
      button.dataset.count = String(count);
      const from = Math.max(years.min, bin.start);
      const to = Math.min(years.max, bin.end);
      const label = `${bin.start}–${bin.end}: ${count} ${count === 1 ? 'record' : 'records'}`;
      button.title = label;
      button.setAttribute('aria-label', `${label}. Filter to ${from}–${to}.`);
      const bar = button.firstElementChild;
      if (bar) bar.style.height = `${count === 0 ? 2 : Math.max(4, Math.round((count / busiest) * 100))}%`;
      button.classList.toggle('is-empty', count === 0);
    });
    histogramEl.setAttribute('aria-label', `Maps by publication decade. Choose a period (${total} dated records; ${undated} undated records remain browseable).`);
  }

  /** Mark the bins inside the current range and keep exactly one tabbable bin. */
  function updateHistogram(state) {
    if (!histogramEl) return;
    const buttons = histogramButtons();
    for (const button of buttons) {
      button.setAttribute('aria-current', Number(button.dataset.start) <= state.to && Number(button.dataset.end) >= state.from ? 'true' : 'false');
    }
    if (!buttons.some((button) => button.tabIndex === 0)) {
      const anchor = buttons.find((button) => Number(button.dataset.start) <= state.to && Number(button.dataset.end) >= state.to) ?? buttons[0];
      if (anchor) anchor.tabIndex = 0;
    }
  }

  /* ---------- brushing a range across the bars ---------- */

  let brush = null; // { pointerId, anchor, index, moved }
  let brushGuardUntil = 0; // swallows the click the browser fires after a drag

  function paintBrush(a, b, on) {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    histogramButtons().forEach((button, index) => button.classList.toggle('is-brushing', Boolean(on) && index >= lo && index <= hi));
  }

  function announceBrush(a, b) {
    if (!histogramHint) return;
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const range = brushYears(histogramBins, lo, hi, years.min, years.max);
    if (!range) return;
    let count = 0;
    for (let index = lo; index <= hi; index += 1) count += Number(histogramButtons()[index]?.dataset.count ?? 0);
    histogramHint.textContent = `${range.from}–${range.to} selected: ${count} ${count === 1 ? 'record' : 'records'}. Release to apply.`;
  }

  function endBrush(event, commit) {
    if (!brush || (event && event.pointerId !== brush.pointerId)) return;
    const { anchor, index, moved } = brush;
    brush = null;
    paintBrush(0, 0, false);
    if (histogramHint) histogramHint.textContent = HISTOGRAM_HINT;
    if (!commit) return;
    // A pointer gesture ends with a click whose target may be the chart itself
    // (`setPointerCapture`), the button, or the common ancestor of a drag: the
    // range is therefore committed here, and the trailing click is ignored.
    brushGuardUntil = Date.now() + 400;
    selectBins(anchor, index);
  }

  histogramEl?.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const button = event.target.closest?.('button.zh-histogram__bin');
    const index = button ? histogramButtons().indexOf(button) : -1;
    if (index < 0) return;
    brush = { pointerId: event.pointerId, anchor: index, index, moved: false };
    // Capture so a drag that leaves the chart (or the pointer's target) still ends here.
    try {
      histogramEl.setPointerCapture(event.pointerId);
    } catch {
      /* capture is a convenience, the pointerup listener still handles a tap */
    }
  });

  histogramEl?.addEventListener('pointermove', (event) => {
    if (!brush || event.pointerId !== brush.pointerId) return;
    const buttons = histogramButtons();
    const rect = histogramEl.getBoundingClientRect();
    if (!rect.width || buttons.length === 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = Math.max(0, Math.min(buttons.length - 1, Math.floor(ratio * buttons.length)));
    if (index !== brush.index) {
      brush.index = index;
      brush.moved = true;
    }
    if (!brush.moved) return;
    event.preventDefault();
    paintBrush(brush.anchor, brush.index, true);
    announceBrush(brush.anchor, brush.index);
  });

  histogramEl?.addEventListener('pointerup', (event) => endBrush(event, true));
  histogramEl?.addEventListener('pointercancel', (event) => endBrush(event, false));

  // Toolbar pattern: one tab stop, arrows move between decades, Enter/Space filters.
  histogramEl?.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...histogramEl.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (index === -1) return;
    event.preventDefault();
    const next =
      event.key === 'Home' ? 0
      : event.key === 'End' ? buttons.length - 1
      : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    for (const button of buttons) button.tabIndex = -1;
    buttons[next].tabIndex = 0;
    buttons[next].focus();
  });

  buildHistogram();

  setYearBounds();
  // main.js loads the data *before* it initialises the modules, so the
  // "records:loaded" event has already fired by now - clamp + apply explicitly.
  clampYearsToData();
  apply();

  return { apply, get filtered() { return lastFiltered; } };
}

function clampYear(value, years) {
  const number = Number(value);
  if (!Number.isFinite(number)) return years.min;
  return Math.max(years.min, Math.min(years.max, Math.round(number)));
}

/**
 * One bin per decade the publication years span (inclusive, zero-count decades
 * included so the axis never lies about a gap). Pure: the caller supplies the
 * data range, the returned bins carry no counts.
 */
export function histogramBinsFor(minYear, maxYear, binYears = 10) {
  if (!Number.isFinite(minYear) || !Number.isFinite(maxYear) || maxYear < minYear || binYears <= 0) return [];
  const bins = [];
  for (let start = Math.floor(minYear / binYears) * binYears; start <= maxYear; start += binYears) {
    bins.push({ start, end: start + binYears - 1 });
  }
  return bins;
}

/**
 * Count records into the fixed bins. A record's publication year is `yearStart`
 * with `yearEnd` as the honest fallback (`yearStart` may be null upstream); years
 * outside the data range are clamped into the end bins like the chart does.
 */
export function countHistogramBins(bins, records, minYear = -Infinity, maxYear = Infinity, binYears = 10) {
  const counts = new Map((bins ?? []).map((bin) => [bin.start, 0]));
  for (const record of records ?? []) {
    const year = Number.isFinite(record?.yearStart) ? record.yearStart : record?.yearEnd;
    if (!Number.isFinite(year)) continue;
    const start = Math.floor(Math.max(minYear, Math.min(maxYear, year)) / binYears) * binYears;
    if (counts.has(start)) counts.set(start, counts.get(start) + 1);
  }
  return counts;
}

/**
 * The year range a selection of bins stands for: the first bin's start to the
 * last bin's end, clamped to what the data offers. Order-insensitive, so a brush
 * dragged to the left gives the same range as one dragged to the right;
 * `null` when there is no bin to select.
 */
export function brushYears(bins, a, b, minYear = -Infinity, maxYear = Infinity) {
  if (!bins || bins.length === 0) return null;
  const clampIndex = (index) => Math.max(0, Math.min(bins.length - 1, Math.trunc(index)));
  const [lo, hi] = a <= b ? [clampIndex(a), clampIndex(b)] : [clampIndex(b), clampIndex(a)];
  return { from: Math.max(minYear, bins[lo].start), to: Math.min(maxYear, bins[hi].end) };
}

export { TYPE_LABELS };
