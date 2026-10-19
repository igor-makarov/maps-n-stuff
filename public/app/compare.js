/**
 * Vergleichsliste ("merken und gegenüberstellen") — owned by maps-1.
 *
 * A small, independent optional module (coordination D4): it reads the shared
 * store/bus, pins up to four records under the shareable `cmp` URL parameter and
 * lays two of them out side by side with their real IIIF/WMTS previews, titles,
 * dates, holding institutions and links back to the original records.
 *
 * Since iteration 7-16 (zurich-maps-3) the panes of records with a IIIF manifest
 * are *interactive*: the same viewer factory as the detail panel requests real
 * region cut-outs, and a toggle couples the panes through the extent each record
 * documents in the catalogue (see `viewToExtent`/`extentToView` in iiif.js) so a
 * zoom in one sheet follows in the others. Records without a manifest keep the
 * static raster tile preview.
 *
 * It never writes into another module's DOM: the panel markup lives in
 * public/index.html and the previews are built from the record itself.
 */

import { el, qs, setStatus, trapFocus, copyText } from './dom.js';
import { createViewer } from './detail.js';
import { fetchUpstreamJson } from './upstream.js';
import { describeUpstreamError, extentToView, parseManifest, viewToExtent } from './iiif.js';

const MAX_PINNED = 4;
const COMPARE_WIDTH = 1200; // IIIF Image API width for a readable comparison
const STORAGE_KEY = 'kartenzeit.cmp.v1'; // device-local “Merkliste”, never sent anywhere

/**
 * The pinned list is shareable through `?cmp=`; it is also kept in this browser
 * so a visitor finds their own list again after a reload or a later visit. Only
 * the record ids are stored, nothing else, and a failing/blocked localStorage
 * (private mode, disabled storage) simply means “no saved list”.
 */
export function readStoredIds() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id) => typeof id === 'string' && id.trim() && !id.includes(',')))]
      .map((id) => id.trim())
      .slice(0, MAX_PINNED);
  } catch {
    return [];
  }
}

export function writeStoredIds(ids) {
  try {
    if (ids.length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY);
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_PINNED)));
  } catch {
    /* storage unavailable: the URL remains the only carrier of the list */
  }
}

