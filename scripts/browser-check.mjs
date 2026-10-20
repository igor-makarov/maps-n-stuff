#!/usr/bin/env node
/**
 * End-to-end browser check for the Meridian Atlas Workers site.
 *
 * Drives the Chromium binary that is already installed on the runner over the
 * DevTools protocol (no Playwright/Puppeteer download, no extra npm dependency).
 * It exercises the real interactions the product promises:
 *
 *   1. initial load: shell renders, records arrive, map tiles are fetched
 *   2. year/time-range control actually filters the result list
 *   3. selecting a record opens the detail panel with metadata + IIIF preview
 *   4. place search (swisstopo via the Worker) returns suggestions
 *   5. keyboard use: focus the map, pan with the arrow keys
 *   6. shareable URL state survives a reload
 *   7. mobile viewport: no horizontal overflow, controls stay reachable
 *
 * Usage:
 *   npx wrangler dev --port 8787          # in another shell
 *   node scripts/browser-check.mjs [--url http://127.0.0.1:8787] [--out /tmp/kartenzeit-shots]
 *
 * Exit code 0 = every check passed; 1 = at least one check failed (details on
 * stdout, screenshots and a JSON report in --out).
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE_URL = argValue('url', 'http://127.0.0.1:8787').replace(/\/$/, '');
const OUT_DIR = argValue('out', path.join(os.tmpdir(), 'kartenzeit-shots'));
const DEBUG_PORT = Number(argValue('port', '9222'));
const CHROME = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable'].find((bin) => {
  for (const dir of (process.env.PATH || '').split(':')) if (dir && existsSync(path.join(dir, bin))) return true;
  return false;
});

const results = [];
const consoleMessages = [];
const appInfo = [];
const failedRequests = [];
const apiRequests = []; // fetch()/XHR traffic: must stay on our own origin (CSP)
const imageRequests = []; // tracked upstream IIIF image requests, for diagnosing failures
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok: Boolean(ok), detail });
  if (!ok) failures += 1;
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** In-page WCAG 2.2 AA contrast sweep; returns the offending nodes. */
const CONTRAST_SWEEP = `(() => {
    const parse = (c) => {
      const m = c.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)(?:,\\s*([\\d.]+))?\\)/);
      return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
    };
    const lum = ({ r, g, b }) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const ratio = (a, b) => { const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); };
    const backdrop = (node) => {
      let n = node;
      while (n && n !== document.documentElement) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c && c.a > 0) return c; // opaque or translucent layer: good enough for a sweep
        n = n.parentElement;
      }
      return { r: 255, g: 255, b: 255, a: 1 };
    };
    const bad = [];
    for (const node of document.querySelectorAll('body *')) {
      if (node.closest('.visuallyhidden')) continue;
      if (node.closest('[aria-hidden="true"]')) continue;
      const text = [...node.childNodes].filter((c) => c.nodeType === 3).map((c) => c.textContent.trim()).join('');
      if (!text) continue;
      const cs = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      if (cs.visibility === 'hidden' || cs.display === 'none' || r.width < 4 || r.height < 4) continue;
      if (r.bottom < 0 || r.top > window.innerHeight * 6) continue;
      const fg = parse(cs.color);
      if (!fg || fg.a < 0.5) continue;
      const bg = backdrop(node);
      const size = parseFloat(cs.fontSize);
      const weight = Number(cs.fontWeight) || 400;
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const need = large ? 3 : 4.5;
      const value = ratio(fg, bg);
      if (value < need) bad.push({ sel: node.tagName.toLowerCase() + (node.className ? '.' + String(node.className).split(' ')[0] : ''), text: text.slice(0, 30), ratio: Math.round(value * 100) / 100, need, color: cs.color, bg: 'rgb(' + bg.r + ',' + bg.g + ',' + bg.b + ')' });
    }
    return { checked: document.querySelectorAll('body *').length, bad: bad.slice(0, 12), badCount: bad.length };
  })()`;

const describeContrast = (c) =>
  c.badCount === 0
    ? `${c.checked} elements inspected`
    : c.bad.map((b) => `${b.sel} ${b.ratio}:1<${b.need}:1 "${b.text}" (${b.color} on ${b.bg})`).join(' | ');

/* ------------------------------------------------------------------ CDP glue */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${JSON.stringify(message.error.data ?? '')})`));
        else resolve(message.result);
        return;
      }
      if (message.method) {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30_000);
    });
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  /** Evaluate an expression in the page and return its JSON value. */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) {
      const reason = exceptionDetails.exception?.description || exceptionDetails.text;
      // Include the expression: a failure inside a generated snippet is otherwise
      // impossible to place ("SyntaxError: Unexpected token '}'").
      throw new Error(`${reason}\n  in expression: ${String(expression).replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    return result?.value;
  }

  async waitFor(expression, { timeout = 20_000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await sleep(250);
    }
    throw new Error(`timeout waiting for ${label} (last: ${JSON.stringify(last)})`);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(file, Buffer.from(data, 'base64'));
  }

  /** Click a element found by CSS selector with a real mouse event. */
  async click(selector, { index = 0 } = {}) {
    const box = await this.eval(`(() => {
      const nodes = document.querySelectorAll(${JSON.stringify(selector)});
      const node = nodes[${index}];
      if (!node) return null;
      // The canton stylesheet enables smooth scrolling; force instant scrolling so
      // the click coordinates are stable (and do not fight reduced-motion users).
      node.scrollIntoView({ block: 'center', behavior: 'instant', inline: 'nearest' });
      const r = node.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) {
        const absolute = r.top + window.scrollY - window.innerHeight / 2 + r.height / 2;
        window.scrollTo({ top: Math.max(0, absolute), behavior: 'instant' });
      }
      const after = node.getBoundingClientRect();
      return { x: after.left + after.width / 2, y: after.top + after.height / 2, w: after.width, h: after.height };
    })()`);
    if (!box) throw new Error(`click: no element for ${selector}[${index}]`);
    const common = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...common });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...common });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...common });
    return box;
  }

  async typeInto(selector, text) {
    await this.click(selector);
    await this.eval(`(() => { const n = document.querySelector(${JSON.stringify(selector)}); n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
    await this.send('Input.insertText', { text });
    return this.eval(`document.querySelector(${JSON.stringify(selector)}).value`);
  }

  /**
   * Dispatch one key press.
   *
   * `Enter` and `Space` are sent as the full rawKeyDown + char + keyUp
   * sequence, because only that sequence triggers the browser's *default*
   * action — activating the focused native `<button>` (or submitting a form).
   * A plain keyDown/keyUp pair reaches JS `keydown` handlers but leaves a real
   * button unclicked (verified while adding the footprint switch check). Use
   * `{ native: false }` for the short pair and for keys that only JS handles.
   */
  async pressKey(key, { code, keyCode, native = key === 'Enter' || key === ' ' } = {}) {
    const map = { ArrowRight: { code: 'ArrowRight', keyCode: 39 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, ArrowDown: { code: 'ArrowDown', keyCode: 40 }, Enter: { code: 'Enter', keyCode: 13 }, Escape: { code: 'Escape', keyCode: 27 }, Home: { code: 'Home', keyCode: 36 }, ' ': { code: 'Space', keyCode: 32 } };
    const info = { code: code ?? map[key]?.code, windowsVirtualKeyCode: keyCode ?? map[key]?.keyCode, nativeVirtualKeyCode: keyCode ?? map[key]?.keyCode };
    if (native) {
      const text = key === 'Enter' ? '\r' : ' ';
      await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, ...info });
      await this.send('Input.dispatchKeyEvent', { type: 'char', text, unmodifiedText: text, key, ...info });
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...info });
      return;
    }
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, ...info });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, ...info });
  }
}

async function launchChrome() {
  const userDataDir = path.join(os.tmpdir(), `kartenzeit-chrome-${process.pid}`);
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--hide-scrollbars',
      '--window-size=1440,960',
      `--remote-debugging-port=${DEBUG_PORT}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const stderr = [];
  chrome.stderr.on('data', (d) => stderr.push(d.toString()));

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) {
        const info = await res.json();
        const target = await openPageTarget();
        return { chrome, userDataDir, info, target, stderr };
      }
    } catch {
      /* not up yet */
    }
    await sleep(300);
  }
  throw new Error(`Chromium did not expose a DevTools endpoint.\n${stderr.join('').slice(-800)}`);
}

/** A page target's WebSocket (domains Page/Runtime/Network live there, not on the browser socket). */
async function openPageTarget() {
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, { method });
      if (res.ok) {
        const target = await res.json();
        if (target.webSocketDebuggerUrl) return target.webSocketDebuggerUrl;
      }
    } catch {
      /* try the next method */
    }
  }
  throw new Error('could not open a DevTools page target');
}

/* --------------------------------------------------------------------- main */

if (!CHROME) {
  console.error('No Chromium/Chrome binary found on PATH; skipping browser checks.');
  process.exit(2);
}

await mkdir(OUT_DIR, { recursive: true });

// Fail fast with a clear message when the Workers preview is not running.
try {
  const health = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(4000) });
  if (!health.ok) throw new Error(`HTTP ${health.status}`);
} catch (err) {
  console.error(`Cannot reach ${BASE_URL}/api/health — start the preview first (npx wrangler dev). ${err.message}`);
  process.exit(2);
}

// The seed grows and changes; checks that talk about a specific record read its
// real year/institution from the API instead of hardcoding the data of the day.
const recordIndex = new Map();
try {
  const seed = await (await fetch(`${BASE_URL}/api/records`, { signal: AbortSignal.timeout(10_000) })).json();
  for (const record of seed.records ?? seed) recordIndex.set(record.id, record);
} catch {
  /* no index: the affected checks fall back to reading the DOM */
}

/**
 * A point (and, when the seed documents some sheet everywhere, a period) that no
 * record in that filter scope covers — the honest “nothing here” for the
 * point-filter empty state. Derived from the seed instead of hard-coded: the
 * overview maps added in iteration 7-16 cover large parts of Europe and since
 * 7-20 the world set documents the whole globe, so “outside every footprint” can
 * now mean “outside every footprint **of that period**”. The period is the
 * publication year of a sheet elsewhere in the seed, so an empty result is the
 * point's doing and not an empty period.
 */
const pointProbe = (() => {
  const records = [...recordIndex.values()].filter((record) => record.extent);
  if (records.length === 0) return { lat: 52.52, lon: 13.405, from: 1900, to: 1900 };
  const covers = (box, lat, lon) => lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north;
  const years = [...new Set(records.map((record) => Number(record.yearStart)).filter(Number.isFinite))].sort((a, b) => a - b);
  for (let lat = 62; lat >= -54; lat -= 4) {
    for (let lon = -178; lon <= 178; lon += 4) {
      const covering = records.filter((record) => covers(record.extent, lat, lon));
      if (covering.length === 0) return { lat, lon, from: 1781, to: 1900 };
      const year = years.find((candidate) =>
        covering.every((record) => {
          const start = Number(record.yearStart);
          const end = Number(record.yearEnd ?? record.yearStart);
          return Number.isFinite(start) && (candidate < start || candidate > end);
        }),
      );
      if (year !== undefined) return { lat, lon, from: year, to: year };
    }
  }
  return { lat: -58, lon: -178, from: 1781, to: 1900 };
})();
const uncoveredPoint = pointProbe;
const uncoveredAt = `${pointProbe.lat.toFixed(4)}%2C${pointProbe.lon.toFixed(4)}`;
const uncoveredQuery = `from=${pointProbe.from}&to=${pointProbe.to}`;

const { chrome, userDataDir, info, target } = await launchChrome();
const ws = new WebSocket(target);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
const cdp = new CDP(ws);

