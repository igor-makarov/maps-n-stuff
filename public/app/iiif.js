/**
 * IIIF helpers for Meridian Atlas.
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
 * IIIF labels are a string (v2) or a language map (v3, e.g. `{ de: ['Sheet 1'] }`).
 * Returns a plain string or `null`; never invents a label.
 */
export function labelText(label, preferred = ['en', 'none']) {
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
    label: labelText(canvas.label) ?? `Sheet ${index + 1}`,
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
  if (!manifest || typeof manifest !== 'object') throw new Error('No IIIF manifest was returned (expected JSON).');
  const raw = Array.isArray(manifest.sequences?.[0]?.canvases)
    ? manifest.sequences[0].canvases
    : Array.isArray(manifest.items)
      ? manifest.items
      : null;
  if (!raw) throw new Error('IIIF manifest has no image pages (no items or sequences).');

  const canvases = raw.map((canvas, index) => normaliseCanvas(canvas, index)).filter(Boolean);
  if (canvases.length === 0) throw new Error('IIIF manifest has no usable image pages.');

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

/**
 * Name of one sheet in a list of sheets (“Blatt 7 von 33”).
 *
 * The upstream canvas label is appended only when it says something the sheet
 * number does not already say: e-rara states the plain number ("7") for many
 * works, and "Blatt 7 von 33 – 7" would read like a broken control. Unknown
 * labels are omitted, never invented.
 */
export function sheetOptionLabel(canvas, index, total) {
  const number = Math.max(0, Math.floor(Number(index) || 0)) + 1;
  const count = Math.max(number, Math.floor(Number(total) || number));
  const name = `Sheet ${number} of ${count}`;
  const label = String(canvas?.label ?? '').trim();
  if (!label) return name;
  // e-rara states the plain sheet number as the canvas label — sometimes written
  // as “[7]” — and repeating it would read like a defect (“Blatt 7 von 33 – [7]”).
  const plain = label.replace(/[[\]]/g, '').trim();
  if (!plain || plain === String(number)) return name;
  if (/^blatt\s*\d+$/i.test(plain)) return name;
  return `${name} – ${label}`;
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

/* --------------------------------------------------------- shareable view */

/**
 * Compact, shareable form of a view: `x,y,w,h` in image pixels.
 *
 * Returns `''` (no URL parameter) when the view is the whole sheet — the default
 * is not spelled out — and also for a view that cannot be expressed, so a broken
 * viewer state can never put nonsense in a shared link. Integer pixels are exact
 * enough: every image request rounds the region to whole pixels anyway.
 */
export function formatViewParam(view, bounds, tolerance = 1) {
  if (!view || !bounds) return '';
  const { x, y, w, h } = view;
  if (![x, y, w, h].every((value) => Number.isFinite(value)) || w <= 0 || h <= 0) return '';
  const whole =
    x <= bounds.x + tolerance &&
    y <= bounds.y + tolerance &&
    w >= bounds.w - tolerance &&
    h >= bounds.h - tolerance;
  if (whole) return '';
  const parts = [x, y, w, h].map((value) => Math.max(0, Math.round(value)));
  if (parts[2] <= 0 || parts[3] <= 0) return '';
  return parts.join(',');
}

/**
 * Parse a shared `vv` value back into a view of the given sheet.
 *
 * Returns `null` when the value is not a region this viewer could have produced:
 * wrong shape, non-numeric, larger than the sheet, or smaller than the deepest
 * zoom (`MIN_REGION_FRACTION`). The caller then shows the whole sheet instead of
 * a random corner, and clears the unusable value from the URL. A valid region
 * that only sits slightly outside the sheet is clamped, not rejected.
 */
export function parseViewParam(value, bounds) {
  if (!bounds || !(bounds.w > 0) || !(bounds.h > 0)) return null;
  const parts = String(value ?? '').split(',');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (part.trim() === '' ? Number.NaN : Number(part)));
  if (!numbers.every((number) => Number.isFinite(number) && number >= 0)) return null;
  const [x, y, w, h] = numbers;
  if (w <= 0 || h <= 0) return null;
  // One pixel of tolerance: `formatViewParam` rounds to whole pixels, so a region
  // at the deepest zoom can come back up to 1 px smaller than the exact bound.
  if (w > bounds.w + 1 || h > bounds.h + 1) return null;
  const minW = bounds.w * MIN_REGION_FRACTION;
  const minH = bounds.h * MIN_REGION_FRACTION;
  if (w < minW - 1 || h < minH - 1) return null;
  return clampView({ x, y, w, h }, bounds);
}

/* ------------------------------------------- coupling by documented extent */

/** Accepts a box in the same shape as a record's `extent`; `null` when unusable. */
function usableBox(box) {
  if (!box) return null;
  const west = Number(box.west);
  const south = Number(box.south);
  const east = Number(box.east);
  const north = Number(box.north);
  if (![west, south, east, north].every((value) => Number.isFinite(value))) return null;
  if (east <= west || north <= south) return null;
  if (west < -180 || east > 180 || south < -90 || north > 90) return null;
  return { west, south, east, north };
}

function usableSheet(bounds) {
  return Boolean(bounds && bounds.w > 0 && bounds.h > 0);
}

function usableView(view) {
  return Boolean(view && [view.x, view.y, view.w, view.h].every((value) => Number.isFinite(value)) && view.w > 0 && view.h > 0);
}

/**
 * Geographic box of the region that is currently visible in the viewer.
 *
 * The sheet is mapped linearly onto the record's **documented** `extent` — the
 * same coarse assumption the map view makes when it draws the footprint of a
 * record. The maps in the seed are not georeferenced, so this is a coupling aid
 * for placing two sheets next to each other, not a georeference; the comparison
 * view says so. Returns `null` for anything unusable instead of guessing.
 */
export function viewToExtent(view, bounds, extent) {
  const box = usableBox(extent);
  if (!box || !usableSheet(bounds) || !usableView(view)) return null;
  const fx = (view.x - bounds.x) / bounds.w;
  const fy = (view.y - bounds.y) / bounds.h;
  const fw = view.w / bounds.w;
  const fh = view.h / bounds.h;
  const west = box.west + (box.east - box.west) * fx;
  const north = box.north - (box.north - box.south) * fy;
  return {
    west,
    east: west + (box.east - box.west) * fw,
    north,
    south: north - (box.north - box.south) * fh,
  };
}

/**
 * The region of a sheet that shows a geographic box — the inverse of
 * `viewToExtent`. The result is clamped to the sheet and to the deepest zoom
 * (`MIN_REGION_FRACTION`), so a box that reaches beyond the sheet still yields a
 * view the viewer can show instead of a letterbox inside the image.
 */
export function extentToView(part, bounds, extent) {
  const box = usableBox(extent);
  const target = usableBox(part);
  if (!box || !target || !usableSheet(bounds)) return null;
  const x = bounds.x + ((target.west - box.west) / (box.east - box.west)) * bounds.w;
  const y = bounds.y + ((box.north - target.north) / (box.north - box.south)) * bounds.h;
  const w = ((target.east - target.west) / (box.east - box.west)) * bounds.w;
  const h = ((target.north - target.south) / (box.north - box.south)) * bounds.h;
  return clampView({ x, y, w, h }, bounds);
}

/**
 * The part of the world two documented extents have in common — `null` when
 * they do not meet at all. Two sheets that overlap only along an edge have no
 * shared *area*, which is also `null`.
 */
export function intersectExtents(a, b) {
  const boxA = usableBox(a);
  const boxB = usableBox(b);
  if (!boxA || !boxB) return null;
  const west = Math.max(boxA.west, boxB.west);
  const east = Math.min(boxA.east, boxB.east);
  const south = Math.max(boxA.south, boxB.south);
  const north = Math.min(boxA.north, boxB.north);
  if (east <= west || north <= south) return null;
  return { west, south, east, north };
}

/** Degree tolerance for “the same box”: extents are stated to the minute. */
const COVER_EPSILON = 1e-6;

/**
 * The view a coupled partner pane can honestly show for a geographic box, plus
 * how much of that box the partner's sheet really covers:
 *
 * - `outside` — the box lies beside the documented extent. There is no region to
 *   show, and the pane must say so instead of silently jumping to its whole
 *   sheet (which would look like the coupling did nothing).
 * - `partial` — only the shared part of the box is on this sheet, so that part
 *   is shown. The pane notes that the sheet does not reach further.
 * - `full` — the whole box is inside the documented extent.
 *
 * The region is the intersection, not the clamped box: a box that reaches far
 * beyond the sheet must not be squeezed onto the sheet edges, which would show
 * the wrong place. Returns `null` when the inputs are unusable.
 */
export function coupledView(box, bounds, extent) {
  const source = usableBox(box);
  const target = usableBox(extent);
  if (!source || !target || !usableSheet(bounds)) return null;
  const shared = intersectExtents(source, target);
  if (!shared) return { view: null, coverage: 'outside' };
  const view = extentToView(shared, bounds, target);
  if (!view) return null;
  const partial =
    shared.west > source.west + COVER_EPSILON ||
    shared.east < source.east - COVER_EPSILON ||
    shared.south > source.south + COVER_EPSILON ||
    shared.north < source.north - COVER_EPSILON;
  return { view, coverage: partial ? 'partial' : 'full' };
}

/* ----------------------------------- cut-outs of several sheets at once */

/** One record id as the data contract writes it (`<providerId>:<recordId>`). */
const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{0,40}:[A-Za-z0-9][A-Za-z0-9._:-]{0,160}$/;
/** One `x,y,w,h` region, the exact shape `formatViewParam` writes. */
const REGION = /^\d{1,6}(?:,\d{1,6}){3}$/;
/** The comparison lays out at most four panes, so at most four cut-outs. */
export const MAX_COMPARE_VIEWS = 4;

/**
 * Read the `cvv` value back into `record id → region` (`x,y,w,h`).
 *
 * The comparison shows several sheets next to each other, so each pane needs
 * its own cut-out — and it is keyed by record id, not by position, because the
 * pane order changes with the record that was clicked (it leads the view).
 * The region itself stays the same compact token the detail viewer uses (`vv`),
 * so a pane validates it against its own sheet size. A hostile or stale value
 * yields fewer (or no) entries instead of throwing; a duplicate id keeps the
 * last pair, and everything beyond `limit` panes is ignored.
 */
export function parseCompareViews(value, limit = MAX_COMPARE_VIEWS) {
  const views = new Map();
  for (const pair of String(value ?? '').split(';')) {
    if (views.size >= limit) break;
    const at = pair.indexOf('@');
    if (at <= 0) continue;
    const id = pair.slice(0, at).trim();
    const region = pair.slice(at + 1).trim();
    if (!IDENTIFIER.test(id) || !REGION.test(region)) continue;
    views.set(id, region);
  }
  return views;
}

/**
 * Write `[record id, region]` pairs as the shareable `cvv` value.
 *
 * The whole sheet is the default and stays out of the URL (`''`), and a pane
 * that reports no region — no canvas yet, the whole sheet, or a value the
 * viewer could never have produced — is simply not written. The first
 * `limit` usable pairs win, so the string can never grow past what the
 * comparison can show.
 */
export function formatCompareViews(entries, limit = MAX_COMPARE_VIEWS) {
  const parts = [];
  const seen = new Set();
  for (const [id, region] of entries ?? []) {
    const key = String(id ?? '').trim();
    const value = String(region ?? '').trim();
    if (!IDENTIFIER.test(key) || !REGION.test(value) || seen.has(key)) continue;
    seen.add(key);
    parts.push(`${key}@${value}`);
    if (parts.length >= limit) break;
  }
  return parts.join(';');
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
 * `HTTP 502` on top; neither belongs in the visible English UI. Our own messages
 * (from `parseManifest`) are already written for visitors and are passed through
 * unchanged, so an unusable manifest still says exactly what is wrong with it.
 *
 * The raw string stays available for logs — callers must not render it.
 */
export function describeUpstreamError(err) {
  const raw = String(err?.message ?? err ?? '').trim();
  if (!raw) return 'Preview unavailable (unknown error).';
  const status = raw.match(/\bHTTP (\d{3})\b/);
  if (/failed to fetch|networkerror|network error|load failed|err_/i.test(raw)) {
    return 'Preview unavailable. Could not connect to the image service.';
  }
  if (status) {
    return `Preview unavailable. The image service returned HTTP ${status[1]}.`;
  }
  // A message we wrote ourselves (manifest parsing): keep it, it is precise.
  if (/^IIIF manifest /i.test(raw)) return `Preview unavailable: ${raw}`;
  return 'Preview unavailable. The image service returned an unexpected response.';
}
