/**
 * IIIF helpers for Kartenzeit.
 *
 * Everything here is pure (no DOM, no network) so it can be unit-tested with
 * `node --test` and reused by the detail viewer. Two flavours of IIIF are
 * supported because the collections we harvest are not uniform:
 *
 *   - Presentation **2.0** (`sequences[].canvases[].images[].resource`) – e-rara
 *   - Presentation **3.0** (`items[].items[].body`) – other Swiss institutions
 *
 * Image requests use the IIIF Image API 2/3 syntax. For e-rara the service
 * advertises `regionByPx`, `sizeByW` and `sizeAboveFull` (checked in
 * `info.json`, see docs/data-sources.md), so a real deep-zoom viewer can request
 * exactly the visible rectangle instead of the whole sheet.
 *
 * Metadata that an upstream does not state is *not* guessed here: unknown fields
 * stay `null` and the UI says so.
 */

/** Widest derivative we will ask an image service for (protects the provider). */
export const MAX_OUTPUT_WIDTH = 2000;

/** Smallest region, as a fraction of the full sheet, that we zoom into (≈5×). */
export const MIN_REGION_FRACTION = 0.04;

/* ------------------------------------------------------------------ labels */

/**
 * IIIF labels are a string (v2) or a language map (v3, e.g. `{ de: ['Blatt 1'] }`).
 * Returns a plain string or `null`; never invents a label.
 */
export function labelText(label, preferred = ['de', 'en', 'none']) {
  if (label == null) return null;
  if (typeof label === 'string') return label.trim() || null;
  if (Array.isArray(label)) {
    const joined = label.map((entry) => labelText(entry, preferred)).filter(Boolean).join(' – ');
    return joined || null;
  }
  if (typeof label === 'object') {
    for (const lang of preferred) {
      const value = label[lang];
      if (value) {
        const text = labelText(value, preferred);
        if (text) return text;
      }
    }
    const [first] = Object.values(label);
    return labelText(first, preferred);
  }
  return null;
}

/** `service` is an object, an array of objects, or an id string depending on flavour. */
export function serviceId(service) {
  if (!service) return null;
  if (typeof service === 'string') return service.replace(/\/+$/, '');
  if (Array.isArray(service)) {
    for (const entry of service) {
      const id = serviceId(entry);
      if (id) return id;
    }
    return null;
  }
  const id = service['@id'] ?? service.id ?? null;
  return id ? String(id).replace(/\/+$/, '') : null;
}

/* ---------------------------------------------------------------- manifests */

/** One canvas → one flat object the viewer can use. Unknown values stay null. */
export function normaliseCanvas(canvas, index = 0) {
  if (!canvas) return null;
  // Presentation 2: canvas.images[0] is the annotation. Presentation 3:
  // canvas.items[0] is an AnnotationPage whose items[0] is the annotation.
  const page = canvas.images?.[0] ?? canvas.items?.[0] ?? null;
  const annotation = page?.items?.[0] ?? page;
  const resource = annotation?.resource ?? annotation?.body ?? null;
  const service = serviceId(resource?.service ?? annotation?.service);

  return {
    id: canvas['@id'] ?? canvas.id ?? null,
    index,
    label: labelText(canvas.label) ?? `Blatt ${index + 1}`,
    // Canvas size is the full-resolution image; the painting resource may be a
    // smaller derivative (`webcache/1000`), which is a *provider* choice.
    width: numberOrNull(canvas.width ?? resource?.width),
    height: numberOrNull(canvas.height ?? resource?.height),
    service,
    imageUrl: typeof resource?.['@id'] === 'string' ? resource['@id'] : typeof resource?.id === 'string' ? resource.id : null,
    thumbnail: thumbnailId(canvas),
  };
}

function thumbnailId(canvas) {
  const thumb = canvas?.thumbnail;
  if (!thumb) return null;
  if (typeof thumb === 'string') return thumb;
  if (Array.isArray(thumb)) return thumbnailId({ thumbnail: thumb[0] });
  return thumb['@id'] ?? thumb.id ?? null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Accepts a Presentation 2.0 or 3.0 manifest and returns the parts the UI needs.
 * Throws for input that is not a manifest, so callers can show an honest error.
 */
export function parseManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Kein IIIF-Manifest (JSON erwartet).');
  const raw = Array.isArray(manifest.sequences?.[0]?.canvases)
    ? manifest.sequences[0].canvases
    : Array.isArray(manifest.items)
      ? manifest.items
      : null;
  if (!raw) throw new Error('IIIF-Manifest ohne Bildseiten (weder items noch sequences).');

  const canvases = raw.map((canvas, index) => normaliseCanvas(canvas, index)).filter(Boolean);
  if (canvases.length === 0) throw new Error('IIIF-Manifest ohne verwendbare Bildseiten.');

  return {
    id: manifest['@id'] ?? manifest.id ?? null,
    version: Array.isArray(manifest.sequences) ? 2 : 3,
    label: labelText(manifest.label),
    attribution: labelText(manifest.attribution) ?? null,
    license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.['@id'] ?? null,
    // The METS/OAI record behind the manifest is the most authoritative metadata.
    seeAlso: seeAlsoUrl(manifest),
    metadata: parseMetadata(manifest.metadata),
    canvases,
  };
}