cdp.on('Runtime.consoleAPICalled', (params) => {
  const text = params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
  if (params.type === 'info' || params.type === 'log') {
    appInfo.push(text);
    return;
  }
  if (!['error', 'warning'].includes(params.type)) return;
  // main.js catches a module whose init() throws and logs a warning. That is the
  // right runtime behaviour, but it means a whole feature can be dead while the
  // console stays quiet, so the harness treats it as a failure.
  const deadModule = /\[meridian-atlas\] module ".*" not available/.test(text);
  consoleMessages.push({ level: deadModule ? 'error' : params.type, text });
});
cdp.on('Runtime.exceptionThrown', (params) => {
  consoleMessages.push({ level: 'exception', text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text });
});
// Browser-level log entries: CSP violations, blocked mixed content, failed loads.
cdp.on('Log.entryAdded', ({ entry }) => {
  if (entry.level !== 'error') return;
  if (/favicon/.test(entry.text || '')) return;
  consoleMessages.push({ level: 'browser', text: `${entry.text} ${entry.url || ''}`.trim() });
});
cdp.on('Network.requestWillBeSent', (params) => {
  if (params.type === 'Fetch' || params.type === 'XHR') apiRequests.push(params.request.url);
  if (/e-rara\.ch\/i3f\//.test(params.request.url)) imageRequests.push(params.request.url);
});
cdp.on('Network.responseReceived', (params) => {
  const { response } = params;
  if (response.status >= 400 && !/favicon/.test(response.url)) failedRequests.push({ status: response.status, url: response.url });
});

await Promise.all([
  cdp.send('Page.enable'),
  cdp.send('Runtime.enable'),
  cdp.send('Network.enable'),
  cdp.send('Log.enable'),
]);

const report = { url: BASE_URL, ranAt: new Date().toISOString(), checks: results, consoleMessages, failedRequests, screenshots: [] };

try {
  /* --- 1. initial load -------------------------------------------------- */
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.readyState === 'complete'`, { label: 'page load' });
  await cdp.waitFor(`document.querySelector('#main') != null`, { label: 'shell' });

  const recordCount = await cdp.waitFor(`document.querySelectorAll('#result-list > *').length`, { label: 'result rows' });
  check('result list renders real records', recordCount > 5, `${recordCount} rows`);
  await cdp.waitFor(`window.__kartenzeitReady !== undefined || document.documentElement.dataset.app === 'meridian-atlas'`, { label: 'app bootstrap' });
  const tiles = await cdp.waitFor(
    `(() => { const imgs = [...document.querySelectorAll('#map img')]; return imgs.filter((i) => i.complete && i.naturalWidth > 0).length; })()`,
    { label: 'map tiles', timeout: 25_000 },
  );
  check('interactive map loads basemap tiles', tiles > 0, `${tiles} tiles decoded`);
  const attribution = await cdp.eval(`document.querySelector('#map .map-badge, .map-badge')?.textContent?.trim() || ''`);
  check('the basemap attribution is visible', /OpenStreetMap|swisstopo/i.test(attribution), attribution.slice(0, 80));
  const yearSpan = await cdp.eval(`(() => {
    const from = document.querySelector('#year-from'), to = document.querySelector('#year-to');
    return from && to ? { min: from.min, max: from.max, from: from.value, to: to.value } : null;
  })()`);
  check('time-range control is present and bounded by the data', Boolean(yearSpan && yearSpan.min && yearSpan.max), yearSpan ? `${yearSpan.from}–${yearSpan.to} (${yearSpan.min}–${yearSpan.max})` : 'missing');
  await cdp.screenshot(path.join(OUT_DIR, '01-desktop.png')).then(() => report.screenshots.push('01-desktop.png'));

  /* --- 2. year filter --------------------------------------------------- */
  const before = await cdp.eval(`document.querySelector('#result-count')?.textContent || ''`);
  const filtered = await cdp.eval(`(() => {
    const to = document.querySelector('#year-to');
    if (!to) return null;
    to.value = '1850';
    to.dispatchEvent(new Event('input', { bubbles: true }));
    to.dispatchEvent(new Event('change', { bubbles: true }));
    return to.value;
  })()`);
  await sleep(700);
  const afterCount = await cdp.eval(`document.querySelectorAll('#result-list > *').length`);
  const after = await cdp.eval(`document.querySelector('#result-count')?.textContent || ''`);
  check('time range filters the coordinated result list', afterCount > 0 && afterCount < recordCount, `"${before.trim()}" -> "${after.trim()}" (${recordCount} -> ${afterCount} rows, slider ${filtered})`);
  const urlAfterFilter = await cdp.eval(`location.search`);
  check('filter state is written to the shareable URL', /to=1850/.test(urlAfterFilter), urlAfterFilter);

  /* --- 2b. collection facet (series from the data) ---------------------- */
  // The period start is the slider's, not a constant: the seed's earliest
  // publication year moves whenever the harvest grows.
  const periodRange = await cdp.eval(`(() => ({ from: document.querySelector('#year-from')?.value, to: document.querySelector('#year-to')?.value }))()`);
  const collectionFacet = await cdp.eval(`(() => {
    const select = document.querySelector('#collection-filter');
    if (!select) return null;
    const options = [...select.options].map((o) => ({ value: o.value, text: o.textContent.trim(), count: Number(o.dataset.count || 0) }));
    return {
      options,
      hint: document.querySelector('#facet-hint')?.textContent || '',
      range: \`\${document.querySelector('#year-from')?.value}–\${document.querySelector('#year-to')?.value}\`,
    };
  })()`);
  const zeroCounts = (collectionFacet?.options ?? []).filter((o) => /\(0\)$/.test(o.text)).length;
  const periodHint = periodRange?.from && periodRange?.to ? `published in ${periodRange.from}–${periodRange.to}` : null;
  check(
    'collection facet lists the real series with counts for the current period',
    Boolean(collectionFacet) &&
      collectionFacet.options.length >= 3 &&
      zeroCounts > 0 &&
      (periodHint ? collectionFacet.hint.includes(periodHint) : /published in \d{4}–\d{4}/.test(collectionFacet.hint)),
    `${collectionFacet?.options.length ?? 0} options, ${zeroCounts} empty in period, expected "${periodHint}", hint: ${collectionFacet?.hint ?? 'missing'}`,
  );
  const collectionChoice = await cdp.eval(`(() => {
    const select = document.querySelector('#collection-filter');
    if (!select) return null;
    const best = [...select.options]
      .filter((o) => o.value)
      .map((option) => ({ option, count: Number(option.dataset.count || 0) }))
      .sort((a, b) => b.count - a.count)[0];
    if (!best || !best.count) return null;
    select.value = best.option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return { value: best.option.value, label: best.option.textContent.trim(), count: best.count };
  })()`);
  await sleep(500);
  const collectionRows = await cdp.eval(`document.querySelectorAll('#result-list > *').length`);
  const collectionUrl = new URLSearchParams(await cdp.eval(`location.search`));
  check(
    'choosing a collection filters the list and is shareable',
    Boolean(collectionChoice) && collectionRows > 0 && collectionRows < afterCount && collectionUrl.get('c') === collectionChoice?.value,
    `${collectionChoice?.label ?? 'none'} -> ${collectionRows} rows, c=${collectionUrl.get('c') ?? ''} (was ${afterCount})`,
  );
  // Back to all series so the detail checks below keep their e-rara record.
  await cdp.eval(`(() => { const s = document.querySelector('#collection-filter'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  await sleep(500);

  /* --- 2c. decade histogram (time browsing without the slider) ---------- */
  const histogram = await cdp.eval(`(() => {
    const host = document.querySelector('#year-histogram');
    if (!host) return null;
    const bins = [...host.querySelectorAll('button')].map((b) => ({ start: Number(b.dataset.start), end: Number(b.dataset.end), count: Number(b.dataset.count), tab: b.tabIndex }));
    return { bins, scale: document.querySelector('#year-histogram-scale')?.textContent || '', tabbable: bins.filter((b) => b.tab === 0).length };
  })()`);
  const binTotal = (histogram?.bins ?? []).reduce((sum, bin) => sum + bin.count, 0);
  check(
    'decade histogram shows the real distribution with one tab stop',
    Boolean(histogram) && histogram.bins.length >= 10 && binTotal > 5 && histogram.tabbable === 1 && /\d{4}/.test(histogram.scale),
    `${histogram?.bins.length ?? 0} bins, ${binTotal} records in bins, ${histogram?.tabbable ?? 0} tab stops, scale ${histogram?.scale ?? ''}`,
  );
  const histogramClick = await cdp.eval(`(() => {
    const host = document.querySelector('#year-histogram');
    const bin = [...host.querySelectorAll('button')].sort((a, b) => Number(b.dataset.count) - Number(a.dataset.count))[0];
    bin.click();
    return { start: Number(bin.dataset.start), end: Number(bin.dataset.end), count: Number(bin.dataset.count) };
  })()`);
  await sleep(600);
  const histogramState = await cdp.eval(`(() => ({
    search: location.search,
    rows: document.querySelectorAll('#result-list > *').length,
    yearMax: Number(document.querySelector('#year-to')?.max || 0),
    current: [...document.querySelectorAll('#year-histogram button')].filter((b) => b.getAttribute('aria-current') === 'true').map((b) => Number(b.dataset.start)),
  }))()`);
  const histogramParams = new URLSearchParams(histogramState.search);
  check(
    'a histogram bar filters the range and marks the active decades',
    Number(histogramParams.get('from')) === histogramClick.start
      && Number(histogramParams.get('to')) === Math.min(histogramClick.end, histogramState.yearMax)
      && histogramState.rows >= histogramClick.count && histogramClick.count > 0
      && histogramState.current.includes(histogramClick.start),
    `bin ${histogramClick.start}–${histogramClick.end} (${histogramClick.count}) -> ${histogramState.rows} rows, ${histogramState.search}`,
  );
  const histogramKeys = await cdp.eval(`(() => {
    const host = document.querySelector('#year-histogram');
    const first = host.querySelector('button');
    first.focus();
    const start = document.activeElement?.dataset.start;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    const end = document.activeElement?.dataset.start;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    const home = document.activeElement?.dataset.start;
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    const next = document.activeElement?.dataset.start;
    return { start, end, home, next, tabbable: [...host.querySelectorAll('button')].filter((b) => b.tabIndex === 0).length };
  })()`);
  check(
    'histogram keyboard: End/Home/ArrowRight move between decades',
    Boolean(histogram) && histogramKeys.start === String(histogram.bins[0].start)
      && histogramKeys.end === String(histogram.bins.at(-1).start)
      && histogramKeys.home === String(histogram.bins[0].start)
      && histogramKeys.next === String(histogram.bins[1].start)
      && histogramKeys.tabbable === 1,
    JSON.stringify(histogramKeys),
  );
  /* --- 2c-2. the bars follow the filters, and one drag brushes a range --- */
  // The histogram is a facet like the provider/type checkboxes above: its bars
  // count every active filter *except* the period, so a narrow range must not
  // shrink them (the visitor sees what widening the range would bring back).
  const histogramScope = await cdp.eval(`(() => {
    const host = document.querySelector('#year-histogram');
    return {
      sum: [...host.querySelectorAll('button')].reduce((total, b) => total + Number(b.dataset.count), 0),
      aria: host.getAttribute('aria-label') || '',
      bins: host.querySelectorAll('button').length,
      rows: document.querySelectorAll('#result-list > *').length,
      from: document.querySelector('#year-from')?.value ?? '',
      to: document.querySelector('#year-to')?.value ?? '',
    };
  })()`);
  check(
    'histogram bars count the other filters, not the period',
    histogramScope.bins >= 10
      && histogramScope.sum > histogramScope.rows
      && histogramScope.aria.includes(`${histogramScope.sum} im aktuellen Filter`),
    `period ${histogramScope.from}–${histogramScope.to}: ${histogramScope.rows} rows but ${histogramScope.sum} records in ${histogramScope.bins} bars, aria “${histogramScope.aria}”`,
  );
  const providerChoice = await cdp.eval(`(() => {
    const input = document.querySelector('#provider-filters input');
    if (!input) return null;
    input.click();
    return { value: input.value };
  })()`);
  await sleep(600);
  const providerScope = await cdp.eval(`(() => ({
    sum: [...document.querySelectorAll('#year-histogram button')].reduce((total, b) => total + Number(b.dataset.count), 0),
    aria: document.querySelector('#year-histogram')?.getAttribute('aria-label') || '',
    rows: document.querySelectorAll('#result-list > *').length,
    provider: new URLSearchParams(location.search).get('p'),
    facetText: [...document.querySelectorAll('#provider-filters label')].map((l) => l.textContent.trim()).join(', '),
  }))()`);
  check(
    'a provider filter narrows the histogram to that provider\u2019s records',
    Boolean(providerChoice)
      && providerScope.provider === providerChoice.value
      && providerScope.sum > 0
      && providerScope.sum < histogramScope.sum
      && providerScope.rows <= providerScope.sum
      && providerScope.aria.includes(`${providerScope.sum} im aktuellen Filter`),
    `${providerChoice?.value ?? 'none'}: bars ${histogramScope.sum} -> ${providerScope.sum}, ${providerScope.rows} rows, facet “${providerScope.facetText}”`,
  );
  await cdp.eval(`(() => { const input = document.querySelector('#provider-filters input'); if (input && input.checked) input.click(); })()`);
  await sleep(500);

  // One gesture, one range: press on a decade, drag across, release. The hint
  // previews the range while dragging; the URL gets exactly the brushed decades.
  const brushBins = await cdp.eval(`(() => {
    const host = document.querySelector('#year-histogram');
    host.scrollIntoView({ block: 'center', behavior: 'instant' });
    return [...host.querySelectorAll('button')].map((b, index) => {
      const r = b.getBoundingClientRect();
      return { index, start: Number(b.dataset.start), end: Number(b.dataset.end), count: Number(b.dataset.count), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height - 6) };
    });
  })()`);
  let brushFrom = brushBins.find((b) => b.count > 2) ?? brushBins[0];
  brushFrom = brushBins[Math.min(brushBins.length - 1, brushFrom.index)];
  const brushTo = brushBins[Math.min(brushBins.length - 1, brushFrom.index + 2)];
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: brushFrom.x, y: brushFrom.y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: brushFrom.x, y: brushFrom.y, button: 'left', clickCount: 1, buttons: 1 });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: Math.round(brushFrom.x + ((brushTo.x - brushFrom.x) * step) / 6),
      y: brushTo.y,
      button: 'left',
      buttons: 1,
    });
    await sleep(20);
  }
  const brushPreview = await cdp.eval(`({
    brushed: document.querySelectorAll('#year-histogram .is-brushing').length,
    hint: document.querySelector('#year-histogram-hint')?.textContent || '',
  })`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: brushTo.x, y: brushTo.y, button: 'left', buttons: 0 });
  await sleep(600);
  const brushState = await cdp.eval(`(() => ({
    search: location.search,
    current: [...document.querySelectorAll('#year-histogram button')].filter((b) => b.getAttribute('aria-current') === 'true').map((b) => Number(b.dataset.start)),
    brushed: document.querySelectorAll('#year-histogram .is-brushing').length,
    hint: document.querySelector('#year-histogram-hint')?.textContent || '',
    rows: document.querySelectorAll('#result-list > *').length,
    yearMin: Number(document.querySelector('#year-from')?.min || 0),
    yearMax: Number(document.querySelector('#year-to')?.max || 0),
  }))()`);
  const brushParams = new URLSearchParams(brushState.search);
  check(
    'dragging across the decades filters one range in a single gesture',
    Number(brushParams.get('from')) === Math.max(brushState.yearMin, brushFrom.start)
      && Number(brushParams.get('to')) === Math.min(brushState.yearMax, brushTo.end)
      && brushPreview.brushed === 3
      && brushPreview.hint.includes(`${brushFrom.start}–${brushTo.end}`)
      && brushState.current.length === 3
      && brushState.brushed === 0
      && !/selected:/.test(brushState.hint)
      && brushState.rows <= histogramScope.sum,
    `${brushFrom.start}–${brushTo.end}: mid-drag “${brushPreview.hint}” (${brushPreview.brushed} bars) -> ${brushState.search}, ${brushState.rows} rows, ${brushState.current.join(',')}`,
  );
  // A pointer *tap* ends the same gesture without movement: exactly one decade.
  const tapBin = brushBins.find((b) => b.count > 0 && b.index !== brushFrom.index) ?? brushBins[0];
  await cdp.click('#year-histogram button', { index: tapBin.index });
  await sleep(600);
  const tapState = await cdp.eval(`(() => ({
    search: location.search,
    yearMin: Number(document.querySelector('#year-from')?.min || 0),
    yearMax: Number(document.querySelector('#year-to')?.max || 0),
    rows: document.querySelectorAll('#result-list > *').length,
  }))()`);
  const tapParams = new URLSearchParams(tapState.search);
  check(
    'one tap on a bar still selects exactly that decade',
    Number(tapParams.get('from')) === Math.max(tapState.yearMin, tapBin.start)
      && Number(tapParams.get('to')) === Math.min(tapState.yearMax, tapBin.end),
    `tapped ${tapBin.start} (${tapBin.count}) -> ${tapState.search}, ${tapState.rows} rows`,
  );

  // Restore the start year of the initial view plus the 1850 end of the time-range
  // check, so the reload comparison below still means something.
  await cdp.eval(`(() => {
    const from = document.querySelector('#year-from');
    const to = document.querySelector('#year-to');
    from.value = '${yearSpan.from}';
    to.value = '1850';
    from.dispatchEvent(new Event('input', { bubbles: true }));
    to.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await cdp.waitFor(`document.querySelector('#result-count')?.textContent.includes('${yearSpan.from}–1850')`, { label: 'restored year range', timeout: 8_000 }).catch(() => {});

  /* --- 3. record detail + IIIF ------------------------------------------ */
  await cdp.click('#result-list > *');
  await cdp.waitFor(`document.querySelector('#detail') && !document.querySelector('#detail').hidden`, { label: 'detail panel', timeout: 15_000 });
  const detailOpen = await cdp.eval(`document.querySelector('#detail').textContent.trim().length`);
  check('selecting a record opens the detail panel', detailOpen > 100, `${detailOpen} chars`);
  // The expectation is read from the record data, not from a hardcoded list of
  // libraries: the seed holds e-rara works from ZB Zürich, ETH-Bibliothek, the
  // Universitätsbibliothek Bern and the Bibliothèque de Genève.
  const selectedId = await cdp.eval(`document.querySelector('#result-list > *')?.dataset.recordId || null`);
  const selectedRecord = selectedId ? recordIndex.get(selectedId) : null;
  const detail = await cdp.eval(`(() => {
    const d = document.querySelector('#detail');
    const text = d.textContent.replace(/\\s+/g, ' ');
    const link = [...d.querySelectorAll('a')].find((a) => /e-rara|geo\\.admin|zb\\.uzh/.test(a.href));
    const img = d.querySelector('#detail-preview img, #detail-preview img');
    const expected = ${JSON.stringify(selectedRecord?.institution ?? null)};
    return {
      text: text.slice(0, 400),
      sourceHref: link?.href || null,
      institution: expected
        ? text.includes(expected)
        : /Zentralbibliothek|ETH-Bibliothek|swisstopo|Universitätsbibliothek|Bibliothèque|Library of Congress/.test(text),
      rights: /Public Domain|Rechte|OGD|©/i.test(text),
      previewSrc: img?.src || null,
      previewLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
    };
  })()`);
  check('detail links to the original collection record', Boolean(detail.sourceHref), detail.sourceHref ?? 'no link');
  const viewerLink = await cdp.eval(`(() => { const a = [...document.querySelectorAll('#detail a')].find((n) => /content\\/zoom/.test(n.href)); return a?.href || null; })()`);
  check('detail links to the library\'s own viewer', /^https:\/\/www\.e-rara\.ch\/[a-z]+\/content\/zoom\/\d+$/.test(viewerLink || ''), viewerLink ?? 'no viewer link');
  check('detail names the holding institution and rights', detail.institution && detail.rights, `${selectedRecord?.institution ?? '?'} · ${detail.text.slice(0, 100)}`);

  // The reuse links are filled from the manifest response (image service + METS).
  // The image-service link is rendered from the harvested record immediately, but
  // keep a bounded wait so a slow manifest can never make this check flaky.
  await cdp
    .waitFor(`(() => [...document.querySelectorAll('#reuse-links a')].some((a) => a.href.endsWith('/full/max/0/default.jpg')))()`, {
      label: 'IIIF reuse link',
      timeout: 20_000,
    })
    .catch(() => {});
  const reuse = await cdp.eval(`(() => {
    const citation = document.querySelector('#citation-text')?.textContent || '';
    const links = [...document.querySelectorAll('#reuse-links a')].map((a) => a.href);
    return { citation, hasFullImage: links.some((h) => h.endsWith('/full/max/0/default.jpg')), links };
  })()`);
  check(
    'detail offers an honest citation and reuse links',
    /Abgerufen am \d{4}-\d{2}-\d{2}/.test(reuse.citation) && /https:\/\/www\.e-rara\.ch\/doi\/10\.3931\//.test(reuse.citation) && reuse.hasFullImage,
    `${reuse.citation.slice(0, 90)} … ${reuse.links.length} links`,
  );
  const citationClean = !/\.\./.test(reuse.citation);
  check('citation punctuation stays clean with verbatim upstream values', citationClean, reuse.citation.slice(-80));

  // The IIIF manifest + first image come from e-rara; give the image service time
  // to answer, then insist on a rendered image (a real derivative, not a placeholder).
  let preview = { state: 'missing' };
  try {
    await cdp.waitFor(
      `(() => { const img = document.querySelector('#detail-preview img'); return Boolean(img && img.complete && img.naturalWidth > 0); })()`,
      { label: 'IIIF preview image', timeout: 25_000 },
    );
    preview = await cdp.eval(
      `(() => { const img = document.querySelector('#detail-preview img'); return { state: 'loaded', src: img.src, w: img.naturalWidth, h: img.naturalHeight, meta: document.querySelector('#preview-meta')?.textContent || '' }; })()`,
    );
  } catch (err) {
    preview = await cdp.eval(`(() => { const p = document.querySelector('#detail-preview'); return { state: (p?.textContent || 'empty').replace(/\\s+/g, ' ').slice(0, 160) }; })()`);
    preview.error = err.message;
  }
  check('detail shows a IIIF preview image', preview.state === 'loaded', JSON.stringify(preview).slice(0, 200));
  await cdp.screenshot(path.join(OUT_DIR, '02-detail.png')).then(() => report.screenshots.push('02-detail.png'));

  /**
   * Wait until the IIIF viewer settles into a state matching `predicate`.
   * Returns the last snapshot, so a failing check can report what it saw.
   */
  const waitForViewer = async (predicate, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    let last = { src: '', decoded: false, state: '', readout: '', decodeW: 0, decodeH: 0, stageW: 0 };
    while (Date.now() < deadline) {
      last = await cdp.eval(`(() => {
        const img = document.querySelector('.app-viewer__image');
        const stage = document.querySelector('#viewer-stage');
        return {
          src: img?.src || '',
          decoded: Boolean(img && img.complete && img.naturalWidth > 0),
          state: stage?.dataset.state || '',
          readout: document.querySelector('#viewer-resolution')?.textContent || '',
          decodeW: img?.naturalWidth || 0,
          decodeH: img?.naturalHeight || 0,
          stageW: Math.round(stage?.getBoundingClientRect().width || 0),
        };
      })()`);
      if (await cdp.eval(`(${predicate})(${JSON.stringify(last)})`)) return last;
      await sleep(200);
    }
    return last;
  };

  /**
   * Wait until comparison pane `index` settles into a state matching `predicate`.
   * Reads the pane's real `<img>`, no matter whether it is an interactive viewer
   * stage or the static tile fallback of a record without a manifest.
   */
  const waitForComparePane = async (index, predicate, timeout = 30_000) => {
    const deadline = Date.now() + timeout;
    let last = { src: '', decoded: false, state: '', readout: '', decodeW: 0, decodeH: 0, stageW: 0, viewer: false };
    while (Date.now() < deadline) {
      last = await cdp.eval(`(() => {
        const pane = document.querySelectorAll('#compare-view-body .app-compare__pane')[${index}];
        const stage = pane?.querySelector('[data-compare-stage]');
        const img = pane?.querySelector('img');
        return {
          src: img?.src || '',
          decoded: Boolean(img && img.complete && img.naturalWidth > 0),
          state: stage?.dataset.state || '',
          readout: pane?.querySelector('[data-compare-readout]')?.textContent || '',
          decodeW: img?.naturalWidth || 0,
          decodeH: img?.naturalHeight || 0,
          stageW: Math.round(stage?.getBoundingClientRect().width || 0),
          viewer: Boolean(stage),
        };
      })()`);
      if (await cdp.eval(`(${predicate})(${JSON.stringify(last)})`)) return last;
      await sleep(200);
    }
    return last;
  };

  /* --- 3a. IIIF deep zoom (region requests) ---------------------------- */
  const singleSheet = await cdp.eval(`(() => { const nav = document.querySelector('#page-nav'); return { nav: nav?.hidden, display: nav ? getComputedStyle(nav).display : null, label: document.querySelector('#page-label')?.textContent }; })()`);
  check('sheet navigation is hidden for a single-sheet record', singleSheet.nav === true && singleSheet.display === 'none', JSON.stringify(singleSheet));

  const fullSheetSrc = await cdp.eval(`document.querySelector('.app-viewer__image')?.src || ''`);
  await cdp.eval(`document.querySelector('#viewer-zoom-in').click(); document.querySelector('#viewer-zoom-in').click(); true`);
  // Region requests are debounced and then only reflected in `img.src` once the
  // bitmap has decoded; e-rara latency varies a lot, so wait for the state
  // instead of guessing a delay (a fixed sleep made this check flaky).
  const zoomed = await waitForViewer('(v) => v.decoded && !v.src.includes("/full/") && v.src.includes(",")');
  check(
    'detail viewer asks the image service for the visible region (deep zoom)',
    /e-rara\.ch\/i3f\/v\d+\/\d+\/\d+,\d+,\d+,\d+\/\d+,\/0\/default\.jpg$/.test(zoomed.src) && zoomed.decodeW >= Math.min(300, zoomed.stageW),
    JSON.stringify(zoomed).slice(0, 220),
  );
  check('viewer reports the real resolution and cut-out', /Resolution \d+ %/.test(zoomed.readout) && /Region/.test(zoomed.readout), zoomed.readout);
  await cdp.screenshot(path.join(OUT_DIR, '02b-detail-zoom.png')).then(() => report.screenshots.push('02b-detail-zoom.png'));

  // A real click focuses the stage, like a keyboard user tabbing into it.
  await cdp.click('#viewer-stage');
  await cdp.pressKey('ArrowRight');
  await cdp.pressKey('ArrowRight');
  const focusBefore = await cdp.eval(`document.activeElement?.id || document.activeElement?.tagName`);
  const panned = await waitForViewer(`(v) => v.decoded && v.src !== ${JSON.stringify(zoomed.src)}`);
  check('clicking the preview focuses the stage (keyboard route in)', focusBefore === 'viewer-stage', String(focusBefore));
  check('viewer pans with the arrow keys', panned.src !== zoomed.src && /\d+,\d+,\d+,\d+\//.test(panned.src), panned.src.slice(-60));

  await cdp.pressKey('Home');
  const reset = await waitForViewer(`(v) => v.decoded && v.src === ${JSON.stringify(fullSheetSrc)}`);
  const resetSrc = reset.src;
  check('Home returns to the whole sheet', resetSrc === fullSheetSrc && /\/full\//.test(resetSrc), resetSrc.slice(-60));

  /* --- 3a2. the visible region is shareable state (?vv=x,y,w,h) -------- */
  await cdp.eval(`document.querySelector('#viewer-zoom-in').click(); document.querySelector('#viewer-zoom-in').click(); true`);
  await waitForViewer('(v) => v.decoded && /\\d+,\\d+,\\d+,\\d+\\//.test(v.src) && !v.src.includes("/full/")');
  // The viewer writes the region into the URL debounced (a drag must not rewrite
  // history on every frame), so wait for the write instead of reading once.
  const regionState = await cdp
    .waitFor(
      `(() => {
        const src = document.querySelector('.app-viewer__image')?.src || '';
        const region = (src.match(/\\/(\\d+,\\d+,\\d+,\\d+)\\//) || [])[1] || null;
        const search = decodeURIComponent(location.search);
        if (!region || !search.includes('vv=' + region)) return '';
        return { search, region, readout: document.querySelector('#viewer-resolution')?.textContent || '' };
      })()`,
      { label: 'shareable viewer region in the URL', timeout: 15_000 },
    )
    .catch(() => null);
  const regionSearch = regionState?.search ?? (await cdp.eval(`decodeURIComponent(location.search)`));
  check(
    'the visible viewer region is shareable (?vv=)',
    Boolean(regionState?.region) && regionState.search.includes(`vv=${regionState.region}`),
    JSON.stringify(regionState).slice(0, 220),
  );
  // `window.__kzBefore` proves the assertions below run in the reloaded document
  // (the old one is briefly still there after Page.navigate).
  await cdp.eval(`window.__kzBefore = 1`);
  await cdp.send('Page.navigate', { url: `${BASE_URL}/${regionSearch}` });
  await cdp.waitFor(`document.readyState === 'complete' && !window.__kzBefore`, { label: 'reload of the shared ?vv= link', timeout: 30_000 });
  const restoredRegion = await waitForViewer(`(v) => v.decoded && v.src.includes(${JSON.stringify(regionState?.region ?? '')})`, 30_000);
  check(
    'a shared ?vv= link reopens the same cut-out',
    Boolean(regionState?.region) && restoredRegion.src.includes(regionState.region) && restoredRegion.readout === regionState.readout,
    `${restoredRegion.readout} · ${restoredRegion.src.slice(-44)}`,
  );
  // A hand-edited region this viewer could never produce (off the sheet and far
  // smaller than the deepest zoom) must not open a random corner: the whole
  // sheet is shown and the unusable value is dropped from the URL.
  const impossible = new URLSearchParams(regionSearch);
  impossible.set('vv', '999999,999999,5,5');
  await cdp.eval(`window.__kzBefore = 1`);
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?${impossible}` });
  await cdp.waitFor(`document.readyState === 'complete' && !window.__kzBefore`, { label: 'reload with an impossible ?vv= value', timeout: 30_000 });
  const regionFallback = await waitForViewer('(v) => v.decoded && /Whole sheet/.test(v.readout)', 30_000);
  const fallbackSearch = await cdp.eval(`location.search`);
  check(
    'an impossible ?vv= value shows the whole sheet and is dropped',
    /Whole sheet/.test(regionFallback.readout) && !/(?:^|&)vv=/.test(fallbackSearch),
    `${regionFallback.readout} · ${fallbackSearch}`,
  );
  await cdp.screenshot(path.join(OUT_DIR, '02c-region-permalink.png')).then(() => report.screenshots.push('02c-region-permalink.png'));
  // The reload left the focus on <body>; a keyboard user reaches the panel again
  // by clicking/tabbing into the viewer (Escape is handled by the panel).
  await cdp.click('#viewer-stage');

  await cdp.pressKey('Escape');
  const closed = await cdp.eval(`document.querySelector('#detail')?.hidden`);
  check('Escape closes the detail panel', closed === true);
  check('closing the panel clears the region from the URL', !/(?:^|&)vv=/.test(await cdp.eval(`location.search`)), await cdp.eval(`location.search`));
  check('detail selection is shareable', /sel=/.test(await cdp.eval(`location.search`)), await cdp.eval(`location.search`));

  /* --- 3b. swisstopo comparison layer (real georeferenced tiles) -------- */
  const overlayApplied = await cdp.eval(`(() => {
    const select = document.querySelector('#overlay-select');
    if (!select) return null;
    const option = [...select.options].filter((o) => o.value).find((o) => o.value === 'ch.swisstopo.zeitreihen') ?? [...select.options].find((o) => /hiks|zeitreihen/.test(o.value));
    if (!option) return null;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return option.value;
  })()`);
  await sleep(3500);
  const overlayTiles = await cdp.eval(`document.querySelectorAll('#map .map-layer--overlay img').length`);
  check('historical Zeitreise layer renders georeferenced WMTS tiles', Boolean(overlayApplied) && overlayTiles > 0, `${overlayApplied} → ${overlayTiles} tiles`);
  const timeControl = await cdp.eval(`(() => { const f = document.querySelector('#overlay-time-field'), i = document.querySelector('#overlay-time'); return f && i ? { hidden: f.hidden, min: i.min, max: i.max, value: i.value } : null; })()`);
  check(
    'comparison layer exposes its documented editions',
    Boolean(timeControl) && !timeControl.hidden && Number(timeControl.max) >= 1,
    JSON.stringify(timeControl),
  );
  const contrastWithOverlay = await cdp.eval(CONTRAST_SWEEP);
  check('active comparison layer keeps its attribution legible', contrastWithOverlay.badCount === 0, describeContrast(contrastWithOverlay));

  await cdp.screenshot(path.join(OUT_DIR, '04-zeitreise.png')).then(() => report.screenshots.push('04-zeitreise.png'));
  await cdp.eval(`(() => { const s = document.querySelector('#overlay-select'); if (s) { s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); } return true; })()`);
  await sleep(500);

  /* --- 4. place search (Worker -> swisstopo) ---------------------------- */
  const moduleReport = await cdp.eval(`(() => ({
    ready: document.documentElement.dataset.app || '',
    modules: document.querySelectorAll('[data-module]').length,
  }))()`);
  const loadedLine = appInfo.find((line) => /Modul\(e\)|modules/i.test(line)) || '';
  const failedModules = consoleMessages.filter((m) => /not available/.test(m.text)).map((m) => m.text.slice(0, 90));
  check(
    'every UI module initialises',
    failedModules.length === 0 && /map|search|results|detail/.test(loadedLine + JSON.stringify(moduleReport)),
    failedModules.length ? failedModules.join(' | ') : `${loadedLine.slice(0, 120)} ${JSON.stringify(moduleReport)}`,
  );

  const quickPicks = await cdp.eval(`document.querySelectorAll('#place-quick .zh-chip').length`);
  check('place search offers keyboard-reachable quick picks', quickPicks >= 3, `${quickPicks} chips`);

  const typed = await cdp.typeInto('#place-input', 'Rheinau');
  let suggestions = null;
  try {
    await cdp.waitFor(
      `(() => { const l = document.querySelector('#place-suggestions'); return l && !l.hidden && l.querySelectorAll('li').length > 0; })()`,
      { label: 'place suggestions', timeout: 12_000 },
    );
  } catch {
    /* reported below with diagnostics */
  }
  suggestions = await cdp.eval(`(() => {
    const list = document.querySelector('#place-suggestions');
    return list ? { hidden: list.hidden, items: list.querySelectorAll('li, option').length, text: list.textContent.trim().slice(0, 120), input: document.querySelector('#place-input').value, status: document.querySelector('#place-status').textContent.trim().slice(0, 120) } : null;
  })()`);
  check(
    'place search reaches the swisstopo search service',
    Boolean(suggestions && (suggestions.items > 0 || /Rheinau/.test(suggestions.text))),
    `${JSON.stringify(suggestions)} (typed "${typed}")`,
  );

  // Choose the first suggestion with the keyboard: the map must re-centre and the
  // place has to survive in the URL (shareable state).
  await cdp.pressKey('ArrowDown');
  await cdp.pressKey('Enter');
  await sleep(1200);
  const placeChosen = await cdp.eval(`(() => ({ search: location.search, label: document.querySelector('#place-input').value, listHidden: document.querySelector('#place-suggestions').hidden }))()`);
  check(
    'keyboard selection of a suggestion sets the shared map place',
    Boolean(placeChosen.label) && /place=/.test(placeChosen.search) && placeChosen.listHidden,
    JSON.stringify(placeChosen),
  );

  /* --- 5. keyboard map control ----------------------------------------- */
  const keyboard = await cdp.eval(`(() => {
    const map = document.querySelector('#map');
    map.focus();
    return { focused: document.activeElement === map, tabindex: map.getAttribute('tabindex') };
  })()`);
  check('map is keyboard focusable', keyboard.focused && keyboard.tabindex === '0', JSON.stringify(keyboard));
  const searchBefore = await cdp.eval(`location.search`);
  await cdp.pressKey('ArrowRight');
  await cdp.pressKey('ArrowRight');
  await sleep(600);
  const searchAfter = await cdp.eval(`location.search`);
  check('arrow keys pan the map and update URL state', searchBefore !== searchAfter, `${searchBefore} -> ${searchAfter}`);

  /* --- 6. reload reproduces the shared state --------------------------- */
  const shared = await cdp.eval(`location.href`);
  await cdp.send('Page.navigate', { url: shared });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'reload results' });
  const restored = await cdp.eval(`(() => ({ rows: document.querySelectorAll('#result-list > *').length, to: document.querySelector('#year-to')?.value, sel: document.querySelector('#detail')?.hidden === false }))()`);
  check('a shared URL reproduces the filters', restored.to === '1850' && restored.rows === afterCount, JSON.stringify(restored));
  check('a shared ?sel= URL reopens the detail panel', restored.sel === true, JSON.stringify(restored));

  /* --- 6b. detail → time filter hand-off ------------------------------- */
  // Read the year from the panel itself: the first record in the current result
  // set changes whenever the seed grows, so a hard-coded year would make this
  // check fail for reasons that have nothing to do with the hand-off.
  const periodExpected = await cdp.eval(`(() => {
    const text = document.querySelector('#detail')?.textContent || '';
    const m = text.match(/Publication year\\s*(\\d{4})(?:\\s*[–-]\\s*(\\d{4}))?/);
    return m ? { from: m[1], to: m[2] || m[1] } : null;
  })()`);
  const periodButton = await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('#detail button')].find((b) => /Zeitraum/.test(b.textContent));
    if (!button) return null;
    button.click();
    return true;
  })()`);
  await sleep(900);
  const appliedPeriod = await cdp.eval(`(() => ({ from: document.querySelector('#year-from')?.value, to: document.querySelector('#year-to')?.value, panelHidden: document.querySelector('#detail')?.hidden, count: document.querySelectorAll('#result-list > *').length, state: document.querySelector('#results-live')?.textContent || '' }))()`);
  check(
    'the detail panel can push its own period into the time filter',
    periodButton === true &&
      appliedPeriod.panelHidden === true &&
      appliedPeriod.count >= 1 &&
      appliedPeriod.state.length > 0 &&
      (periodExpected
        ? appliedPeriod.from === periodExpected.from && appliedPeriod.to === periodExpected.to
        : appliedPeriod.from === appliedPeriod.to),
    `${JSON.stringify(appliedPeriod)} expected ${JSON.stringify(periodExpected)}`,
  );

  /* --- 7. mobile layout ------------------------------------------------- */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'mobile results' });
  await sleep(800);
  const mobile = await cdp.eval(`(() => ({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    mapHeight: document.querySelector('#map')?.getBoundingClientRect().height || 0,
    searchVisible: (() => { const r = document.querySelector('#place-input')?.getBoundingClientRect(); return Boolean(r && r.width > 100 && r.top < window.innerHeight * 2); })(),
    rows: document.querySelectorAll('#result-list > *').length,
  }))()`);
  check('mobile layout has no horizontal overflow', mobile.overflow <= 1, `overflow ${mobile.overflow}px`);
  check('mobile keeps map, search and results reachable', mobile.mapHeight > 150 && mobile.searchVisible && mobile.rows > 0, JSON.stringify(mobile));
  await cdp.screenshot(path.join(OUT_DIR, '03-mobile.png')).then(() => report.screenshots.push('03-mobile.png'));

  /* --- 7b. touch: the detail viewer must zoom and pan without a mouse ---- */
  await cdp.click('#result-list > *');
  await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'mobile IIIF viewer', timeout: 25_000 });
  // On a phone the preview must not sit behind a stack of buttons; the workflow
  // actions (period filter, permalink, overlay) now follow the viewer.
  const mobileDetail = await cdp.eval(`(() => {
    const body = document.querySelector('#detail-body');
    const stage = document.querySelector('#viewer-stage');
    const r = stage?.getBoundingClientRect();
    return {
      stageTop: r ? Math.round(r.top) : null,
      viewport: window.innerHeight,
      scrollTop: Math.round(body?.scrollTop ?? 0),
      secondaryBelow: Boolean(document.querySelector('#detail-preview + .app-detail__actions--secondary')),
      primaryButtons: document.querySelectorAll('.app-detail__actions--primary > *').length,
      secondaryButtons: document.querySelectorAll('.app-detail__actions--secondary > *').length,
    };
  })()`);
  check(
    'mobile detail: the viewer starts within the first screen',
    mobileDetail.stageTop !== null && mobileDetail.stageTop < mobileDetail.viewport && mobileDetail.secondaryBelow && mobileDetail.primaryButtons <= 4 && mobileDetail.secondaryButtons >= 2,
    JSON.stringify(mobileDetail),
  );
  // Real touch input: turn on touch emulation (synthetic `dispatchTouchEvent`
  // sequences are delivered inconsistently without it) and record what the page
  // sees, so a failure here is diagnosable instead of "nothing happened".
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const touchBox = await cdp.eval(`(() => { const r = document.querySelector('#viewer-stage').getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
  const touchPoint = (x, y, id) => ({ x: Math.round(x), y: Math.round(y), id, radiusX: 12, radiusY: 12, force: 1 });
  const beforeTouch = await cdp.eval(`(() => {
    const img = document.querySelector('.app-viewer__image');
    const stage = document.querySelector('#viewer-stage');
    window.__viewerInput = { down: 0, move: 0, up: 0, cancel: 0, changes: [] };
    for (const [type, key] of [['pointerdown', 'down'], ['pointermove', 'move'], ['pointerup', 'up'], ['pointercancel', 'cancel']])
      stage.addEventListener(type, () => { window.__viewerInput[key] += 1; }, true);
    if (img)
      new MutationObserver(() => window.__viewerInput.changes.push({ t: Date.now(), src: img.src.slice(-52), state: stage.dataset.state })).observe(img, {
        attributes: true,
        attributeFilter: ['src'],
      });
    return img?.src || '';
  })()`);
  const waitForViewerChange = (from, label, timeout) =>
    cdp.waitFor(
      `(() => { const src = document.querySelector('.app-viewer__image')?.src || ''; return src !== ${JSON.stringify(from)} && document.querySelector('#viewer-stage')?.dataset.state === 'ready' ? src : ''; })()`,
      { label, timeout },
    );
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(touchBox.cx - 40, touchBox.cy, 1), touchPoint(touchBox.cx + 40, touchBox.cy, 2)] });
  for (let step = 1; step <= 6; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [touchPoint(touchBox.cx - 40 - step * 16, touchBox.cy, 1), touchPoint(touchBox.cx + 40 + step * 16, touchBox.cy, 2)],
    });
    await sleep(60);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  let afterPinch = beforeTouch;
  let pinchError = '';
  try {
    // A pinch asks the viewer for a zoomed region; the provider then serves a
    // fresh cut-out (up to ~24 MP on the largest e-rara sheets), which can take
    // a while. 10 s was too tight once the seed grew (80 records, 2026-10-18);
    // the viewer keeps the old bitmap until the new region is decoded, so a
    // short wait fails on a slow provider, not on a broken gesture.
    afterPinch = await waitForViewerChange(beforeTouch, 'pinch region', 25_000);
  } catch (err) {
    pinchError = err.message;
  }
  const pinchInfo = await cdp.eval(
    `(() => ({ ...window.__viewerInput, readout: document.querySelector('#preview-meta')?.textContent || '', state: document.querySelector('#viewer-stage')?.dataset.state || '' }))()`,
  );
  const regionOf = (url) => {
    const m = /\/(\d+),(\d+),(\d+),(\d+)\/\d+,/.exec(url || '');
    return m ? { x: +m[1], y: +m[2], w: +m[3], h: +m[4] } : null;
  };
  const fullOf = (text) => {
    const m = /Original (\d+)×(\d+)/.exec(text || '');
    return m ? { w: +m[1], h: +m[2] } : null;
  };
  const pinchedRegion = regionOf(afterPinch);
  const beforeRegion = regionOf(beforeTouch);
  const sheet = fullOf(pinchInfo.readout) ?? fullOf(beforeTouch);
  const zoomedIn =
    Boolean(pinchedRegion) &&
    (!beforeRegion || pinchedRegion.w * pinchedRegion.h < beforeRegion.w * beforeRegion.h * 0.95) &&
    (!sheet || pinchedRegion.w * pinchedRegion.h < sheet.w * sheet.h * 0.6);
  check(
    'touch: pinch-zoom asks for a smaller IIIF region',
    afterPinch !== beforeTouch && zoomedIn,
    `${beforeTouch.slice(-46)} -> ${afterPinch.slice(-46)} · down/move/up ${pinchInfo.down}/${pinchInfo.move}/${pinchInfo.up} state=${pinchInfo.state} ${pinchError}`,
  );
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(touchBox.cx, touchBox.cy, 1)] });
  for (let step = 1; step <= 5; step += 1) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(touchBox.cx - step * 14, touchBox.cy - step * 9, 1)] });
    await sleep(60);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  let afterDrag = afterPinch;
  let dragError = '';
  try {
    afterDrag = await waitForViewerChange(afterPinch, 'drag region', 25_000);
  } catch (err) {
    dragError = err.message;
  }
  const dragInfo = await cdp.eval(`({ ...window.__viewerInput, readout: document.querySelector('#preview-meta')?.textContent || '' })`);
  check(
    'touch: one-finger drag pans the sheet',
    afterDrag !== afterPinch,
    `${afterPinch.slice(-46)} -> ${afterDrag.slice(-46)} · moves ${dragInfo.move} ${dragError} ${imageRequests.slice(-2).join(' ')}`,
  );
  await cdp.screenshot(path.join(OUT_DIR, '03b-mobile-viewer.png')).then(() => report.screenshots.push('03b-mobile-viewer.png'));

  /* --- 7c. very narrow phone (320 px, the smallest cantonal breakpoint) -- */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: '320 px results' });
  await sleep(800);
  const narrow = await cdp.eval(`(() => ({
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    histogram: Math.round(document.querySelector('#year-histogram')?.getBoundingClientRect().width || 0),
    bins: document.querySelectorAll('#year-histogram button').length,
    collection: Math.round(document.querySelector('#collection-filter')?.getBoundingClientRect().width || 0),
    rows: document.querySelectorAll('#result-list > *').length,
  }))()`);
  check(
    '320 px: no horizontal overflow, chart and facets stay usable',
    narrow.overflow <= 1 && narrow.bins > 5 && narrow.histogram >= 200 && narrow.collection > 150 && narrow.rows > 0,
    JSON.stringify(narrow),
  );
  await cdp.screenshot(path.join(OUT_DIR, '03c-mobile-320.png')).then(() => report.screenshots.push('03c-mobile-320.png'));

  // The multi-column list view must also survive the narrowest breakpoint: its
  // `minmax(320px, …)` track once forced a 12 px horizontal overflow here.
  const narrowList = await cdp.eval(`(() => {
    document.querySelector('[data-view="list"]')?.click();
    return {
      view: document.body.className,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      rows: document.querySelectorAll('#result-list > *').length,
    };
  })()`);
  check(
    '320 px: list-only view does not overflow horizontally',
    narrowList.view.includes('app-view--list') && narrowList.overflow <= 1 && narrowList.rows > 0,
    JSON.stringify(narrowList),
  );

  /* --- 8. WCAG 2.2 AA contrast sweep of the visible UI ------------------ */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'contrast sweep page' });
  await sleep(1200);
  const contrast = await cdp.eval(CONTRAST_SWEEP);
  check('visible text meets WCAG 2.2 AA contrast', contrast.badCount === 0, describeContrast(contrast));

  /* --- 8b. a shared link with a collection filter ----------------------- */
  if (collectionChoice?.value) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1816&to=1850&c=${encodeURIComponent(collectionChoice.value)}` });
    await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'collection deep link' });
    const deepLink = await cdp.eval(`(() => ({
      value: document.querySelector('#collection-filter')?.value,
      rows: document.querySelectorAll('#result-list > *').length,
      count: document.querySelector('#result-count')?.textContent || '',
    }))()`);
    check(
      'a shared link with ?c= restores the collection filter',
      deepLink.value === collectionChoice.value && deepLink.rows > 0 && deepLink.count.includes(collectionChoice.value),
      JSON.stringify(deepLink),
    );
  }

  /* --- 8c. comparison list and side-by-side view ------------------------ */
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'compare page' });
  await sleep(600);

  /** Select result `index`, pin it, and report the resulting shareable state. */
  const pinResult = async (index) => {
    await cdp.pressKey('Escape'); // close detail/compare overlays from the previous round
    await sleep(300);
    await cdp.click('#result-list > *', { index });
    await cdp.waitFor(`document.querySelector('#detail') && !document.querySelector('#detail').hidden`, { label: `detail for result ${index}` });
    await sleep(400);
    await cdp.pressKey('Escape'); // the panel overlays the compare list
    await sleep(300);
    await cdp.eval(`(() => { const panel = document.querySelector('#compare-panel'); if (panel) panel.open = true; return true; })()`);
    await sleep(200);
    await cdp.click('#compare-add');
    await sleep(500);
    return cdp.eval(`(() => {
      const params = new URLSearchParams(location.search);
      return {
        cmp: params.get('cmp') || '',
        status: document.querySelector('#compare-status')?.textContent || '',
        add: document.querySelector('#compare-add')?.textContent || '',
        toolbarHidden: document.querySelector('#compare-open')?.hidden,
        listItems: document.querySelectorAll('#compare-list .app-compare__item').length,
      };
    })()`);
  };

  // The coupling in 8c2 maps the visible region through the extents the
  // catalogue documents, so it can only keep “the same place” between sheets of
  // a comparable scale. The seed's first rows are no longer two such sheets: the
  // world set (1787–1914) sorts first, and a cut-out of a world map covers a city
  // sheet whole — the mapping is degenerate and nothing should move. Pin two
  // sheets whose documented spans are within a factor of four and that overlap,
  // so the check tests the promised coupling; the degenerate pair is what 8c4
  // asserts instead.
  const listIds = await cdp.eval(`[...document.querySelectorAll('#result-list > *')].map((row) => (row.querySelector('button[data-record-id]') || row).dataset?.recordId || row.dataset?.recordId || '')`);
  const rowOf = new Map(listIds.map((id, index) => [id, index]));
  const spanOf = (record) => {
    const box = record?.extent;
    return box && Number.isFinite(box.east) ? Math.max(Math.abs(box.east - box.west), Math.abs(box.north - box.south)) : 0;
  };
  const overlapOf = (a, b) => a.west < b.east && b.west < a.east && a.south < b.north && b.south < a.north;
  const pickPair = (maxSpan) => {
    const candidates = [...recordIndex.values()].filter(
      (record) => record.iiifManifest && record.extent && rowOf.has(record.id) && spanOf(record) <= maxSpan,
    );
    for (const first of candidates) {
      for (const second of candidates) {
        if (first.id === second.id) continue;
        const ratio = spanOf(first) / spanOf(second);
        if (ratio < 0.25 || ratio > 4 || !overlapOf(first.extent, second.extent)) continue;
        return [first, second];
      }
    }
    return null;
  };
  // Prefer two regional sheets (faster to load, and the check then measures the
  // coupling the seed's Zürich maps promise), fall back to any comparable pair.
  const couplingPair = pickPair(6) ?? pickPair(Infinity);
  const couplingRows = couplingPair ? [rowOf.get(couplingPair[0].id), rowOf.get(couplingPair[1].id)] : [0, 1];
  const pinOne = await pinResult(couplingRows[0]);
  const pinTwo = await pinResult(couplingRows[1]);
  const pinnedIds = (pinTwo.cmp || pinOne.cmp).split(',').filter(Boolean);
  check(
    'compare: two records can be pinned and the list is shareable',
    pinnedIds.length === 2 &&
      pinTwo.listItems === 2 &&
      pinTwo.toolbarHidden === false &&
      /gemerkt/.test(pinTwo.status) &&
      new URLSearchParams(await cdp.eval(`location.search`)).get('cmp') === pinnedIds.join(','),
    `${pinnedIds.join(' + ')} · status: ${pinTwo.status.slice(0, 60)}`,
  );

  await cdp.click('#compare-open');
  await cdp.waitFor(`document.querySelector('#compare-view') && !document.querySelector('#compare-view').hidden`, { label: 'compare view', timeout: 10_000 });
  try {
    // Each pane is ready when its own image has decoded: an interactive IIIF
    // pane reports `data-state="ready"` once the requested region arrived, a
    // record without a manifest is ready when its raster tile decoded.
    await cdp.waitFor(
      `(() => {
        const panes = [...document.querySelectorAll('#compare-view-body .app-compare__pane')];
        if (panes.length < 2) return false;
        return panes.every((pane) => {
          const stage = pane.querySelector('[data-compare-stage]');
          const img = pane.querySelector('img');
          if (stage) return stage.dataset.state === 'ready' && img && img.complete && img.naturalWidth > 0;
          return img && img.complete && img.naturalWidth > 0;
        });
      })()`,
      { label: 'compare panes ready', timeout: 60_000 },
    );
  } catch {
    /* the assertions below report the panes that did (not) load */
  }
  const panes = await cdp.eval(`(() => [...document.querySelectorAll('#compare-view-body .app-compare__pane')].map((pane) => {
    const stage = pane.querySelector('[data-compare-stage]');
    const img = pane.querySelector('img');
    return {
      title: pane.querySelector('h3')?.textContent || '',
      caption: (pane.querySelector('figcaption')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      viewer: Boolean(stage),
      state: stage?.dataset.state ?? null,
      img: img ? { src: img.src, w: img.naturalWidth, h: img.naturalHeight } : null,
      readout: pane.querySelector('[data-compare-readout]')?.textContent || '',
      link: pane.querySelector('a[href]')?.href || '',
    };
  }))()`);
  const paneRecords = pinnedIds.map((id) => recordIndex.get(id));
  const paneProblems = panes
    .map((pane, index) => {
      const record = paneRecords[index];
      if (!record) return `${index}: no seed record`;
      if (pane.title !== record.title) return `${index}: title "${pane.title}" != "${record.title}"`;
      const minWidth = pane.viewer ? 200 : 1000;
      if (!pane.img || pane.img.w < minWidth || pane.img.h < 200) return `${index}: image ${pane.img ? `${pane.img.w}×${pane.img.h}` : 'missing'}`;
      if (pane.viewer && !/\/i3f\/v\d+\/\d+\//.test(pane.img.src)) return `${index}: viewer image is not a IIIF request (${pane.img.src.slice(0, 60)})`;
      if (!/^https?:\/\//.test(pane.link)) return `${index}: no source link`;
      if (record.institution && !pane.caption.includes(record.institution)) return `${index}: caption misses ${record.institution}`;
      return null;
    })
    .filter(Boolean);
  check(
    'compare view shows both sheets with real images and source links',
    panes.length === 2 && paneProblems.length === 0,
    paneProblems.length
      ? paneProblems.join(' | ')
      : panes.map((pane) => `${pane.title.slice(0, 24)}:${pane.viewer ? 'viewer ' : ''}${pane.img.w}×${pane.img.h}`).join(' | '),
  );

  /* --- 8c2. the comparison panes are coupled viewers -------------------- */
  const coupledUi = await cdp.eval(`(() => {
    const button = document.querySelector('#compare-sync');
    return {
      stages: document.querySelectorAll('#compare-view-body [data-compare-stage]').length,
      pressed: button?.getAttribute('aria-pressed') ?? null,
      hidden: button?.hidden ?? null,
      text: button?.textContent ?? '',
      label: button?.getAttribute('aria-label') ?? '',
      hint: document.querySelector('#compare-sync-hint')?.textContent ?? '',
      readouts: [...document.querySelectorAll('[data-compare-readout]')].map((node) => node.textContent),
    };
  })()`);
  check(
    'the comparison mounts a real IIIF viewer per pane and offers the coupling switch',
    coupledUi.stages === 2 && coupledUi.pressed === 'true' && coupledUi.hidden === false && /linked/.test(coupledUi.text) && /Unlink/.test(coupledUi.label) && coupledUi.readouts.every((text) => text.length > 0),
    JSON.stringify(coupledUi).slice(0, 260),
  );

  const pane1Before = await cdp.eval(`document.querySelectorAll('#compare-view-body .app-viewer__image')[0]?.src || ''`);
  const pane2Before = await cdp.eval(`document.querySelectorAll('#compare-view-body .app-viewer__image')[1]?.src || ''`);
  await cdp.eval(`document.querySelector('[data-compare-stage="0"]').focus(); true`);
  await cdp.pressKey('+', { keyCode: 187 });
  await cdp.pressKey('+', { keyCode: 187 });
  // Both panes fetch their own region on a debounce, so the followed pane can
  // arrive before the source pane's own request does. Wait for the source too.
  const paneOneZoomed = await waitForComparePane(0, `(pane) => pane.decoded && pane.src !== ${JSON.stringify(pane1Before)}`, 40_000).catch(() => null);
  const followed = await waitForComparePane(
    1,
    `(pane) => pane.decoded && pane.src !== ${JSON.stringify(pane2Before)} && /Region/.test(pane.readout)`,
    40_000,
  ).catch(() => null);
  const pane1After = await cdp.eval(`document.querySelectorAll('#compare-view-body .app-viewer__image')[0]?.src || ''`);
  check(
    'zooming one pane follows in the other (coupled through the documented extent)',
    Boolean(paneOneZoomed) && Boolean(followed) && pane1After !== pane1Before && followed.src !== pane2Before && /Region \d+×\d+/.test(followed.readout),
    `pane 1 ${pane1Before.slice(-32)} -> ${pane1After.slice(-32)} · pane 2 ${pane2Before.slice(-32)} -> ${followed ? followed.src.slice(-32) : 'unchanged'} (${followed?.readout ?? 'no readout'})`,
  );
  await cdp.screenshot(path.join(OUT_DIR, '11-compare-coupled.png')).then(() => report.screenshots.push('11-compare-coupled.png'));

  await cdp.click('#compare-sync');
  await sleep(300);
  const uncoupledUi = await cdp.eval(`({ pressed: document.querySelector('#compare-sync')?.getAttribute('aria-pressed'), text: document.querySelector('#compare-sync')?.textContent, hint: document.querySelector('#compare-sync-hint')?.textContent })`);
  const pane1Decoupled = await cdp.eval(`document.querySelectorAll('#compare-view-body .app-viewer__image')[0]?.src || ''`);
  await cdp.eval(`document.querySelector('[data-compare-stage="0"]').focus(); true`);
  await cdp.pressKey('+', { keyCode: 187 });
  const decoupledWait = await waitForComparePane(0, `(pane) => pane.decoded && pane.src !== ${JSON.stringify(pane1Decoupled)}`, 40_000).catch(() => null);
  await sleep(1500); // give a wrong coupling the same time to arrive in pane 2
  const decoupled = await cdp.eval(`({ pane2: document.querySelectorAll('#compare-view-body .app-viewer__image')[1]?.src || '', pane2Readout: document.querySelector('[data-compare-readout]')?.textContent || '' })`);
  check(
    'the coupling switch decouples the panes again',
    uncoupledUi.pressed === 'false' && /koppeln/.test(uncoupledUi.text) && Boolean(decoupledWait) && decoupled.pane2 === followed?.src,
    `${JSON.stringify(uncoupledUi)} · pane 2 stayed on ${decoupled.pane2.slice(-32)}`,
  );

  // 390 px: the comparison stacks, stays inside the page and keeps the switch
  // reachable (the panes are real viewers now, so their height matters).
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(800);
  const mobileCompare = await cdp.eval(`(() => {
    const body = document.querySelector('#compare-view-body');
    const panes = [...document.querySelectorAll('#compare-view-body .app-compare__pane')].map((pane) => pane.getBoundingClientRect());
    const button = document.querySelector('#compare-sync')?.getBoundingClientRect();
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      bodyOverflow: body ? body.scrollWidth - body.clientWidth : 0,
      stacked: panes.length === 2 && panes[1].top > panes[0].bottom - 1,
      stageHeights: [...document.querySelectorAll('[data-compare-stage]')].map((stage) => Math.round(stage.getBoundingClientRect().height)),
      switchVisible: Boolean(button && button.width > 40 && button.height > 20),
      switchLabel: document.querySelector('#compare-sync')?.textContent || '',
    };
  })()`);
  check(
    '390 px: the comparison stacks and keeps the coupling switch reachable',
    mobileCompare.overflow <= 1 &&
      mobileCompare.bodyOverflow <= 1 &&
      mobileCompare.stacked &&
      mobileCompare.stageHeights.length === 2 &&
      mobileCompare.stageHeights.every((height) => height >= 180) &&
      mobileCompare.switchVisible,
    JSON.stringify(mobileCompare),
  );
  await cdp.screenshot(path.join(OUT_DIR, '11b-compare-mobile.png')).then(() => report.screenshots.push('11b-compare-mobile.png'));
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);

  await cdp.pressKey('Escape');
  await sleep(500);
  const compareClosed = await cdp.eval(`document.querySelector('#compare-view')?.hidden === true`);
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?cmp=${encodeURIComponent(pinnedIds.join(','))}` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'shared compare link' });
  await sleep(600);
  const sharedCompare = await cdp.eval(`(() => ({
    open: document.querySelector('#compare-panel')?.open === true,
    items: document.querySelectorAll('#compare-list .app-compare__item').length,
    toolbar: document.querySelector('#compare-open')?.hidden === false,
    status: document.querySelector('#compare-status')?.textContent || '',
  }))()`);
  check(
    'a shared ?cmp= link restores the comparison list',
    compareClosed && sharedCompare.open && sharedCompare.items === 2 && sharedCompare.toolbar,
    `${compareClosed ? 'closed' : 'still open'} -> ${JSON.stringify(sharedCompare)}`,
  );

  /* --- 8c3. the cut-outs are shareable state of their own (cvv) --------- */
  const comparePaneSelector = '#compare-view-body .app-viewer__image';
  const readyPanes = `(() => {
    const panes = [...document.querySelectorAll('#compare-view-body .app-compare__pane')];
    return panes.length === 2 && panes.every((pane) => pane.querySelector('[data-compare-stage]')?.dataset.state === 'ready');
  })()`;
  const resetButtons = `[...document.querySelectorAll('#compare-view-body [data-compare-reset]')].map((button) => ({ text: button.textContent, disabled: button.disabled }))`;
  await cdp.click('#compare-open');
  await cdp.waitFor(`document.querySelector('#compare-view') && !document.querySelector('#compare-view').hidden`, { label: 'compare view from a shared list', timeout: 10_000 });
  await cdp.waitFor(readyPanes, { label: 'panes ready for the cut-out check', timeout: 60_000 }).catch(() => null);

  const resetBefore = await cdp.eval(resetButtons);
  const paneOneBefore = await cdp.eval(`document.querySelectorAll('${comparePaneSelector}')[0]?.src || ''`);
  await cdp.eval(`document.querySelector('[data-compare-stage="0"]').focus(); true`);
  await cdp.pressKey('+', { keyCode: 187 });
  await cdp.pressKey('+', { keyCode: 187 });
  const zoomedPane = await waitForComparePane(
    0,
    `(pane) => pane.decoded && /Region/.test(pane.readout) && pane.src !== ${JSON.stringify(paneOneBefore)}`,
    40_000,
  ).catch(() => null);
  // The viewer reports its region debounced (400 ms), and the URL write after it.
  const cutout = await cdp
    .waitFor(
      `(() => {
        const value = new URLSearchParams(location.search).get('cvv') || '';
        const img = document.querySelectorAll('${comparePaneSelector}')[0];
        const region = (img?.src || '').split('/').find((part) => /^\\d+,\\d+,\\d+,\\d+$/.test(part)) || '';
        return value && region ? { value, region, readout: document.querySelectorAll('[data-compare-readout]')[0]?.textContent || '' } : null;
      })()`,
      { label: 'the pane cut-out lands in cvv', timeout: 10_000 },
    )
    .catch(() => null);
  check(
    'zooming a comparison pane writes that pane’s own cut-out as shareable state (cvv)',
    resetBefore.length === 2 &&
      resetBefore.every((button) => button.disabled && /Whole sheet/.test(button.text)) &&
      Boolean(cutout) &&
      (cutout?.value ?? '').split(';').includes(`${pinnedIds[0]}@${cutout?.region}`),
    `reset buttons ${JSON.stringify(resetBefore)} · cvv "${cutout?.value ?? 'none'}" vs its own request ${cutout?.region ?? 'none'} (${zoomedPane?.readout ?? 'no readout'})`,
  );

  await cdp.click('#compare-view-body [data-compare-reset="0"]');
  const afterReset = await cdp
    .waitFor(
      `(() => {
        const readouts = [...document.querySelectorAll('[data-compare-readout]')].map((node) => node.textContent || '');
        const buttons = ${resetButtons};
        const cvv = new URLSearchParams(location.search).get('cvv') || '';
        return readouts.length === 2 && readouts.every((text) => /Whole sheet/.test(text)) && cvv === '' && buttons.every((button) => button.disabled)
          ? { readouts, cvv, disabled: buttons.map((button) => button.disabled) }
          : null;
      })()`,
      { label: 'panes back on the whole sheet', timeout: 20_000 },
    )
    .catch(() => null);
  check(
    'each comparison pane can go back to the whole sheet, and the link drops the cut-out',
    Boolean(afterReset),
    afterReset ? `${afterReset.readouts[0]} · cvv "${afterReset.cvv}" · disabled ${JSON.stringify(afterReset.disabled)}` : 'the panes stayed on a cut-out',
  );

  const sharedCutout = cutout?.value ?? '';
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?cmp=${encodeURIComponent(pinnedIds.join(','))}&cvv=${encodeURIComponent(sharedCutout)}` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'shared cut-out link' });
  await sleep(500);
  await cdp.click('#compare-open');
  await cdp.waitFor(`document.querySelector('#compare-view') && !document.querySelector('#compare-view').hidden`, { label: 'compare view for the shared cut-out', timeout: 10_000 });
  const restoredOwn = await waitForComparePane(0, `(pane) => pane.decoded && /Region/.test(pane.readout)`, 60_000).catch(() => null);
  const restoredOther = await waitForComparePane(1, `(pane) => pane.decoded && /Region/.test(pane.readout)`, 60_000).catch(() => null);
  const restoredUrl = await cdp.eval(`new URLSearchParams(location.search).get('cvv') || ''`);
  await cdp.screenshot(path.join(OUT_DIR, '11c-compare-cutout.png')).then(() => report.screenshots.push('11c-compare-cutout.png'));
  check(
    'a shared comparison link reopens that cut-out in its own pane and, coupled, in the other',
    Boolean(restoredOwn && restoredOther) &&
      restoredOwn.src.includes(`${cutout?.region}`) &&
      restoredUrl.includes(`${pinnedIds[0]}@${cutout?.region}`) &&
      restoredUrl.includes(`${pinnedIds[1]}@`),
    `pane 1 ${restoredOwn?.readout ?? 'no cut-out'} · pane 2 ${restoredOther?.readout ?? 'no cut-out'} · link cvv "${restoredUrl}"`,
  );

  /* --- 8c4. the degenerate pair is not coupled silently ---------------- */
  // The coupling maps a cut-out through the *documented* extents. A world sheet
  // and a small plan whose boxes never meet have no region in common, and the
  // honest answer is a pane that keeps its whole sheet and says why — not a
  // silent no-op, and not a guessed region. The pair is derived from the seed:
  // each “+” press shrinks both axes by 1.6 (the stage aspect can only shrink
  // them further), so a plan outside that predicted box cannot meet the cut-out.
  const centreOf = (box) => ({ lon: (box.west + box.east) / 2, lat: (box.south + box.north) / 2 });
  const predictedCutout = (record, presses) => {
    const factor = 1.6 ** presses;
    const { lon, lat } = centreOf(record.extent);
    const width = (record.extent.east - record.extent.west) / factor;
    const height = (record.extent.north - record.extent.south) / factor;
    return { west: lon - width / 2, east: lon + width / 2, south: lat - height / 2, north: lat + height / 2 };
  };
  const seeded = [...recordIndex.values()];
  const worldSheet =
    seeded.find((record) => record.iiifManifest && record.extent && spanOf(record) >= 180 && rowOf.has(record.id)) ??
    seeded.find((record) => record.iiifManifest && record.extent && spanOf(record) >= 180);
  const cutoutBox = worldSheet ? predictedCutout(worldSheet, 3) : null;
  const distantPlan = cutoutBox
    ? seeded.find(
        (record) =>
          record.id !== worldSheet.id &&
          record.iiifManifest &&
          record.extent &&
          spanOf(record) > 0 &&
          spanOf(record) <= 2 &&
          !overlapOf(record.extent, cutoutBox),
      )
    : null;
  if (!worldSheet || !distantPlan) {
    check(
      'a world sheet next to a distant plan: the pane says the cut-out is off its sheet',
      false,
      `no such pair in the seed (world: ${worldSheet?.id ?? 'none'}, plan: ${distantPlan?.id ?? 'none'})`,
    );
  } else {
    const degenerateIds = [worldSheet.id, distantPlan.id];
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?cmp=${encodeURIComponent(degenerateIds.join(','))}` });
    await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'degenerate-pair page' });
    await sleep(500);
    await cdp.click('#compare-open');
    await cdp.waitFor(`document.querySelector('#compare-view') && !document.querySelector('#compare-view').hidden`, {
      label: 'compare view for the degenerate pair',
      timeout: 10_000,
    });
    await cdp.waitFor(readyPanes, { label: 'degenerate panes ready', timeout: 60_000 }).catch(() => null);
    const planPaneBefore = await cdp.eval(`document.querySelectorAll('${comparePaneSelector}')[1]?.src || ''`);
    await cdp.eval(`document.querySelector('[data-compare-stage="0"]').focus(); true`);
    await cdp.pressKey('+', { keyCode: 187 });
    await cdp.pressKey('+', { keyCode: 187 });
    await cdp.pressKey('+', { keyCode: 187 });
    const worldZoomed = await waitForComparePane(0, `(pane) => pane.decoded && /Region/.test(pane.readout)`, 60_000).catch(() => null);
    const uncovered = await cdp
      .waitFor(
        `(() => {
          const pane = document.querySelectorAll('#compare-view-body .app-compare__pane')[1];
          const note = pane?.querySelector('[data-compare-coverage="1"]');
          if (!pane || !note || pane.dataset.coverage !== 'outside' || note.hidden) return null;
          return {
            coverage: pane.dataset.coverage,
            note: note.textContent,
            readout: pane.querySelector('[data-compare-readout]')?.textContent || '',
            src: pane.querySelector('img')?.src || '',
            hint: document.querySelector('#compare-sync-hint')?.textContent || '',
            status: document.querySelector('#compare-status')?.textContent || '',
          };
        })()`,
        { label: 'the plan pane names the uncovered cut-out', timeout: 30_000 },
      )
      .catch(() => null);
    const planPaneAfter = await cdp.eval(`document.querySelectorAll('${comparePaneSelector}')[1]?.src || ''`);
    // The viewer reports its region on a 400 ms debounce, so the shareable
    // cut-out lands in the URL *after* the note appears — read it by waiting
    // for the write instead of once (the same race the `vv` check hit).
    const degenerateCvv = await cdp
      .waitFor(`new URLSearchParams(location.search).get('cvv') || ''`, { label: 'the world pane writes its cut-out to cvv', timeout: 10_000 })
      .catch(() => '');
    check(
      'a world sheet next to a distant plan: the pane says the cut-out is off its sheet',
      Boolean(uncovered) &&
        /Region/.test(worldZoomed?.readout ?? '') &&
        /Whole sheet/.test(uncovered?.readout ?? '') &&
        /does not cover the selected region/.test(uncovered?.note ?? '') &&
        /ausserhalb der belegten Ausdehnung/.test(uncovered?.hint ?? '') &&
        planPaneAfter === planPaneBefore &&
        degenerateCvv.startsWith(`${worldSheet.id}@`) &&
        !degenerateCvv.includes(distantPlan.id),
      `Karte 1 ${worldZoomed?.readout ?? 'no cut-out'} · Karte 2 ${uncovered?.readout ?? 'unchanged'} · coverage "${uncovered?.coverage ?? 'none'}" · cvv "${degenerateCvv}" · note “${(uncovered?.note ?? 'absent').slice(0, 52)}…”`,
    );
    await cdp.screenshot(path.join(OUT_DIR, '11d-compare-degenerate.png')).then(() => report.screenshots.push('11d-compare-degenerate.png'));
  }

  /* --- 8c5. the coupling state is shareable, and the view is keyboard-usable */
  // Coupled is the documented default and stays out of the link; a visitor who
  // decoupled the panes sends `csync=0`, and the link must reopen exactly that
  // view instead of silently re-coupling sheets of different scales. The switch
  // is a real button, so Enter toggles it — and the same section checks that the
  // dialog keeps keyboard focus inside itself and hands it back on Escape.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?cmp=${encodeURIComponent(pinnedIds.join(','))}&csync=0` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'uncoupled compare link' });
  await sleep(500);
  await cdp.click('#compare-open');
  await cdp.waitFor(`document.querySelector('#compare-view') && !document.querySelector('#compare-view').hidden`, { label: 'uncoupled compare view', timeout: 10_000 });
  await cdp.waitFor(readyPanes, { label: 'uncoupled panes ready', timeout: 60_000 }).catch(() => null);
  const uncoupledLink = await cdp.eval(`(() => ({
    pressed: document.querySelector('#compare-sync')?.getAttribute('aria-pressed') ?? null,
    text: document.querySelector('#compare-sync')?.textContent ?? '',
    hint: document.querySelector('#compare-sync-hint')?.textContent ?? '',
    csync: new URLSearchParams(location.search).get('csync'),
    focus: document.activeElement?.id ?? '',
  }))()`);
  check(
    'a comparison link that uncoupled the panes reopens decoupled (csync=0) and says so',
    uncoupledLink.pressed === 'false' &&
      /koppeln/.test(uncoupledLink.text) &&
      /Linked views are off/.test(uncoupledLink.hint) &&
      uncoupledLink.csync === '0' &&
      uncoupledLink.focus === 'compare-view-close',
    JSON.stringify(uncoupledLink).slice(0, 240),
  );

  await cdp.eval(`document.querySelector('#compare-sync').focus(); true`);
  await cdp.pressKey('Enter');
  await sleep(500);
  const recoupledLink = await cdp.eval(`(() => ({
    pressed: document.querySelector('#compare-sync')?.getAttribute('aria-pressed') ?? null,
    text: document.querySelector('#compare-sync')?.textContent ?? '',
    csync: new URLSearchParams(location.search).get('csync'),
    status: document.querySelector('#compare-status')?.textContent ?? '',
  }))()`);
  check(
    'the coupling switch is keyboard-operable and coupled stays the default in the URL',
    recoupledLink.pressed === 'true' && /Views linked/.test(recoupledLink.text) && recoupledLink.csync === null && /linked/.test(recoupledLink.status),
    JSON.stringify(recoupledLink).slice(0, 240),
  );

  // Tab from the dialog's last focusable wraps to its first (trapFocus), and
  // Escape closes the dialog and hands focus back to the button that opened it.
  const lastFocusable = await cdp.eval(`(() => {
    const nodes = [...document.querySelectorAll('#compare-view a[href], #compare-view button:not([disabled]), #compare-view input:not([disabled]), #compare-view select:not([disabled]), #compare-view textarea:not([disabled]), #compare-view [tabindex]:not([tabindex="-1"])')].filter((node) => node.offsetParent !== null);
    const last = nodes[nodes.length - 1];
    if (!last) return null;
    last.focus();
    return { count: nodes.length, last: last.id || last.className || last.tagName, first: nodes[0]?.id || nodes[0]?.tagName || '' };
  })()`);
  await cdp.pressKey('Tab', { code: 'Tab', keyCode: 9 });
  await sleep(200);
  const afterTab = await cdp.eval(`document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName || ''`);
  await cdp.pressKey('Escape');
  await sleep(400);
  const afterEscape = await cdp.eval(`({ hidden: document.querySelector('#compare-view')?.hidden === true, focus: document.activeElement?.id || '' })`);
  check(
    'the comparison dialog keeps Tab focus inside and returns it to the toolbar on Escape',
    Boolean(lastFocusable) && afterTab === lastFocusable.first && afterEscape.hidden && afterEscape.focus === 'compare-open',
    `${JSON.stringify(lastFocusable)} · Tab -> ${afterTab} · Escape -> ${JSON.stringify(afterEscape)}`,
  );

  /* --- 8d. a real multi-sheet work: sheet navigation -------------------- */
  const multiSheet = [...recordIndex.values()].find((record) => (record.canvasCount ?? 0) > 1 && record.iiifManifest);
  if (multiSheet) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(multiSheet.id)}` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'multi-sheet viewer', timeout: 25_000 });
    const sheetOne = await cdp.eval(`(() => ({
      label: document.querySelector('#page-label')?.textContent || '',
      navHidden: document.querySelector('#page-nav')?.hidden,
      prevDisabled: document.querySelector('#page-prev')?.disabled,
      src: document.querySelector('.app-viewer__image')?.src || '',
      hint: /Change sheet: Alt/.test(document.querySelector('.app-viewer__hint')?.textContent || ''),
    }))()`);
    await cdp.screenshot(path.join(OUT_DIR, '05-multi-sheet.png')).then(() => report.screenshots.push('05-multi-sheet.png'));
    await cdp.click('#page-next');
    let sheetTwoSrc = sheetOne.src;
    try {
      sheetTwoSrc = await cdp.waitFor(
        `(() => { const src = document.querySelector('.app-viewer__image')?.src || ''; return src !== ${JSON.stringify(sheetOne.src)} && document.querySelector('#viewer-stage')?.dataset.state === 'ready' ? src : ''; })()`,
        { label: 'second sheet', timeout: 25_000 },
      );
    } catch {
      /* reported below */
    }
    const sheetTwo = await cdp.eval(`(() => ({
      label: document.querySelector('#page-label')?.textContent || '',
      prevDisabled: document.querySelector('#page-prev')?.disabled,
      nextDisabled: document.querySelector('#page-next')?.disabled,
      alt: document.querySelector('.app-viewer__image')?.alt || '',
    }))()`);
    const expectedTotal = String(multiSheet.canvasCount);
    check(
      'a real multi-sheet work offers working sheet navigation',
      sheetOne.navHidden === false &&
        sheetOne.hint === true &&
        sheetOne.label === `Sheet 1 of ${expectedTotal}` &&
        sheetOne.prevDisabled === true &&
        sheetTwo.label === `Sheet 2 of ${expectedTotal}` &&
        sheetTwoSrc !== sheetOne.src &&
        sheetTwo.prevDisabled === false,
      `${multiSheet.id} (${expectedTotal} Blatt) · "${sheetOne.label}" -> "${sheetTwo.label}" ${sheetOne.src.slice(-40)} -> ${sheetTwoSrc.slice(-40)}`,
    );
  } else {
    check('a real multi-sheet work offers working sheet navigation', false, 'no multi-sheet record in the seed');
  }

  /* --- 8e. the open sheet is shareable URL state (?sh=) ----------------- */
  if (multiSheet) {
    const total = multiSheet.canvasCount;
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(multiSheet.id)}&sh=${total}` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'deep-linked sheet', timeout: 25_000 });
    const deepLink = await cdp.eval(`(() => ({
      label: document.querySelector('#page-label')?.textContent || '',
      active: document.querySelector('#page-strip [aria-current="true"]')?.dataset.sheet ?? null,
      strip: document.querySelectorAll('#page-strip [data-sheet]').length,
      stripHidden: document.querySelector('#page-strip')?.hidden,
    }))()`);
    check(
      'a shared ?sh= link opens that sheet and the strip marks it',
      deepLink.label === `Sheet ${total} of ${total}` && deepLink.active === String(total - 1) && deepLink.strip === total && deepLink.stripHidden === false,
      `${multiSheet.id} sh=${total} -> ${JSON.stringify(deepLink)}`,
    );

    let thumbs = { loaded: 0, total: 0 };
    try {
      thumbs = await cdp.waitFor(
        `(() => { const imgs = [...document.querySelectorAll('#page-strip img')]; const loaded = imgs.filter((img) => img.naturalWidth > 0).length; return imgs.length > 0 && loaded === imgs.length ? { loaded, total: imgs.length } : ''; })()`,
        { label: 'sheet thumbnails', timeout: 20_000 },
      );
    } catch {
      thumbs = await cdp.eval(`(() => { const imgs = [...document.querySelectorAll('#page-strip img')]; return { loaded: imgs.filter((img) => img.naturalWidth > 0).length, total: imgs.length }; })()`);
    }
    check('the sheet strip shows a real thumbnail per sheet', thumbs.loaded === total, JSON.stringify(thumbs));

    // Out-of-range values are clamped to the real canvas count and written back.
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(multiSheet.id)}&sh=99` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'clamped sheet', timeout: 25_000 });
    await sleep(300);
    const clamped = await cdp.eval(`(() => ({ label: document.querySelector('#page-label')?.textContent || '', sh: new URLSearchParams(location.search).get('sh') }))()`);
    check(
      'an out-of-range sheet number is clamped and written back to the URL',
      clamped.label === `Sheet ${total} of ${total}` && clamped.sh === String(total),
      JSON.stringify(clamped),
    );

    // The strip is a real control: clicking a sheet switches the viewer and URL.
    await cdp.click('#page-strip [data-sheet="0"]');
    let stripSwitch = null;
    try {
      stripSwitch = await cdp.waitFor(
        `(() => { const label = document.querySelector('#page-label')?.textContent || ''; const sh = new URLSearchParams(location.search).get('sh'); return label === 'Sheet 1 of ${total}' && sh === null ? { label, sh } : ''; })()`,
        { label: 'strip click', timeout: 10_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'clicking a sheet in the strip switches to it (sheet 1 is the default URL state)',
      stripSwitch?.label === `Sheet 1 of ${total}` && stripSwitch?.sh === null,
      JSON.stringify(stripSwitch),
    );

    // The strip is one tab stop (roving tabindex): ←/→/Home/End walk the sheets.
    // Without it a 26-sheet work would add 26 tab stops before the next control.
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(multiSheet.id)}` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'strip keyboard entry', timeout: 25_000 });
    const stripTabs = await cdp.eval(`(() => {
      const buttons = [...document.querySelectorAll('#page-strip [data-sheet]')];
      return { tabbable: buttons.filter((button) => button.tabIndex === 0).map((button) => button.dataset.sheet) };
    })()`);
    await cdp.eval(`document.querySelector('#page-strip [data-sheet="0"]')?.focus(); true`);
    await cdp.pressKey('ArrowRight');
    let stripArrow = null;
    try {
      stripArrow = await cdp.waitFor(
        `(() => { const label = document.querySelector('#page-label')?.textContent || ''; return label === 'Sheet 2 of ${total}' ? { label, focused: document.activeElement?.dataset?.sheet ?? null, sh: new URLSearchParams(location.search).get('sh') } : ''; })()`,
        { label: 'strip arrow key', timeout: 10_000 },
      );
    } catch {
      /* reported below */
    }
    await cdp.pressKey('Home');
    let stripHome = null;
    try {
      stripHome = await cdp.waitFor(
        `(() => { const label = document.querySelector('#page-label')?.textContent || ''; return label === 'Sheet 1 of ${total}' ? { label, focused: document.activeElement?.dataset?.sheet ?? null } : ''; })()`,
        { label: 'strip Home key', timeout: 10_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'the sheet strip is a single tab stop and ←/→/Home walk the sheets',
      stripTabs.tabbable.length === 1 && stripTabs.tabbable[0] === '0' && stripArrow?.label === `Sheet 2 of ${total}` && stripArrow.focused === '1' && stripHome?.label === `Sheet 1 of ${total}` && stripHome?.focused === '0',
      `${JSON.stringify(stripTabs)} -> ${JSON.stringify(stripArrow)} -> ${JSON.stringify(stripHome)}`,
    );

    // Fullscreen is the real Fullscreen API (not a fake overlay) and Esc must
    // leave fullscreen without closing the panel: a trapped user is worse off.
    const fullscreenBefore = await cdp.eval(`(() => { const b = document.querySelector('#viewer-fullscreen'); return b ? { exists: true, pressed: b.getAttribute('aria-pressed'), text: b.textContent } : { exists: false }; })()`);
    let fullscreenIn = null;
    let fullscreenOut = null;
    if (fullscreenBefore.exists) {
      await cdp.click('#viewer-fullscreen');
      try {
        fullscreenIn = await cdp.waitFor(
          `(() => { const button = document.querySelector('#viewer-fullscreen'); const active = document.fullscreenElement === document.querySelector('#viewer-stage'); return active && button.getAttribute('aria-pressed') === 'true' ? { active, pressed: button.getAttribute('aria-pressed'), text: button.textContent } : ''; })()`,
          { label: 'fullscreen on', timeout: 8_000 },
        );
      } catch {
        /* reported below */
      }
      await cdp.screenshot(path.join(OUT_DIR, '06-fullscreen.png')).then(() => report.screenshots.push('06-fullscreen.png'));
      await cdp.pressKey('Escape');
      await sleep(300);
      // Esc is handled by the browser itself (and must not close the panel). The
      // control row is not on screen while the stage is fullscreen, so the exit
      // path is driven through the API the browser also uses — what matters here
      // is that the panel reacts to `fullscreenchange` and stays usable.
      const afterEscape = await cdp.eval(`(() => ({ panelOpen: document.querySelector('#detail')?.hidden === false, stillFullscreen: Boolean(document.fullscreenElement) }))()`);
      if (afterEscape.stillFullscreen) await cdp.eval(`document.exitFullscreen?.(); true`);
      try {
        fullscreenOut = await cdp.waitFor(
          `(() => { const button = document.querySelector('#viewer-fullscreen'); const stage = document.querySelector('#viewer-stage'); return !document.fullscreenElement && button.getAttribute('aria-pressed') === 'false' && !stage.classList.contains('is-fullscreen') ? { active: false, pressed: 'false', text: button.textContent, panelOpen: document.querySelector('#detail')?.hidden === false } : ''; })()`,
          { label: 'fullscreen off', timeout: 8_000 },
        );
      } catch {
        /* reported below */
      }
      fullscreenOut = { ...(fullscreenOut ?? {}), afterEscape };
    }
    check(
      'the sheet can go fullscreen without losing the panel (and comes back cleanly)',
      fullscreenIn?.active === true &&
        fullscreenIn.pressed === 'true' &&
        fullscreenOut?.active === false &&
        fullscreenOut?.pressed === 'false' &&
        fullscreenOut?.panelOpen === true &&
        fullscreenOut?.afterEscape?.panelOpen === true,
      `${JSON.stringify(fullscreenBefore)} -> ${JSON.stringify(fullscreenIn)} -> ${JSON.stringify(fullscreenOut)}`,
    );

    // A deep link into a multi-sheet work must not scroll the panel away: the
    // sheet strip used to call `scrollIntoView()`, which also scrolls its
    // ancestors and pushed the title (and the whole viewer) out of a phone screen.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(multiSheet.id)}&sh=${total}` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'mobile sheet deep link', timeout: 25_000 });
    await sleep(700);
    const sheetScroll = await cdp.eval(`(() => {
      const panel = document.querySelector('#detail');
      const title = document.querySelector('#detail-title');
      const stage = document.querySelector('#viewer-stage');
      return {
        panelScrollTop: panel?.scrollTop ?? -1,
        titleTop: Math.round(title?.getBoundingClientRect().top ?? -999),
        stageTop: Math.round(stage?.getBoundingClientRect().top ?? -999),
        viewport: window.innerHeight,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        active: document.querySelector('#page-strip [aria-current="true"]')?.dataset.sheet ?? null,
        label: document.querySelector('#page-label')?.textContent || '',
      };
    })()`);
    check(
      'a multi-sheet deep link on a phone keeps the title and the viewer in view',
      sheetScroll.panelScrollTop === 0 &&
        sheetScroll.titleTop >= 0 &&
        sheetScroll.titleTop < sheetScroll.viewport &&
        sheetScroll.stageTop > 0 &&
        sheetScroll.stageTop < sheetScroll.viewport &&
        sheetScroll.overflow <= 1 &&
        sheetScroll.active === String(total - 1),
      JSON.stringify(sheetScroll),
    );
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }

  /* --- 8o. large works: jump to a sheet, thumbnails only where they show --- */
  // The seed's largest digitised work (65 sheets since iteration 7-16). Sheet 20
  // is 19 “Sheet ›” clicks away, and the strip used to request every thumbnail
  // while showing about ten — both are what this section measures. The option
  // label may carry the upstream canvas label as a suffix, so it is compared by
  // prefix (maps-2 repaired this stale expectation after the data grew).
  const bigWork = [...recordIndex.values()]
    .filter((record) => record.iiifManifest && (record.canvasCount ?? 0) > 12)
    .sort((a, b) => (b.canvasCount ?? 0) - (a.canvasCount ?? 0))[0] ?? null;
  if (bigWork && multiSheet) {
    const bigTotal = bigWork.canvasCount;

    // A work with three sheets must stay as it was: no extra control.
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(multiSheet.id)}` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'small work viewer', timeout: 25_000 });
    const smallJump = await cdp.eval(`(() => ({ hidden: document.querySelector('#page-jump-wrap')?.hidden, options: document.querySelector('#page-jump')?.options.length ?? -1 }))()`);
    check(
      'the direct sheet jump stays out of a small work',
      smallJump.hidden === true && smallJump.options === 0,
      `${multiSheet.id} (${multiSheet.canvasCount} Blätter) -> ${JSON.stringify(smallJump)}`,
    );

    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(bigWork.id)}&sh=20` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'large work viewer', timeout: 30_000 });
    const announced = await cdp
      .waitFor(`/^Sheet 20 of ${bigTotal} loaded\\.$/.test(document.querySelector('#viewer-status')?.textContent || '') ? document.querySelector('#viewer-status').textContent : ''`, {
        label: 'sheet announcement',
        timeout: 15_000,
      })
      .catch(() => '');
    const largeJump = await cdp.eval(`(() => {
      const select = document.querySelector('#page-jump');
      return {
        visible: document.querySelector('#page-jump-wrap')?.hidden === false,
        options: select?.options.length ?? -1,
        value: select?.value ?? '',
        option20: select?.options[19]?.textContent ?? '',
        label: document.querySelector('#page-label')?.textContent ?? '',
        active: document.querySelector('#page-strip [aria-current="true"]')?.dataset.sheet ?? null,
        thumbnails: document.querySelectorAll('#page-strip img').length,
        sheets: document.querySelectorAll('#page-strip [data-sheet]').length,
      };
    })()`);
    check(
      'a large work gets a “Blatt” jump control and announces the open sheet',
      largeJump.visible === true &&
        largeJump.options === bigTotal &&
        largeJump.value === '20' &&
        largeJump.option20.startsWith(`Sheet 20 of ${bigTotal}`) &&
        largeJump.label === `Sheet 20 of ${bigTotal}` &&
        largeJump.active === '19' &&
        announced === `Sheet 20 of ${bigTotal} loaded.`,
      `${bigWork.id} (${bigTotal} Blätter) -> ${JSON.stringify(largeJump)} announced "${announced}"`,
    );
    check(
      'opening a large work requests thumbnails only for the sheets in view',
      largeJump.sheets === bigTotal && largeJump.thumbnails > 0 && largeJump.thumbnails < bigTotal,
      `sheets=${largeJump.sheets} thumbnails=${largeJump.thumbnails} (of ${bigTotal})`,
    );

    // Choosing a sheet directly must really swap the canvas, centre the strip and
    // share the sheet; a reader is told which sheet is on screen.
    const sheet20Src = await cdp.eval(`document.querySelector('.app-viewer__image')?.src || ''`);
    await cdp.eval(`(() => { const select = document.querySelector('#page-jump'); select.value = '7'; select.dispatchEvent(new Event('change', { bubbles: true })); return select.value; })()`);
    let jumpState = null;
    try {
      jumpState = await cdp.waitFor(
        `(() => {
          const label = document.querySelector('#page-label')?.textContent || '';
          const sh = new URLSearchParams(location.search).get('sh');
          const active = document.querySelector('#page-strip [aria-current="true"]');
          const strip = document.querySelector('#page-strip');
          const src = document.querySelector('.app-viewer__image')?.src || '';
          // The viewer swaps the bitmap only when the new region has arrived, so
          // waiting for the label alone would read the previous sheet's image.
          if (label !== 'Sheet 7 of ${bigTotal}' || sh !== '7' || active?.dataset.sheet !== '6' || !src || src === ${JSON.stringify(sheet20Src)}) return '';
          const button = active.getBoundingClientRect();
          const box = strip.getBoundingClientRect();
          return {
            label,
            sh,
            active: active.dataset.sheet,
            value: document.querySelector('#page-jump').value,
            inStrip: button.left >= box.left - 1 && button.right <= box.right + 1,
            src,
          };
        })()`,
        { label: 'jump to sheet 7', timeout: 25_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'the jump control opens sheet 7, centres it in the strip and shares ?sh=7',
      jumpState?.label === `Sheet 7 of ${bigTotal}` &&
        jumpState?.sh === '7' &&
        jumpState?.active === '6' &&
        jumpState?.value === '7' &&
        jumpState?.inStrip === true &&
        jumpState?.src &&
        jumpState.src !== sheet20Src,
      `${JSON.stringify(jumpState)} (was ${sheet20Src.slice(-40)})`,
    );

    // Thumbnails are lazy, not missing: scrolling to the last sheet loads its
    // 96-px derivative then (and only then).
    const lazyBefore = await cdp.eval(`(() => { const b = document.querySelectorAll('#page-strip [data-sheet]')[${bigTotal - 1}]; return { hasImg: Boolean(b?.querySelector('img')), loaded: document.querySelectorAll('#page-strip img').length }; })()`);
    await cdp.eval(`(() => { const strip = document.querySelector('#page-strip'); strip.scrollLeft = strip.scrollWidth; return strip.scrollLeft; })()`);
    let lazyAfter = null;
    try {
      lazyAfter = await cdp.waitFor(
        `(() => { const b = document.querySelectorAll('#page-strip [data-sheet]')[${bigTotal - 1}]; const img = b?.querySelector('img'); return img && img.naturalWidth > 0 ? { loaded: document.querySelectorAll('#page-strip img').length, lastLoaded: true } : ''; })()`,
        { label: 'thumbnails after scrolling', timeout: 20_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'scrolling the strip loads the thumbnails that come into view',
      lazyBefore.hasImg === false && lazyAfter?.lastLoaded === true && lazyAfter.loaded > lazyBefore.loaded,
      `last sheet before ${JSON.stringify(lazyBefore)} -> after ${JSON.stringify(lazyAfter)}`,
    );

    // The extra control must not push the panel wider than a phone screen.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(bigWork.id)}&sh=31` });
    await cdp.waitFor(`document.querySelector('#viewer-stage')?.dataset.state === 'ready'`, { label: 'phone large work', timeout: 30_000 });
    const phoneJump = await cdp.eval(`(() => {
      const select = document.querySelector('#page-jump');
      const r = select?.getBoundingClientRect();
      const panel = document.querySelector('#detail')?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        visible: document.querySelector('#page-jump-wrap')?.hidden === false,
        value: select?.value ?? '',
        insidePanel: r && panel ? r.left >= panel.left - 1 && r.right <= panel.right + 1 : false,
        width: Math.round(r?.width ?? 0),
      };
    })()`);
    await cdp.screenshot(path.join(OUT_DIR, '09-large-work-jump.png')).then(() => report.screenshots.push('09-large-work-jump.png'));
    check(
      '390 px: the sheet jump stays inside the panel without overflow',
      phoneJump.overflow <= 1 && phoneJump.visible === true && phoneJump.value === '31' && phoneJump.insidePanel && phoneJump.width > 100,
      JSON.stringify(phoneJump),
    );
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  }

  /* --- 8p. a georeferenced record as a map layer, from the detail panel ---- */
  // swisstopo records have no IIIF manifest: the panel shows the documented
  // WMTS tile and offers its own toggle for the comparison layer.
  const overlayRecord = [...recordIndex.values()].find((record) => record.overlay?.urlTemplate && record.overlay?.layerId && record.thumbnail) ?? null;
  if (overlayRecord) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(overlayRecord.id)}&ov=&ot=` });
    await cdp.waitFor(`document.querySelector('#detail')?.hidden === false`, { label: 'overlay record panel', timeout: 20_000 });
    const overlayPanel = await cdp.waitFor(
      `(() => {
        const img = document.querySelector('#detail-preview img');
        const button = document.querySelector('#detail-overlay');
        if (!img || !(img.naturalWidth > 0) || !button) return '';
        return {
          viewer: Boolean(document.querySelector('#viewer-stage')),
          tileLoaded: img.naturalWidth > 0,
          caption: document.querySelector('#detail-preview + p, #detail-body .app-viewer__caption')?.textContent || '',
          label: button.textContent,
          pressed: button.getAttribute('aria-pressed'),
          records: document.querySelectorAll('#result-list > *').length,
        };
      })()`,
      { label: 'overlay record tile', timeout: 20_000 },
    );
    check(
      'a WMTS record shows its documented tile and a layer toggle instead of a viewer',
      overlayPanel.viewer === false &&
        overlayPanel.tileLoaded === true &&
        /WMTS-Kachelprobe/.test(overlayPanel.caption) &&
        /swisstopo/.test(overlayPanel.caption) &&
        overlayPanel.label === 'Show as overlay' &&
        overlayPanel.pressed === 'false',
      `${overlayRecord.id} -> ${JSON.stringify(overlayPanel)}`,
    );

    await cdp.click('#detail-overlay');
    let overlayOn = null;
    try {
      overlayOn = await cdp.waitFor(
        `(() => {
          const params = new URLSearchParams(location.search);
          const button = document.querySelector('#detail-overlay');
          const select = document.querySelector('#overlay-select');
          const tiles = document.querySelectorAll('.map-overlay-tile').length;
          if (params.get('ov') !== ${JSON.stringify(overlayRecord.overlay.layerId)} || !tiles || button?.getAttribute('aria-pressed') !== 'true') return '';
          return {
            ov: params.get('ov'),
            ot: params.get('ot'),
            select: select?.value ?? '',
            tiles,
            label: button.textContent,
            pressed: button.getAttribute('aria-pressed'),
            status: document.querySelector('#detail-status')?.textContent || '',
          };
        })()`,
        { label: 'comparison layer on', timeout: 20_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'the layer button of the panel really puts the documented layer on the map',
      overlayOn?.ov === overlayRecord.overlay.layerId &&
        overlayOn?.ot === String(overlayRecord.overlay.timeValue ?? '') &&
        overlayOn?.select === overlayRecord.overlay.layerId &&
        overlayOn?.tiles > 0 &&
        overlayOn?.pressed === 'true' &&
        overlayOn?.label === 'Hide overlay' &&
        /eingeblendet/.test(overlayOn?.status ?? ''),
      `${overlayRecord.id} -> ${JSON.stringify(overlayOn)}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, '10-overlay-layer.png')).then(() => report.screenshots.push('10-overlay-layer.png'));

    // A second press removes it again — and the sidebar select must agree, so the
    // panel cannot leave a layer behind that the rest of the app still shows.
    await cdp.click('#detail-overlay');
    let overlayOff = null;
    try {
      overlayOff = await cdp.waitFor(
        `(() => {
          const params = new URLSearchParams(location.search);
          const button = document.querySelector('#detail-overlay');
          if (params.get('ov') || button?.getAttribute('aria-pressed') !== 'false') return '';
          return {
            ov: params.get('ov'),
            select: document.querySelector('#overlay-select')?.value ?? '',
            tiles: document.querySelectorAll('.map-overlay-tile').length,
            label: button.textContent,
          };
        })()`,
        { label: 'comparison layer off', timeout: 20_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'a second press removes the layer and the sidebar select follows',
      overlayOff?.ov === null && overlayOff?.select === '' && overlayOff?.tiles === 0 && overlayOff?.label === 'Show as overlay',
      JSON.stringify(overlayOff),
    );
    await cdp.pressKey('Escape');
    await sleep(300);
  }

  /* --- 8f. device-local list + map-first shell -------------------------- */
  // The pinned list is also kept in this browser. A plain page load (no ?cmp=)
  // must bring it back; «Liste leeren» must remove it from the device again.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'saved list page' });
  let savedList = null;
  try {
    savedList = await cdp.waitFor(
      `(() => {
        const items = document.querySelectorAll('#compare-list .app-compare__item').length;
        const stored = localStorage.getItem('kartenzeit.cmp.v1');
        return items >= 2 && stored ? { items, stored, status: document.querySelector('#compare-status')?.textContent || '', cmp: new URLSearchParams(location.search).get('cmp') || '' } : '';
      })()`,
      { label: 'restored list', timeout: 15_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'the list pinned in this browser comes back without a link',
    savedList?.items === 2 && savedList?.cmp.split(',').filter(Boolean).length === 2 && /Browser/.test(savedList?.status || ''),
    savedList ? `${savedList.items} gemerkt · ${JSON.stringify(savedList.status.slice(0, 70))}` : 'no restored list',
  );

  await cdp.eval(`(() => { const panel = document.querySelector('#compare-panel'); if (panel) panel.open = true; return true; })()`);
  await cdp.click('#compare-clear');
  await sleep(400);
  const afterClear = await cdp.eval(`({ stored: localStorage.getItem('kartenzeit.cmp.v1'), items: document.querySelectorAll('#compare-list .app-compare__item').length })`);
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'cleared list page' });
  await sleep(800);
  const clearedReload = await cdp.eval(`({ stored: localStorage.getItem('kartenzeit.cmp.v1'), items: document.querySelectorAll('#compare-list .app-compare__item').length })`);
  check(
    '«Liste leeren» also clears the device-local list (no resurrection on reload)',
    afterClear.stored === null && afterClear.items === 0 && clearedReload.stored === null && clearedReload.items === 0,
    `after clear ${JSON.stringify(afterClear)}, after reload ${JSON.stringify(clearedReload)}`,
  );

  // Sharing a search: the state is already in the URL, the filter panel turns it
  // into a copied link (and says so, whether the clipboard API or the fallback
  // path did the work).
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1788&to=1850` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'share-link page' });
  await cdp.eval(`(() => { const panel = document.querySelector('.app-filters'); if (panel) panel.open = true; return true; })()`);
  await cdp.click('#permalink-copy');
  let shareStatus = null;
  try {
    shareStatus = await cdp.waitFor(
      `(() => { const text = document.querySelector('#permalink-status')?.textContent || ''; return /copied|Could not copy/.test(text) ? { text, url: location.href } : ''; })()`,
      { label: 'share status', timeout: 10_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    '“Suchlink kopieren” reports the copied search state',
    Boolean(shareStatus?.url.includes('from=1788') && shareStatus?.url.includes('to=1850')),
    shareStatus ? `${shareStatus.text.slice(0, 60)} · ${shareStatus.url.split('?')[1]}` : 'no status message',
  );

  // Map-first shell: the map is the product, so part of it has to be visible on
  // a plain desktop/tablet viewport instead of sitting below a full-height intro
  // block. 840 px is the breakpoint where the compact intro band starts.
  const measureFirstScreen = () =>
    cdp.eval(`(() => {
      // Measure the untouched first screen: earlier checks scrolled the page and
      // the map column is sticky, which would report the sticky offset instead.
      window.scrollTo({ top: 0, behavior: 'instant' });
      const map = document.querySelector('#map')?.getBoundingClientRect();
      const hero = document.querySelector('.app-intro')?.getBoundingClientRect();
      return {
        vw: window.innerWidth,
        vh: window.innerHeight,
        mapTop: map ? Math.round(map.top + window.scrollY) : -1,
        mapVisible: map ? Math.round(Math.min(window.innerHeight - map.top, map.height)) : 0,
        heroHeight: hero ? Math.round(hero.height) : -1,
        facts: document.querySelectorAll('#intro-facts li').length,
        jump: Boolean(document.querySelector('.app-intro__more a[href="#map"]')),
      };
    })()`);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(500);
  const wideScreen = await measureFirstScreen();
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 840, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  const mediumScreen = await measureFirstScreen();
  const firstScreen = mediumScreen;
  check(
    'the map is on the first desktop and tablet screen (map-first shell)',
    wideScreen.mapVisible > 200 && mediumScreen.mapVisible > 200 && mediumScreen.facts >= 4 && mediumScreen.jump,
    `1440: ${wideScreen.mapTop}/${wideScreen.mapVisible} · 840: ${mediumScreen.mapTop}/${mediumScreen.mapVisible}`,
  );
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(400);


  // Keyboard route from the intro to the map: the link must move focus, not
  // only scroll, or a keyboard user keeps tabbing through the intro block.
  await cdp.click('.app-intro__more a[href="#map"]');
  await sleep(500);
  const jumpToMap = await cdp.eval(`({ active: document.activeElement?.id || document.activeElement?.tagName || '', scrolled: window.scrollY > 100 })`);
  check(
    '“Direkt zur Karte” moves focus into the map',
    jumpToMap.active === 'map' && jumpToMap.scrolled,
    JSON.stringify(jumpToMap),
  );

  // The cantonal type curve for the page heading: 32 px base, 28 px at the
  // smallest breakpoint ($fontSizeCurves huge/tiny). Checking the *class* keeps
  // the shell from losing .zh-heading--1 again (a bare h1 gets 32 px anyway).
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'narrow heading' });
  await sleep(600);
  const heading = await cdp.eval(`(() => {
    const node = document.querySelector('#intro-heading');
    return { size: getComputedStyle(node).fontSize, classes: node.className, lineClamp: getComputedStyle(document.querySelector('.zh-lead')).webkitLineClamp };
  })()`);
  check(
    'the page heading follows the cantonal type curve at 390 px',
    heading.size === '28px' && /zh-heading--1/.test(heading.classes),
    JSON.stringify(heading),
  );

  // Phone map-first: below 600 px the hero gives its stock figures to the
  // “Über das Projekt” card (#about-facts, filled from the same data), so the
  // map itself starts on the first phone screen instead of behind a facts strip
  // (maps-1, iteration 7-16). Measured before the change: map top 722 px of an
  // 844 px screen → 122 px of map; now 609 px → 235 px.
  const phoneFirstScreen = await cdp.eval(`(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const map = document.querySelector('#map')?.getBoundingClientRect();
    const aboutFacts = document.querySelector('#about-facts');
    const heroFacts = document.querySelector('#intro-facts');
    return {
      mapTop: map ? Math.round(map.top + window.scrollY) : -1,
      mapVisible: map ? Math.round(Math.min(window.innerHeight - map.top, map.height)) : 0,
      aboutFacts: aboutFacts ? aboutFacts.querySelectorAll('li').length : 0,
      aboutFactsVisible: aboutFacts ? getComputedStyle(aboutFacts).display !== 'none' : false,
      heroFactsHidden: heroFacts ? getComputedStyle(heroFacts).display === 'none' : false,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      lead: (() => {
        const node = document.querySelector('.app-intro .zh-lead');
        const short = document.querySelector('.app-intro__lead-short');
        const long = document.querySelector('.app-intro__lead-long');
        const aboutLead = document.querySelector('#about [data-record-count]')?.closest('p');
        return {
          display: node ? getComputedStyle(node).display : '',
          shortVisible: short ? getComputedStyle(short).display !== 'none' : false,
          longVisible: long ? getComputedStyle(long).display !== 'none' : false,
          clamped: node ? node.scrollHeight > node.clientHeight + 1 : true,
          aboutVisible: aboutLead ? getComputedStyle(aboutLead).display !== 'none' : false,
          aboutText: aboutLead ? aboutLead.textContent.replace(/\\s+/g, ' ').trim() : '',
        };
      })(),
    };
  })()`);
  check(
    'phone map-first: the map starts on the first screen and the stock figures stay in “Über das Projekt”',
    phoneFirstScreen.mapVisible > 180 &&
      phoneFirstScreen.aboutFacts >= 4 &&
      phoneFirstScreen.aboutFactsVisible &&
      phoneFirstScreen.heroFactsHidden &&
      phoneFirstScreen.overflow === 0,
    JSON.stringify(phoneFirstScreen),
  );
  await cdp.screenshot(path.join(OUT_DIR, '03d-mobile-mapfirst.png')).then(() => report.screenshots.push('03d-mobile-mapfirst.png'));

  // The intro sentence must end on its own at every phone width. Before 7-18
  // the long lead needed 4–8 lines at 320–430 px and the 2-line clamp cut it
  // mid-word (“… aus echten Sammlungen – mit Kartenvorschau, Zeitfilter,
  // Vergleichsebene und…”); the short phone variant is a complete sentence of
  // its own and the clamp is only the safety net. Measured at 390 and 320.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 640, deviceScaleFactor: 2, mobile: true });
  await sleep(500);
  const narrowLead = await cdp.eval(`(() => {
    window.scrollTo({ top: 0, behavior: 'instant' });
    const lead = document.querySelector('.app-intro .zh-lead');
    const aboutLead = document.querySelector('#about [data-record-count]')?.closest('p');
    const map = document.querySelector('#map')?.getBoundingClientRect();
    return {
      display: lead ? getComputedStyle(lead).display : '',
      aboutVisible: aboutLead ? getComputedStyle(aboutLead).display !== 'none' : false,
      aboutText: aboutLead ? aboutLead.textContent.replace(/\\s+/g, ' ').trim() : '',
      mapTop: map ? Math.round(map.top + window.scrollY) : -1,
      mapVisible: map ? Math.round(Math.max(0, Math.min(innerHeight, map.bottom) - Math.max(0, map.top))) : 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  // Signature of the very-small-phone step (maps-1, 7-19): below the cantonal
  // 400 px breakpoint the hero hands the lead sentence and its two links to the
  // map, and that sentence stands complete in “Über das Projekt”. Measured
  // 390×844: map top 609 → 483 px (235 → 361 px of map); 320×640: 658 → 507 px
  // (0 → 133 px of map).
  const heroYieldsToMap = (m) => m.lead.display === 'none' && m.lead.aboutVisible && /\.$/.test(m.lead.aboutText);
  check(
    'below 400 px the hero lead yields to the map and reads complete in “Über das Projekt”',
    heroYieldsToMap(phoneFirstScreen) && narrowLead.display === 'none' && narrowLead.aboutVisible && /\.$/.test(narrowLead.aboutText),
    JSON.stringify({ at390: phoneFirstScreen.lead, at320: { lead: narrowLead.display, about: narrowLead.aboutText.slice(0, 80) } }),
  );
  check(
    'the map starts on the first screen at 320×640 as well',
    narrowLead.mapVisible > 100 && narrowLead.mapTop < 640 && narrowLead.overflow === 0,
    JSON.stringify({ mapTop: narrowLead.mapTop, mapVisible: narrowLead.mapVisible, overflow: narrowLead.overflow }),
  );
  await cdp.send('Emulation.clearDeviceMetricsOverride');

  /* --- 8g. view switch: map-only / list-only stay inside their boxes ---- */
  // The map container keeps absolutely positioned tiles, extents and markers as
  // children. A `position: static` override in map-only view once let them
  // escape the box: they painted over the intro, added ~80 px of horizontal
  // page overflow and put clickable markers outside the map.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'view switch page' });
  await sleep(800);
  const markerInfo = await cdp.eval(`(() => {
    const marker = document.querySelector('.map-marker');
    if (!marker) return null;
    const style = getComputedStyle(marker);
    const rect = marker.getBoundingClientRect();
    return {
      count: document.querySelectorAll('.map-marker').length,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      bg: style.backgroundColor,
      color: style.color,
      visible: (document.querySelector('#map-visible-count')?.textContent || '').trim(),
    };
  })()`);
  check(
    'map pins are visible, sized and named in the map status line',
    Boolean(markerInfo) &&
      markerInfo.count > 0 &&
      markerInfo.w >= 24 &&
      markerInfo.h >= 24 &&
      markerInfo.bg !== 'rgb(255, 255, 255)' &&
      /view/.test(markerInfo.visible),
    JSON.stringify(markerInfo),
  );
  await cdp.screenshot(path.join(OUT_DIR, '05-map-pins.png')).then(() => report.screenshots.push('05-map-pins.png'));

  // Clustering: “Treffer einpassen” zooms out to the whole result set, where
  // overlapping pins must collapse into numbered clusters that zoom in on click.
  const clusterState = await cdp.eval(`(async () => {
    document.querySelector('[data-map-cmd="fitresults"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const module = await import('/app/main.js');
    const api = module.ctx.moduleApis.map;
    const markers = api.getMarkers();
    const nodes = [...document.querySelectorAll('.map-cluster')];
    return {
      markers,
      nodes: nodes.length,
      counts: nodes.map((node) => Number(node.dataset.count || 0)).sort((a, b) => b - a),
      zoom: api.getView().zoom,
    };
  })()`);
  check(
    'overlapping results collapse into numbered clusters',
    clusterState.markers.clusters >= 1 &&
      clusterState.nodes === clusterState.markers.clusters &&
      clusterState.counts.every((count) => count >= 2) &&
      clusterState.counts.reduce((sum, count) => sum + count, 0) === clusterState.markers.clustered,
    JSON.stringify(clusterState),
  );
  const clusterClick = await cdp.eval(`(async () => {
    const module = await import('/app/main.js');
    const api = module.ctx.moduleApis.map;
    const before = api.getView().zoom;
    const biggest = [...document.querySelectorAll('.map-cluster')].sort((a, b) => Number(b.dataset.count) - Number(a.dataset.count))[0];
    const count = Number(biggest?.dataset.count || 0);
    biggest?.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const markers = api.getMarkers();
    return { before, after: api.getView().zoom, count, markers, counted: markers.individual + markers.clustered };
  })()`);
  check(
    'clicking a cluster zooms in and keeps its records reachable',
    clusterClick.count >= 2 && clusterClick.after > clusterClick.before && clusterClick.counted > 0,
    JSON.stringify(clusterClick),
  );

  /* --- 8o. point piles: a cluster zooming provably cannot split -------------
   * Groups of records in the seed share one *documented* anchor (six Zürich
   * Stadtpläne sit on 47.358330 / 8.533340), so their pins keep landing in the
   * same 56 px cell at every zoom level. The pile is derived from the committed
   * seed at run time — a new harvest may move it, but it cannot make this check
   * lie — and the time range is the pile's own years, so no filter hides its
   * members. maps-2 owns map.js; this section is additive, flagged in
   * coordination/zurich-maps-2.md.
   */
  const pile = await cdp.eval(`(async () => {
    const seed = await (await fetch('/data/records.json')).json();
    let records = Array.isArray(seed) ? seed : (seed.records ?? []);
    if (!Array.isArray(seed)) {
      for (const url of seed.shards ?? []) {
        const shard = await (await fetch(url)).json();
        records = records.concat(shard.records ?? []);
      }
    }
    const groups = new Map();
    for (const record of records) {
      const geo = record.geo;
      if (!geo || !Number.isFinite(geo.lat) || !Number.isFinite(geo.lon)) continue;
      const key = geo.lat.toFixed(6) + ':' + geo.lon.toFixed(6);
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    const biggest = [...groups.values()].filter((list) => list.length > 2).sort((a, b) => b.length - a.length)[0];
    if (!biggest) return null;
    const years = biggest.map((record) => record.yearStart).sort((a, b) => a - b);
    return {
      count: biggest.length,
      lat: biggest[0].geo.lat,
      lon: biggest[0].geo.lon,
      ids: biggest.map((record) => record.id),
      firstTitle: biggest[0].title,
      from: years[0],
      to: years[years.length - 1],
    };
  })()`);
  if (pile) {
    const pileUrl = `${BASE_URL}/?lat=${pile.lat.toFixed(5)}&lon=${pile.lon.toFixed(5)}&z=17&from=${pile.from}&to=${pile.to}`;
    await cdp.send('Page.navigate', { url: pileUrl });
    await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'point pile records' });
    await cdp.waitFor(`document.querySelector('.map-cluster[data-action=\"list\"]') != null`, { label: 'point pile cluster', timeout: 15_000 });

    // The hover card is read in the same turn as the event: a deferred re-render
    // (records:filtered, ResizeObserver) legitimately hides it again.
    const pileCluster = await cdp.eval(`(() => {
      const node = document.querySelector('.map-cluster[data-action="list"]');
      node.dispatchEvent(new PointerEvent('pointerenter', { bubbles: true }));
      const card = document.querySelector('.map-preview');
      const snapshot = { cardText: card.textContent, cardHidden: card.hidden };
      node.dispatchEvent(new PointerEvent('pointerleave', { bubbles: true }));
      return {
        count: Number(node.dataset.count || 0),
        action: node.dataset.action,
        label: node.getAttribute('aria-label') || '',
        cardText: snapshot.cardText,
        cardHidden: snapshot.cardHidden,
        zoom: new URLSearchParams(location.search).get('z'),
      };
    })()`);
    check(
      'a cluster of records on one documented point offers its list instead of a zoom',
      pileCluster.count === pile.count &&
        pileCluster.action === 'list' &&
        !pileCluster.cardHidden &&
        /Open list/.test(pileCluster.label) &&
        !/Zoom in to explore/.test(pileCluster.label) &&
        /Click to browse/.test(pileCluster.cardText),
      JSON.stringify(pileCluster),
    );

    // The list must be reachable without a mouse: focus the pin, press Enter.
    await cdp.eval(`document.querySelector('.map-cluster[data-action="list"]').focus(); true`);
    await cdp.pressKey('Enter');
    await sleep(500);
    const pileList = await cdp.eval(`(() => {
      const list = document.querySelector('.map-cluster-list');
      const items = [...list.querySelectorAll('.map-cluster-list__item')];
      const mapRect = document.querySelector('#map').getBoundingClientRect();
      const rect = list.getBoundingClientRect();
      return {
        hidden: list.hidden,
        role: list.getAttribute('role'),
        title: document.getElementById(list.getAttribute('aria-labelledby'))?.textContent || '',
        items: items.length,
        ids: items.map((item) => item.dataset.recordId),
        firstFocused: document.activeElement === items[0],
        firstText: items[0]?.textContent || '',
        insideMap: rect.top >= mapRect.top - 1 && rect.bottom <= mapRect.bottom + 1 && rect.left >= mapRect.left - 1 && rect.right <= mapRect.right + 1,
        zoom: new URLSearchParams(location.search).get('z'),
      };
    })()`);
    check(
      'the pile list is a labelled dialog that names every record and takes focus',
      !pileList.hidden &&
        pileList.role === 'dialog' &&
        pileList.title === `Karten an diesem Punkt (${pile.count})` &&
        pileList.items === pile.count &&
        pile.count === pileList.ids.length &&
        pileList.firstFocused &&
        pileList.insideMap &&
        pileList.zoom === '17',
      JSON.stringify(pileList),
    );
    await cdp.screenshot(path.join(OUT_DIR, '12-point-pile.png')).then(() => report.screenshots.push('12-point-pile.png'));

    // Choosing a row is a real record choice: the same path as a marker click.
    await cdp.pressKey('Enter');
    await cdp.waitFor(`document.querySelector('#detail') && !document.querySelector('#detail').hidden`, { label: 'pile detail panel', timeout: 15_000 });
    await sleep(400);
    const pileChoice = await cdp.eval(`(() => ({
      listHidden: document.querySelector('.map-cluster-list').hidden,
      url: location.search,
      detailTitle: document.querySelector('#detail-title')?.textContent || '',
      source: document.querySelector('#detail a[href^="https://"]')?.getAttribute('href') || '',
    }))()`);
    const chosenId = new URLSearchParams(pileChoice.url).get('sel');
    check(
      'pressing Enter on a pile row opens that record and closes the list',
      pileChoice.listHidden && pile.ids.includes(chosenId) && pileChoice.detailTitle.length > 0 && pileChoice.source.startsWith('https://'),
      `${chosenId} · ${pileChoice.detailTitle.slice(0, 48)} · ${pileChoice.source}`,
    );
    await cdp.pressKey('Escape');
    await sleep(400);

    // Escape closes the list and hands focus back to the pin it came from.
    await cdp.eval(`document.querySelector('.map-cluster[data-action="list"]').focus(); true`);
    await cdp.pressKey('Enter');
    await sleep(400);
    await cdp.pressKey('Escape');
    await sleep(400);
    const pileEscape = await cdp.eval(`(() => ({
      hidden: document.querySelector('.map-cluster-list').hidden,
      focusOnPin: document.activeElement === document.querySelector('.map-cluster[data-action="list"]'),
    }))()`);
    check(
      'Escape closes the pile list and returns focus to the pin',
      pileEscape.hidden && pileEscape.focusOnPin,
      JSON.stringify(pileEscape),
    );

    // The list does not remove the zoom gesture, it only stops being the *only*
    // offer: “Zoom in anyway” really zooms (and cannot loop back
    // into the list it came from).
    await cdp.eval(`document.querySelector('.map-cluster[data-action="list"]').focus(); true`);
    await cdp.pressKey('Enter');
    await sleep(400);
    const pileZoom = await cdp.eval(`(async () => {
      const before = new URLSearchParams(location.search).get('z');
      const foot = document.querySelector('.map-cluster-list__foot button');
      const label = foot?.textContent || '';
      foot?.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      return { label, before, after: new URLSearchParams(location.search).get('z'), hidden: document.querySelector('.map-cluster-list').hidden };
    })()`);
    check(
      'the pile list still offers a real zoom (no dead end)',
      pileZoom.label.includes('Zoom in') && Number(pileZoom.after) > Number(pileZoom.before) && pileZoom.hidden,
      JSON.stringify(pileZoom),
    );
  } else {
    console.log('· no point pile in this seed — the pile checks were skipped');
  }

  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'start page after the pile checks' });
  await sleep(600);

  const mapOnly = await cdp.eval(`(() => {
    document.querySelector('[data-view="map"]')?.click();
    const map = document.querySelector('#map');
    const rect = map.getBoundingClientRect();
    const above = document.elementFromPoint(Math.round(rect.x + rect.width / 2), Math.max(0, Math.round(rect.y - 24)));
    const markers = [...document.querySelectorAll('.map-marker')].map((m) => m.getBoundingClientRect());
    return {
      view: document.body.className,
      intro: getComputedStyle(document.querySelector('.app-intro')).display,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      height: Math.round(rect.height),
      top: Math.round(rect.y),
      markers: markers.length,
      markersInside: markers.filter((b) => {
        const cx = b.x + b.width / 2;
        const cy = b.y + b.height / 2;
        return cx >= rect.x && cx <= rect.right && cy >= rect.y && cy <= rect.bottom;
      }).length,
      aboveIsMap: Boolean(above && above.closest && above.closest('#map')),
    };
  })()`);
  check(
    'map-only view keeps tiles and markers inside the map box',
    mapOnly.view.includes('app-view--map') &&
      mapOnly.intro === 'none' &&
      mapOnly.overflow <= 1 &&
      mapOnly.height > 300 &&
      mapOnly.markers > 0 &&
      mapOnly.markersInside === mapOnly.markers &&
      mapOnly.aboveIsMap === false,
    JSON.stringify(mapOnly),
  );
  await cdp.screenshot(path.join(OUT_DIR, '05-map-only.png')).then(() => report.screenshots.push('05-map-only.png'));

  const listOnly = await cdp.eval(`(() => {
    document.querySelector('[data-view="list"]')?.click();
    return {
      view: document.body.className,
      mapDisplay: getComputedStyle(document.querySelector('.app-mapwrap')).display,
      rows: document.querySelectorAll('#result-list > *').length,
      columns: getComputedStyle(document.querySelector('#result-list')).gridTemplateColumns.split(' ').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  check(
    'list-only view hides the map and keeps the results readable',
    listOnly.view.includes('app-view--list') &&
      listOnly.mapDisplay === 'none' &&
      listOnly.rows > 0 &&
      listOnly.columns > 1 &&
      listOnly.overflow <= 1,
    JSON.stringify(listOnly),
  );
  // Back to the documented default combination for anything that follows.
  await cdp.eval(`document.querySelector('[data-view="split"]')?.click(); true`);
  await sleep(400);
  /* --- 8h. pin/unpin from the detail panel ------------------------------ */
  // Runs after 8f, which leaves the device-local Merkliste empty and the URL
  // clean, so the first record really starts unpinned.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'results for detail pin' });
  await cdp.click('#result-list > *');
  await cdp.waitFor(`document.querySelector('#detail-pin') ? true : ''`, { label: 'detail pin button', timeout: 10_000 });
  const pinBefore = await cdp.eval(`(() => { const b = document.querySelector('#detail-pin'); return { exists: Boolean(b), pressed: b?.getAttribute('aria-pressed'), cmp: new URLSearchParams(location.search).get('cmp') }; })()`);
  await cdp.click('#detail-pin');
  let pinnedFromDetail = null;
  try {
    pinnedFromDetail = await cdp.waitFor(
      `(() => { const cmp = new URLSearchParams(location.search).get('cmp'); if (!cmp) return ''; const b = document.querySelector('#detail-pin'); return { cmp, pressed: b?.getAttribute('aria-pressed'), items: document.querySelectorAll('#compare-list .app-compare__item').length }; })()`,
      { label: 'pinned from detail', timeout: 10_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'the detail panel pins the open record for the comparison',
    pinBefore.exists === true && pinBefore.pressed === 'false' && !pinBefore.cmp && pinnedFromDetail?.pressed === 'true' && pinnedFromDetail?.cmp && pinnedFromDetail.items >= 1,
    `${JSON.stringify(pinBefore)} -> ${JSON.stringify(pinnedFromDetail)}`,
  );
  await cdp.click('#detail-pin');
  let unpinnedFromDetail = null;
  try {
    unpinnedFromDetail = await cdp.waitFor(
      `(() => { if (new URLSearchParams(location.search).get('cmp')) return ''; const b = document.querySelector('#detail-pin'); return { pressed: b?.getAttribute('aria-pressed'), items: document.querySelectorAll('#compare-list .app-compare__item').length }; })()`,
      { label: 'unpinned from detail', timeout: 10_000 },
    );
  } catch {
    /* reported below */
  }
  check('the same button unpins the record again', unpinnedFromDetail?.pressed === 'false', JSON.stringify(unpinnedFromDetail));

  // The result list is much taller than the map: scrolling it must keep the map
  // (and its controls) in view. The sticky element is the wrapper, because the
  // map alone is only as tall as its parent and therefore never sticks.
  const stickyMap = await cdp.eval(`(() => {
    window.scrollTo({ top: 1200, behavior: 'instant' });
    return true;
  })()`);
  await sleep(400);
  const stickyState = await cdp.eval(`(() => {
    const rect = document.querySelector('#map').getBoundingClientRect();
    const wrapper = getComputedStyle(document.querySelector('.app-mapwrap'));
    return {
      scrollY: window.scrollY,
      mapTop: Math.round(rect.y),
      mapBottom: Math.round(rect.bottom),
      height: Math.round(rect.height),
      position: wrapper.position,
      inView: rect.top >= 0 && rect.top < window.innerHeight / 2 && rect.bottom > window.innerHeight / 2,
    };
  })()`);
  check(
    'scrolling the result list keeps the map in view (sticky map)',
    Boolean(stickyMap) && stickyState.scrollY > 400 && stickyState.position === 'sticky' && stickyState.inView && stickyState.height > 300,
    JSON.stringify(stickyState),
  );
  await cdp.eval(`window.scrollTo({ top: 0, behavior: 'instant' }); true`);

  /* --- 8h2. a pin selection brings its row into view (maps-2) ----------- */
  // With 199 records a pin's row can be screens away from the map, so a map
  // selection scrolls the list to that row and marks it. Only in the desktop
  // split layout (the map column is sticky there, so the page can move without
  // taking the map away); on a phone the page must stay where the visitor is.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 20`, { label: 'rows for the reveal check' });
  await cdp.waitFor(`document.querySelectorAll('.map-marker:not(.map-cluster)').length > 0`, { label: 'markers for the reveal check' });
  await sleep(800);
  // The marker with the lowest list position: its row is the furthest away from
  // what the map currently shows, and it is a real pin in the current viewport.
  const revealTarget = await cdp.eval(`(() => {
    const rows = [...document.querySelectorAll('#result-list > *')];
    const index = new Map(rows.map((li, i) => [li.querySelector('button.zh-result')?.dataset.recordId, i]));
    let best = null;
    for (const marker of document.querySelectorAll('.map-marker:not(.map-cluster)')) {
      const i = index.get(marker.dataset.id);
      if (i === undefined) continue;
      if (!best || i < best.index) best = { index: i, id: marker.dataset.id };
    }
    if (!best) return null;
    const row = rows[best.index].getBoundingClientRect();
    // Park the row above the viewport on purpose: the reveal has to bring it
    // back, not find it already visible.
    window.scrollTo({ top: window.scrollY + row.top + 240, behavior: 'instant' });
    const rect = rows[best.index].getBoundingClientRect();
    const markerRect = document.querySelector('.map-marker[data-id="' + CSS.escape(best.id) + '"]').getBoundingClientRect();
    return {
      ...best,
      scrollY: window.scrollY,
      rowOutOfView: rect.bottom < 0 || rect.top > window.innerHeight,
      x: markerRect.left + markerRect.width / 2,
      y: markerRect.top + markerRect.height / 2,
      mapVisible: document.querySelector('#map').getBoundingClientRect().bottom > 0,
    };
  })()`);
  let revealAfter = null;
  if (revealTarget) {
    // A real mouse click at the pin: no `scrollIntoView`, the page position is
    // exactly what this check is about.
    const point = { x: Math.round(revealTarget.x), y: Math.round(revealTarget.y), button: 'left', clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    try {
      await cdp.waitFor(`new URLSearchParams(location.search).get('sel') === ${JSON.stringify(revealTarget.id)}`, { label: 'pin selection', timeout: 8_000 });
    } catch {
      /* reported below */
    }
    revealAfter = await cdp.eval(`(() => {
      const li = [...document.querySelectorAll('#result-list > *')].find((node) => node.querySelector('button')?.dataset.recordId === ${JSON.stringify(revealTarget.id)});
      if (!li) return null;
      const button = li.querySelector('button');
      const rect = li.getBoundingClientRect();
      const detail = document.querySelector('#detail');
      const panelLeft = detail.hidden ? window.innerWidth : detail.getBoundingClientRect().left;
      return {
        scrollY: window.scrollY,
        top: Math.round(rect.top),
        bottom: Math.round(rect.bottom),
        inView: rect.top >= 0 && rect.bottom <= window.innerHeight,
        selected: button.getAttribute('aria-current'),
        revealed: button.classList.contains('is-revealed'),
        coveredByPanel: rect.right > panelLeft,
        mapVisible: document.querySelector('#map').getBoundingClientRect().bottom > 0,
        live: document.querySelector('#results-live')?.textContent || '',
      };
    })()`);
  }
  check(
    'a pin click brings its result row into view in the split layout',
    Boolean(revealTarget) &&
      revealTarget.rowOutOfView === true &&
      revealTarget.mapVisible === true &&
      revealAfter?.inView === true &&
      revealAfter?.selected === 'true' &&
      revealAfter?.revealed === true &&
      revealAfter?.coveredByPanel === false &&
      revealAfter?.mapVisible === true &&
      revealAfter?.scrollY !== revealTarget.scrollY,
    `${JSON.stringify(revealTarget && { id: revealTarget.id, index: revealTarget.index, scrollY: revealTarget.scrollY, rowOutOfView: revealTarget.rowOutOfView })} -> ${JSON.stringify(revealAfter)}`,
  );
  // The same selection has to be announced: the reveal moves the page for a
  // sighted visitor, and `#results-live` (role="status") is what tells a screen
  // reader which row the list moved to and that the page scrolled with it.
  check(
    'the map selection is announced with its row number in the live region',
    Boolean(revealAfter) &&
      revealAfter.live.includes(`Zeile ${revealTarget.index + 1} von `) &&
      revealAfter.live.includes('selected') &&
      revealAfter.live.includes('scrolled'),
    JSON.stringify(revealAfter?.live || ''),
  );
  await cdp.screenshot(path.join(OUT_DIR, '13-map-reveal.png')).then(() => report.screenshots.push('13-map-reveal.png'));

  // The same click on a phone must not scroll: the map is not sticky there, so
  // the reveal would carry the visitor away from the pin they just used.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 20`, { label: 'phone rows for the reveal check' });
  await cdp.waitFor(`document.querySelectorAll('.map-marker:not(.map-cluster)').length > 0`, { label: 'phone markers for the reveal check' });
  await sleep(900);
  const phonePin = await cdp.eval(`(() => {
    const marker = [...document.querySelectorAll('.map-marker:not(.map-cluster)')].find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.top > 40 && rect.bottom < window.innerHeight - 40;
    });
    if (!marker) return null;
    const rect = marker.getBoundingClientRect();
    return { id: marker.dataset.id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, scrollY: window.scrollY };
  })()`);
  let phoneAfter = null;
  if (phonePin) {
    const point = { x: Math.round(phonePin.x), y: Math.round(phonePin.y), button: 'left', clickCount: 1 };
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point });
    try {
      await cdp.waitFor(`new URLSearchParams(location.search).get('sel') === ${JSON.stringify(phonePin.id)}`, { label: 'phone pin selection', timeout: 8_000 });
    } catch {
      /* reported below */
    }
    phoneAfter = await cdp.eval(`({ scrollY: window.scrollY, sel: new URLSearchParams(location.search).get('sel'), revealed: document.querySelectorAll('.zh-result.is-revealed').length, live: document.querySelector('#results-live')?.textContent || '' })`);
  }
  check(
    '390 px: a pin click keeps the page on the map it was used on',
    Boolean(phonePin) && phoneAfter?.sel === phonePin.id && Math.abs(phoneAfter.scrollY - phonePin.scrollY) <= 2 && phoneAfter.revealed === 0,
    `${JSON.stringify(phonePin && { id: phonePin.id, scrollY: phonePin.scrollY })} -> ${JSON.stringify(phoneAfter)}`,
  );
  // The phone keeps the page still, but the selection still has to be announced
  // — without the “the list scrolled” clause, which would be a lie there.
  check(
    '390 px: the selection is announced without claiming a scroll',
    Boolean(phoneAfter) && phoneAfter.live.includes('selected') && phoneAfter.live.includes('Row ') && !phoneAfter.live.includes('scrolled'),
    JSON.stringify(phoneAfter?.live || ''),
  );

  /* --- 8h3. Windows high contrast / forced colors (maps-2) -------------- */
  // The selected pin, the selected row and the selected decade are communicated
  // with `background-color`, which forced-colors mode replaces. The rules in
  // app.css use system colours and borders instead; this drives the real
  // emulation and compares a selected element with an unselected one.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 20`, { label: 'rows for the forced-colors check' });
  await cdp.waitFor(`document.querySelectorAll('.map-marker:not(.map-cluster)').length > 0`, { label: 'markers for the forced-colors check' });
  await sleep(800);
  await cdp.eval(`(() => { document.querySelector('.map-marker:not(.map-cluster)').click(); return true; })()`);
  try {
    await cdp.waitFor(`new URLSearchParams(location.search).get('sel') ? true : ''`, { label: 'selection for the forced-colors check', timeout: 8_000 });
  } catch {
    /* reported below */
  }
  await sleep(400);
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] });
  await sleep(400);
  const forcedColors = await cdp.eval(`(() => {
    const paint = (node) => {
      if (!node) return null;
      const style = getComputedStyle(node);
      return {
        background: style.backgroundColor,
        borderLeft: style.borderLeftWidth + ' ' + style.borderLeftColor,
        borderStyle: style.borderTopStyle,
        outline: style.outlineWidth + ' ' + style.outlineStyle,
      };
    };
    const bins = [...document.querySelectorAll('.zh-histogram__bin')];
    const currentBin = bins.find((bin) => bin.getAttribute('aria-current') === 'true');
    const otherBin = bins.find((bin) => bin.getAttribute('aria-current') !== 'true' && !bin.classList.contains('is-empty'));
    return {
      matches: matchMedia('(forced-colors: active)').matches,
      selectedRow: paint(document.querySelector('.zh-result[aria-current="true"]')),
      otherRow: paint(document.querySelector('.zh-result:not([aria-current="true"])')),
      selectedPin: paint(document.querySelector('.map-marker.is-selected')),
      otherPin: paint(document.querySelector('.map-marker:not(.is-selected):not(.map-cluster)')),
      currentBar: paint(currentBin?.querySelector('.zh-histogram__bar')),
      otherBar: paint(otherBin?.querySelector('.zh-histogram__bar')),
    };
  })()`);
  check(
    'forced colors: the selected pin, row and decade keep a state of their own',
    forcedColors?.matches === true &&
      forcedColors.selectedRow?.borderLeft !== forcedColors.otherRow?.borderLeft &&
      forcedColors.otherRow?.borderStyle === 'solid' &&
      forcedColors.selectedPin?.background !== forcedColors.otherPin?.background &&
      forcedColors.selectedPin?.outline.startsWith('3px solid') &&
      forcedColors.currentBar?.background !== forcedColors.otherBar?.background,
    JSON.stringify(forcedColors),
  );
  await cdp.screenshot(path.join(OUT_DIR, '13b-forced-colors.png')).then(() => report.screenshots.push('13b-forced-colors.png'));

  // A brushed range under the mode: the bars' own fill is replaced by the
  // system colour, so `.is-brushing` adds a Highlight fill *and* an outline.
  // This drives the real drag and compares a brushed decade with a plain one
  // (the drag is released afterwards, which commits the range as usual).
  // The detail panel has to go first: its `.app-scrim` covers the sidebar, so a
  // real mouse event would land on the scrim instead of a bar.
  await cdp.eval(`(() => {
    const close = [...document.querySelectorAll('#detail button')].find((node) => /Schliessen/.test(node.textContent));
    close?.click();
    return true;
  })()`);
  await sleep(400);
  const fcBrushBins = await cdp.eval(`(() => {
    const host = document.querySelector('#year-histogram');
    host.scrollIntoView({ block: 'center', behavior: 'instant' });
    return [...host.querySelectorAll('button')].filter((b) => !b.classList.contains('is-empty')).slice(0, 4).map((b) => {
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height - 6) };
    });
  })()`);
  let fcBrush = null;
  if (fcBrushBins.length >= 2) {
    const from = fcBrushBins[0];
    const to = fcBrushBins[fcBrushBins.length - 1];
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let step = 1; step <= 6; step += 1) {
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(from.x + ((to.x - from.x) * step) / 6),
        y: to.y,
        button: 'left',
        buttons: 1,
      });
      await sleep(20);
    }
    fcBrush = await cdp.eval(`(() => {
      const paint = (node) => {
        if (!node) return null;
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, outline: style.outlineWidth + ' ' + style.outlineStyle + ' ' + style.outlineColor };
      };
      const brushedBin = document.querySelector('.zh-histogram__bin.is-brushing');
      // A plain decade is neither brushed nor part of the current period: the
      // current ones are already Highlight, which is what a brush paints too.
      const plainBin = [...document.querySelectorAll('.zh-histogram__bin')].find(
        (b) => !b.classList.contains('is-brushing') && !b.classList.contains('is-empty') && b.getAttribute('aria-current') !== 'true',
      );
      return {
        brushed: document.querySelectorAll('#year-histogram .is-brushing').length,
        brushedBar: paint(brushedBin?.querySelector('.zh-histogram__bar')),
        plainBar: paint(plainBin?.querySelector('.zh-histogram__bar')),
        brushedOutline: paint(brushedBin)?.outline,
        plainOutline: paint(plainBin)?.outline,
        scrimHidden: document.querySelector('#scrim')?.hidden === true,
      };
    })()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0 });
    await sleep(300);
  }
  check(
    'forced colors: a brushed range keeps a Highlight fill and an outline',
    Boolean(fcBrush) &&
      fcBrush.brushed >= 2 &&
      fcBrush.scrimHidden === true &&
      fcBrush.brushedBar?.background !== fcBrush.plainBar?.background &&
      fcBrush.brushedOutline?.startsWith('1px solid') === true,
    JSON.stringify(fcBrush),
  );
  await cdp.send('Emulation.setEmulatedMedia', { features: [] });

  /* --- 8i. no placeholder values in the rendered UI --------------------- */
  // `replaceChildren(null)` renders a literal "null" text node (unlike `el()`),
  // so the panel with the most conditional links is scanned after a real session.
  const leaks = await cdp.eval(`(() => {
    const bad = [];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walk.nextNode(); node; node = walk.nextNode()) {
      const text = (node.nodeValue || '').trim();
      if (text === 'null' || text === 'undefined' || text === 'NaN' || text === 'object Object') {
        const host = node.parentElement;
        bad.push((host?.id || host?.className || host?.tagName || '?') + ' = ' + text);
      }
    }
    return bad;
  })()`);
  check('no placeholder value (null/undefined/NaN) is rendered in the UI', leaks.length === 0, leaks.slice(0, 6).join(' | '));

  /* --- 8j. point filter: browse the maps that cover a place ----------- */
  // The OldMapsOnline step after finding a place: narrow the list to the maps
  // whose documented extent covers a point. Keyboard route (P / the map-centre
  // button), a real map click, the shared URL and the honest empty state.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&to=1900` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'point filter page' });
  await sleep(700);
  const rowsBeforePoint = await cdp.eval(`document.querySelectorAll('#result-list > *').length`);
  await cdp.eval(`document.querySelector('#map').focus()`);
  await cdp.pressKey('p');
  let pointOn = null;
  try {
    pointOn = await cdp.waitFor(
      `(() => {
        const chip = document.querySelector('#point-filter');
        if (!chip || chip.hidden) return '';
        // The list render is debounced (40 ms): wait for the filtered rows too,
        // otherwise this reads the previous list and fails on a race.
        const rows = document.querySelectorAll('#result-list > *').length;
        if (rows >= ${rowsBeforePoint}) return '';
        return {
          url: location.search,
          text: document.querySelector('#point-filter-text')?.textContent || '',
          rows,
          crosshair: Boolean(document.querySelector('.map-point')),
        };
      })()`,
      { label: 'point filter on', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'keyboard: P filters the results to the map-centre point',
    Boolean(pointOn?.url.includes('at=')) && pointOn.rows > 0 && pointOn.rows < rowsBeforePoint && pointOn.crosshair && /Karten an diesem Punkt/.test(pointOn.text),
    JSON.stringify(pointOn),
  );

  await cdp.click('#point-filter-clear');
  await sleep(500);
  const pointOff = await cdp.eval(`({
    url: location.search,
    hidden: document.querySelector('#point-filter').hidden,
    rows: document.querySelectorAll('#result-list > *').length,
    crosshair: Boolean(document.querySelector('.map-point')),
  })`);
  check(
    'clearing the point filter restores the whole result list',
    !pointOff.url.includes('at=') && pointOff.hidden && pointOff.rows === rowsBeforePoint && !pointOff.crosshair,
    JSON.stringify(pointOff),
  );

  const mapCentre = await cdp.eval(`(() => { window.scrollTo({ top: 0, behavior: 'instant' }); const r = document.querySelector('#map').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mapCentre.x, y: mapCentre.y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mapCentre.x, y: mapCentre.y, button: 'left', clickCount: 1 });
  let pointClick = null;
  try {
    pointClick = await cdp.waitFor(
      `(() => {
        const chip = document.querySelector('#point-filter');
        if (!chip || chip.hidden) return '';
        const rows = document.querySelectorAll('#result-list > *').length;
        if (rows >= ${rowsBeforePoint}) return '';
        return { url: location.search, rows };
      })()`,
      { label: 'point filter after click', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'a real map click filters the results to the clicked point',
    Boolean(pointClick) && /at=47\.37|at=47\.38/.test(pointClick.url) && pointClick.rows > 0 && pointClick.rows < rowsBeforePoint,
    JSON.stringify(pointClick),
  );

  // The visible keyboard skip list under the map is the discoverable route to
  // the same filter (the ⌖ control inside the map is only reachable after it).
  await cdp.click('#point-filter-clear');
  await sleep(400);
  await cdp.click('[data-map-cmd="point"]');
  let pointChip = null;
  try {
    pointChip = await cdp.waitFor(
      `(() => {
        const chip = document.querySelector('#point-filter');
        if (!chip || chip.hidden) return '';
        const rows = document.querySelectorAll('#result-list > *').length;
        if (rows >= ${rowsBeforePoint}) return '';
        return { url: location.search, rows, label: document.querySelector('[data-map-cmd="point"]').textContent.trim() };
      })()`,
      { label: 'skip-list point filter', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'the map skip list offers the point filter for keyboard users',
    Boolean(pointChip) && pointChip.url.includes('at=') && pointChip.rows > 0 && /Punktfilter/.test(pointChip.label),
    JSON.stringify(pointChip),
  );
  await cdp.click('#point-filter-clear');
  await sleep(400);

  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&to=1900&at=47.3769%2C8.5417` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'shared point page' });
  await sleep(600);
  const sharedPoint = await cdp.eval(`({
    url: location.search,
    hidden: document.querySelector('#point-filter').hidden,
    text: document.querySelector('#point-filter-text').textContent,
    rows: document.querySelectorAll('#result-list > *').length,
    crosshair: Boolean(document.querySelector('.map-point')),
  })`);
  check(
    'a shared ?at= link restores the point filter and shows the point',
    !sharedPoint.hidden && sharedPoint.url.includes('at=47.3769') && /Karten an diesem Punkt/.test(sharedPoint.text) && sharedPoint.rows > 0 && sharedPoint.crosshair,
    JSON.stringify(sharedPoint),
  );
  // Evidence screenshot for the new interaction (chip + crosshair on the map).
  await cdp.eval(`document.querySelector('#point-filter')?.scrollIntoView({ block: 'center' }); true`);
  await sleep(300);
  await cdp.screenshot(path.join(OUT_DIR, '06-point-filter.png')).then(() => report.screenshots.push('06-point-filter.png'));

  // The chip row must survive the smallest cantonal breakpoint, like every other
  // filter control (390 px is the phone the rest of the harness uses).
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&to=1900&at=47.3769%2C8.5417` });
  await cdp.waitFor(`(() => { const chip = document.querySelector('#point-filter'); return chip && !chip.hidden && document.querySelector('#point-filter-clear'); })()`, { label: 'mobile point filter', timeout: 8_000 });
  await sleep(500);
  const mobilePoint = await cdp.eval(`({
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    chipVisible: document.querySelector('#point-filter').getBoundingClientRect().height > 20,
    clear: document.querySelector('#point-filter-clear').textContent.trim(),
  })`);
  check(
    '390 px: the point filter chip stays inside the page',
    mobilePoint.overflow <= 1 && mobilePoint.chipVisible && /Punktfilter/.test(mobilePoint.clear),
    JSON.stringify(mobilePoint),
  );
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await cdp.send('Page.navigate', { url: `${BASE_URL}/?${uncoveredQuery}&at=${uncoveredAt}` });
  let emptyPoint = null;
  try {
    emptyPoint = await cdp.waitFor(
      `(() => {
        const chip = document.querySelector('#point-filter');
        if (!chip || chip.hidden) return '';
        const state = document.querySelector('#results-state');
        return { rows: document.querySelectorAll('#result-list > *').length, empty: state?.hidden === false, text: state?.textContent.slice(0, 90) || '' };
      })()`,
      { label: 'empty point state', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  const pointRemove = await cdp.eval(`(() => {
    const button = [...document.querySelectorAll('#results-state button')].find((b) => /Punktfilter/.test(b.textContent));
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(500);
  const afterPointRemove = await cdp.eval(`({ rows: document.querySelectorAll('#result-list > *').length, at: new URLSearchParams(location.search).get('at') })`);
  check(
    `a point with no map in the chosen period says so and can be removed on its own (${uncoveredPoint.lat}, ${uncoveredPoint.lon} · ${uncoveredPoint.from}–${uncoveredPoint.to})`,
    Boolean(emptyPoint) && emptyPoint.rows === 0 && emptyPoint.empty && pointRemove === true && afterPointRemove.rows > 0 && !afterPointRemove.at,
    `${JSON.stringify(emptyPoint)} remove=${pointRemove} ${JSON.stringify(afterPointRemove)}`,
  );

  // Place search -> “Karten an diesem Ort”: the quick picks need no network, so
  // this check also runs when the gazetteer is unreachable.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'place action page' });
  await sleep(600);
  const rowsBeforePlace = await cdp.eval(`document.querySelectorAll('#result-list > *').length`);
  await cdp.eval(`document.querySelector('#place-quick button').click()`);
  let placeBrowse = null;
  try {
    placeBrowse = await cdp.waitFor(
      `(() => { const chip = document.querySelector('#place-action button'); return chip ? { text: chip.textContent, pressed: chip.getAttribute('aria-pressed') } : ''; })()`,
      { label: 'place browse chip', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  await cdp.eval(`document.querySelector('#place-action button')?.click()`);
  let placeApplied = null;
  try {
    placeApplied = await cdp.waitFor(
      `(() => {
        const chip = document.querySelector('#point-filter');
        if (!chip || chip.hidden) return '';
        const rows = document.querySelectorAll('#result-list > *').length;
        if (rows >= ${rowsBeforePlace}) return '';
        return { url: location.search, rows };
      })()`,
      { label: 'place point filter', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'place search offers browsing the maps that cover the chosen place',
    Boolean(placeBrowse && /Karten an diesem Ort/.test(placeBrowse.text)) && Boolean(placeApplied) && placeApplied.url.includes('at=47.3769') && placeApplied.rows > 0 && placeApplied.rows < rowsBeforePlace,
    `chip ${JSON.stringify(placeBrowse)} -> ${JSON.stringify(placeApplied)}`,
  );
  await cdp.eval(`document.querySelector('#point-filter-clear')?.click()`);
  await sleep(400);

  /* --- 8k. the detail panel leads to the series ------------------------- */
  const seriesRecord = [...recordIndex.values()].find(
    (record) => record.collection && [...recordIndex.values()].filter((other) => other.collection === record.collection && other.id !== record.id).length >= 2,
  );
  if (seriesRecord) {
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(seriesRecord.id)}` });
    await cdp.waitFor(`document.querySelector('#detail-related') ? true : ''`, { label: 'related section', timeout: 15_000 });
    const related = await cdp.eval(`(() => {
      const section = document.querySelector('#detail-related');
      return {
        heading: section?.querySelector('h3')?.textContent || '',
        chips: section?.querySelectorAll('li button').length ?? 0,
        filterButton: [...(section?.querySelectorAll('button') ?? [])].some((button) => /Sammlung in der Ergebnisliste/.test(button.textContent)),
        before: document.querySelector('#detail-title')?.textContent?.slice(0, 50) || '',
      };
    })()`);
    await cdp.click('#detail-related li button');
    let switched = null;
    try {
      switched = await cdp.waitFor(
        `(() => { const sel = new URLSearchParams(location.search).get('sel'); const title = document.querySelector('#detail-title')?.textContent || ''; return sel && sel !== ${JSON.stringify(seriesRecord.id)} && title && title !== ${JSON.stringify(related.before)} ? { sel, title: title.slice(0, 50) } : ''; })()`,
        { label: 'related record switch', timeout: 10_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'the detail panel leads to the other sheets of the same series',
      related.chips >= 2 && /Weitere Karten dieser Sammlung/.test(related.heading) && related.filterButton === true && Boolean(switched?.sel) && switched.sel !== seriesRecord.id,
      `${seriesRecord.id} · "${related.heading}" · ${related.chips} chips · filter=${related.filterButton} -> ${JSON.stringify(switched)}`,
    );
  } else {
    check('the detail panel leads to the other sheets of the same series', false, 'no record with 2+ siblings in the seed');
  }

  // “Nach oben” (cantonal `mdl-back2top`, wired in main.js): hidden at the top
  // of the page, appears once scrolled, and moves focus to the content start so
  // a keyboard user is not stranded on a control that just disappeared. The
  // detail panel (z 1100) intentionally covers the page-level button, so close
  // it first — the button belongs to the page, not the panel.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'back-to-top page' });
  await sleep(500);
  const backAtTop = await cdp.eval(`document.querySelector('#back-to-top')?.hidden ?? null`);
  await cdp.eval(`window.scrollTo({ top: 4000, behavior: 'instant' }); true`);
  let backButton = null;
  try {
    backButton = await cdp.waitFor(
      `(() => {
        const b = document.querySelector('#back-to-top');
        if (!b || b.hidden) return '';
        const r = b.getBoundingClientRect();
        return {
          w: Math.round(r.width), h: Math.round(r.height),
          radius: getComputedStyle(b).borderRadius,
          right: Math.round(window.innerWidth - r.right),
          bottom: Math.round(window.innerHeight - r.bottom),
        };
      })()`,
      { label: 'back-to-top visible', timeout: 5_000 },
    );
  } catch {
    /* reported below */
  }
  await cdp.click('#back-to-top').catch(() => {});
  let backState = null;
  try {
    backState = await cdp.waitFor(
      `(() => window.scrollY < 40 ? { scrollY: Math.round(window.scrollY), active: document.activeElement?.id || '', hidden: document.querySelector('#back-to-top')?.hidden } : '')()`,
      { label: 'scrolled back to top', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    '“Nach oben” appears when scrolled and returns to the content start',
    backAtTop === true &&
      backButton &&
      backButton.w >= 44 &&
      backButton.h >= 44 &&
      backButton.radius === '50%' &&
      backState?.active === 'main' &&
      backState.hidden === true,
    `${JSON.stringify(backButton)} -> ${JSON.stringify(backState)}`,
  );
  await cdp.eval(`window.scrollTo({ top: 0, behavior: 'instant' }); true`);

  /* --- 8l. “Footprints”: the documented footprints of the filtered set ---- */
  // The visual answer to “which maps claim to cover this place?”. The layer is
  // outline-only and purely decorative (pointer-events off, aria-hidden), so the
  // checks look at geometry and the honest status line, not at pixels.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&to=1900` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'footprint page' });
  await sleep(700);
  const extentBefore = await cdp.eval(`(() => {
    const chip = document.querySelector('.app-map__skip [data-map-cmd="extents"]');
    return {
      exists: Boolean(chip),
      pressed: chip?.getAttribute('aria-pressed'),
      label: chip?.textContent || '',
      boxes: document.querySelectorAll('.map-footprint').length,
      status: document.querySelector('#map-extent-count')?.textContent || '',
      inlineLink: Boolean(document.querySelector('.app-map__hintlink[data-map-cmd="extents"]')),
    };
  })()`);
  await cdp.click('.app-map__skip [data-map-cmd="extents"]');
  let extentOn = null;
  try {
    extentOn = await cdp.waitFor(
      `(() => {
        const boxes = [...document.querySelectorAll('.map-footprint')];
        if (boxes.length === 0) return '';
        const map = document.querySelector('#map').getBoundingClientRect();
        // Boxes are kept for a 64 px margin around the container (no edge
        // flicker while panning), so “near” is the honest test, not “inside”.
        const near = boxes.filter((b) => { const r = b.getBoundingClientRect(); return r.right > map.left - 80 && r.left < map.right + 80 && r.bottom > map.top - 80 && r.top < map.bottom + 80; }).length;
        const intersects = boxes.filter((b) => { const r = b.getBoundingClientRect(); return r.right > map.left && r.left < map.right && r.bottom > map.top && r.top < map.bottom; }).length;
        const chip = document.querySelector('.app-map__skip [data-map-cmd="extents"]');
        return {
          url: location.search,
          pressed: chip?.getAttribute('aria-pressed'),
          label: chip?.textContent || '',
          boxes: boxes.length,
          near,
          intersects,
          layerInsideMap: document.querySelector('.map-layer--footprints')?.parentElement?.id === 'map',
          status: document.querySelector('#map-extent-count')?.textContent || '',
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      })()`,
      { label: 'footprints drawn', timeout: 8_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'the “Footprints” switch draws the documented footprints and shares them in the URL',
    Boolean(extentBefore.exists && extentBefore.inlineLink && extentBefore.pressed === 'false' && extentBefore.boxes === 0 && extentBefore.status === '') &&
      Boolean(extentOn) &&
      extentOn.url.includes('ex=1') &&
      extentOn.pressed === 'true' &&
      /ausblenden/.test(extentOn.label) &&
      extentOn.boxes > 0 &&
      extentOn.near === extentOn.boxes &&
      extentOn.intersects > 0 &&
      extentOn.layerInsideMap &&
      /dokumentiertem Ausmass/.test(extentOn.status) &&
      extentOn.overflow <= 1,
    `before ${JSON.stringify(extentBefore)} -> ${JSON.stringify(extentOn)}`,
  );
  await cdp.screenshot(path.join(OUT_DIR, '08-footprints.png')).then(() => report.screenshots.push('08-footprints.png'));

  // A shared link must restore the layer, and with a point filter the drawn
  // rectangles have to contain the crosshair — that is the question the layer
  // exists to answer.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&to=1900&ex=1&at=47.3769,8.5417` });
  await cdp.waitFor(`document.querySelectorAll('.map-footprint').length > 0`, { label: 'shared footprint link', timeout: 10_000 });
  await sleep(500);
  const extentShared = await cdp.eval(`(() => {
    const point = document.querySelector('.map-point');
    if (!point) return null;
    const p = point.getBoundingClientRect();
    const cx = p.left + p.width / 2, cy = p.top + p.height / 2;
    const covering = [...document.querySelectorAll('.map-footprint')].filter((b) => {
      const r = b.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    }).length;
    const chip = document.querySelector('.app-map__skip [data-map-cmd="extents"]');
    return {
      url: location.search,
      boxes: document.querySelectorAll('.map-footprint').length,
      covering,
      pressed: chip?.getAttribute('aria-pressed'),
      rows: document.querySelectorAll('#result-list > *').length,
    };
  })()`);
  check(
    'a shared link restores the footprints, and they cover the filtered point',
    Boolean(extentShared) && extentShared.pressed === 'true' && extentShared.covering > 0 && extentShared.boxes >= extentShared.covering && extentShared.url.includes('ex=1'),
    JSON.stringify(extentShared),
  );

  // Hovering a result row highlights the footprint that belongs to it, the same
  // cross-highlight the markers and list rows already share.
  // Hover a row whose footprint is actually drawn (a record outside the current
  // view has no rectangle, so the first row is not a safe choice).
  const extentPreview = await cdp.eval(`(() => {
    const drawn = new Set([...document.querySelectorAll('.map-footprint')].flatMap((b) => (b.dataset.recordIds || '').split(' ')));
    const row = [...document.querySelectorAll('#result-list button.zh-result')].find((b) => drawn.has(b.dataset.recordId));
    if (!row) return null;
    row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
    return row.dataset.recordId;
  })()`);
  await sleep(300);
  const extentPreviewState = await cdp.eval(`(() => ({
    highlighted: document.querySelectorAll('.map-footprint.is-preview').length,
    rows: document.querySelectorAll('#result-list button.zh-result.is-preview').length,
  }))()`);
  check(
    'hovering a result row highlights its documented footprint',
    Boolean(extentPreview) && extentPreviewState.highlighted === 1 && extentPreviewState.rows === 1,
    `${extentPreview} -> ${JSON.stringify(extentPreviewState)}`,
  );

  // The inline switch in the map hint toggles the same state, and switching the
  // layer off removes the rectangles again (nothing inert, no stale URL key).
  await cdp.eval(`document.querySelector('.app-map__hintlink[data-map-cmd="extents"]').focus(); true`);
  // A native <button> is activated by the browser's default action, so this
  // needs the full key sequence — `pressKey` sends it for Enter/Space.
  await cdp.pressKey('Enter');
  await sleep(600);
  const extentOff = await cdp.eval(`({
    url: location.search,
    boxes: document.querySelectorAll('.map-footprint').length,
    status: document.querySelector('#map-extent-count')?.textContent || '',
    chipPressed: document.querySelector('.app-map__skip [data-map-cmd="extents"]')?.getAttribute('aria-pressed'),
  })`);
  check(
    'the inline switch (keyboard) turns the footprint layer off again',
    !extentOff.url.includes('ex=') && extentOff.boxes === 0 && extentOff.status === '' && extentOff.chipPressed === 'false',
    JSON.stringify(extentOff),
  );

  // Phone: the switch is reachable at the cantonal 390 px breakpoint and the
  // rectangles stay clipped to the map box (no page overflow, nothing painted
  // above the map).
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&to=1900&ex=1` });
  await cdp.waitFor(`document.querySelectorAll('.map-footprint').length > 0`, { label: 'footprints on a phone', timeout: 10_000 });
  await sleep(600);
  const extentMobile = await cdp.eval(`(() => {
    const map = document.querySelector('#map').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.map-footprint')];
    const escaped = boxes.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.right > map.right + 1 || r.left < map.left - 1 || r.bottom > map.bottom + 1 || r.top < map.top - 1;
    }).length; // painting is clipped by the container; the rect itself may extend
    const chip = document.querySelector('.app-map__skip [data-map-cmd="extents"]');
    return {
      boxes: boxes.length,
      chipVisible: chip ? chip.getBoundingClientRect().width > 0 : false,
      chipPressed: chip?.getAttribute('aria-pressed'),
      statusVisible: (document.querySelector('#map-extent-count')?.getBoundingClientRect().width || 0) > 0,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      escaped,
      clip: getComputedStyle(document.querySelector('#map')).overflow,
    };
  })()`);
  check(
    '390 px: the footprint switch is reachable and the layer stays clipped to the map',
    extentMobile.boxes > 0 && extentMobile.chipVisible && extentMobile.chipPressed === 'true' && extentMobile.statusVisible && extentMobile.overflow <= 1 && extentMobile.clip === 'hidden',
    JSON.stringify(extentMobile),
  );
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, screenWidth: 1440, screenHeight: 900 });

  /* --- 8m. browser back/forward walk the exploration -------------------- */
  // The product promises shareable state, so the browser buttons have to walk
  // the same path the user took: a selection or a typed search is a history
  // entry, while panning the map must not be one. Every check below reads where
  // a single press of “back” lands (browsers clamp history.length, so counting
  // entries would be a flaky proxy) and uses real mouse events.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // 1. Leaving the app and coming back must not be blocked by entries the app
  // creates for itself while starting up (it clamps the year range to the data).
  await cdp.send('Page.navigate', { url: 'about:blank' });
  await cdp.waitFor(`location.href === 'about:blank'`, { label: 'blank page', timeout: 10_000 });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 5`, { label: 'history start page' });
  await sleep(1500); // give a late start-up write-back time to happen
  await cdp.eval(`history.back()`).catch(() => {});
  let historyLeftApp = false;
  try {
    historyLeftApp = await cdp.waitFor(`location.href === 'about:blank' ? 'yes' : ''`, { label: 'one back press leaves the app', timeout: 8_000 });
  } catch {
    /* reported below */
  }
  check(
    'the app adds no history entry of its own while it starts up',
    historyLeftApp === 'yes',
    `one “back” from the start page: ${JSON.stringify(await cdp.eval(`location.href`).catch(() => '?'))}`,
  );

  // 2. Forward brings the app back — restored from the back/forward cache or
  // loaded again, it has to work either way.
  await cdp.eval(`history.forward()`).catch(() => {});
  let historyForward = null;
  try {
    historyForward = await cdp.waitFor(
      `(() => { const rows = document.querySelectorAll('#result-list > *').length; return rows > 5 ? { rows, search: location.search } : ''; })()`,
      { label: 'forward returns to the app', timeout: 12_000 },
    );
  } catch {
    /* reported below */
  }
  check('“forward” brings the app back with its results', Boolean(historyForward?.rows > 5), JSON.stringify(historyForward));

  // 3. Opening a record is a step the browser can undo.
  const historyRecord = [...recordIndex.values()].find((record) => record.title) ?? null;
  let historyOpened = null;
  if (historyRecord) {
    await cdp.click(`#result-list button[data-record-id="${historyRecord.id}"]`).catch(() => {});
    try {
      historyOpened = await cdp.waitFor(
        `(() => {
          const sel = new URLSearchParams(location.search).get('sel');
          return sel && document.querySelector('#detail')?.hidden === false ? { sel, rows: document.querySelectorAll('#result-list > *').length } : '';
        })()`,
        { label: 'record opened for the history check', timeout: 12_000 },
      );
    } catch {
      /* reported below */
    }
  }
  check(
    'opening a record is a step the browser can undo',
    Boolean(historyOpened) && historyOpened?.sel === historyRecord?.id,
    historyOpened ? `sel=${historyOpened.sel}` : 'the detail panel never opened',
  );

  await cdp.eval(`history.back()`).catch(() => {});
  let historyClosed = null;
  try {
    historyClosed = await cdp.waitFor(
      `(() => {
        const sel = new URLSearchParams(location.search).get('sel');
        return !sel && document.querySelector('#detail')?.hidden === true
          ? { rows: document.querySelectorAll('#result-list > *').length }
          : '';
      })()`,
      { label: 'back closes the record', timeout: 12_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    '“back” closes the open record and keeps the search',
    Boolean(historyClosed && historyClosed.rows > 5),
    JSON.stringify(historyClosed ?? { search: await cdp.eval(`location.search`).catch(() => '?') }),
  );

  // 4. …and forward re-opens it.
  await cdp.eval(`history.forward()`).catch(() => {});
  let historyReopened = null;
  try {
    historyReopened = await cdp.waitFor(
      `(() => {
        const sel = new URLSearchParams(location.search).get('sel');
        return sel && document.querySelector('#detail')?.hidden === false ? { sel } : '';
      })()`,
      { label: 'forward re-opens the record', timeout: 12_000 },
    );
  } catch {
    /* reported below */
  }
  check('“forward” re-opens the record', historyReopened?.sel === historyRecord?.id, JSON.stringify(historyReopened));

  // 5. A map drag changes the view but must replace the current entry: after one
  // “back” the browser has to leave the app entirely, not land on a pan step.
  await cdp.eval(`history.back()`).catch(() => {});
  await cdp.waitFor(`!new URLSearchParams(location.search).get('sel')`, { label: 'back on the plain start entry', timeout: 12_000 }).catch(() => {});
  await sleep(500);
  const mapBox = await cdp
    .eval(`(() => { const m = document.querySelector('#map'); if (!m) return null; const r = m.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`)
    .catch(() => null);
  if (mapBox) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mapBox.x, y: mapBox.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: mapBox.x, y: mapBox.y, button: 'left', clickCount: 1 });
    for (const step of [40, 80, 120, 160]) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mapBox.x + step, y: mapBox.y + step / 2, button: 'left' });
      await sleep(80);
    }
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: mapBox.x + 160, y: mapBox.y + 80, button: 'left', clickCount: 1 });
    await sleep(1200);
  }
  const dragged = await cdp.eval(`({ lat: new URLSearchParams(location.search).get('lat'), sel: new URLSearchParams(location.search).get('sel') })`);
  await cdp.eval(`history.back()`).catch(() => {});
  let panLeftApp = false;
  try {
    panLeftApp = await cdp.waitFor(`location.href === 'about:blank' ? 'yes' : ''`, { label: 'the pan was not a history step', timeout: 8_000 });
  } catch {
    /* reported below */
  }
  check(
    'a map drag replaces the entry instead of adding history steps',
    Boolean(dragged.lat) && dragged.sel === null && panLeftApp === 'yes',
    `the drag wrote lat=${dragged.lat}; one “back” then reached ${JSON.stringify(await cdp.eval(`location.href`).catch(() => '?'))}`,
  );

  // 6. Typing is one entry per search, not one per keystroke: the row debounces
  // the field and the store merges the successive values of the same gesture.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 5`, { label: 'typing history page' });
  await sleep(600);
  await cdp.click('#text-filter');
  for (const [index, char] of [...'Zürich'].entries()) {
    await cdp.send('Input.insertText', { text: char });
    // Slower than the field's own debounce, so every keystroke reaches the store
    // — plus one deliberate stall in the middle of the word: a busy main thread
    // (or a visitor who pauses to read) must not cut one query into two history
    // entries. This is where the check failed on 2026-10-19 (maps-1 fixed the
    // store: HISTORY_TEXT_KEYS keeps a still-edited query in its entry).
    await sleep(index === 2 ? 1_200 : 260);
  }
  await sleep(1200);
  const searchTyped = await cdp.eval(`({ q: new URLSearchParams(location.search).get('q'), rows: document.querySelectorAll('#result-list > *').length })`);
  await cdp.eval(`history.back()`).catch(() => {});
  await sleep(1500);
  const searchUndone = await cdp.eval(`({ q: new URLSearchParams(location.search).get('q'), rows: document.querySelectorAll('#result-list > *').length })`);
  check(
    'one “back” undoes a whole typed search (the keystrokes coalesce)',
    searchTyped.q === 'Zürich' && searchUndone.q === null && searchUndone.rows > searchTyped.rows && searchTyped.rows > 5,
    `typed “Zürich” -> ${searchTyped.rows} rows, one “back” -> ${searchUndone.rows} rows, q=${JSON.stringify(searchUndone.q)}`,
  );

  /* --- 8n. the search box also finds records (title, series, library) ----- */
  // The box is a place search, but a visitor who types a series or a library
  // expects map results (the OldMapsOnline behaviour). The record suggestion is
  // built from the committed seed and applies the sidebar keyword filter.
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'keyword search page' });
  await sleep(600);
  const rowsBeforeKeyword = await cdp.eval(`document.querySelectorAll('#result-list > *').length`);
  await cdp.typeInto('#place-input', 'Siegfriedkarte');
  let keywordOffer = null;
  try {
    keywordOffer = await cdp.waitFor(
      `(() => {
        const items = [...document.querySelectorAll('#place-suggestions li button')];
        const item = items.find((b) => /Maps matching/.test(b.textContent));
        return item ? { text: item.textContent, items: items.length, status: document.querySelector('#place-status')?.textContent || '' } : '';
      })()`,
      { label: 'record search suggestion', timeout: 12_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'the place box also offers the records that match the typed words',
    Boolean(keywordOffer) && /Siegfriedkarte/.test(keywordOffer.text) && /records?/.test(keywordOffer.text) && /place suggestion|No place suggestion/i.test(keywordOffer.status),
    JSON.stringify(keywordOffer),
  );

  // Choosing it applies the keyword filter (no invented result): the list, the
  // count line, the sidebar field and the URL all agree.
  await cdp.eval(`[...document.querySelectorAll('#place-suggestions li button')].find((b) => /Maps matching/.test(b.textContent))?.click(); true`);
  await sleep(800);
  const keywordApplied = await cdp.eval(`({
    url: location.search,
    rows: document.querySelectorAll('#result-list > *').length,
    count: document.querySelector('#result-count')?.textContent || '',
    keywordField: document.querySelector('#text-filter')?.value || '',
    status: document.querySelector('#place-status')?.textContent || '',
    listHidden: document.querySelector('#place-suggestions')?.hidden,
  })`);
  check(
    'choosing it filters the records and keeps the search shareable',
    keywordApplied.url.includes('q=Siegfriedkarte') &&
      keywordApplied.rows > 0 &&
      keywordApplied.rows < rowsBeforeKeyword &&
      keywordApplied.keywordField === 'Siegfriedkarte' &&
      /Map search: \d+ records?/.test(keywordApplied.status) &&
      keywordApplied.listHidden === true,
    `${rowsBeforeKeyword} rows before -> ${JSON.stringify(keywordApplied)}`,
  );

  // A query without a place and without a title match says so — never a silent
  // empty list and never a raw developer string.
  await cdp.typeInto('#place-input', 'Xqzwv');
  let keywordEmpty = null;
  try {
    keywordEmpty = await cdp.waitFor(
      `(() => { const text = document.querySelector('#place-status')?.textContent || ''; const items = document.querySelectorAll('#place-suggestions li').length; return /No place and no title match/.test(text) && items === 0 ? text : ''; })()`,
      { label: 'honest no-match search status', timeout: 12_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'a search without any match says so instead of listing noise',
    Boolean(keywordEmpty) && !/Failed to fetch|undefined|null/.test(keywordEmpty),
    `"${String(keywordEmpty).slice(0, 120)}"`,
  );

  // The spelling a Swiss keyboard produces has to find the catalogue's
  // spelling: before 2026-10-19 “Zuerich” returned an empty list while
  // “Zürich” returned the whole canton (folding in records.js, maps-2). The
  // three spellings must agree exactly — same rows, same count line — and the
  // keyword box is left empty for the sections that follow.
  const spelling = await cdp.eval(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const box = document.querySelector('#text-filter');
    const type = async (value) => {
      box.focus();
      box.value = value;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(700);
      return { rows: document.querySelectorAll('#result-list > *').length, count: document.querySelector('#result-count')?.textContent || '' };
    };
    const umlaut = await type('Zürich');
    const digraph = await type('Zuerich');
    const plain = await type('Zurich');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(500);
    return { umlaut, digraph, plain, cleared: document.querySelectorAll('#result-list > *').length };
  })()`);
  check(
    '“Zuerich”, “Zurich” and “Zürich” find the same records (umlaut folding)',
    spelling.umlaut.rows > 0 &&
      spelling.digraph.rows === spelling.umlaut.rows &&
      spelling.plain.rows === spelling.umlaut.rows &&
      /^Zuerich$/i.test((spelling.digraph.count.match(/“(.+?)”/) || [])[1] || '') &&
      spelling.cleared > spelling.umlaut.rows,
    `${spelling.umlaut.rows} / ${spelling.digraph.rows} / ${spelling.plain.rows} rows · cleared ${spelling.cleared}`,
  );

  /* --- 8q. Grundkarte (base map): farbig / grau / Luftbild -------------- */
  // The map offers the three documented swisstopo WMTS base layers. The chips
  // are built by map.js from BASE_LAYERS, so this section checks the real
  // tiles, the attribution, the shared URL state and the keyboard route.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&to=1900` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'Grundkarte page' });
  await cdp.waitFor(`document.querySelectorAll('.map-tile').length > 0`, { label: 'base tiles', timeout: 15_000 });
  await sleep(600);
  const baseBefore = await cdp.eval(`(() => {
    const chips = [...document.querySelectorAll('#base-layer-switch [data-base-key]')];
    const group = document.querySelector('#base-layer-switch');
    const label = document.querySelector('#base-layer-label');
    const tiles = [...document.querySelectorAll('.map-tile')];
    return {
      keys: chips.map((c) => c.dataset.baseKey),
      texts: chips.map((c) => c.textContent.trim()),
      pressed: chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.baseKey),
      names: chips.map((c) => c.getAttribute('aria-label') || ''),
      groupRole: group?.getAttribute('role'),
      labelledBy: group?.getAttribute('aria-labelledby'),
      labelText: label?.textContent || '',
      inSkipList: group?.closest('.app-map__skip') !== null,
      loadedDefault: tiles.filter((i) => (i.getAttribute('src') || '').includes('tile.openstreetmap.org') && i.naturalWidth > 0).length,
      badge: document.querySelector('.map-badge')?.textContent || '',
      // The view must not move when the base map changes: the transforms of the
      // tiles and markers are compared before/after the switch.
      grid: [...document.querySelectorAll('.map-tile')].map((i) => i.style.transform).join('|'),
      markers: [...document.querySelectorAll('.map-marker')].map((i) => i.style.transform).join('|'),
    };
  })()`);
  check(
    'the Basemap switch names its documented layers and marks the worldwide default',
    baseBefore.keys.join(',') === 'osm,farbe,grau,luftbild' &&
      baseBefore.pressed.join(',') === 'osm' &&
      baseBefore.names.every((n) => /^Basemap: \S/.test(n)) &&
      baseBefore.groupRole === 'group' &&
      baseBefore.labelledBy === 'base-layer-label' &&
      /^Basemap$/.test(baseBefore.labelText) &&
      baseBefore.inSkipList &&
      baseBefore.loadedDefault > 0 &&
      /OpenStreetMap/.test(baseBefore.badge),
    JSON.stringify({ keys: baseBefore.keys, texts: baseBefore.texts, pressed: baseBefore.pressed, groupRole: baseBefore.groupRole, labelledBy: baseBefore.labelledBy, labelText: baseBefore.labelText, inSkipList: baseBefore.inSkipList, loadedDefault: baseBefore.loadedDefault, badge: baseBefore.badge }),
  );

  // One click switches the layer: new real tiles, honest attribution, shareable
  // URL — and the previous layer's tiles must leave the DOM (they would paint
  // over the new ones).
  await cdp.click('#base-layer-switch [data-base-key="grau"]');
  let baseGrau = null;
  try {
    baseGrau = await cdp.waitFor(
      `(() => {
        const loaded = [...document.querySelectorAll('.map-tile')].filter((i) => (i.getAttribute('src') || '').includes('pixelkarte-grau') && i.naturalWidth > 0);
        if (loaded.length === 0) return '';
        const chips = [...document.querySelectorAll('#base-layer-switch [data-base-key]')];
        return {
          url: location.search,
          loaded: loaded.length,
          tile: loaded[0].getAttribute('src'),
          pressed: chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.baseKey),
          oldTiles: document.querySelectorAll('.map-tile[src*="pixelkarte-farbe"]').length,
          badge: document.querySelector('.map-badge')?.textContent || '',
          grid: [...document.querySelectorAll('.map-tile')].map((i) => i.style.transform).join('|'),
          markers: [...document.querySelectorAll('.map-marker')].map((i) => i.style.transform).join('|'),
        };
      })()`,
      { label: 'grau tiles loaded', timeout: 15_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'choosing “grau” loads the real grey WMTS tiles, credits them and is shareable',
    Boolean(baseGrau) &&
      /pixelkarte-grau\/default\/current\/3857\/\d+\/\d+\/\d+\.jpeg$/.test(baseGrau.tile) &&
      baseGrau.loaded > 0 &&
      baseGrau.url.includes('base=grau') &&
      baseGrau.pressed.join(',') === 'grau' &&
      baseGrau.oldTiles === 0 &&
      /grau/.test(baseGrau.badge) &&
      baseGrau.grid === baseBefore.grid &&
      baseGrau.markers === baseBefore.markers,
    `before ${JSON.stringify({ ...baseBefore, grid: baseBefore.grid.length, markers: baseBefore.markers.length })} -> ${JSON.stringify({ ...baseGrau, grid: baseGrau.grid.length, markers: baseGrau.markers.length })}`,
  );
  await cdp.screenshot(path.join(OUT_DIR, '09-grundkarte.png')).then(() => report.screenshots.push('09-grundkarte.png'));

  // A shared link opens on the named layer: the URL is the state (D4/D6).
  await cdp.send('Page.navigate', { url: `${BASE_URL}/?from=1781&base=luftbild` });
  let baseShared = null;
  try {
    baseShared = await cdp.waitFor(
      `(() => {
        const loaded = [...document.querySelectorAll('.map-tile')].filter((i) => (i.getAttribute('src') || '').includes('swissimage') && i.naturalWidth > 0);
        if (loaded.length === 0) return '';
        const chips = [...document.querySelectorAll('#base-layer-switch [data-base-key]')];
        return {
          url: location.search,
          loaded: loaded.length,
          pressed: chips.filter((c) => c.getAttribute('aria-pressed') === 'true').map((c) => c.dataset.baseKey),
          badge: document.querySelector('.map-badge')?.textContent || '',
        };
      })()`,
      { label: 'shared Luftbild link', timeout: 15_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'a shared ?base=luftbild link opens on the aerial layer',
    Boolean(baseShared) &&
      baseShared.url.includes('base=luftbild') &&
      baseShared.loaded > 0 &&
      baseShared.pressed.join(',') === 'luftbild' &&
      /SWISSIMAGE/.test(baseShared.badge),
    JSON.stringify(baseShared),
  );

  // Keyboard: the switch is a toggle-button group, so Enter on the focused chip
  // must switch back — the same route a keyboard-only user takes.
  await cdp.eval(`document.querySelector('#base-layer-switch [data-base-key="farbe"]').focus(); true`);
  await cdp.pressKey('Enter');
  let baseKeyboard = null;
  try {
    baseKeyboard = await cdp.waitFor(
      `(() => {
        const chip = document.querySelector('#base-layer-switch [data-base-key="farbe"]');
        if (chip?.getAttribute('aria-pressed') !== 'true') return '';
        const loaded = [...document.querySelectorAll('.map-tile')].filter((i) => (i.getAttribute('src') || '').includes('pixelkarte-farbe') && i.naturalWidth > 0).length;
        return { url: location.search, loaded, active: document.activeElement?.dataset?.baseKey ?? null, badge: document.querySelector('.map-badge')?.textContent || '' };
      })()`,
      { label: 'keyboard base switch', timeout: 15_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'the focused Grundkarte chip switches the layer with Enter',
    Boolean(baseKeyboard) &&
      !baseKeyboard.url.includes('base=') &&
      baseKeyboard.loaded > 0 &&
      baseKeyboard.active === 'farbe' &&
      /farbig/.test(baseKeyboard.badge),
    JSON.stringify(baseKeyboard),
  );

  // Phone: the row has to wrap inside the page and stay operable.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenWidth: 390, screenHeight: 844 });
  await sleep(600);
  const baseMobile = await cdp.eval(`(() => {
    const group = document.querySelector('#base-layer-switch');
    const chips = [...document.querySelectorAll('#base-layer-switch [data-base-key]')];
    const inside = chips.filter((c) => { const r = c.getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth + 1; }).length;
    return {
      visible: group ? group.getBoundingClientRect().height > 0 : false,
      chips: chips.length,
      inside,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  check(
    '390 px: the Grundkarte chips stay inside the page',
    baseMobile.visible && baseMobile.chips === 3 && baseMobile.inside === 3 && baseMobile.overflow <= 1,
    JSON.stringify(baseMobile),
  );
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // (the series section runs after 8j and opens another record of the seed)
  /* --- console hygiene -------------------------------------------------- */
  // A partner library that is down or throttling makes the browser log
  // “Failed to load resource: net::ERR_CONNECTION_REFUSED https://…/i3f/…”.
  // That is not a product regression: the app's fallback path is what matters
  // and section 9 blocks the image host on purpose to assert it. Keep the
  // evidence in the report, but only our own origin and our own exceptions can
  // fail this check (e-rara answered 429/5xx repeatedly on 2026-10-19 and was
  // refused outright during this iteration's first run).
  const upstreamConsoleErrors = [];
  const realErrors = consoleMessages.filter((m) => {
    if (m.level === 'warning' || /favicon/i.test(m.text)) return false;
    const external = !m.text.includes(new URL(BASE_URL).origin);
    if (m.level === 'browser' && external && /^Failed to load resource: net::ERR_(CONNECTION_|NAME_|TIMED_OUT|INTERNET_|NETWORK_|ADDRESS_|CERT_)/.test(m.text)) {
      upstreamConsoleErrors.push(m.text);
      return false;
    }
    return true;
  });
  report.upstreamConsoleErrors = upstreamConsoleErrors;
  if (upstreamConsoleErrors.length) {
    console.log(`ℹ ${upstreamConsoleErrors.length} external resource error(s) from a partner library or tile host, kept in report.upstreamConsoleErrors`);
  }
  check('no uncaught console errors during the whole session', realErrors.length === 0, realErrors.map((m) => m.text.slice(0, 160)).join(' | '));  const broken = failedRequests.filter((r) => !/favicon|\/api\/fetch/.test(r.url));
  check('no failed asset or data requests', broken.length === 0, broken.slice(0, 4).map((b) => `${b.status} ${b.url}`).join(' | '));

  // public/_headers ships `connect-src 'self'`: every fetch()/XHR must go through
  // our own origin (the Worker proxy), and `img-src` allows the tile/IIIF hosts.
  const offOrigin = [...new Set(apiRequests.filter((u) => !u.startsWith(BASE_URL)))];
  check(
    'fetch/XHR traffic stays same-origin (the CSP allows connect-src \'self\')',
    offOrigin.length === 0,
    offOrigin.length ? offOrigin.slice(0, 4).join(' | ') : `${new Set(apiRequests).size} same-origin API calls`,
  );

  /* --- 8m. the loading state is real, not just markup --------------------- */
  // On a slow connection the seed is in flight for seconds. The shell must say
  // what is happening (maps-1, 7-17) and the “Zeitraum” chart — which results.js
  // can only build once the records arrive — must not look like a broken, empty
  // box (maps-1, 7-19). Throttled instead of blocked: a blocked request fails
  // instantly and never shows the loading window.
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: 2000, downloadThroughput: 20_000, uploadThroughput: 20_000, connectionType: 'cellular3g',
  });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  let loadingState = null;
  try {
    loadingState = await cdp.waitFor(
      `(() => {
        const loading = document.querySelector('#results-loading');
        const busy = document.querySelector('#result-list')?.getAttribute('aria-busy');
        if (!loading || loading.hidden || busy !== 'true') return '';
        // The throttled nav also slows the stylesheets down; the skeleton can
        // only be measured once app.css has parsed (otherwise this reads the
        // pre-CSS page and reports “none”).
        const appSheet = [...document.styleSheets].find((sheet) => String(sheet.href || '').endsWith('/app.css'));
        if (!appSheet || !appSheet.cssRules.length) return '';
        const hist = document.querySelector('#year-histogram');
        return {
          stylesReady: true,
          count: (document.querySelector('#result-count')?.textContent || '').trim(),
          block: (document.querySelector('#results-loading .zh-state__title')?.textContent || '').trim(),
          skeleton: String(getComputedStyle(hist, '::after').content || ''),
          bins: hist ? hist.childElementCount : -1,
          overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        };
      })()`,
      { label: 'throttled loading state', timeout: 20_000 },
    );
  } catch {
    /* reported below */
  }
  check(
    'a slow seed shows the loading state and a year-chart skeleton instead of an empty box',
    Boolean(loadingState) &&
      loadingState.bins === 0 &&
      /Loading/i.test(loadingState.skeleton) &&
      /Loading/i.test(loadingState.count) &&
      /Loading/i.test(loadingState.block) &&
      loadingState.overflow === 0,
    JSON.stringify(loadingState).slice(0, 220),
  );
  await cdp.screenshot(path.join(OUT_DIR, '07c-loading-state.png')).then(() => report.screenshots.push('07c-loading-state.png'));
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });

  /* --- 9. honest degradation when the image service is unreachable ------ */
  // Deliberately after the console/failed-request checks: blocking a host logs
  // net::ERR_BLOCKED_BY_CLIENT and produces failed requests by design, and that
  // expected noise must not be confused with a defect of the product.
  const degradable = [...recordIndex.values()].find((record) => record.iiifManifest && record.thumbnail) ?? null;
  if (degradable) {
    await cdp.send('Network.setBlockedURLs', { urls: ['*e-rara.ch*', '*/api/fetch*'] });
    await cdp.send('Page.navigate', { url: `${BASE_URL}/?sel=${encodeURIComponent(degradable.id)}` });
    await cdp.waitFor(`document.querySelector('#detail')?.hidden === false`, { label: 'degraded detail panel', timeout: 15_000 });
    await sleep(3500);
    const degraded = await cdp.eval(`(() => {
      const fallback = document.querySelector('#detail-preview .app-viewer__fallback');
      const text = (fallback?.textContent || '').replace(/\\s+/g, ' ').trim();
      return {
        fallback: Boolean(fallback),
        text: text.slice(0, 200),
        rawLeak: /Failed to fetch|NetworkError|TypeError|is not a function|HTTP \\d{3} \\/|undefined/.test(text),
        providerLink: fallback?.querySelector('a.zh-button')?.getAttribute('href') || null,
        thumb: fallback?.querySelector('img')?.getAttribute('src') || null,
        title: document.querySelector('#detail-title')?.textContent?.slice(0, 60) || '',
        facts: document.querySelectorAll('.app-detail__facts dt').length,
        reuseLinks: document.querySelectorAll('#reuse-links > *').length,
        literalNull: [...document.querySelectorAll('#detail-body *')].filter((node) => node.children.length === 0 && /^(null|undefined)$/.test(node.textContent.trim())).length,
        panelOpen: document.querySelector('#detail')?.hidden === false,
      };
    })()`);
    check(
      'an unreachable image service degrades to an honest, readable panel',
      degraded.fallback === true &&
        /Preview unavailable/.test(degraded.text) &&
        String(degraded.providerLink).startsWith('https://') &&
        degraded.thumb === degradable.thumbnail &&
        degraded.title.length > 5 &&
        degraded.facts >= 8 &&
        degraded.reuseLinks >= 1 &&
        degraded.panelOpen === true,
      JSON.stringify(degraded).slice(0, 320),
    );
    check(
      'the degraded panel shows no raw developer error and no literal null',
      degraded.rawLeak === false && degraded.literalNull === 0,
      `rawLeak=${degraded.rawLeak} literalNull=${degraded.literalNull} · ${degraded.text.slice(0, 120)}`,
    );
    await cdp.screenshot(path.join(OUT_DIR, '07-degraded.png')).then(() => report.screenshots.push('07-degraded.png'));

    // The place search has its own outage path (it falls back to titles from the
    // seed); the same rule applies: no English developer string in the UI.
    await cdp.send('Network.setBlockedURLs', { urls: ['*/api/search/places*'] });
    await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
    await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 5`, { label: 'degraded search page', timeout: 20_000 });
    // "Zürich" appears in 28 seed titles, so the local fallback really has matches
    // to offer here ("Rheinau" would only prove the no-match branch).
    await cdp.typeInto('#place-input', 'Zürich');
    let searchStatus = '';
    try {
      searchStatus = await cdp.waitFor(
        `(() => { const text = document.querySelector('#place-status')?.textContent || ''; return /unavailable/i.test(text) ? text : ''; })()`,
        { label: 'search outage status', timeout: 15_000 },
      );
    } catch {
      searchStatus = await cdp.eval(`document.querySelector('#place-status')?.textContent || ''`);
    }
    const localSuggestions = await cdp.eval(`document.querySelectorAll('#place-suggestions li').length`);
    check(
      'an unreachable place-search service falls back to local titles without raw errors',
      /unavailable/i.test(searchStatus) && !/Failed to fetch|NetworkError|undefined/.test(searchStatus) && localSuggestions >= 1,
      `"${String(searchStatus).slice(0, 150)}" · ${localSuggestions} local suggestions`,
    );

    // The seed itself is one file: when it cannot be fetched, the results area
    // must say so in plain English, drop its aria-busy flag, stop claiming to
    // load and keep the raw browser string out of the UI (maps-1, 7-17).
    await cdp.send('Network.setBlockedURLs', { urls: ['*/data/records.json'] });
    await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
    let seedOutage = null;
    try {
      seedOutage = await cdp.waitFor(
        `(() => {
          const state = document.querySelector('#results-state');
          if (!state || state.hidden || !/could not be loaded/.test(state.textContent)) return '';
          return {
            text: state.textContent.replace(/\\s+/g, ' ').trim(),
            count: (document.querySelector('#result-count')?.textContent || '').trim(),
            busy: document.querySelector('#result-list')?.getAttribute('aria-busy') ?? null,
            loadingHidden: document.querySelector('#results-loading')?.hidden ?? null,
            rawLeak: /Failed to fetch|NetworkError|undefined|\\.json/.test(state.textContent.replace('/data/records.json', '')),
          };
        })()`,
        { label: 'seed outage state', timeout: 15_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'an unreachable seed says so in plain English and stops claiming to load',
      Boolean(seedOutage) &&
        seedOutage.count === 'Catalogue unavailable' &&
        seedOutage.busy === 'false' &&
        seedOutage.loadingHidden === true &&
        seedOutage.rawLeak === false,
      JSON.stringify(seedOutage).slice(0, 220),
    );
    await cdp.screenshot(path.join(OUT_DIR, '07b-seed-outage.png')).then(() => report.screenshots.push('07b-seed-outage.png'));

    // …and the app must recover on its own once the upstream answers again.
    await cdp.send('Network.setBlockedURLs', { urls: [] });
    await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
    await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 5`, { label: 'recovered page', timeout: 20_000 });
    const recovered = await cdp.eval(`(() => ({ rows: document.querySelectorAll('#result-list > *').length, notices: document.querySelector('#app-notices')?.hidden ?? true }))()`);
    check('the app loads normally again after the upstream recovers', recovered.rows > 5 && recovered.notices === true, JSON.stringify(recovered));
  } else {
    check('an unreachable image service degrades to an honest, readable panel', false, 'no record with manifest + thumbnail in the seed');
  }
} catch (err) {
  check('browser check completed without throwing', false, err.message);
} finally {
  report.checks = results;
  await writeFile(path.join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2)).catch(() => {});
  console.log(`\nreport: ${path.join(OUT_DIR, 'report.json')}`);
  console.log(`${results.filter((r) => r.ok).length}/${results.length} checks passed`);
  try {
    ws.close();
  } catch {
    /* ignore */
  }
  chrome.kill('SIGKILL');
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(failures > 0 ? 1 : 0);
}
