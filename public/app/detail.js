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
  eRaraViewerUrl,
  fullImageUrl,
  imageRequestUrl,
  panView,
  parseManifest,
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
  function open(record) {
    if (!record) return;
    current = record;
    manifest = null;
    page = 0;
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
      el('div', { class: 'app-detail__actions' }, [
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
      viewer_,
      factsSection(record),
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
    const from = record.depictedYearStart ?? record.yearStart;
    const to = record.depictedYearEnd ?? record.yearEnd ?? record.yearStart;
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
      controls,
      el('p', { class: 'app-viewer__caption' }, [
        el('span', { id: 'preview-meta', text: 'IIIF-Vorschau wird geladen …' }),
      ]),
      el('p', { class: 'app-viewer__hint', text: 'Zoomen: + / −, Doppelklick oder Ctrl/⌘ + Mausrad · Verschieben: ziehen oder Pfeiltasten (mit Shift grössere Schritte) · Home zeigt das ganze Blatt.' }),
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
      onError: (message) => setStatus(statusNode(), message, 'error'),
    });
    const instance = viewerEl.__viewer;
    viewerEl.querySelector('#viewer-zoom-in')?.addEventListener('click', () => instance.zoomIn());
    viewerEl.querySelector('#viewer-zoom-out')?.addEventListener('click', () => instance.zoomOut());
    viewerEl.querySelector('#viewer-reset')?.addEventListener('click', () => instance.reset());
    viewerEl.querySelector('#page-prev')?.addEventListener('click', () => gotoPage(page - 1));
    viewerEl.querySelector('#page-next')?.addEventListener('click', () => gotoPage(page + 1));
    return viewerEl;
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
      page = 0;
      showCanvas();
    } catch (err) {
      showPreviewFallback(record, `Vorschau konnte nicht geladen werden (${err?.message || err}).`);
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
    const canvas = manifest?.canvases?.[page];
    if (!canvas) return;
    const pageLabel = qs('#page-label');
    const total = manifest.canvases.length;
    if (pageLabel) pageLabel.textContent = `Blatt ${page + 1} von ${total}`;
    viewer?.setCanvas(canvas, { label: canvas.label });
    const nav = qs('#page-nav');
    if (nav) nav.hidden = total <= 1;
    const prev = qs('#page-prev');
    const next = qs('#page-next');
    if (prev) prev.disabled = page === 0;
    if (next) next.disabled = page === total - 1;
  }

  function gotoPage(next) {
    const total = manifest?.canvases?.length ?? 0;
    if (total === 0) return;
    page = Math.max(0, Math.min(total - 1, next));
    showCanvas();
  }

  function showPreviewFallback(record, message) {
    const frame = qs('#detail-preview');
    if (!frame) return;
    const url = record?.thumbnail ?? null;
    frame.replaceChildren(
      el('div', { class: 'app-viewer__fallback' }, [
        el('p', { class: 'zh-hint', text: message }),
        url ? el('img', { src: url, alt: '', decoding: 'async' }) : null,
        el('a', { class: 'zh-button zh-button--small', href: record?.recordUrl ?? '#', target: '_blank', rel: 'noopener', text: 'Beim Anbieter ansehen ↗' }),
      ]),
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

  /* -------------------------------------------------------------- events */

  ctx.bus.on('record:selected', ({ record }) => open(record));
  ctx.bus.on('records:loaded', () => {
    const id = ctx.store.getState().selected;
    const record = ctx.data.recordIndex.get(id);
    if (id && record && panel.hidden) open(record);
  });

  scrim?.addEventListener('click', close);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
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
    if (record) open(record);
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
function createViewer(stage, { record, live, loadJson, meta, onZoom, onError } = {}) {
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
  let destroyed = false;
  let loadToken = 0;
  let regionFailed = false;
  let announceTimer = null;

  const pointers = new Map();
  let drag = null;
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
    if (!regionFailed) {
      const url = imageRequestUrl(service, currentView, outputWidthFor(currentView), { bounds });
      if (url) return url;
    }
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
    onZoom?.(whole ? `Ganzes Blatt · Auflösung ${percent} %` : `Auflösung ${percent} % · ${box}`);
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
    const token = ++loadToken;
    stage.dataset.state = 'loading';
    const preload = new Image();
    preload.decoding = 'async';
    preload.addEventListener('load', () => {
      if (destroyed || token !== loadToken) return;
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
        bits.push('IIIF Image API (regionByPx, sizeByW)');
        info.textContent = bits.join(' · ');
      }
      updateReadout();
    });
    preload.addEventListener('error', () => {
      if (destroyed || token !== loadToken) return;
      if (!regionFailed) {
        // Services without regionByPx (or with tighter rights) still serve `full`.
        regionFailed = true;
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
    if (!view || regionFailed) return;
    const { width, height } = stageSize();
    // Zooming reshapes the region to the stage aspect ratio so the map fills the
    // viewport instead of sitting in letterbox bars (contain → cover).
    view = zoomView(view, factor, anchor ?? { x: 0.5, y: 0.5 }, bounds, { aspect: width / height });
    applyTransform();
    updateReadout();
    announce(`Auflösung ${zoomPercent(view, stageSize().width)} Prozent`);
    scheduleFetch();
  }

  function reset() {
    if (!bounds) return;
    view = viewForCanvas(bounds.w, bounds.h);
    if (regionFailed) {
      // Only the full-sheet derivative is available: show it and stay honest.
      rendered = null;
      load();
      return;
    }
    applyTransform();
    updateReadout();
    announce('Ganzes Blatt');
    scheduleFetch();
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

  const onPointerDown = (event) => {
    if (!view) return;
    stage.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) drag = { x: event.clientX, y: event.clientY, moved: false };
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), center: screenPoint((a.x + b.x) / 2, (a.y + b.y) / 2) };
      drag = null;
    }
    stage.dataset.dragging = 'true';
  };

  const onPointerMove = (event) => {
    if (!pointers.has(event.pointerId) || !view) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (regionFailed) return;

    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.distance > 8 && distance > 8) {
        zoom(distance / pinch.distance, pinch.center);
      }
      pinch = { ...pinch, distance, center: pinch.center };
      return;
    }
    if (pinch) return; // finishing a pinch: ignore the remaining single pointer

    if (!drag) {
      drag = { x: event.clientX, y: event.clientY, moved: false };
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    drag = { x: event.clientX, y: event.clientY, moved: true };
    stage.dataset.dragging = 'true';
    const imagePxPerCssPx = rendered ? rendered.view.w / rendered.width : 1;
    view = panView(view, (-dx * imagePxPerCssPx) / view.w, (-dy * imagePxPerCssPx) / view.h, bounds);
    applyTransform();
    scheduleFetch();
    if (meta && rendered && !regionFailed) {
      meta.textContent = `Ausschnitt ${Math.round(view.w)}×${Math.round(view.h)} von ${bounds.w}×${bounds.h} Bildpunkten`;
    }
  };

  function endPointer(event) {
    pointers.delete(event.pointerId);
    if (pointers.size === 0) {
      drag = null;
      pinch = null;
      delete stage.dataset.dragging;
      updateReadout();
      scheduleFetch();
    } else if (pointers.size === 1) {
      pinch = null;
      const [only] = [...pointers.values()];
      drag = { x: only.x, y: only.y, moved: true };
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
    /** Show a canvas of the current manifest (possibly at full resolution). */
    setCanvas(next, { label } = {}) {
      if (!next?.service) return;
      canvas = { ...next, label: label ?? next.label };
      service = next.service;
      const width = next.width ?? 0;
      const height = next.height ?? 0;
      if (!width || !height) {
        // Presentation 3 manifests may omit the size; the image service states it.
        loadJson(`${service}/info.json`)
          .then((info) => this.setCanvas({ ...canvas, width: info.width, height: info.height }))
          .catch(() => onError?.('Die Bildmasse konnten nicht ermittelt werden (info.json nicht erreichbar).'));
        return;
      }
      bounds = boundsForCanvas(width, height);
      view = viewForCanvas(width, height);
      regionFailed = false;
      rendered = null;
      load();
    },
    zoomIn: () => zoom(1.6),
    zoomOut: () => zoom(1 / 1.6),
    reset,
    destroy() {
      destroyed = true;
      clearTimeout(fetchTimer);
      clearTimeout(announceTimer);
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