function seeAlsoUrl(manifest) {
  const entry = Array.isArray(manifest.seeAlso) ? manifest.seeAlso[0] : manifest.seeAlso;
  if (!entry) return null;
  return entry['@id'] ?? entry.id ?? (typeof entry === 'string' ? entry : null);
}

/** Presentation 2/3 `metadata` → `[{ label, value }]` of plain strings. */
export function parseMetadata(metadata) {
  if (!Array.isArray(metadata)) return [];
  return metadata
    .map((entry) => ({ label: labelText(entry?.label), value: labelText(entry?.value) }))
    .filter((entry) => entry.label && entry.value);
}

/* -------------------------------------------------------------- image URLs */

/**
 * IIIF Image API request for a pixel region: `{region}/{size}/0/default.jpg`.
 * `outputWidth` is a `sizeByW` value and is clamped to MAX_OUTPUT_WIDTH.
 */
export function imageRequestUrl(service, view, outputWidth, { quality = 'default', format = 'jpg', bounds = null } = {}) {
  if (!service) return null;
  const r = regionRequest(view, bounds);
  if (!r) return null;
  const width = Math.max(16, Math.min(Math.round(outputWidth || MAX_OUTPUT_WIDTH), MAX_OUTPUT_WIDTH));
  return `${String(service).replace(/\/+$/, '')}/${r}/${width},/0/${quality}.${format}`;
}

/**
 * IIIF region parameter for a view rect. When the view covers the whole sheet we
 * ask for `full`, because some services only implement that form.
 */
export function regionRequest(view, bounds = null) {
  if (!view) return null;
  const { x, y, w, h } = view;
  if (![x, y, w, h].every((v) => Number.isFinite(v)) || w <= 0 || h <= 0) return null;
  const covers = bounds && x <= bounds.x + 0.5 && y <= bounds.y + 0.5 && w >= bounds.w - 1 && h >= bounds.h - 1;
  if (covers) return 'full';
  return `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`;
}

/** Full-sheet derivative at a given width (used for previews/fallbacks). */
export function fullImageUrl(service, width = 1000) {
  if (!service) return null;
  const w = Math.max(16, Math.min(Math.round(width || 1000), MAX_OUTPUT_WIDTH));
  return `${String(service).replace(/\/+$/, '')}/full/${w},/0/default.jpg`;
}

/**
 * Small preview of one sheet for the sheet strip.
 *
 * The manifest's own `thumbnail` wins; without one the URL is derived from the
 * canvas image service with a documented Image API request (`full/<w>,/0/default.jpg`,
 * the level-2 `sizeByW` feature e-rara advertises). If the canvas has neither,
 * `null` is returned and the UI falls back to the sheet number alone — nothing
 * is invented.
 */
export function sheetThumbUrl(canvas, width = 96) {
  if (!canvas) return null;
  if (canvas.thumbnail) return String(canvas.thumbnail);
  if (!canvas.service) return null;
  const w = Math.max(32, Math.min(Math.round(width || 96), 400));
  return `${String(canvas.service).replace(/\/+$/, '')}/full/${w},/0/default.jpg`;
}

/* ------------------------------------------------------------------ view box */

/**
 * The whole sheet as a view. The viewer keeps this aspect ratio while zooming
 * and panning (a `contain` model: the requested region is exactly the visible
 * part of the sheet, so nothing outside the image is ever requested).
 */
export function viewForCanvas(width, height) {
  return { x: 0, y: 0, w: width, h: height };
}

/** Bounds of a sheet, the space every view is clamped to. */
export function boundsForCanvas(width, height) {
  return { x: 0, y: 0, w: width, h: height };
}

/**
 * Keep a view inside the sheet. Regions larger than an axis are centred on that
 * axis (letterbox) — that is the only way to keep the stage aspect ratio.
 */
export function clampView(view, bounds) {
  const w = Math.min(Math.max(view.w, bounds.w * MIN_REGION_FRACTION), bounds.w);
  const h = Math.min(Math.max(view.h, bounds.h * MIN_REGION_FRACTION), bounds.h);
  const x = w >= bounds.w ? bounds.x : Math.min(Math.max(view.x, bounds.x), bounds.x + bounds.w - w);
  const y = h >= bounds.h ? bounds.y : Math.min(Math.max(view.y, bounds.y), bounds.y + bounds.h - h);
  return { x, y, w, h };
}

/**
 * Zoom by `factor` (>1 zooms in) around an anchor given in fractions of the view.
 * Used by buttons, keyboard and wheel; the anchor keeps the point under the
 * cursor fixed, which is what makes a zoom feel right.
 *
 * `options.aspect` (width ÷ height) reshapes the region to the stage aspect
 * ratio, so a zoomed-in region covers the whole viewport instead of leaving
 * letterbox bars. The region never leaves the sheet: it is reduced again until
 * it fits, which only happens at the sheet edges.
 */
