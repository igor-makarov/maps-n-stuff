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

import { copyText, el, formatYearRange, qs, setStatus, trapFocus } from './dom.js';
import { recordCenter } from './records.js';
import {
  boundsForCanvas,
  describeUpstreamError,
  eRaraViewerUrl,
  formatViewParam,
  fullImageUrl,
  imageRequestUrl,
  panView,
  parseManifest,
  parseViewParam,
  sheetThumbUrl,
  viewForCanvas,
  zoomPercent,
  zoomView,
} from './iiif.js';

const FULL_PREVIEW_WIDTH = 1000;

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
        el('span', { class: 'zh-tag zh-tag--blue', text: 'Detailansicht' }),
        el('button', {
          class: 'zh-button zh-button--small',
          type: 'button',
          text: 'Schliessen (Esc)',
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
          text: 'Originaldatensatz öffnen ↗',
        }),
        eRaraViewerUrl(record)
          ? el('a', {
              class: 'zh-button zh-button--ghost zh-button--small',
              href: eRaraViewerUrl(record),
              target: '_blank',
              rel: 'noopener',
              text: 'Im e-rara-Viewer öffnen ↗',
            })
          : null,
        el('button', {
          class: 'zh-button zh-button--ghost zh-button--small',
          type: 'button',
          text: 'Auf der Karte zeigen',
          onclick: () => {
            const bounds = record.extent ?? (center ? { west: center.lon - 0.05, east: center.lon + 0.05, south: center.lat - 0.03, north: center.lat + 0.03 } : null);
            if (bounds) ctx.bus.emit('view:fit', { bounds });
            else setStatus(statusNode(), 'Für diesen Datensatz ist kein Kartenausschnitt dokumentiert.', 'info');
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
          text: 'Zeitraum dieses Blattes filtern',
          onclick: (event) => applyPeriod(record, event.currentTarget),
        }),
        el('button', {
          class: 'zh-button zh-button--ghost zh-button--small',
          type: 'button',
          text: 'Permalink kopieren',
          onclick: async (event) => {
            // The region reaches the URL debounced; flush it first so the copied
            // link is the view on screen even if the user clicks immediately.
            const region = viewer?.getViewParam?.();
            if (region !== undefined && region !== null) ctx.store.update({ vv: region });
            const ok = await copyText(window.location.href);
            event.currentTarget.textContent = ok ? 'Link kopiert ✓' : 'Kopieren nicht möglich';
            setTimeout(() => (event.currentTarget.textContent = 'Permalink kopieren'), 2500);
          },
        }),
        record.overlay
          ? el('button', {
              class: 'zh-button zh-button--small',
              type: 'button',
              text: 'Als Kartenebene einblenden',
              onclick: () => showAsOverlay(record),
            })
          : null,
      ]),
      reuseSection(record),
      factsSection(record),
      relatedSection(record),
      el('p', { class: 'visuallyhidden', role: 'status', 'aria-live': 'polite', id: 'detail-status' }),
      el('p', { class: 'zh-hint' }, [
        el('span', { text: 'Angaben stammen aus dem Datenlieferanten. ' }),
        record.iiifManifest
          ? el('a', { href: record.iiifManifest, target: '_blank', rel: 'noopener', text: 'IIIF-Manifest (JSON) öffnen ↗' })
          : el('span', { text: 'Kein IIIF-Manifest hinterlegt.' }),
      ]),
    );
    viewer = viewer_?.__viewer ?? null;
  }

  /* ------------------------------------------------- comparison pinning */

  const pinnedIds = () => String(ctx.store.getState().cmp || '').split(',').map((id) => id.trim()).filter(Boolean);

  function updatePinButton(button, record) {
    if (!button || !record) return;
    const pinned = pinnedIds().includes(record.id);
    button.textContent = pinned ? 'Gemerkt ✓ (Vergleich)' : 'Für den Vergleich merken';
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
          setStatus(statusNode(), 'Es lassen sich höchstens vier Datensätze für den Vergleich merken.', 'warn');
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
      attribution: overlay.attribution ?? '© swisstopo',
    };
    ctx.store.update({ overlay: layer.id, otime: overlay.timeValue ?? '' });
    ctx.bus.emit('overlay:changed', { layer, time: overlay.timeValue ?? 'current' });
    ctx.bus.emit('overlay:time', { time: overlay.timeValue ?? 'current', layer });
    setStatus(statusNode(), `${layer.title} ist als Kartenebene eingeblendet (Deckkraft im Filterbereich einstellbar).`, 'info');
  }

  /** Use this sheet's publication period as the time filter, then get out of the way. */
  function applyPeriod(record, button) {
    // The slider is documented as “Zeitraum (Publikationsjahr)” (#year-from/#year-to,
    // index.html) and the intro states that the depicted date can differ, so this
    // button must feed the same publication range. Using the depicted period here
    // would hide the very sheet it came from as soon as a source states a survey
    // period (e.g. the Zürich Wildkarte sheets: published 1853, surveyed 1843–1851).
    const from = record.yearStart;
    const to = record.yearEnd ?? record.yearStart;
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      setStatus(statusNode(), 'Für diesen Datensatz ist kein Jahr dokumentiert.', 'info');
      return;
    }
    ctx.store.update({ from: Math.min(from, to), to: Math.max(from, to), selected: record.id });
    close();
    const live = qs('#results-live');
    const message = `Zeitraum auf ${Math.min(from, to)}–${Math.max(from, to)} gesetzt (${record.title}).`;
    if (live) live.textContent = message;
    if (button) button.textContent = 'Zeitraum übernommen ✓';
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
      'aria-roledescription': 'Kartenvorschau mit Zoom',
      'aria-label': `Kartenvorschau: ${record.title}. Zoomen mit Plus und Minus, verschieben mit den Pfeiltasten.`,
    }, [el('span', { class: 'zh-spinner', role: 'presentation' })]);
    const live = el('span', { class: 'visuallyhidden', role: 'status', 'aria-live': 'polite', id: 'viewer-status' });

    const controls = el('div', { class: 'app-viewer__controls' }, [
      el('button', { class: 'zh-button zh-button--small', type: 'button', id: 'viewer-zoom-out', 'aria-label': 'Verkleinern', text: '−' }),
      el('button', { class: 'zh-button zh-button--small', type: 'button', id: 'viewer-zoom-in', 'aria-label': 'Vergrössern', text: '+' }),
      el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', id: 'viewer-reset', text: 'Ganzes Blatt' }),
      // Real fullscreen for the sheet (the Fullscreen API, not a simulated
      // overlay): the largest possible view of a map without leaving the page.
      // Only offered when the browser supports it – no inert control.
      document.fullscreenEnabled
        ? el('button', {
            class: 'zh-button zh-button--ghost zh-button--small',
            type: 'button',
            id: 'viewer-fullscreen',
            'aria-pressed': 'false',
            text: 'Vollbild',
          })
        : null,
      el('span', { class: 'app-viewer__readout', id: 'viewer-resolution', text: 'Auflösung –' }),
      // Sheet navigation appears once we know the record has more than one sheet.
      el('span', { class: 'app-viewer__nav', id: 'page-nav', hidden: true }, [
        el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', id: 'page-prev', text: '‹ Blatt' }),
        el('span', { class: 'zh-hint', id: 'page-label', text: 'Blatt 1' }),
        el('button', { class: 'zh-button zh-button--ghost zh-button--small', type: 'button', id: 'page-next', text: 'Blatt ›' }),
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
          'aria-label': 'Blätter dieses Kartenwerks',
          hidden: true,
          onkeydown: onStripKeyDown,
        },
      ),
      controls,
      el('p', { class: 'app-viewer__caption' }, [
        el('span', { id: 'preview-meta', text: 'IIIF-Vorschau wird geladen …' }),
      ]),
      el('p', {
        class: 'app-viewer__hint',
        // Multi-sheet works name the keyboard route explicitly (and the strip).
        text: `Zoomen: + / −, Doppelklick oder Ctrl/⌘ + Mausrad · Verschieben: ziehen oder Pfeiltasten (mit Shift grössere Schritte) · Home zeigt das ganze Blatt.${(record.canvasCount ?? 0) > 1 ? ' Blatt wechseln: Alt + ←/→ oder die Blätterleiste unter dem Bild.' : ''}`,
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
      button.textContent = active ? 'Vollbild beenden' : 'Vollbild';
      stage.classList.toggle('is-fullscreen', active);
      instance?.refresh?.();
    };
    button.addEventListener('click', () => {
      if (document.fullscreenElement === stage) document.exitFullscreen?.().catch(() => {});
      else stage.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => setStatus(statusNode(), 'Vollbild ist in diesem Browser nicht verfügbar.', 'info'));
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
        el('p', { class: 'zh-hint', text: 'Für diesen Datensatz ist keine Vorschau hinterlegt.' }),
      ]);
    }
    return el('section', { class: 'app-viewer' }, [
      el('div', { class: 'app-viewer__stage app-viewer__stage--static', id: 'detail-preview' }, [
        el('img', { src: record.thumbnail, alt: `Kartenkachel: ${record.title}`, decoding: 'async' }),
      ]),
      el('p', { class: 'app-viewer__caption' }, [
        el('span', { text: 'WMTS-Kachelprobe (© swisstopo) – das Kartenwerk selbst liegt als Vergleichsebene über der Karte.' }),
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
   * JSON from an allowlisted upstream (IIIF manifest, image info).
   *
   * The site ships a strict `connect-src 'self'` CSP (public/_headers), so the
   * same-origin Worker proxy is the *primary* path — it is also edge-cached
   * (1 h). The direct call stays as a fallback for a deployment without the
   * Worker (e.g. plain static hosting) — e-rara sends `access-control-allow-origin: *`.
   */
  async function fetchJson(url) {
    try {
      const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}&accept=application/json`);
      if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
      return await res.json();
    } catch (proxyError) {
      try {
        const res = await fetch(url, { headers: { accept: 'application/json' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (directError) {
        throw new Error(`${proxyError.message} / ${directError.message}`);
      }
    }
  }

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
    if (pageLabel) pageLabel.textContent = `Blatt ${page + 1} von ${total}`;
    viewer?.setCanvas(canvas, { label: canvas.label, restore: ctx.store.getState().vv });
    updateReuseLinks(current);
    const nav = qs('#page-nav');
    if (nav) nav.hidden = total <= 1;
    const prev = qs('#page-prev');
    const next = qs('#page-next');
    if (prev) prev.disabled = page === 0;
    if (next) next.disabled = page === total - 1;
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

  /** Build one button per sheet (real thumbnail when the manifest offers one). */
  function renderSheetStrip() {
    const strip = qs('#page-strip');
    if (!strip) return;
    const canvases = manifest?.canvases ?? [];
    if (canvases.length <= 1) {
      strip.hidden = true;
      strip.replaceChildren();
      return;
    }
    strip.replaceChildren(
      ...canvases.map((canvas, index) =>
        el(
          'button',
          {
            class: 'app-viewer__sheet',
            type: 'button',
            'data-sheet': String(index),
            'aria-label': `Blatt ${index + 1} von ${canvases.length}: ${canvas.label}`,
            title: canvas.label,
            onclick: () => gotoPage(index),
          },
          [
            sheetThumbUrl(canvas)
              ? el('img', {
                  src: sheetThumbUrl(canvas),
                  alt: '',
                  loading: 'lazy',
                  decoding: 'async',
                  onerror: (event) => {
                    event.currentTarget.hidden = true;
                  },
                })
              : null,
            el('span', { class: 'app-viewer__sheetnum', text: String(index + 1) }),
          ],
        ),
      ),
    );
    strip.hidden = false;
    updateSheetStrip(canvases.length);
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
  }

  function showPreviewFallback(record, message, rawDetail = '') {
    const frame = qs('#detail-preview');
    if (!frame) return;
    const url = record?.thumbnail ?? null;
    frame.replaceChildren(
      el('div', { class: 'app-viewer__fallback' }, [
        el('p', { class: 'zh-hint', text: message, title: rawDetail || undefined }),
        url ? el('img', { src: url, alt: '', decoding: 'async', onerror: (event) => (event.currentTarget.hidden = true) }) : null,
        el('a', { class: 'zh-button zh-button--small', href: record?.recordUrl ?? '#', target: '_blank', rel: 'noopener', text: 'Beim Anbieter ansehen ↗' }),
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
      `Abgerufen am ${new Date().toISOString().slice(0, 10)}.`,
    ].join('');
  }

  function reuseSection(record) {
    const copyButton = el('button', {
      class: 'zh-button zh-button--ghost zh-button--small',
      type: 'button',
      text: 'Zitierweise kopieren',
      onclick: async (event) => {
        const ok = await copyText(citationText(record));
        event.currentTarget.textContent = ok ? 'Zitierweise kopiert ✓' : 'Kopieren nicht möglich';
        setTimeout(() => (event.currentTarget.textContent = 'Zitierweise kopieren'), 2500);
      },
    });
    return el('section', { id: 'reuse-section' }, [
      el('h3', { class: 'zh-heading zh-heading--4', text: 'Zitieren und weiterverwenden' }),
      el('p', { class: 'zh-hint', id: 'citation-text', text: citationText(record) }),
      el('div', { class: 'app-detail__actions' }, [
        copyButton,
        record.iiifManifest
          ? el('a', {
              class: 'zh-button zh-button--ghost zh-button--small',
              href: record.iiifManifest,
              target: '_blank',
              rel: 'noopener',
              text: 'IIIF-Manifest (JSON) ↗',
            })
          : null,
      ]),
      // The harvested record already names the image service, so the full-size
      // link is there on first paint; only the METS/OAI link needs the manifest.
      el('div', { class: 'app-detail__actions', id: 'reuse-links' }, [
        record.imageService
          ? fullImageLink(record.imageService)
          : el('span', { class: 'zh-hint', text: record.iiifManifest ? 'Weitere Links werden geladen …' : 'Kein IIIF-Bilddienst hinterlegt – nutzen Sie den Originaldatensatz.' }),
      ]),
      el('p', { class: 'zh-hint', text: 'Bitte prüfen Sie Rechte und Zitierweise beim Anbieter; die Angaben hier stammen aus dessen Metadaten.' }),
    ]);
  }

  /** The full-resolution IIIF image link, named the same way everywhere. */
  function fullImageLink(service) {
    return el('a', {
      class: 'zh-button zh-button--ghost zh-button--small',
      href: `${service}/full/max/0/default.jpg`,
      target: '_blank',
      rel: 'noopener',
      text: 'Bild in Originalgrösse öffnen (IIIF) ↗',
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
        service
          ? fullImageLink(service)
          : el('span', { class: 'zh-hint', text: 'Für dieses Blatt liefert der Anbieter keinen IIIF-Bilddienst.' }),
        manifest?.seeAlso
          ? el('a', {
              class: 'zh-button zh-button--ghost zh-button--small',
              href: manifest.seeAlso,
              target: '_blank',
              rel: 'noopener',
              text: 'METS/MODS über OAI-PMH ↗',
            })
          : null,
        record?.recordUrl
          ? el('a', { class: 'zh-button zh-button--ghost zh-button--small', href: record.recordUrl, target: '_blank', rel: 'noopener', text: 'DOI/Datensatz ↗' })
          : null,
      ].filter(Boolean),
    );
  }

  /* --------------------------------------------------------------- facts */

  function factsSection(record) {
    const facts = [
      ['Publikationsjahr', formatYearRange(record.yearStart, record.yearEnd)],
      [
        'Dargestellter Zeitraum',
        record.depictedYearStart || record.depictedYearEnd
          ? formatYearRange(record.depictedYearStart ?? record.depictedYearEnd, record.depictedYearEnd ?? record.depictedYearStart)
          : 'vom Anbieter nicht angegeben',
      ],
      ['Urheber', record.creators?.length ? record.creators.join(', ') : 'nicht angegeben'],
      ['Besitzende Institution', record.institution],
      ['Signatur', record.shelfmark || 'nicht angegeben'],
      ['Verlag / Impressum', [record.publisher, record.imprint].filter(Boolean).join(' – ') || 'nicht angegeben'],
      ['Sprache', record.languages?.length ? record.languages.join(', ') : 'nicht angegeben'],
      ['Rechtehinweis', record.rights],
      [
        'Kartenausschnitt',
        record.extent
          ? `W ${record.extent.west.toFixed(2)}° / E ${record.extent.east.toFixed(2)}° / S ${record.extent.south.toFixed(2)}° / N ${record.extent.north.toFixed(2)}°`
          : 'nicht angegeben',
      ],
      ['Umfang', record.canvasCount ? `${record.canvasCount} digitalisierte Seiten` : 'nicht angegeben'],
      ['Datenquelle', `${record.providerId} · ${record.id}`],
    ];
    return el('section', {}, [
      el('h3', { class: 'zh-heading zh-heading--4', text: 'Angaben zum Objekt' }),
      el('dl', { class: 'app-detail__facts' }, facts.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })])),
      record.geoNote ? el('p', { class: 'zh-hint', text: `Hinweis zur Verortung: ${record.geoNote}` }) : null,
      el('p', { class: 'zh-hint' }, [
        el('span', { text: 'Bildrechte und Zitierweise stehen beim Datensatz des Anbieters. ' }),
        el('a', { href: record.recordUrl, target: '_blank', rel: 'noopener', text: 'Rechtehinweis prüfen ↗' }),
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
      el('h3', { class: 'zh-heading zh-heading--4', text: `Weitere Karten dieser Sammlung (${siblings.length})` }),
      el('p', { class: 'zh-hint', text: `Aus «${series}». Jahr und Urheber stehen so, wie der Anbieter sie nennt.` }),
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
        ? el('p', { class: 'zh-hint', text: `… und ${siblings.length - shown.length} weitere in dieser Sammlung.` })
        : null,
      el('button', {
        class: 'zh-button zh-button--ghost zh-button--small',
        type: 'button',
        text: 'Sammlung in der Ergebnisliste filtern',
        onclick: () => {
          ctx.store.update({ collection: series, selected: '' });
          close();
          const live = qs('#results-live');
          if (live) live.textContent = `Ergebnisliste auf die Sammlung «${series}» eingeschränkt.`;
        },
      }),
    ]);
  }

  /* -------------------------------------------------------------- events */

  ctx.bus.on('record:selected', ({ record }) => open(record));
  // The comparison list is shareable state; keep the panel's pin label in sync
  // when the sidebar (or a shared ?cmp= link) changes it.
  ctx.store.subscribe((state, changed) => {
    if (changed.includes('cmp')) updatePinButton(qs('#detail-pin'), current);
    // A hand-edited or reloaded `vv` (or a cleared one) drives the open viewer;
    // the viewer ignores a value that matches what is already on screen, so the
    // debounced write-back from the viewer cannot loop back into it.
    if (changed.includes('vv')) viewer?.restoreView?.(state.vv);
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
 */
function createViewer(stage, { record, live, loadJson, meta, onZoom, onError, onViewChange } = {}) {
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
    const box = `Ausschnitt ${Math.round(view.w)}×${Math.round(view.h)} von ${bounds.w}×${bounds.h} Bildpunkten`;
    // "Gesamtansicht" and not "Ganzes Blatt": the button next to the read-out is
    // called "Ganzes Blatt", and two identical labels next to each other read
    // like a duplicate control.
    onZoom?.(whole ? `Gesamtansicht · Auflösung ${percent} %` : `Auflösung ${percent} % · ${box}`);
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
      img.alt = canvas?.label ? `Kartenvorschau: ${record?.title ?? ''} (${canvas.label})` : `Kartenvorschau: ${record?.title ?? ''}`;
      layout();
      stage.dataset.state = 'ready';
      const info = meta?.();
      if (info) {
        const bits = [];
        if (canvas?.label) bits.push(`Blatt ${canvas.label}`);
        bits.push(`${preload.naturalWidth}×${preload.naturalHeight} px geladen`);
        if (bounds) bits.push(`Original ${bounds.w}×${bounds.h} px`);
        bits.push(regionsUnsupported ? 'IIIF Image API (nur Gesamtbild)' : 'IIIF Image API (regionByPx, sizeByW)');
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
      onError?.('Die Bildvorschau konnte nicht geladen werden (Netzwerk, Rechte oder Dienst nicht erreichbar).');
      const info = meta?.();
      if (info) info.textContent = 'Vorschau nicht verfügbar – Metadaten und Originaldatensatz bleiben nutzbar.';
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
    announce(`Auflösung ${zoomPercent(view, stageSize().width)} Prozent`);
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
      notifyView();
      return;
    }
    applyTransform();
    updateReadout();
    announce('Ganzes Blatt');
    scheduleFetch();
    notifyView();
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
      meta.textContent = `Ausschnitt ${Math.round(view.w)}×${Math.round(view.h)} von ${bounds.w}×${bounds.h} Bildpunkten`;
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
          .catch(() => onError?.('Die Bildmasse konnten nicht ermittelt werden (info.json nicht erreichbar).'));
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
