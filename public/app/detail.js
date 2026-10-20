/**
 * Detail panel: metadata, honest date statements, an interactive IIIF viewer
 * (region requests = real deep zoom), rights/credit and prominent links to the
 * holding institution.
 *
 * The viewer only uses documented IIIF Image API parameters (`regionByPx`,
 * `sizeByW`); every request URL is built by `iiif.js` and unit-tested there. When
 * a service refuses a region request the viewer falls back to the full-sheet
 * derivative and finally to the record thumbnail, always saying which state it is
 * in instead of showing an empty box.
 */

import { copyText, el, formatLanguage, formatYearRange, qs, setStatus, trapFocus } from './dom.js';
import { recordCenter } from './records.js';
import { fetchUpstreamJson } from './upstream.js';
import {
  boundsForCanvas,
  clampView,
  describeUpstreamError,
  eRaraViewerUrl,
  formatViewParam,
  fullImageUrl,
  imageRequestUrl,
  panView,
  parseManifest,
  parseViewParam,
  sheetOptionLabel,
  sheetThumbUrl,
  viewForCanvas,
  zoomPercent,
  zoomView,
} from './iiif.js';

const FULL_PREVIEW_WIDTH = 1000;
/** A work with more sheets than this gets the direct “jump to sheet” control. */
const JUMP_MIN_SHEETS = 12;