export function init(ctx) {
  const panel = qs('#compare-panel');
  const listNode = qs('#compare-list');
  const addButton = qs('#compare-add');
  const clearButton = qs('#compare-clear');
  const countNode = qs('#compare-count');
  const status = qs('#compare-status');
  const toolbarButton = qs('#compare-open');
  const toolbarCount = qs('#compare-open-count');
  const view = qs('#compare-view');
  const viewBody = qs('#compare-view-body');
  const viewTitle = qs('#compare-view-title');
  const scrim = qs('#scrim');
  if (!panel || !listNode || !view || !viewBody) return;

  let lastFocused = null;
  let open = false;
  let viewRecords = []; // order shown in the comparison view (clicked record first)
  /** Mounted comparison viewers: `{ index, record, viewer, stage }`. */
  let panes = [];
  /** Bumped on every rebuild/close so a slow manifest cannot mount into a stale view. */
  let viewToken = 0;
  let coupled = true;
  let lastActivePane = 0;

  const recordOf = (id) => ctx.data.recordIndex?.get(id) ?? null;
  const pinnedIds = () => {
    const raw = String(ctx.store.getState().cmp || '');
    return raw ? raw.split(',').filter(Boolean).slice(0, MAX_PINNED) : [];
  };
  const pinnedRecords = () => pinnedIds().map((id) => ({ id, record: recordOf(id) }));

  /* ------------------------------------------------------------------ panel */

  function render() {
    const entries = pinnedRecords();
    const known = entries.filter((entry) => entry.record);
    const unknown = entries.filter((entry) => !entry.record).map((entry) => entry.id);

    if (countNode) {
      countNode.textContent = entries.length > 0 ? ` (${entries.length})` : '';
    }
    const selected = ctx.store.getState().selected;
    if (addButton) {
      const isPinned = selected && pinnedIds().includes(selected);
      addButton.disabled = !selected || Boolean(isPinned) || entries.length >= MAX_PINNED;
      addButton.textContent = isPinned
        ? 'Ausgewählter Datensatz ist gemerkt'
        : entries.length >= MAX_PINNED
          ? `Maximal ${MAX_PINNED} Datensätze`
          : 'Ausgewählten Datensatz merken';
    }
    if (clearButton) clearButton.disabled = entries.length === 0;

    listNode.replaceChildren(
      ...known.map(({ id, record }) => {
        const index = known.findIndex((entry) => entry.id === id);
        return el('li', { class: 'app-compare__item' }, [
          thumb(record, 'app-compare__thumb'),
          el('div', { class: 'app-compare__meta' }, [
            el('span', { class: 'app-compare__title', text: record.title }),
            el('span', {
              class: 'zh-hint',
              text: `${yearText(record)} · ${record.institution || record.providerId}`,
            }),
            el('div', { class: 'app-compare__itemactions' }, [
              el('button', {
                class: 'zh-chip',
                type: 'button',
                disabled: known.length < 2,
                onclick: () => openCompare(index),
                text: 'Vergleichen',
              }),
              el('button', {
                class: 'zh-chip',
                type: 'button',
                onclick: () => remove(id),
                text: 'Entfernen',
              }),
            ]),
          ]),
        ]);
      }),
      ...unknown.map((id) =>
        el('li', { class: 'app-compare__item app-compare__item--unknown' }, [
          el('div', { class: 'app-compare__meta' }, [
            el('span', { class: 'app-compare__title', text: 'Unbekannter Datensatz' }),
            el('span', { class: 'zh-hint', text: `${id} – nicht im aktuellen Bestand.` }),
            el('div', { class: 'app-compare__itemactions' }, [
              el('button', { class: 'zh-chip', type: 'button', onclick: () => remove(id), text: 'Entfernen' }),
            ]),
          ]),
        ]),
      ),
    );

    if (entries.length === 0) {
      listNode.append(
        el('li', { class: 'app-compare__empty zh-hint' }, [
          'Noch nichts gemerkt: Datensatz in der Liste wählen und «Ausgewählten Datensatz merken» drücken – oder einen Vergleichslink mit ',
          el('code', { text: '?cmp=' }),
          ' öffnen.',
        ]),
      );
    }

    syncToolbar();

    if (unknown.length > 0) {
      setStatus(status, `${unknown.length} gemerkte(r) Datensatz/Datensätze ist nicht mehr im Bestand und wurde rot markiert.`, 'warn');
    }
    if (open) renderView();
  }

  function addSelected() {
    const { selected } = ctx.store.getState();
    if (!selected) {
      setStatus(status, 'Zuerst in der Trefferliste oder auf der Karte einen Datensatz auswählen.', 'warn');
      return;
    }
    const ids = pinnedIds();
    if (ids.includes(selected)) {
      setStatus(status, 'Dieser Datensatz ist bereits gemerkt.', 'info');
      return;
    }
    if (ids.length >= MAX_PINNED) {
      setStatus(status, `Mehr als ${MAX_PINNED} Datensätze passen nicht in die Vergleichsliste.`, 'warn');
      return;
    }
    const record = recordOf(selected);
    ctx.store.update({ cmp: [...ids, selected].join(',') });
    setStatus(status, `„${record?.title ?? selected}“ gemerkt (${ids.length + 1} von ${MAX_PINNED}).`, 'success');
  }

  function remove(id) {
    const ids = pinnedIds().filter((entry) => entry !== id);
    ctx.store.update({ cmp: ids.join(',') });
    setStatus(status, ids.length === 0 ? 'Vergleichsliste ist leer.' : `Datensatz entfernt – ${ids.length} gemerkt.`, 'info');
  }

  function clearAll() {
    ctx.store.update({ cmp: '' });
    setStatus(status, 'Vergleichsliste ist leer.', 'info');
  }

  /* ------------------------------------------------------------- comparison */

  function renderView() {
    const pinned = pinnedRecords().filter((entry) => entry.record).map((entry) => entry.record);
    // Keep the order the user opened, drop records that were removed meanwhile.
    const known = viewRecords.length > 0 ? viewRecords.filter((record) => pinned.includes(record)) : pinned;
    if (known.length === 0) viewRecords = [];
    if (viewTitle) {
      viewTitle.textContent = `Vergleich: ${known.map((record) => shortTitle(record)).join(' ↔ ')}`;
    }
    destroyViewers();
    viewBody.replaceChildren(
      ...(known.length >= 2 ? [couplingControls()] : []),
      ...known.map((record, index) =>
        el('figure', { class: 'app-compare__pane' }, [
          paneImage(record, index),
          el('figcaption', {}, [
            el('p', { class: 'app-compare__paneindex zh-hint', text: `Karte ${index + 1} von ${known.length}` }),
            el('h3', { class: 'zh-heading zh-heading--5', text: record.title }),
            el('p', { class: 'zh-hint', text: `${yearText(record)} · ${record.creatorText || (record.creators ?? []).join(', ') || 'Urheber unbekannt'}` }),
            el('p', { class: 'zh-hint', text: `${record.institution || record.providerId} · ${record.rights || 'Rechte nicht angegeben'}` }),
            el('p', { class: 'app-compare__readout zh-hint', 'data-compare-readout': '', text: viewerCapable(record) ? 'Ausschnitt wird geladen …' : '' }),
            viewerCapable(record)
              ? el('p', {
                  class: 'app-compare__viewhint zh-hint',
                  text: 'Echter IIIF-Ausschnitt: zoomen mit +/−, Doppelklick oder Ctrl/⌘ + Mausrad, verschieben mit den Pfeiltasten oder per Zug.',
                })
              : null,
            el('p', { class: 'app-compare__paneactions' }, [
              el('a', { class: 'zh-button zh-button--small', href: record.recordUrl, rel: 'noopener', text: 'Originaldatensatz öffnen ↗' }),
              el('button', {
                class: 'zh-button zh-button--small zh-button--ghost',
                type: 'button',
                onclick: () => {
                  ctx.store.update({ selected: record.id });
                  ctx.bus.emit('record:selected', { record, source: 'compare' });
                  setStatus(status, `„${record.title}“ ist ausgewählt.`, 'success');
                },
                text: 'Auswählen',
              }),
            ]),
          ]),
        ]),
      ),
    );
    if (known.length < 2) {
      viewBody.append(el('p', { class: 'zh-state zh-hint', text: 'Für einen Vergleich mindestens zwei Datensätze merken.' }));
    }
    // Real viewers for the panes with a manifest; they need the visible layout.
    void mountViewers(known, viewBody);
  }

  /* ------------------------------------------------------- coupled viewers */

  /** Records with a IIIF manifest get an interactive pane instead of the tile. */
  function viewerCapable(record) {
    return Boolean(record?.iiifManifest);
  }

  /** The coupling switch; only rendered for a real comparison (two or more panes). */
  function couplingControls() {
    return el('div', { class: 'app-compare__sync' }, [
      el('button', {
        class: 'zh-chip',
        type: 'button',
        id: 'compare-sync',
        'aria-pressed': 'true',
        onclick: (event) => toggleCoupling(event.currentTarget),
        text: 'Ausschnitte gekoppelt',
      }),
      el('p', { class: 'zh-hint', id: 'compare-sync-hint', role: 'status', 'aria-live': 'polite', text: '' }),
    ]);
  }

  function paneImage(record, index) {
    if (!viewerCapable(record)) return el('div', { class: 'app-compare__paneimage' }, [thumb(record, 'app-compare__image', true)]);
    return el('div', { class: 'app-compare__paneimage app-compare__paneimage--viewer' }, [
      el(
        'div',
        {
          class: 'app-viewer__stage app-viewer__stage--compare',
          'data-compare-stage': String(index),
          tabindex: '0',
          role: 'group',
          'aria-roledescription': 'Kartenausschnitt mit Zoom',
          'aria-label': `Karte ${index + 1}: ${record.title}. Zoomen mit Plus und Minus, verschieben mit den Pfeiltasten.`,
        },
        [el('span', { class: 'zh-spinner', role: 'presentation' })],
      ),
    ]);
  }

  /**
   * Mount one viewer per pane that has a manifest and load its first canvas.
   * A manifest that cannot be loaded falls back to the documented thumbnail with
   * a plain German sentence (`describeUpstreamError`) instead of an empty box.
   */
  async function mountViewers(records, container) {
    const token = ++viewToken;
    panes = [];
    updateSyncUi();
    for (const [index, record] of records.entries()) {
      const stage = container.querySelector(`[data-compare-stage="${index}"]`);
      if (!stage) continue;
      try {
        const manifest = parseManifest(await fetchUpstreamJson(record.iiifManifest));
        if (token !== viewToken || !open) return;
        const canvas = manifest.canvases[0];
        const instance = createViewer(stage, {
          record,
          loadJson: fetchUpstreamJson,
          onZoom: (text) => setReadout(stage, text),
          onError: (message) => showPaneFallback(stage, record, message),
          // A view change is the coupling trigger; the value itself is not shared
          // through the URL (the comparison view is not the detail panel).
          onViewChange: () => propagate(index),
        });
        instance.setCanvas(canvas, { label: canvas.label });
        panes.push({ index, record, viewer: instance, stage });
      } catch (err) {
        if (token !== viewToken) return;
        showPaneFallback(stage, record, describeUpstreamError(err));
      }
    }
    if (token !== viewToken) return;
    updateSyncUi();
    if (coupled && panes.length > 1) {
      // Whole sheets on both sides are already "the same place" (the documented
      // extent), so nothing has to be applied here — but the toggle must state
      // honestly whether coupling is possible at all.
      updateSyncHint();
    }
  }

  function setReadout(stage, text) {
    const readout = stage.closest('figure')?.querySelector('[data-compare-readout]');
    if (readout) readout.textContent = text;
  }

  /** Replace a failed viewer stage with the record's documented thumbnail. */
  function showPaneFallback(stage, record, message) {
    const wrap = stage.parentElement;
    if (!wrap) return;
    const pane = panes.find((entry) => entry.stage === stage);
    if (pane) pane.failed = true;
    wrap.replaceChildren(
      el('div', { class: 'app-compare__box' }, [
        el('span', { class: 'app-compare__image app-compare__placeholder', text: message }),
        thumb(record, 'app-compare__image', false),
      ]),
    );
    updateSyncUi();
  }

  function destroyViewers() {
    viewToken += 1;
    for (const pane of panes) {
      try {
        pane.viewer?.destroy();
      } catch {
        /* a broken viewer must not block closing the comparison */
      }
    }
    panes = [];
  }

  /**
   * A zoom/pan in one pane follows in every other pane that documents an extent:
   * the visible region becomes a geographic box,
   * which is mapped back onto the other sheets’ pixels. Two viewers never report
   * their own `setView` back, so this cannot loop.
   */
  function propagate(sourceIndex) {
    lastActivePane = sourceIndex;
    const source = panes.find((pane) => pane.index === sourceIndex);
    const geometry = source?.viewer.getView();
    if (!source || !geometry) return;
    const geo = viewToExtent(geometry.view, geometry.bounds, source.record.extent);
    if (!geo) return;
    if (!coupled) {
      updateSyncHint(`Ausschnitt in Karte ${sourceIndex + 1} geändert – die Kopplung ist aus.`);
      return;
    }
    let applied = 0;
    for (const pane of panes) {
      if (pane === source || pane.failed) continue;
      const target = pane.viewer.getView();
      if (!target) continue;
      const view = extentToView(geo, target.bounds, pane.record.extent);
      if (view && pane.viewer.setView(view)) applied += 1;
    }
    if (applied > 0) {
      updateSyncHint(`Ausschnitt von Karte ${sourceIndex + 1} auf ${applied} weitere Karte${applied === 1 ? '' : 'n'} übertragen.`);
    } else if (panes.length > 1) {
      updateSyncHint(`Karte ${sourceIndex + 1} hat keine belegte Ausdehnung – die übrigen Karten bleiben stehen.`);
    }
  }

  function updateSyncUi() {
    const button = qs('#compare-sync');
    if (button) {
      const possible = panes.filter((pane) => !pane.failed && pane.record.extent).length >= 2;
      button.hidden = !possible;
      button.setAttribute('aria-pressed', coupled ? 'true' : 'false');
      button.textContent = coupled ? 'Ausschnitte gekoppelt' : 'Ausschnitte koppeln';
      button.setAttribute('aria-label', coupled ? 'Kartenausschnitte entkoppeln' : 'Kartenausschnitte anhand der belegten Ausdehnung koppeln');
    }
    updateSyncHint();
  }

  function updateSyncHint(text) {
    const hint = qs('#compare-sync-hint');
    if (!hint) return;
    if (text) {
      hint.textContent = text;
      return;
    }
    const linked = panes.filter((pane) => !pane.failed && pane.record.extent).length;
    if (panes.length > 1 && linked >= 2) {
      hint.textContent = coupled
        ? 'Zoomen und verschieben in einer Karte folgt in der anderen – gekoppelt über die im Katalog belegte Ausdehnung der Blätter, nicht über eine Georeferenzierung.'
        : 'Die Kopplung ist aus: jede Karte wird für sich bewegt.';
    } else if (panes.length > 1) {
      hint.textContent = 'Für die Kopplung fehlt mindestens einer Karte die belegte Ausdehnung – die Ausschnitte bleiben unabhängig.';
    } else {
      hint.textContent = 'Datensätze öffnen einen echten IIIF-Ausschnitt; mit «Ausschnitte koppeln» folgen sich zwei Karten am selben Ort.';
    }
  }

  function toggleCoupling(button) {
    coupled = !coupled;
    button.setAttribute('aria-pressed', coupled ? 'true' : 'false');
    updateSyncUi();
    if (coupled) propagate(lastActivePane);
    setStatus(status, coupled ? 'Kartenausschnitte sind gekoppelt.' : 'Kartenausschnitte sind entkoppelt.', 'info');
  }

  /** Toolbar entry point: only useful (and only shown) with two plus records. */
  function syncToolbar() {
    if (!toolbarButton) return;
    const known = pinnedRecords().filter((entry) => entry.record).length;
    toolbarButton.hidden = known < 2;
    if (toolbarCount) toolbarCount.textContent = known >= 2 ? ` (${known})` : '';
    toolbarButton.setAttribute('aria-label', known >= 2 ? `Vergleich von ${known} Datensätzen öffnen` : 'Vergleich öffnen');
  }

  function openCompare(index = 0) {
    const known = pinnedRecords().filter((entry) => entry.record);
    if (known.length < 2) {
      setStatus(status, 'Für den Vergleich mindestens zwei Datensätze merken.', 'warn');
      return;
    }
    // Show the clicked record first; the pinned list itself keeps its order.
    const lead = Math.min(Math.max(index, 0), known.length - 1);
    viewRecords = [known[lead].record, ...known.filter((_, i) => i !== lead).map((entry) => entry.record)];
    lastFocused = document.activeElement;
    open = true;
    view.hidden = false;
    if (scrim) scrim.hidden = false;
    document.body.classList.add('app-compare--open');
    // Only now has the comparison a real layout: the viewer stages measure their
    // size when the manifest arrives, so they must not be mounted while hidden.
    renderView();
    qs('#compare-view-close', view)?.focus();
  }

  function closeCompare() {
    if (!open) return;
    open = false;
    destroyViewers();
    view.hidden = true;
    const detailOpen = qs('#detail')?.hidden === false;
    if (scrim && !detailOpen) scrim.hidden = true;
    document.body.classList.remove('app-compare--open');
    if (lastFocused?.isConnected) lastFocused.focus();
    setStatus(status, 'Vergleich geschlossen.', 'info');
  }

  /* ---------------------------------------------------------------- helpers */

  function yearText(record) {
    const start = record.yearStart;
    const end = record.yearEnd;
    if (start && end && start !== end) return `${start}–${end}`;
    return start ? String(start) : 'ohne Jahr';
  }

  function shortTitle(record) {
    return record.title.length > 48 ? `${record.title.slice(0, 45)}…` : record.title;
  }

  /**
   * Preview image: e-rara IIIF thumbnails are widened through the Image API,
   * swisstopo records carry a raster tile, everything else keeps its thumbnail.
   * While the (large) image loads a hint is shown; a failed image becomes a
   * labelled placeholder instead of a broken icon.
   */
  function thumb(record, className, large = false) {
    const box = el('div', { class: 'app-compare__box' });
    const src = previewUrl(record, large);
    if (!src) {
      box.append(el('span', { class: `${className} app-compare__placeholder`, text: 'keine Vorschau' }));
      return box;
    }
    // The large comparison panes can take a few seconds (real IIIF scans), so
    // they get a visible loading hint; the small list thumbs do not.
    const hint = large ? el('span', { class: 'app-compare__loading zh-hint', text: 'Vorschau wird geladen …' }) : null;
    const img = el('img', {
      class: className,
      src,
      alt: `Kartenvorschau: ${record.title}`,
      loading: 'lazy',
      decoding: 'async',
    });
    img.addEventListener('load', () => hint?.remove());
    img.addEventListener('error', () => {
      img.remove();
      const message = el('span', { class: `${className} app-compare__placeholder`, text: `Vorschau nicht verfügbar (${record.providerId})` });
      if (hint?.isConnected) hint.replaceWith(message);
      else box.append(message);
    });
    box.append(...[hint, img].filter(Boolean));
    return box;
  }

  function previewUrl(record, large) {
    const url = record.thumbnail;
    if (!url) return null;
    if (large && /\/i3f\/v2\d\/\d+\/full\/\d+/.test(url)) {
      return url.replace(/\/full\/\d+/, `/full/${COMPARE_WIDTH},`);
    }
    return url;
  }

  /* ----------------------------------------------------------------- wiring */

  addButton?.addEventListener('click', addSelected);
  toolbarButton?.addEventListener('click', () => openCompare(0));
  clearButton?.addEventListener('click', clearAll);
  qs('#compare-view-close', view)?.addEventListener('click', closeCompare);
  qs('#compare-view-copy', view)?.addEventListener('click', async () => {
    const ok = await copyText(window.location.href);
    setStatus(status, ok ? 'Permalink der Vergleichsliste kopiert.' : 'Kopieren nicht möglich – Adresse bitte aus der Adresszeile übernehmen.', ok ? 'success' : 'warn');
  });
  qs('#compare-view-list', view)?.addEventListener('click', () => {
    closeCompare();
    panel.open = true;
    panel.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });

  document.addEventListener('keydown', (event) => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      closeCompare();
      return;
    }
    if (open && event.key === 'Tab') trapFocus(view, event);
  });

  ctx.store.subscribe((state, changed) => {
    if (changed.includes('cmp')) {
      writeStoredIds(pinnedIds());
      render();
    } else if (changed.includes('selected')) updateAddButton();
  });

  ctx.bus.on('records:loaded', () => render());
  ctx.bus.on('record:selected', () => updateAddButton());

  function updateAddButton() {
    const { selected } = ctx.store.getState();
    if (!addButton) return;
    const entries = pinnedIds();
    const isPinned = selected && entries.includes(selected);
    addButton.disabled = !selected || Boolean(isPinned) || entries.length >= MAX_PINNED;
    addButton.textContent = !selected
      ? 'Zuerst einen Datensatz auswählen'
      : isPinned
        ? 'Ausgewählter Datensatz ist gemerkt'
        : entries.length >= MAX_PINNED
          ? `Maximal ${MAX_PINNED} Datensätze`
          : 'Ausgewählten Datensatz merken';
  }

  render();
  updateAddButton();
  syncToolbar();
  if (pinnedIds().length >= 2) {
    // A shared comparison link should show the list it carries instead of
    // hiding it behind a closed panel.
    panel.open = true;
    setStatus(status, `${pinnedIds().length} gemerkte Datensätze aus dem Link geladen – «Vergleichen» öffnet die Gegenüberstellung.`, 'info');
  } else if (pinnedIds().length === 0) {
    // No list in the link: fall back to the list saved in this browser.
    const saved = readStoredIds();
    if (saved.length > 0) {
      ctx.store.update({ cmp: saved.join(',') });
      if (saved.length >= 2) panel.open = true;
      setStatus(
        status,
        `${saved.length} gemerkte${saved.length === 1 ? 'r Datensatz' : ' Datensätze'} aus diesem Browser wiederhergestellt – die Liste liegt nur lokal und steht zusätzlich im Link (?cmp=).`,
        'info',
      );
    }
  }

  return { open: openCompare, close: closeCompare, add: addSelected, clear: clearAll };
}
