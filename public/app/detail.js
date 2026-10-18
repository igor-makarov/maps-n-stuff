/**
 * Detail panel: metadata, honest date statements, IIIF preview with page
 * navigation, rights/credit and a prominent link to the holding institution.
 */

import { copyText, el, formatYearRange, qs, setStatus, trapFocus } from './dom.js';
import { recordCenter } from './records.js';

const PAGE_SIZE_DEFAULT = 1000;

export function init(ctx) {
  const panel = qs('#detail');
  const body = qs('#detail-body');
  const scrim = qs('#scrim');
  if (!panel || !body) return;

  let opener = null;
  let current = null;
  let manifest = null;
  let page = 0;
  let size = PAGE_SIZE_DEFAULT;

  function open(record, source = 'list') {
    if (!record) return;
    current = record;
    manifest = null;
    page = 0;
    size = PAGE_SIZE_DEFAULT;
    if (!panel.hidden && opener) return render(record); // already open – just swap content
    opener = document.activeElement;
    render(record);
    panel.hidden = false;
    if (scrim) scrim.hidden = false;
    panel.setAttribute('aria-modal', 'true');
    document.body.classList.add('has-detail');
    const heading = body.querySelector('[data-detail-heading]');
    heading?.focus();
    if (source === 'map' || source === 'list') loadManifest(record);
  }

  function close() {
    if (panel.hidden) return;
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

  function render(record) {
    const center = recordCenter(record);
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
      previewSection(record),
      factsSection(record),
      el('p', { class: 'visuallyhidden', role: 'status', 'aria-live': 'polite', id: 'detail-status' }),
      el('p', { class: 'zh-hint' }, [
        el('span', { text: 'Angaben stammen aus dem Datenlieferanten. ' }),
        record.iiifManifest
          ? el('a', { href: record.iiifManifest, target: '_blank', rel: 'noopener', text: 'IIIF-Manifest (JSON) öffnen ↗' })
          : el('span', { text: 'Kein IIIF-Manifest hinterlegt.' }),
      ]),
    );
  }

  const statusNode = () => qs('#detail-status');

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

  /* ---------------- IIIF preview ---------------- */

  function previewSection(record) {
    const frame = record.iiifManifest
      ? el('div', { class: 'app-detail__preview', id: 'detail-preview' }, [
          el('span', { class: 'zh-spinner', role: 'presentation' }),
          el('span', { class: 'visuallyhidden', text: 'Vorschau wird geladen' }),
        ])
      : el('div', { class: 'app-detail__preview', id: 'detail-preview' }, staticPreview(record));
    const nav = el('div', { class: 'app-detail__preview-nav' }, [
      el('div', { class: 'app-detail__actions' }, [
        el('button', { class: 'zh-button zh-button--small', type: 'button', id: 'page-prev', text: '‹ vorherige', onclick: () => gotoPage(page - 1) }),
        el('span', { class: 'zh-hint', id: 'page-label', text: record.canvasCount ? `Blatt 1 von ${record.canvasCount}` : 'Blatt 1' }),
        el('button', { class: 'zh-button zh-button--small', type: 'button', id: 'page-next', text: 'nächste ›', onclick: () => gotoPage(page + 1) }),
      ]),
      record.iiifManifest
        ? el('label', { class: 'zh-hint', for: 'preview-size' }, [
            el('span', { text: 'Bildbreite ' }),
            el('input', {
              class: 'zh-input',
              id: 'preview-size',
              type: 'range',
              min: '400',
              max: '2400',
              step: '200',
              value: String(size),
              style: 'width: 140px; display:inline-block',
            }),
          ])
        : el('span', { class: 'zh-hint', text: 'Kachelansicht des georeferenzierten Kartenwerks' }),
    ]);
    return el('section', { class: 'app-detail__preview-wrap' }, [el('h3', { class: 'visuallyhidden', text: 'Kartenvorschau' }), frame, nav]);
  }

  /** WMTS records have no IIIF manifest – show a real tile and name what it is. */
  function staticPreview(record) {
    if (!record.thumbnail) return [el('p', { class: 'zh-hint', text: 'Für diesen Datensatz ist keine Vorschau hinterlegt.' })];
    return [
      el('img', { src: record.thumbnail, alt: `Kartenkachel: ${record.title}`, decoding: 'async' }),
      el('p', { class: 'zh-hint', text: 'WMTS-Kachelprobe (© swisstopo) – das Kartenwerk selbst liegt als Vergleichsebene über der Karte.' }),
    ];
  }

  async function loadManifest(record) {
    if (!record.iiifManifest) return;
    try {
      manifest = await fetchManifest(record.iiifManifest);
      const canvases = manifest?.sequences?.[0]?.canvases ?? [];
      if (canvases.length > 0) {
        gotoPage(0);
      } else {
        showPreviewFallback(record, 'Das IIIF-Manifest enthält keine Bildseiten.');
      }
    } catch (err) {
      showPreviewFallback(record, `Vorschau konnte nicht geladen werden (${err?.message || err}).`);
    }
  }

  /** IIIF Presentation 2.0 manifest; direct first, Worker proxy as fallback. */
  async function fetchManifest(url) {
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      const res = await fetch(`/api/fetch?url=${encodeURIComponent(url)}&accept=application/json`);
      if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
      return await res.json();
    }
  }

  function canvasImage(canvas, width = size) {
    const images = canvas?.images ?? [];
    const resource = images[0]?.resource;
    if (!resource) return null;
    const service = Array.isArray(resource.service) ? resource.service[0]?.['@id'] : resource.service?.['@id'];
    if (service) return `${service}/full/${width},/0/default.jpg`;
    return resource['@id'] ?? null;
  }

  function gotoPage(next) {
    const canvases = manifest?.sequences?.[0]?.canvases ?? [];
    if (canvases.length === 0) return;
    page = Math.max(0, Math.min(canvases.length - 1, next));
    const canvas = canvases[page];
    const src = canvasImage(canvas, size);
    const frame = qs('#detail-preview');
    const label = canvas?.label ?? `Blatt ${page + 1}`;
    const pageLabel = qs('#page-label');
    if (pageLabel) pageLabel.textContent = `${label} · ${page + 1}/${canvases.length}`;
    const prev = qs('#page-prev');
    const next2 = qs('#page-next');
    if (prev) prev.disabled = page === 0;
    if (next2) next2.disabled = page === canvases.length - 1;
    if (!frame) return;
    if (!src) {
      showPreviewFallback(current, 'Für dieses Blatt liefert der IIIF-Dienst keine Bild-URL.');
      return;
    }
    const img = el('img', { src, alt: `Kartenvorschau: ${current?.title ?? ''} (${label})`, decoding: 'async' });
    img.addEventListener('load', () => {
      const info = qs('#preview-meta');
      if (info) info.textContent = `Bild ${img.naturalWidth}×${img.naturalHeight} px · IIIF Image API 2, e-rara`;
    });
    img.addEventListener('error', () => showPreviewFallback(current, 'Das Bild konnte nicht geladen werden (Netzwerk oder Rechte).'));
    frame.replaceChildren(img, el('p', { class: 'zh-hint', id: 'preview-meta', text: 'Bild wird geladen …' }));
  }

  function showPreviewFallback(record, message) {
    const frame = qs('#detail-preview');
    if (!frame) return;
    frame.replaceChildren(
      el('div', {}, [
        el('p', { class: 'zh-hint', text: message }),
        record?.thumbnail ? el('img', { src: record.thumbnail, alt: '', style: 'max-height:32vh' }) : null,
        el('a', { class: 'zh-button zh-button--small', href: record?.recordUrl ?? '#', target: '_blank', rel: 'noopener', text: 'Beim Anbieter ansehen ↗' }),
      ]),
    );
  }

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
    ]);
  }

  /* ---------------- events ---------------- */

  ctx.bus.on('record:selected', ({ record, source }) => open(record, source));
  ctx.bus.on('records:loaded', () => {
    const id = ctx.store.getState().selected;
    const record = ctx.data.recordIndex.get(id);
    if (id && record && panel.hidden) render(record);
  });

  // Re-render the preview at a new IIIF width.
  body.addEventListener('input', (event) => {
    if (event.target.id !== 'preview-size') return;
    size = Number(event.target.value) || PAGE_SIZE_DEFAULT;
    if (manifest) gotoPage(page);
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

  // Deep link: open the record referenced in the URL once data is there.
  const initial = ctx.store.getState().selected;
  if (initial) {
    const record = ctx.data.recordIndex.get(initial);
    if (record) render(record);
  }

  return { open, close, gotoPage };
}