export function zoomView(view, factor, anchor = { x: 0.5, y: 0.5 }, bounds, { aspect = null } = {}) {
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const minW = bounds.w * MIN_REGION_FRACTION;
  const boxW = Math.min(Math.max(view.w / f, minW), bounds.w);
  const boxH = view.h / f;
  let w = boxW;
  let h = boxH;
  if (Number.isFinite(aspect) && aspect > 0) {
    // The largest region with the stage aspect that still fits the zoomed box:
    // the limiting axis keeps the requested zoom, the other one follows.
    if (boxW / boxH > aspect) {
      h = boxH;
      w = h * aspect;
    } else {
      w = boxW;
      h = w / aspect;
    }
  }
  const sx = w / view.w;
  const sy = h / view.h;
  const ax = view.x + view.w * anchor.x;
  const ay = view.y + view.h * anchor.y;
  return clampView(
    {
      x: ax - (ax - view.x) * sx,
      y: ay - (ay - view.y) * sy,
      w,
      h,
    },
    bounds,
  );
}

/** Pan by a fraction of the current view; sign follows screen direction. */
export function panView(view, dxFraction, dyFraction, bounds) {
  return clampView({ x: view.x + view.w * dxFraction, y: view.y + view.h * dyFraction, w: view.w, h: view.h }, bounds);
}

/** Zoom level as a percentage of native resolution (100 % = one image px per CSS px). */
export function zoomPercent(view, stageWidth) {
  if (!stageWidth || !view?.w) return 0;
  return Math.round((stageWidth / view.w) * 100);
}

/* ----------------------------------------------------------------- metadata */

/**
 * The holding library's own viewer for an e-rara record.
 *
 * Order of evidence: a harvested `viewerUrl`, then the corpus of a canonical
 * record URL, then the title id from the IIIF manifest / record id. e-rara's
 * router resolves *any* corpus prefix to the holding library's corpus
 * (verified 2026-10-18 with curl: `/zut/content/zoom/22142031` → 301 →
 * `/zuz/content/zoom/22142031` for a Zentralbibliothek sheet, and
 * `/zuz/content/zoom/6507640` → 301 → `/zut/…` for an ETH-Bibliothek sheet), so
 * `zut` is used as the entry point. Returns `null` when the record carries no
 * e-rara title id at all.
 */
export function eRaraViewerUrl(record) {
  const explicit = record?.viewerUrl;
  if (typeof explicit === 'string' && /^https:\/\/www\.e-rara\.ch\/[a-z]+\/content\/zoom\/\d+/.test(explicit)) return explicit;
  const url = record?.recordUrl;
  const match = typeof url === 'string' ? url.match(/^https:\/\/www\.e-rara\.ch\/([a-z]+)\/content\/(?:titleinfo|zoom|pageview)\/(\d+)/) : null;
  if (match) return `https://www.e-rara.ch/${match[1]}/content/zoom/${match[2]}`;
  const titleId = eRaraTitleId(record?.iiifManifest) ?? (typeof record?.id === 'string' ? record.id.match(/^e-rara:(\d+)$/)?.[1] ?? null : null);
  return titleId ? `https://www.e-rara.ch/zut/content/zoom/${titleId}` : null;
}

/** Title id of an e-rara manifest URL (`…/i3f/v20/6507640/manifest`). */
export function eRaraTitleId(url) {
  const match = typeof url === 'string' ? url.match(/\/i3f\/v\d+\/(\d+)\/manifest/) : null;
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------- errors */

/**
 * One sentence a visitor can act on, for a failed upstream request.
 *
 * Browser errors are English developer strings (`Failed to fetch`,
 * `NetworkError when attempting to fetch resource`) and the proxy adds
 * `HTTP 502` on top; neither belongs in the visible German UI. Our own messages
 * (from `parseManifest`) are already written for visitors and are passed through
 * unchanged, so an unusable manifest still says exactly what is wrong with it.
 *
 * The raw string stays available for logs — callers must not render it.
 */
export function describeUpstreamError(err) {
  const raw = String(err?.message ?? err ?? '').trim();
  if (!raw) return 'Die Vorschau ist nicht erreichbar (unbekannter Fehler).';
  const status = raw.match(/\bHTTP (\d{3})\b/);
  if (/failed to fetch|networkerror|network error|load failed|err_/i.test(raw)) {
    return 'Die Vorschau ist nicht erreichbar: Die Verbindung zum Bilddienst ist fehlgeschlagen.';
  }
  if (status) {
    return `Die Vorschau ist nicht erreichbar: Der Bilddienst antwortet mit HTTP ${status[1]}.`;
  }
  // A message we wrote ourselves (manifest parsing): keep it, it is precise.
  if (/[äöüß]|Manifest|Bildseiten/i.test(raw)) return `Die Vorschau ist nicht verfügbar: ${raw}`;
  return 'Die Vorschau ist nicht erreichbar: Der Bilddienst hat unerwartet geantwortet.';
}