export function init(ctx) {
  const panel = qs('#detail');
  const body = qs('#detail-body');
  const scrim = qs('#scrim');
  if (!panel || !body) return;

  let opener = null;
  let current = null;
  let manifest = null;
  let page = 0;
  /** @type {ReturnType<typeof createViewer>|null} */
  let viewer = null;
  /** @type {IntersectionObserver|null} Loads sheet thumbnails that come into view. */
  let stripObserver = null;

  /** `source` records where the selection came from; the viewer behaves the same. */
  function open(record, { keepSheet = false } = {}) {
    if (!record) return;
    const changedWork = current?.id !== record.id;
    current = record;
    manifest = null;
    // A newly chosen work starts on its first sheet and on the whole sheet; an
    // explicitly shared `sh`/`vv` value (deep link or reload) is kept — `sh` is
    // clamped to the real canvas count once the manifest is parsed, `vv` to the
    // real sheet size once the image service states it.
    if (changedWork && !keepSheet) ctx.store.update({ sheet: 1, vv: '' });
    const wasOpen = !panel.hidden;
    if (!wasOpen) opener = document.activeElement;
    render(record);
    panel.hidden = false;
    if (scrim) scrim.hidden = false;
    panel.setAttribute('aria-modal', 'true');
    document.body.classList.add('has-detail');
    // Focus the heading only when the panel opens (not when its content is swapped).
    if (!wasOpen) body.querySelector('[data-detail-heading]')?.focus();
    // The viewer loads its manifest for every entry point, including `?sel=` links.
    loadManifest(record);
  }

  function close() {
    if (panel.hidden) return;
    viewer?.destroy();
    viewer = null;
    stripObserver?.disconnect();
    stripObserver = null;
    page = 0;
    // A closed panel must not leave a sheet number or a viewer region behind in
    // the shared URL.
    if (ctx.store.getState().sheet !== 1 || ctx.store.getState().vv) ctx.store.update({ sheet: 1, vv: '' });
    panel.hidden = true;
    if (scrim) scrim.hidden = true;
    panel.setAttribute('aria-modal', 'false');
    document.body.classList.remove('has-detail');
    current = null;
    body.replaceChildren();
    opener?.focus?.();
    opener = null;
    ctx.bus.emit('record:deselected', {});
  }

  const statusNode = () => qs('#detail-status');

  /* ------------------------------------------------------------ rendering */

  function render(record) {
    const center = recordCenter(record);
    // A previous viewer (the panel can switch records without closing) keeps a
    // window-resize and a fullscreen listener; drop it before the DOM is replaced.
    viewer?.destroy();
    viewer = null;
    const viewer_ = previewSection(record);
    body.replaceChildren(
      el('div', { class: 'app-detail__bar' }, [
        el('span', { class: 'zh-tag zh-tag--blue', text: 'Map details' }),
        el('button', {
          class: 'zh-button zh-button--small',
          type: 'button',
          text: 'Close (Esc)',
          onclick: close,
        }),
      ]),
      el('h2', { class: 'app-detail__title', id: 'detail-title', 'data-detail-heading': '', tabindex: '-1', text: record.title }),
      el('div', { class: 'app-detail__actions app-detail__actions--primary' }, [
        el('a', {
          class: 'zh-button',
          href: record.recordUrl,
          target: '_blank',
          rel: 'noopener',
          text: 'Open original record ↗',
        }),
        eRaraViewerUrl(record)
          ? el('a', {
              class: 'zh-button zh-button--ghost zh-button--small',
              href: eRaraViewerUrl(record),
              target: '_blank',
              rel: 'noopener',
              text: 'Open collection viewer ↗',
            })
          : null,
        el('button', {
          class: 'zh-button zh-button--ghost zh-button--small',
          type: 'button',
          text: 'Show on map',
          onclick: () => {
            const bounds = record.extent ?? (center ? { west: center.lon - 0.05, east: center.lon + 0.05, south: center.lat - 0.03, north: center.lat + 0.03 } : null);
            if (bounds) ctx.bus.emit('view:fit', { bounds });
            else setStatus(statusNode(), 'This record has no documented map extent.', 'info');
          },
        }),
      ]),
      viewer_,
      // Workflow actions sit under the preview (not above it): on a phone the
      // viewer used to start ~800 px down behind five stacked buttons.
      el('div', { class: 'app-detail__actions app-detail__actions--secondary' }, [
        pinButton(record),
        el('button', {
          class: 'zh-button zh-button--ghost zh-button--small',
          type: 'button',
          text: 'Filter to this map’s year',
          onclick: (event) => applyPeriod(record, event.currentTarget),
        }),
        el('button', {
          class: 'zh-button zh-button--ghost zh-button--small',
          type: 'button',
          text: 'Copy link',
          onclick: async (event) => {
            // The region reaches the URL debounced; flush it first so the copied
            // link is the view on screen even if the user clicks immediately.
            const region = viewer?.getViewParam?.();
            if (region !== undefined && region !== null) ctx.store.update({ vv: region });
            const ok = await copyText(window.location.href);
            event.currentTarget.textContent = ok ? 'Link copied ✓' : 'Could not copy';
            setTimeout(() => (event.currentTarget.textContent = 'Copy link'), 2500);
          },
        }),
        record.overlay
          ? overlayButton(record)
          : null,
      ]),
      reuseSection(record),
      factsSection(record),
      relatedSection(record),
      el('p', { class: 'visuallyhidden', role: 'status', 'aria-live': 'polite', id: 'detail-status' }),
      el('p', { class: 'zh-hint' }, [
        el('span', { text: 'Metadata is supplied by the holding collection. ' }),
        record.iiifManifest
          ? el('a', { href: record.iiifManifest, target: '_blank', rel: 'noopener', text: 'Open IIIF manifest (JSON) ↗' })
          : el('span', { text: 'No IIIF manifest available.' }),
      ]),
    );
    viewer = viewer_?.__viewer ?? null;
  }

  /* ------------------------------------------------- comparison pinning */

  const pinnedIds = () => String(ctx.store.getState().cmp || '').split(',').map((id) => id.trim()).filter(Boolean);

  function updatePinButton(button, record) {
    if (!button || !record) return;
    const pinned = pinnedIds().includes(record.id);
    button.textContent = pinned ? 'Saved ✓ (comparison)' : 'Save for comparison';
    button.setAttribute('aria-pressed', pinned ? 'true' : 'false');
  }

  /** Pin/unpin the open record; the comparison list itself stays in compare.js. */
  function pinButton(record) {
    const button = el('button', {
      class: 'zh-button zh-button--ghost zh-button--small',
      type: 'button',
      id: 'detail-pin',
      'aria-pressed': 'false',
      onclick: () => {
        const ids = pinnedIds();
        if (ids.includes(record.id)) ctx.store.update({ cmp: ids.filter((id) => id !== record.id).join(',') });
        else if (ids.length >= 4) {
          setStatus(statusNode(), 'You can save up to four maps for comparison.', 'warn');
          return;
        } else ctx.store.update({ cmp: [...ids, record.id].join(',') });
        updatePinButton(button, record);
      },
    });
    updatePinButton(button, record);
    return button;
  }

  /** Hand a georeferenced record to the map as the comparison layer. */
  function showAsOverlay(record) {
    const overlay = record.overlay;
    if (!overlay?.urlTemplate) return;
    const layer = {
      id: overlay.layerId,
      title: record.collection || record.title,
      urlTemplate: overlay.urlTemplate,
      timeValues: overlay.timeValue ? [overlay.timeValue] : [],
      maxZoom: overlay.maxZoom ?? 18,
      attribution: overlay.attribution ?? record.institution,
    };
    ctx.store.update({ overlay: layer.id, otime: overlay.timeValue ?? '' });
    ctx.bus.emit('overlay:changed', { layer, time: overlay.timeValue ?? 'current' });
    ctx.bus.emit('overlay:time', { time: overlay.timeValue ?? 'current', layer });
    setStatus(statusNode(), `${layer.title} is shown as an overlay. Adjust its opacity in Filters.`, 'info');
  }

  /** Take this record's layer off the map again (the sidebar select stays in charge). */
  function hideAsOverlay(record) {
    // Same shape the sidebar's “No overlay” option uses, so the map, the select
    // and the shared URL cannot drift apart.
    ctx.store.update({ overlay: '', otime: '' });
    ctx.bus.emit('overlay:changed', { layer: null, time: null });
    setStatus(statusNode(), `${record?.collection || record?.title || 'The map layer'} is hidden.`, 'info');
  }

  /** Is this record's documented layer the one currently shown on the map? */
  function overlayIsShown(record) {
    const overlay = record?.overlay;
    if (!overlay?.layerId) return false;
    const state = ctx.store.getState();
    return state.overlay === overlay.layerId && (state.otime ?? '') === (overlay.timeValue ?? '');
  }

  /** Keep the panel's layer button in step with the shared `ov`/`ot` state. */
  function updateOverlayButton(button, record) {
    if (!button || !record?.overlay) return;
    const shown = overlayIsShown(record);
    button.textContent = shown ? 'Hide overlay' : 'Show as overlay';
    button.setAttribute('aria-pressed', shown ? 'true' : 'false');
  }

  /**
   * The panel's own way to put a georeferenced record on the map. It is a real
   * toggle: a second press removes the layer, and the sidebar's select (or a
   * shared link) keeps the label in sync through the store subscription.
   */
  function overlayButton(record) {
    const button = el('button', {
      class: 'zh-button zh-button--small',
      type: 'button',
      id: 'detail-overlay',
      'aria-pressed': 'false',
      onclick: () => {
        if (overlayIsShown(record)) hideAsOverlay(record);
        else showAsOverlay(record);
        updateOverlayButton(button, record);
      },
    });
    updateOverlayButton(button, record);
    return button;
  }

  /** Use this sheet's publication period as the time filter, then get out of the way. */
  function applyPeriod(record, button) {
    // The slider is documented as “Zeitraum (Publication year)” (#year-from/#year-to,
    // index.html) and the intro states that the depicted date can differ, so this
    // button must feed the same publication range. Using the depicted period here
    // would hide the very sheet it came from as soon as a source states a survey
    // period (e.g. the Zürich Wildkarte sheets: published 1853, surveyed 1843–1851).
    const from = record.yearStart;
    const to = record.yearEnd ?? record.yearStart;
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      setStatus(statusNode(), 'This record has no documented year.', 'info');
      return;
    }
    ctx.store.update({ from: Math.min(from, to), to: Math.max(from, to), selected: record.id });
    close();
    const live = qs('#results-live');
    const message = `Period set to ${Math.min(from, to)}–${Math.max(from, to)} (${record.title}).`;
    if (live) live.textContent = message;
    if (button) button.textContent = 'Year filter applied ✓';
  }

  /* --------------------------------------------------------- preview/viewer */

  function previewSection(record) {
    // Records without a IIIF image service (swisstopo tile layers) keep the
    // documented single-tile probe instead of a fake viewer.
    if (!record.iiifManifest) return staticPreview(record);

    const stage = el('div', {
      class: 'app-viewer__stage',
      id: 'viewer-stage',
      tabindex: '0',
      role: 'group',
      'aria-roledescription': 'Zoomable map preview',
      'aria-label': `Map preview: ${record.title}. Plus and minus zoom; arrow keys pan.`,
    }, [el('span', { class: 'zh-spinner', role: 'presentation' })]);
    const live = el('span', { class: 'visuallyhidden', role: 'status', 'aria-live': 'polite', id: 'viewer-status' });

    const controls = el('div', { class: 'app-viewer__controls' }, [
      el('button', { class: 'zh-button zh-button--small', type: 'button', id: 'viewer-zoom-out', 'aria-label': 'Zoom out', text: '−' }),
      el('button', { class: 'zh-button zh-button--small', type: 'button', id: 'viewer-zoom-in', 'aria-label': 'Zoom in', text: '+' }),
      el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', id: 'viewer-reset', text: 'Whole sheet' }),
      // Real fullscreen for the sheet (the Fullscreen API, not a simulated
      // overlay): the largest possible view of a map without leaving the page.
      // Only offered when the browser supports it – no inert control.
      document.fullscreenEnabled
        ? el('button', {
            class: 'zh-button zh-button--ghost zh-button--small',
            type: 'button',
            id: 'viewer-fullscreen',
            'aria-pressed': 'false',
            text: 'Fullscreen',
          })
        : null,
      el('span', { class: 'app-viewer__readout', id: 'viewer-resolution', text: 'Resolution –' }),
      // Sheet navigation appears once we know the record has more than one sheet.
      el('span', { class: 'app-viewer__nav', id: 'page-nav', hidden: true }, [
        el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', id: 'page-prev', text: '‹ Sheet' }),
        el('span', { class: 'zh-hint', id: 'page-label', text: 'Sheet 1' }),
        el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', id: 'page-next', text: 'Sheet ›' }),
        // Direct jump for works whose strip no longer fits on one row (the
        // 33-sheet canton map): a native select stays keyboard-operable without
        // turning every sheet into a tab stop of its own.
        el('span', { class: 'app-viewer__jump', id: 'page-jump-wrap', hidden: true }, [
          el('label', { class: 'visuallyhidden', for: 'page-jump', text: 'Go to sheet' }),
          el('select', {
            class: 'zh-select',
            id: 'page-jump',
            onchange: (event) => gotoPage(Number(event.currentTarget.value) - 1),
          }),
        ]),
      ]),
    ]);

    const viewerEl = el('div', { class: 'app-viewer', id: 'detail-preview' }, [
      stage,
      // One button per sheet of a multi-sheet work; filled once the manifest is
      // parsed, hidden for the (common) single-sheet case. Roving tabindex: the
      // strip is one tab stop, ←/→/Home/End walk the sheets (26 keys stops for a
      // 26-sheet work would be a keyboard trap of its own).
      el(
        'div',
        {
          class: 'app-viewer__sheets',
          id: 'page-strip',
          role: 'group',
          'aria-label': 'Sheets in this work',
          hidden: true,
          onkeydown: onStripKeyDown,
        },
      ),
      controls,
      el('p', { class: 'app-viewer__caption' }, [
        el('span', { id: 'preview-meta', text: 'Loading map preview …' }),
      ]),
      el('p', {
        class: 'app-viewer__hint',
        // Multi-sheet works name the keyboard route explicitly (and the strip).
        text: `Zoom: + / −, double-click or Ctrl/⌘ + scroll. Pan: drag or arrow keys (Shift for larger steps). Home shows the whole sheet.${(record.canvasCount ?? 0) > 1 ? ' Change sheet: Alt + ←/→ or use the sheet strip below the image.' : ''}`,
      }),
      live,
    ]);
    viewerEl.__viewer = createViewer(stage, {
      record,
      live,
      loadJson: fetchJson,
      meta: () => viewerEl.querySelector('#preview-meta'),
      onZoom: (text) => {
        const readout = viewerEl.querySelector('#viewer-resolution');
        if (readout) readout.textContent = text;
      },
      // The visible region is shareable state: the viewer reports it (debounced)
      // and detail.js keeps `vv` in the URL, so a permalink reproduces the exact
      // cut-out. An unusable shared value is cleared instead of kept.
      onViewChange: (param) => ctx.store.update({ vv: param }),
      onError: (message) => setStatus(statusNode(), message, 'error'),
    });
    const instance = viewerEl.__viewer;
    viewerEl.querySelector('#viewer-zoom-in')?.addEventListener('click', () => instance.zoomIn());
    viewerEl.querySelector('#viewer-zoom-out')?.addEventListener('click', () => instance.zoomOut());
    viewerEl.querySelector('#viewer-reset')?.addEventListener('click', () => instance.reset());
    viewerEl.querySelector('#page-prev')?.addEventListener('click', () => gotoPage(page - 1));
    viewerEl.querySelector('#page-next')?.addEventListener('click', () => gotoPage(page + 1));
    wireFullscreen(viewerEl, stage, instance);
    return viewerEl;
  }

  /* ------------------------------------------------------------- fullscreen */

  /**
   * Fullscreen for the viewer stage. The button is only rendered when the
   * browser advertises `document.fullscreenEnabled`, so the control is never
   * inert; leaving fullscreen (button or Esc) restores the previous layout, and
   * the visible IIIF region is re-requested for the new stage size.
   */
  function wireFullscreen(viewerEl, stage, instance) {
    const button = viewerEl.querySelector('#viewer-fullscreen');
    if (!button) return;
    const sync = () => {
      const active = document.fullscreenElement === stage;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
      button.textContent = active ? 'Exit fullscreen' : 'Fullscreen';
      stage.classList.toggle('is-fullscreen', active);
      instance?.refresh?.();
    };
    button.addEventListener('click', () => {
      if (document.fullscreenElement === stage) document.exitFullscreen?.().catch(() => {});
      else stage.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => setStatus(statusNode(), 'Fullscreen is unavailable in this browser.', 'info'));
    });
    document.addEventListener('fullscreenchange', sync);
    // The viewer is destroyed when the panel closes or the work changes; the
    // document-level listener must go with it (and fullscreen must not survive
    // a closed panel).
    if (instance) {
      const baseDestroy = instance.destroy.bind(instance);
      instance.destroy = () => {
        document.removeEventListener('fullscreenchange', sync);
        if (document.fullscreenElement === stage) document.exitFullscreen?.().catch(() => {});
        baseDestroy();
      };
    }
  }

  /** WMTS records have no IIIF manifest – show a real tile and name what it is. */
  function staticPreview(record) {
    if (!record.thumbnail) {
      return el('section', { class: 'app-viewer' }, [
        el('p', { class: 'zh-hint', text: 'No preview is available for this record.' }),
      ]);
    }
    return el('section', { class: 'app-viewer' }, [
      el('div', { class: 'app-viewer__stage app-viewer__stage--static', id: 'detail-preview' }, [
        el('img', { src: record.thumbnail, alt: `Map tile: ${record.title}`, decoding: 'async' }),
      ]),
      el('p', { class: 'app-viewer__caption' }, [
        el('span', { text: record.overlay ? 'Sample map tile. View the full map with its overlay control.' : 'Collection preview. Open the original record or download for the full image.' }),
      ]),
    ]);
  }

  /* -------------------------------------------------------------- manifests */

  async function loadManifest(record) {
    if (!record.iiifManifest) return;
    try {
      manifest = parseManifest(await fetchJson(record.iiifManifest));
      renderSheetStrip();
      showCanvas();
    } catch (err) {
      // Without a manifest the reuse block must not stay on "Weitere Links
      // werden geladen …": fall back to the harvested record values.
      manifest = null;
      // `describeUpstreamError` keeps developer strings such as "Failed to fetch"
      // out of the panel; `title` keeps the raw text for debugging.
      showPreviewFallback(record, describeUpstreamError(err), String(err?.message ?? err ?? ''));
      updateReuseLinks(record);
    }
  }

  /**
   * JSON from an allowlisted upstream (IIIF manifest, image info). The ladder
   * (same-origin proxy first, direct call as fallback) lives in `upstream.js` so
   * the comparison view can use exactly the same path.
   */
  const fetchJson = fetchUpstreamJson;

  /* --------------------------------------------------------------- viewer */

  function showCanvas() {
    const total = manifest?.canvases?.length ?? 0;
    if (total === 0) return;
    // The sheet number is shareable state; clamp it to what the work really has
    // and write a mismatch back, so the URL never names a sheet that is not there.
    const wanted = Math.floor(Number(ctx.store.getState().sheet) || 1);
    page = Math.max(0, Math.min(total - 1, wanted - 1));
    if (ctx.store.getState().sheet !== page + 1) ctx.store.update({ sheet: page + 1 });
    const canvas = manifest.canvases[page];
    if (!canvas) return;
    const pageLabel = qs('#page-label');
    if (pageLabel) pageLabel.textContent = `Sheet ${page + 1} of ${total}`;
    viewer?.setCanvas(canvas, { label: canvas.label, restore: ctx.store.getState().vv });
    updateReuseLinks(current);
    const nav = qs('#page-nav');
    if (nav) nav.hidden = total <= 1;
    const prev = qs('#page-prev');
    const next = qs('#page-next');
    if (prev) prev.disabled = page === 0;
    if (next) next.disabled = page === total - 1;
    // Announce the sheet for screen readers (the visible label alone changes
    // silently when the viewer swaps the canvas).
    if (total > 1) {
      const liveNode = qs('#viewer-status');
      if (liveNode) liveNode.textContent = `Sheet ${page + 1} of ${total} loaded.`;
    }
    updateSheetStrip(total);
  }

  function gotoPage(next) {
    const total = manifest?.canvases?.length ?? 0;
    if (total === 0) return;
    const target = Math.max(0, Math.min(total - 1, Math.floor(Number(next) || 0)));
    // Each sheet has its own region: a shared `vv` belongs to the sheet it was
    // copied from, so switching sheets starts on the whole sheet.
    ctx.store.update({ sheet: target + 1, vv: '' });
    showCanvas();
  }

  /** Build one button per sheet; thumbnails are filled in when they come into view. */
  function renderSheetStrip() {
    const strip = qs('#page-strip');
    if (!strip) return;
    // A rebuild (another work, another panel opening) drops the old observer.
    stripObserver?.disconnect();
    stripObserver = null;
    const canvases = manifest?.canvases ?? [];
    if (canvases.length <= 1) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    strip.replaceChildren(...canvases.map((canvas, index) => sheetButton(canvas, index, canvases.length)));
    strip.hidden = false;
    observeStripThumbs(strip);
    updateSheetStrip(canvases.length);
  }

  /** One strip button: number always, thumbnail only once it is loaded. */
  function sheetButton(canvas, index, total) {
    return el(
      'button',
      {
        class: 'app-viewer__sheet',
        type: 'button',
        'data-sheet': String(index),
        'data-thumb': sheetThumbUrl(canvas),
        'aria-label': sheetOptionLabel(canvas, index, total),
        title: canvas.label,
        onclick: () => gotoPage(index),
      },
      [el('span', { class: 'app-viewer__sheetnum', text: String(index + 1) })],
    );
  }

  /** Insert a sheet's thumbnail once — the service URL came from the manifest. */
  function loadSheetThumb(button) {
    if (!button || button.querySelector('img')) return;
    const url = button.dataset.thumb;
    if (!url) return;
    button.prepend(
      el('img', {
        src: url,
        alt: '',
        loading: 'lazy',
        decoding: 'async',
        onerror: (event) => {
          event.currentTarget.hidden = true;
        },
      }),
    );
  }

  /**
   * Fetch sheet thumbnails only for the buttons a visitor can actually see (plus
   * one screen of margin). Opening the 33-sheet canton map used to request all 33
   * 96-px derivatives at once, although a desktop strip shows about ten of them.
   * A browser without `IntersectionObserver` loads every thumbnail, as before.
   */
  function observeStripThumbs(strip) {
    const buttons = [...strip.querySelectorAll('[data-sheet]')];
    if (typeof IntersectionObserver !== 'function') {
      buttons.forEach(loadSheetThumb);
      return;
    }
    stripObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          loadSheetThumb(entry.target);
          stripObserver?.unobserve(entry.target);
        }
      },
      { root: strip, rootMargin: '300px 0px' },
    );
    for (const button of buttons) stripObserver.observe(button);
  }

  /**
   * ←/→/Home/End inside the sheet strip. Roving tabindex: exactly one sheet
   * button is tabbable (the visible one), the arrow keys move both the selection
   * and the focus — the same pattern as the year histogram.
   */
  function onStripKeyDown(event) {
    const strip = event.currentTarget;
    const buttons = [...strip.querySelectorAll('[data-sheet]')];
    if (buttons.length < 2) return;
    const currentIndex = buttons.findIndex((button) => Number(button.dataset.sheet) === page);
    const keys = { ArrowRight: currentIndex + 1, ArrowLeft: currentIndex - 1, Home: 0, End: buttons.length - 1 };
    const wanted = keys[event.key];
    if (wanted === undefined) return;
    event.preventDefault();
    const target = Math.max(0, Math.min(buttons.length - 1, wanted));
    if (target === currentIndex) return;
    gotoPage(target);
    qs(`#page-strip [data-sheet="${target}"]`)?.focus();
  }

  /** Mark the visible sheet in the strip without rebuilding it. */
  function updateSheetStrip(total) {
    const strip = qs('#page-strip');
    if (!strip) return;
    strip.hidden = total <= 1;
    for (const button of strip.querySelectorAll('[data-sheet]')) {
      const active = Number(button.dataset.sheet) === page;
      button.classList.toggle('is-active', active);
      // Roving tabindex: one tab stop for the whole strip.
      button.tabIndex = active ? 0 : -1;
      if (active) {
        button.setAttribute('aria-current', 'true');
        // The visible sheet must show its thumbnail even before the observer has
        // reported it (a deep link into the middle of a big work).
        loadSheetThumb(button);
        // Centre the visible sheet *inside the strip*. Deliberately not
        // `scrollIntoView`: that also scrolls every ancestor scroll container, so
        // opening a multi-sheet deep link on a phone pushed the title and the
        // whole viewer out of the panel viewport (measured at 320 px).
        const centred = button.offsetLeft - (strip.clientWidth - button.clientWidth) / 2;
        strip.scrollLeft = Math.max(0, centred);
      } else {
        button.removeAttribute('aria-current');
      }
    }
    updateSheetJump(total);
  }

  /**
   * The “jump to sheet” select for large works: it is only rendered when the
   * strip no longer fits one row, and its options state the same sheet names the
   * strip uses (`sheetOptionLabel`), never an invented one.
   */
  function updateSheetJump(total) {
    const wrap = qs('#page-jump-wrap');
    const jump = qs('#page-jump');
    if (!wrap || !jump) return;
    const needed = total > JUMP_MIN_SHEETS;
    wrap.hidden = !needed;
    if (!needed) {
      jump.replaceChildren();
      return;
    }
    if (jump.options.length !== total) {
      jump.replaceChildren(
        ...(manifest?.canvases ?? []).map((canvas, index) =>
          el('option', { value: String(index + 1), text: sheetOptionLabel(canvas, index, total) }),
        ),
      );
    }
    if (jump.value !== String(page + 1)) jump.value = String(page + 1);
  }

  function showPreviewFallback(record, message, rawDetail = '') {
    const frame = qs('#detail-preview');
    if (!frame) return;
    const url = record?.thumbnail ?? null;
    frame.replaceChildren(
      el('div', { class: 'app-viewer__fallback' }, [
        el('p', { class: 'zh-hint', text: message, title: rawDetail || undefined }),
        url ? el('img', { src: url, alt: '', decoding: 'async', onerror: (event) => (event.currentTarget.hidden = true) }) : null,
        el('a', { class: 'zh-button zh-button--small', href: record?.recordUrl ?? '#', target: '_blank', rel: 'noopener', text: 'View at the collection ↗' }),
      ].filter(Boolean)),
    );
  }

  /* ------------------------------------------------------- reuse/citation */

  /** Citation built only from upstream values; unknown parts are omitted. */
  function citationText(record) {
    const years = record.yearStart ? formatYearRange(record.yearStart, record.yearEnd ?? record.yearStart) : '';
    /** Add a sentence break only when the upstream text does not end with one. */
    const sentence = (text) => {
      const value = (text ?? '').trim();
      if (!value) return '';
      return /[.!?]$/.test(value) ? `${value} ` : `${value}. `;
    };
    return [
      sentence(`${record.title}${years ? ` (${years})` : ''}`),
      sentence(record.creators?.join(', ')),
      sentence(record.collection),
      sentence(record.institution),
      `Online: ${record.recordUrl}. `,
      `Accessed ${new Date().toISOString().slice(0, 10)}.`,
    ].join('');
  }

  function reuseSection(record) {
    const copyButton = el('button', {
      class: 'zh-button zh-button--ghost zh-button--small',
      type: 'button',
      text: 'Copy citation',
      onclick: async (event) => {
        const ok = await copyText(citationText(record));
        event.currentTarget.textContent = ok ? 'Citation copied ✓' : 'Could not copy';
        setTimeout(() => (event.currentTarget.textContent = 'Copy citation'), 2500);
      },
    });
    return el('section', { id: 'reuse-section' }, [
      el('h3', { class: 'zh-heading zh-heading--4', text: 'Cite and reuse' }),
      el('p', { class: 'zh-hint', id: 'citation-text', text: citationText(record) }),
      el('div', { class: 'app-detail__actions' }, [
        copyButton,
        record.iiifManifest
          ? el('a', {
              class: 'zh-button zh-button--ghost zh-button--small',
              href: record.iiifManifest,
              target: '_blank',
              rel: 'noopener',
              text: 'IIIF manifest (JSON) ↗',
            })
          : null,
      ]),
      // The harvested record already names the image service, so the full-size
      // link is there on first paint; only the METS/OAI link needs the manifest.
      el('div', { class: 'app-detail__actions', id: 'reuse-links' }, [
        ...imageReuseLinks(record),
      ]),
      el('p', { class: 'zh-hint', text: 'Check rights and citation guidance with the holding collection. The information here comes from its metadata.' }),
    ]);
  }

  /**
   * The image half of the reuse links as a flat array. A ternary that returns
   * an array inside another array used to stringify to comma-separated URLs
   * instead of rendering anchors, so the caller always spreads this.
   */
  function imageReuseLinks(record) {
    if (record?.imageService) return [fullImageLink(record.imageService)];
    const originals = originalLinks(record);
    if (originals.length) return originals;
    return [el('span', { class: 'zh-hint', text: record?.iiifManifest ? 'Loading source links …' : 'No image service available. Open the original record to view this map.' })];
  }

  /**
   * The provider's own original scan/document links. Doria and similar
   * repositories publish a JPEG or PDF rather than a IIIF image service; the
   * catalogue keeps those URLs and must expose them instead of claiming no
   * image exists. Only https links are rendered; nothing is synthesised.
   */
  function originalLinks(record) {
    const imageUrls = [...new Set([record?.imageUrl, ...(record?.images ?? [])].filter((url) => typeof url === 'string' && /^https:\/\//.test(url)))];
    const documentUrls = [...new Set((record?.documents ?? []).filter((url) => typeof url === 'string' && /^https:\/\//.test(url)))];
    return [
      ...imageUrls.map((href, i) =>
        el('a', {
          class: 'zh-button zh-button--ghost zh-button--small',
          href,
          target: '_blank',
          rel: 'noopener',
          text: i === 0 ? 'Open original scan ↗' : `Open original scan ${i + 1} ↗`,
        }),
      ),
      ...documentUrls.map((href, i) =>
        el('a', {
          class: 'zh-button zh-button--ghost zh-button--small',
          href,
          target: '_blank',
          rel: 'noopener',
          text: /\.pdf(?:$|[?#])/i.test(href)
            ? documentUrls.length > 1
              ? `Open original PDF ${i + 1} ↗`
              : 'Open original PDF ↗'
            : 'Open original document ↗',
        }),
      ),
    ];
  }

  /** The full-resolution IIIF image link, named the same way everywhere. */
  function fullImageLink(service) {
    return el('a', {
      class: 'zh-button zh-button--ghost zh-button--small',
      href: `${service}/full/max/0/default.jpg`,
      target: '_blank',
      rel: 'noopener',
      text: 'Open full-resolution image (IIIF) ↗',
    });
  }

  /** Add the links that need the parsed manifest (image service, METS/OAI). */
  function updateReuseLinks(record) {
    const container = qs('#reuse-links');
    if (!container) return;
    const canvas = manifest?.canvases?.[page];
    // Fall back to the harvested `imageService` so the link never depends on a
    // manifest request that may still be in flight (or fail).
    const service = canvas?.service || record?.imageService;
    // `replaceChildren` turns a `null` argument into a literal "null" text node
    // (unlike `el()`), so absent links are filtered out first — a failed manifest
    // request used to print "null" between the citation buttons.
    container.replaceChildren(
      ...[
        ...(service ? [fullImageLink(service)] : imageReuseLinks(record)),
        manifest?.seeAlso
          ? el('a', {
              class: 'zh-button zh-button--ghost zh-button--small',
              href: manifest.seeAlso,
              target: '_blank',
              rel: 'noopener',
              text: 'METS/MODS via OAI-PMH ↗',
            })
          : null,
        record?.recordUrl
          ? el('a', { class: 'zh-button zh-button--ghost zh-button--small', href: record.recordUrl, target: '_blank', rel: 'noopener', text: 'Original record ↗' })
          : null,
      ].filter(Boolean),
    );
  }

  /* --------------------------------------------------------------- facts */

  function factsSection(record) {
    const facts = [
      ['Publication year', formatYearRange(record.yearStart, record.yearEnd)],
      [
        'Period depicted',
        record.depictedYearStart || record.depictedYearEnd
          ? formatYearRange(record.depictedYearStart ?? record.depictedYearEnd, record.depictedYearEnd ?? record.depictedYearStart)
          : 'not stated by the collection',
      ],
      ['Creator', record.creators?.length ? record.creators.join(', ') : 'not stated'],
      ['Holding institution', record.institution],
      ['Shelfmark', record.shelfmark || 'not stated'],
      ['Publisher / imprint', [record.publisher, record.imprint].filter(Boolean).join(' – ') || 'not stated'],
      ['Language', record.languages?.length ? record.languages.map(formatLanguage).join(', ') : 'not stated'],
      ['Rights', record.rights],
      [
        'Map extent',
        record.extent
          ? `W ${record.extent.west.toFixed(2)}° / E ${record.extent.east.toFixed(2)}° / S ${record.extent.south.toFixed(2)}° / N ${record.extent.north.toFixed(2)}°`
          : 'not stated',
      ],
      ['Digitized pages', record.canvasCount || record.pageCount ? `${record.canvasCount ?? record.pageCount} pages` : 'not stated'],
      ['Physical description', record.physicalExtent || 'not stated'],
      ['Source', `${record.providerId} · ${record.id}`],
    ];
    return el('section', {}, [
      el('h3', { class: 'zh-heading zh-heading--4', text: 'About this map' }),
      el('dl', { class: 'app-detail__facts' }, facts.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })])),
      record.dateNote ? el('p', { class: 'zh-hint', text: record.dateNote }) : null,
      record.geoNote ? el('p', { class: 'zh-hint', text: `Location note: ${record.geoNote}` }) : null,
      el('div', { class: 'app-alignment' }, [
        record.georeference?.kind === 'cog'
          ? el('button', { class: 'zh-button zh-button--small', type: 'button', 'data-show-raster': record.id, text: 'Overlay this georeferenced map' })
          : (record.iiifManifest || record.imageService)
            ? el('button', { class: 'zh-button zh-button--small', type: 'button', 'data-find-alignment': record.id, text: 'Find reusable alignment' }) : null,
        record.georeference?.url ? el('a', { class: 'zh-link', href: record.georeference.url, target: '_blank', rel: 'noopener', text: 'Download original GeoTIFF ↗' }) : null,
        !record.georeference && record.iiifManifest ? el('a', { class: 'zh-link', href: `https://editor.allmaps.org/?url=${encodeURIComponent(record.iiifManifest)}`, target: '_blank', rel: 'noopener', text: 'Georeference in Allmaps ↗' }) : null,
        el('p', { class: 'zh-hint', 'data-alignment-result': '', text: record.georeference || record.overlay ? 'Provider-supplied alignment. Historical accuracy varies by map.' : 'Alignment is optional. This scan can be viewed and compared without it.' }),
      ]),
      el('p', { class: 'zh-hint' }, [
        el('span', { text: 'Image rights and citation guidance are available from the holding collection. ' }),
        el('a', { href: record.recordUrl, target: '_blank', rel: 'noopener', text: 'Check rights ↗' }),
      ]),
    ]);
  }

  /* ------------------------------------------------- leading to the series */

  /** Title short enough for a chip, without cutting a word in the middle. */
  function shortenTitle(title, max = 72) {
    const text = String(title ?? '').trim();
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
  }

  /**
   * Other digitised sheets of the same series: the way a visitor follows a single
   * map into its collection (the OldMapsOnline “browse the series” step). Only
   * records that really carry the same upstream series name are listed, and the
   * list says how many there are — nothing is inferred or padded.
   */
  function relatedSection(record) {
    const series = record.collection;
    if (!series) return null;
    const siblings = (ctx.data.records ?? [])
      .filter((other) => other.id !== record.id && other.collection === series)
      .sort((a, b) => (a.yearStart ?? 0) - (b.yearStart ?? 0));
    if (siblings.length === 0) return null;
    const shown = siblings.slice(0, 6);
    return el('section', { id: 'detail-related' }, [
      el('h3', { class: 'zh-heading zh-heading--4', text: `More maps from this collection (${siblings.length})` }),
      el('p', { class: 'zh-hint', text: `From “${series}”. Dates and creators are transcribed from the collection’s metadata.` }),
      el(
        'ul',
        { class: 'app-detail__related' },
        shown.map((other) =>
          el('li', {}, [
            el('button', {
              class: 'zh-button zh-button--ghost zh-button--small',
              type: 'button',
              text: `${formatYearRange(other.yearStart, other.yearEnd)} · ${shortenTitle(other.title)}`,
              onclick: () => {
                ctx.store.update({ selected: other.id, sheet: 1 });
                ctx.bus.emit('record:selected', { record: other, source: 'detail-related' });
              },
            }),
          ]),
        ),
      ),
      siblings.length > shown.length
        ? el('p', { class: 'zh-hint', text: `… and ${siblings.length - shown.length} more from this collection.` })
        : null,
      el('button', {
        class: 'zh-button zh-button--ghost zh-button--small',
        type: 'button',
        text: 'Browse this collection',
        onclick: () => {
          ctx.store.update({ collection: series, selected: '' });
          close();
          const live = qs('#results-live');
          if (live) live.textContent = `Results filtered to the collection “${series}”.`;
        },
      }),
    ]);
  }

  /* -------------------------------------------------------------- events */

  ctx.bus.on('record:selected', ({ record }) => {
    // Re-selecting the record that is already on screen must not reload its
    // manifest (the store subscription below opens it for URL-driven changes).
    if (!record || (current?.id === record.id && !panel.hidden)) return;
    open(record);
  });
  // The comparison list is shareable state; keep the panel's pin label in sync
  // when the sidebar (or a shared ?cmp= link) changes it.
  ctx.store.subscribe((state, changed) => {
    if (changed.includes('cmp')) updatePinButton(qs('#detail-pin'), current);
    if (changed.includes('overlay') || changed.includes('otime')) updateOverlayButton(qs('#detail-overlay'), current);
    // A hand-edited or reloaded `vv` (or a cleared one) drives the open viewer;
    // the viewer ignores a value that matches what is already on screen, so the
    // debounced write-back from the viewer cannot loop back into it.
    if (changed.includes('vv')) viewer?.restoreView?.(state.vv);
    if (!changed.includes('selected')) return;
    const record = state.selected ? (ctx.data.recordIndex.get(state.selected) ?? null) : null;
    if (!record) {
      // Cleared from the outside — the browser's back button, a shared link or
      // the series lead (`collection` + `selected: ''`). The panel follows the
      // URL instead of showing a record the state no longer names.
      if (!panel.hidden) close();
      return;
    }
    // The bus already opened the panel for a click in the list, the map or the
    // comparison view; this branch covers the URL changing on its own
    // (back/forward to another sheet, a hand-written ?sel= link).
    if (current?.id !== record.id || panel.hidden) open(record, { keepSheet: true });
  });
  ctx.bus.on('records:loaded', () => {
    const id = ctx.store.getState().selected;
    const record = ctx.data.recordIndex.get(id);
    if (id && record && panel.hidden) open(record, { keepSheet: true });
  });

  scrim?.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      // While the sheet is fullscreen, Esc belongs to the browser first: it must
      // leave fullscreen, not close the whole panel.
      if (document.fullscreenElement) return;
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'ArrowLeft' && event.altKey) gotoPage(page - 1);
    if (event.key === 'ArrowRight' && event.altKey) gotoPage(page + 1);
    if (event.key === 'Tab') trapFocus(panel, event);
  });

  // Deep link: `?sel=<id>` must open the panel, not just pre-render it hidden.
  const initial = ctx.store.getState().selected;
  if (initial) {
    const record = ctx.data.recordIndex.get(initial);
    if (record) open(record, { keepSheet: true });
  }

  return { open, close, gotoPage };
}

