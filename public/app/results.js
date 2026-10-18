/**
 * Filters (time, collection, type, keyword), the comparison-layer picker and
 * the result list. Emits `records:filtered` so the map stays in sync.
 */

import { debounce, el, formatYearRange, qs, setStatus } from './dom.js';
import { facets, filterRecords, recordsInBounds, sortRecords } from './records.js';
import { STATE_DEFAULTS } from './store.js';

const TYPE_LABELS = {
  map: 'Einzelkarte',
  atlas: 'Atlas / Kartenwerk',
  sheet: 'Kartenblatt',
  overlay: 'Georeferenzierte Ebene',
};

const SCALE_MAX = 1000; // slider resolution for the year range

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
  const overlayNote = qs('#overlay-note');
  const resetEl = qs('#reset-filters');

  if (!listEl || !countEl) return;

  const records = ctx.data.records;
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
    for (const chip of document.querySelectorAll('[data-range]')) {
      chip.addEventListener('click', () => {
        const value = chip.dataset.range;
        if (value === 'all') ctx.store.update({ from: years.min, to: years.max });
        else {
          const [from, to] = value.split('-').map(Number);
          ctx.store.update({ from, to });
        }
      });
    }
  };

  const buildCheckboxes = (wrap, entries, key) => {
    if (!wrap) return;
    wrap.replaceChildren(
      ...[...entries.entries()].map(([value, count]) => {
        const id = `${key}-${value}`;
        const input = el('input', {
          type: 'checkbox',
          id,
          value,
          onchange: () => ctx.store.update({ [key === 'providers' ? 'provider' : 'type']: input.checked ? value : '' }),
        });
        input.checked = (key === 'providers' ? ctx.store.getState().provider : ctx.store.getState().type) === value;
        return el('label', { class: 'zh-check', for: id }, [input, el('span', { text: `${value} (${count})` })]);
      }),
    );
  };

  buildCheckboxes(providerWrap, providers, 'providers');
  buildCheckboxes(typeWrap, types, 'types');

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

  /** One definition for the filter reset: toolbar button and empty state.
   *  Restores the documented initial view, clamped to what the data offers:
   *  resetting to years.min–years.max silently revealed the 2021 overlay records. */
  function resetFilters() {
    ctx.store.update({
      from: Math.max(years.min, STATE_DEFAULTS.from),
      to: Math.min(years.max, STATE_DEFAULTS.to),
      provider: STATE_DEFAULTS.provider,
      type: STATE_DEFAULTS.type,
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
  const isHistorical = (layer) => /zeitreihen|hiks|swissimage/.test(layer.id);

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
    const historical = layers.filter(isHistorical).sort((a, b) => a.title.localeCompare(b.title, 'de'));
    const modern = layers.filter((l) => !isHistorical(l)).sort((a, b) => a.title.localeCompare(b.title, 'de'));
    overlayEl.replaceChildren(
      el('option', { value: '', text: 'keine Ebene' }),
      el('optgroup', { label: 'Historische Kartenwerke und Luftbilder (Zeitreise, Siegfried, Dufour, SWISSIMAGE)' }, historical.map((l) => el('option', { value: l.id, text: l.title }))),
      el('optgroup', { label: 'Moderne Landeskarten' }, modern.map((l) => el('option', { value: l.id, text: l.title }))),
    );
    overlayEl.addEventListener('change', () => {
      const layer = layers.find((l) => l.id === overlayEl.value) ?? null;
      const edition = editionForYear(layer, ctx.store.getState().to);
      ctx.store.update({ overlay: layer?.id ?? '', otime: edition });
      applyOverlay(layer, edition);
    });
  }

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
        setStatus(overlayNote, `Ausgabe ${formatTime(ctx.store.getState().otime)} zum Zeitraum bis ${state.to} gewählt.`);
      }
    },
  }, ['Ausgabe passend zum Zeitraum']);
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
      if (overlayNote) overlayNote.textContent = 'Georeferenzierte Kartenwerke von swisstopo, direkt als Kachelebene über die moderne Grundkarte gelegt.';
      return;
    }
    if (overlayOpacityField) overlayOpacityField.hidden = false;
    overlayOpacity?.dispatchEvent(new Event('input'));
    const values = editionsOf(layer);
    syncButton.hidden = values.length <= 1;
    syncButton.textContent = `Ausgabe für ${ctx.store.getState().to}`;
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
      overlayNote.textContent = `${layer.title} – ${values.length > 1 ? `${values.length} Ausgaben` : 'eine Ausgabe'}; ${
        layer.license ?? 'swisstopo geoservices'
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
    if (/^\d{8}$/.test(text)) return `${text.slice(6, 8)}.${text.slice(4, 6)}.${text.slice(0, 4)}`;
    return text === 'current' ? 'aktuell' : text;
  }

  /* ---------- result list ---------- */

  function thumb(record) {
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
      img.alt = 'Keine Vorschau verfügbar';
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
            el('span', { text: `Nr. ${index + 1}` }),
            record.type ? el('span', { class: 'zh-tag', text: TYPE_LABELS[record.type] ?? record.type }) : null,
          ]),
          el('span', { class: 'zh-result__title', text: record.title }),
          el('span', { class: 'zh-result__meta' }, [
            el('span', { text: record.creators?.length ? record.creators.join(', ') : 'Urheber nicht angegeben' }),
          ]),
          el('span', { class: 'zh-result__meta' }, [
            el('span', { text: record.institution }),
            record.extent ? el('span', { class: 'zh-tag zh-tag--green', text: 'Kartenausschnitt bekannt' }) : el('span', { class: 'zh-tag', text: 'Ausschnitt nicht angegeben' }),
            record.iiifManifest ? el('span', { class: 'zh-tag zh-tag--turquoise', text: 'IIIF' }) : null,
          ]),
        ]),
      ],
    );
    return el('li', {}, [button]);
  }

  const showIndex = (index) => `Nr. ${index + 1}`;

  function select(record) {
    ctx.store.update({ selected: record.id });
    ctx.bus.emit('record:selected', { record, source: 'list' });
  }

  let items = [];
  const render = debounce((filtered) => {
    lastFiltered = filtered;
    items = filtered;
    if (filtered.length === 0) {
      listEl.replaceChildren();
      if (stateEl) {
        stateEl.hidden = false;
        stateEl.className = 'zh-state zh-state--empty';
        stateEl.replaceChildren(
          el('span', { class: 'zh-state__title', text: 'Keine Treffer für diese Filter' }),
          el('span', { text: 'Zeitraum erweitern, Sammlung abwählen oder das Stichwort löschen – oder alles auf einmal zurücksetzen:' }),
          el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', onclick: resetFilters }, ['Alle Filter zurücksetzen']),
        );
      }
    } else {
      if (stateEl) stateEl.hidden = true;
      listEl.replaceChildren(...filtered.map((record, index) => renderItem(record, index)));
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
    const parts = [`${filtered.length} von ${records.length} Datensätzen`, `${state.from}–${state.to}`];
    if (state.provider) parts.push(state.provider);
    if (state.type) parts.push(TYPE_LABELS[state.type] ?? state.type);
    if (state.q) parts.push(`„${state.q}“`);
    if (state.viewport === '1') parts.push('im Kartenausschnitt');
    countEl.textContent = parts.join(' · ');
    if (liveEl) liveEl.textContent = `${filtered.length} Treffer. ${filtered[0] ? `Erster Treffer: ${filtered[0].title}.` : ''}`;
  }

  function apply() {
    const state = ctx.store.getState();
    let filtered = sortRecords(filterRecords(state, records), state.sort);
    let outsideCount = 0;
    if (state.viewport === '1') {
      const allInBounds = new Set(recordsInBounds(filtered, viewBounds).map((r) => r.id));
      outsideCount = filtered.length - allInBounds.size;
      filtered = filtered.filter((record) => allInBounds.has(record.id));
    }
    if (viewportEl && viewportEl.checked !== (state.viewport === '1')) viewportEl.checked = state.viewport === '1';
    if (viewportCount) {
      viewportCount.textContent =
        state.viewport === '1'                 ? outsideCount > 0
            ? `${outsideCount} weitere Treffer liegen ausserhalb des Ausschnitts.`
            : 'Alle Treffer liegen im Ausschnitt.'
          : '';
    }
    if (textEl && textEl.value !== state.q) textEl.value = state.q;
    if (sortEl && sortEl.value !== state.sort) sortEl.value = state.sort;
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

  // The time slider can only express years that exist in the data: clamp a state
  // that came from the defaults or from a hand-written URL before rendering it.
  function clampYearsToData() {
    const state = ctx.store.getState();
    const patch = {};
    if (state.from < years.min) patch.from = years.min;
    if (state.to > years.max) patch.to = years.max;
    if (Object.keys(patch).length > 0) ctx.store.update(patch);
  }

  ctx.bus.on('records:loaded', () => {
    clampYearsToData();
    apply();
  });
  ctx.bus.on('map:moved', ({ bounds }) => {
    viewBounds = bounds;
    if (ctx.store.getState().viewport === '1') apply();
  });
  ctx.store.subscribe((next, changed) => {
    if (changed.some((key) => ['from', 'to'].includes(key)) && !syncButton.hidden) {
      syncButton.textContent = `Ausgabe für ${next.to}`;
    }
    if (changed.some((key) => ['from', 'to', 'provider', 'type', 'q', 'sort', 'overlay', 'otime', 'viewport'].includes(key))) apply();
    else if (changed.includes('selected')) {
      for (const item of listEl.children) {
        const button = item.querySelector('button');
        button?.setAttribute('aria-current', button?.id === `result-${ctx.store.getState().selected.replace(/[^\w-]/g, '_')}` ? 'true' : 'false');
      }
    }
  });

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

export { TYPE_LABELS };