/* -------------------------------------------------------------------------- */
/* Deep-zoom viewer                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A dependency-free IIIF viewer: it requests exactly the visible rectangle from
 * the image service (`regionByPx` + `sizeByW`), keeps the sheet inside the view
 * box and gives immediate feedback by transforming the current bitmap while the
 * next region is loading.
 *
 * Exported because the comparison view mounts the same viewer for its panes
 * (one factory, one set of IIIF-request rules); it owns nothing but its `stage`.
 */
export function createViewer(stage, { record, live, loadJson, meta, onZoom, onError, onViewChange } = {}) {
  const img = el('img', { class: 'app-viewer__image', alt: '', decoding: 'async' });
  const spinner = stage.querySelector('.zh-spinner') ?? el('span', { class: 'zh-spinner' });
  stage.replaceChildren(spinner, img);
  stage.dataset.state = 'loading';

  let canvas = null;
  let service = null;
  let bounds = null;
  let view = null;
  /** What the visible bitmap shows: { view, left, top, width, height }. */
  let rendered = null;
  let fetchTimer = null;
  let viewTimer = null;
  /** Last `vv` value reported to the store, so identical states are not re-written. */
  let lastViewParam = null;
  let destroyed = false;
  let loadToken = 0;
  let pendingPreload = null;
  let regionFailures = 0;
  /** Set after repeated failures: only the whole-sheet derivative works here. */
  let regionsUnsupported = false;
  let announceTimer = null;

  const pointers = new Map();
  let pinch = null;

  /* --------------------------------------------------------------- helpers */

  const stageSize = () => {
    const rect = stage.getBoundingClientRect();
    return { width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  };

  /** Output width the service has to deliver for the current view (device aware). */
  function outputWidthFor(currentView) {
    const { width, height } = stageSize();
    const scale = Math.min(width / currentView.w, height / currentView.h);
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    return Math.round(Math.max(64, currentView.w * scale * dpr));
  }

  function requestUrl(currentView) {
    if (!service || !bounds) return null;
    if (!regionsUnsupported) {
      const url = imageRequestUrl(service, currentView, outputWidthFor(currentView), { bounds });
      if (url) return url;
    }
    // Services without regionByPx (or with tighter rights) still serve `full`.
    return fullImageUrl(service, FULL_PREVIEW_WIDTH);
  }

  function layout() {
    if (!rendered) return;
    const { width, height } = stageSize();
    const scale = Math.min(width / rendered.view.w, height / rendered.view.h);
    const w = rendered.view.w * scale;
    const h = rendered.view.h * scale;
    const left = (width - w) / 2;
    const top = (height - h) / 2;
    Object.assign(img.style, {
      width: `${w}px`,
      height: `${h}px`,
      left: `${left}px`,
      top: `${top}px`,
    });
    Object.assign(rendered, { left, top, width: w, height: h });
    applyTransform();
  }

  /** Interim transform while a new region is loading (makes zoom/pan immediate). */
  function applyTransform() {
    if (!rendered || !view) return;
    const scale = rendered.view.w / view.w;
    const dx = ((rendered.view.x - view.x) / rendered.view.w) * rendered.width;
    const dy = ((rendered.view.y - view.y) / rendered.view.h) * rendered.height;
    img.style.transformOrigin = '0 0';
    img.style.transform = scale === 1 && dx === 0 && dy === 0 ? 'none' : `translate(${dx}px, ${dy}px) scale(${scale})`;
  }

  /** Screen point (page coords) → fractions inside the *current* view. */
  function screenPoint(clientX, clientY) {
    const rect = stage.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    if (!rendered || !view) return { x: 0.5, y: 0.5 };
    const scale = rendered.view.w / rendered.width; // image px per css px
    const imageX = rendered.view.x + (px - rendered.left) * scale;
    const imageY = rendered.view.y + (py - rendered.top) * scale;
    return {
      x: Math.min(1, Math.max(0, (imageX - view.x) / view.w)),
      y: Math.min(1, Math.max(0, (imageY - view.y) / view.h)),
    };
  }

  function announce(text) {
    if (!live) return;
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => (live.textContent = text), 400);
  }

  function updateReadout() {
    if (!view) return;
    const percent = zoomPercent(view, stageSize().width);
    const whole = view.w >= bounds.w - 1 && view.h >= bounds.h - 1;
    const box = `Region ${Math.round(view.w)}×${Math.round(view.h)} of ${bounds.w}×${bounds.h} pixels`;
    // "Gesamtansicht" and not "Whole sheet": the button next to the read-out is
    // called "Whole sheet", and two identical labels next to each other read
    // like a duplicate control.
    onZoom?.(whole ? `Whole sheet · Resolution ${percent} %` : `Resolution ${percent} % · ${box}`);
  }

  /**
   * Report the visible region as the shareable `vv` value, debounced so a drag or
   * a wheel zoom does not rewrite the URL on every frame. The value is only sent
   * when it actually changed since the last report.
   */
  function notifyView({ immediate = false } = {}) {
    clearTimeout(viewTimer);
    const run = () => {
      if (destroyed || !view || !bounds) return;
      const param = formatViewParam(view, bounds);
      if (param === lastViewParam) return;
      lastViewParam = param;
      onViewChange?.(param);
    };
    if (immediate) run();
    else viewTimer = setTimeout(run, 400);
  }

  /* ---------------------------------------------------------------- loading */

  function scheduleFetch({ immediate = false } = {}) {
    clearTimeout(fetchTimer);
    fetchTimer = setTimeout(load, immediate ? 0 : 180);
  }

  function load() {
    const target = { ...view };
    const url = requestUrl(target);
    if (!url || destroyed) return;
    // Same picture as the one on screen: nothing to fetch (pinch/pan can land on
    // the same rounded region repeatedly).
    if (url === img.src && stage.dataset.state === 'ready') {
      layout();
      return;
    }
    const token = ++loadToken;
    stage.dataset.state = 'loading';
    const preload = new Image();
    // Keep a strong reference: an Image() that is only referenced by its own
    // listeners can be collected before it finishes loading, and the picture
    // then never appears (this was an intermittent failure of the pinch/zoom path).
    pendingPreload = preload;
    preload.decoding = 'async';
    const done = () => {
      clearTimeout(guard);
      if (pendingPreload === preload) pendingPreload = null;
    };
    const guard = setTimeout(() => {
      done();
      if (destroyed || token !== loadToken) return;
      if (!regionsUnsupported) {
        regionsUnsupported = true;
        load();
      }
    }, 15_000);
    preload.addEventListener('load', () => {
      done();
      if (destroyed || token !== loadToken) return;
      regionFailures = 0;
      rendered = { view: target, left: 0, top: 0, width: 0, height: 0 };
      img.src = url;
      img.alt = canvas?.label ? `Map preview: ${record?.title ?? ''} (${canvas.label})` : `Map preview: ${record?.title ?? ''}`;
      layout();
      stage.dataset.state = 'ready';
      const info = meta?.();
      if (info) {
        const bits = [];
        if (canvas?.label) bits.push(`Sheet ${canvas.label}`);
        bits.push(`${preload.naturalWidth}×${preload.naturalHeight} px loaded`);
        if (bounds) bits.push(`Original ${bounds.w}×${bounds.h} px`);
        bits.push(regionsUnsupported ? 'IIIF Image API (whole image only)' : 'IIIF Image API (regionByPx, sizeByW)');
        info.textContent = bits.join(' · ');
      }
      updateReadout();
    });
    preload.addEventListener('error', () => {
      done();
      if (destroyed || token !== loadToken) return;
      regionFailures += 1;
      if (!regionsUnsupported) {
        // Two refusals are enough: stay on the full-sheet derivative, honestly
        // labelled, instead of hammering the service with region requests.
        if (regionFailures >= 2) regionsUnsupported = true;
        load();
        return;
      }
      stage.dataset.state = 'error';
      img.remove();
      onError?.('Could not load the image preview. Open the original record to view this map.');
      const info = meta?.();
      if (info) info.textContent = 'Preview unavailable. Metadata and the original record are still available.';
    });
    preload.src = url;
  }

  /* -------------------------------------------------------------- controls */

  function zoom(factor, anchor) {
    if (!view || regionsUnsupported) return;
    const { width, height } = stageSize();
    // Zooming reshapes the region to the stage aspect ratio so the map fills the
    // viewport instead of sitting in letterbox bars (contain → cover).
    view = zoomView(view, factor, anchor ?? { x: 0.5, y: 0.5 }, bounds, { aspect: width / height });
    applyTransform();
    updateReadout();
    announce(`Resolution ${zoomPercent(view, stageSize().width)} percent`);
    scheduleFetch();
    notifyView();
  }

  function reset() {
    if (!bounds) return;
    view = viewForCanvas(bounds.w, bounds.h);
    if (regionsUnsupported) {
      // Only the full-sheet derivative is available: show it and stay honest.
      rendered = null;
      load();
      notifyView({ immediate: true });
      return;
    }
    applyTransform();
    updateReadout();
    announce('Whole sheet');
    scheduleFetch();
    // Immediate on purpose (the only caller of the flag): a reset is a discrete
    // action, and the comparison's coupled “Whole sheet” returns every pane to
    // its own whole sheet in one press. A debounced report would arrive after
    // that loop and map the reset sheet's place back onto the others, so the
    // button's promise would depend on the timing.
    notifyView({ immediate: true });
  }

  /* ---------------------------------------------------------------- events */

  const onWheel = (event) => {
    if (!(event.ctrlKey || event.metaKey)) return; // keep panel scrolling usable
    event.preventDefault();
    const anchor = screenPoint(event.clientX, event.clientY);
    zoom(Math.exp(-event.deltaY * 0.002), anchor);
  };

  const onDblClick = (event) => {
    const anchor = screenPoint(event.clientX, event.clientY);
    zoom(2, anchor);
  };

  /* One pointer pans, two pointers pinch. Deltas are always measured against the
     previous position *of the same pointer id*, so a lost pointer event cannot
     leave a stale gesture behind (that made one-finger drags after a pinch dead). */
  const onPointerDown = (event) => {
    if (!view) return;
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) pinch = null;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) };
    }
    stage.dataset.dragging = 'true';
  };

  const onPointerMove = (event) => {
    const previous = pointers.get(event.pointerId);
    if (!previous || !view) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (regionsUnsupported) return;

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const center = screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2);
      if (pinch && pinch.distance > 8 && distance > 8) zoom(distance / pinch.distance, center);
      pinch = { distance };
      return;
    }

    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.hypot(dx, dy) < 1) return;
    stage.dataset.dragging = 'true';
    const imagePxPerCssPx = rendered ? rendered.view.w / rendered.width : 1;
    view = panView(view, (-dx * imagePxPerCssPx) / view.w, (-dy * imagePxPerCssPx) / view.h, bounds);
    applyTransform();
    scheduleFetch();
    if (meta && rendered) {
      meta.textContent = `Region ${Math.round(view.w)}×${Math.round(view.h)} of ${bounds.w}×${bounds.h} pixels`;
    }
  };

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = null;
    if (pointers.size === 0) {
      delete stage.dataset.dragging;
      updateReadout();
      scheduleFetch();
      notifyView();
    }
  }

  const KEY_STEPS = {
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
  };

  const onKeyDown = (event) => {
    if (!view) return;
    const step = KEY_STEPS[event.key];
    if (step) {
      event.preventDefault();
      const amount = event.shiftKey ? 0.35 : 0.12;
      view = panView(view, step[0] * amount, step[1] * amount, bounds);
      applyTransform();
      scheduleFetch();
      notifyView();
      return;
    }
    if (event.key === '+' || event.key === '=' || event.key === 'PageUp') {
      event.preventDefault();
      zoom(1.6);
    } else if (event.key === '-' || event.key === '_' || event.key === 'PageDown') {
      event.preventDefault();
      zoom(1 / 1.6);
    } else if (event.key === 'Home' || event.key === '0') {
      event.preventDefault();
      reset();
    }
  };

  const onResize = () => {
    layout();
    scheduleFetch();
  };

  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('dblclick', onDblClick);
  stage.addEventListener('pointerdown', onPointerDown);
  stage.addEventListener('pointermove', onPointerMove);
  stage.addEventListener('pointerup', endPointer);
  stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', onResize);

  return {
    /**
     * Show a canvas of the current manifest (possibly at full resolution).
     *
     * `restore` is the shared `vv` value for this sheet: a usable region becomes
     * the initial view, an unusable one is reported back as `''` so the URL does
     * not keep a value this viewer would never produce.
     */
    setCanvas(next, { label, restore = '' } = {}) {
      if (!next?.service) return;
      canvas = { ...next, label: label ?? next.label };
      service = next.service;
      const width = next.width ?? 0;
      const height = next.height ?? 0;
      if (!width || !height) {
        // Presentation 3 manifests may omit the size; the image service states it.
        loadJson(`${service}/info.json`)
          .then((info) => this.setCanvas({ ...canvas, width: info.width, height: info.height }, { restore }))
          .catch(() => onError?.('Could not load the image dimensions (image service unavailable).'));
        return;
      }
      bounds = boundsForCanvas(width, height);
      const restored = restore ? parseViewParam(restore, bounds) : null;
      view = restored ?? viewForCanvas(width, height);
      lastViewParam = formatViewParam(view, bounds);
      if (restore && !restored) onViewChange?.('');
      regionsUnsupported = false;
      regionFailures = 0;
      rendered = null;
      load();
    },
    zoomIn: () => zoom(1.6),
    zoomOut: () => zoom(1 / 1.6),
    reset,
    /** The current region and the sheet bounds it lives in (`null` before a canvas is set). */
    getView: () => (view && bounds ? { view: { ...view }, bounds: { ...bounds } } : null),
    /**
     * Apply a view that came from outside (the coupled comparison view). The
     * region is clamped to this sheet, the bitmap follows immediately and the
     * next region is fetched — but nothing is *reported* back, so two coupled
     * viewers cannot ping-pong each other's state.
     */
    setView(next) {
      if (!bounds || !view || !next) return false;
      const target = clampView(next, bounds);
      const same =
        Math.abs(target.x - view.x) < 1 && Math.abs(target.y - view.y) < 1 && Math.abs(target.w - view.w) < 1 && Math.abs(target.h - view.h) < 1;
      if (same) return true;
      view = target;
      applyTransform();
      updateReadout();
      scheduleFetch();
      return true;
    },
    /** The current region as the shareable `vv` value (`''` = whole sheet). */
    getViewParam: () => (bounds ? formatViewParam(view, bounds) : null),
    /**
     * Apply a `vv` value that came from outside (reload, hand-edited URL, a
     * cleared value). A value equal to what is on screen is a no-op, which is
     * what keeps the viewer's own debounced write-back from looping.
     */
    restoreView(value) {
      if (!bounds || !view) return false;
      const next = value ? parseViewParam(value, bounds) : viewForCanvas(bounds.w, bounds.h);
      if (!next) return false;
      const same =
        Math.abs(next.x - view.x) < 1 && Math.abs(next.y - view.y) < 1 && Math.abs(next.w - view.w) < 1 && Math.abs(next.h - view.h) < 1;
      if (same) return true;
      view = next;
      applyTransform();
      updateReadout();
      scheduleFetch();
      return true;
    },
    /** Re-fit after the stage changed size outside a window resize (fullscreen). */
    refresh() {
      layout();
      scheduleFetch();
    },
    destroy() {
      destroyed = true;
      clearTimeout(fetchTimer);
      clearTimeout(announceTimer);
      clearTimeout(viewTimer);
      window.removeEventListener('resize', onResize);
      stage.removeEventListener('wheel', onWheel);
      stage.removeEventListener('dblclick', onDblClick);
      stage.removeEventListener('pointerdown', onPointerDown);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerup', endPointer);
      stage.removeEventListener('pointercancel', endPointer);
      stage.removeEventListener('keydown', onKeyDown);
    },
  };
}
