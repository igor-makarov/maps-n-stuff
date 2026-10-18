#!/usr/bin/env node
/**
 * End-to-end browser check for the Kartenzeit Workers site.
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

  async pressKey(key, { code, keyCode } = {}) {
    const map = { ArrowRight: { code: 'ArrowRight', keyCode: 39 }, ArrowLeft: { code: 'ArrowLeft', keyCode: 37 }, Enter: { code: 'Enter', keyCode: 13 }, Escape: { code: 'Escape', keyCode: 27 }, Home: { code: 'Home', keyCode: 36 } };
    const info = { code: code ?? map[key]?.code, windowsVirtualKeyCode: keyCode ?? map[key]?.keyCode };
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
  const deadModule = /\[kartenzeit\] module ".*" not available/.test(text);
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
  await cdp.waitFor(`window.__kartenzeitReady !== undefined || document.documentElement.dataset.app === 'kartenzeit'`, { label: 'app bootstrap' });
  const tiles = await cdp.waitFor(
    `(() => { const imgs = [...document.querySelectorAll('#map img')]; return imgs.filter((i) => i.complete && i.naturalWidth > 0).length; })()`,
    { label: 'map tiles', timeout: 25_000 },
  );
  check('interactive map loads swisstopo tiles', tiles > 0, `${tiles} tiles decoded`);
  const attribution = await cdp.eval(`document.querySelector('#map .map-badge, .map-badge')?.textContent?.trim() || ''`);
  check('swisstopo attribution is visible', /swisstopo/i.test(attribution), attribution.slice(0, 80));
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
  const periodHint = periodRange?.from && periodRange?.to ? `Zeitraum ${periodRange.from}–${periodRange.to}` : null;
  check(
    'collection facet lists the real series with counts for the current period',
    Boolean(collectionFacet) &&
      collectionFacet.options.length >= 3 &&
      zeroCounts > 0 &&
      (periodHint ? collectionFacet.hint.includes(periodHint) : /Zeitraum \d{4}–\d{4}/.test(collectionFacet.hint)),
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
  const detail = await cdp.eval(`(() => {
    const d = document.querySelector('#detail');
    const link = [...d.querySelectorAll('a')].find((a) => /e-rara|geo\\.admin|zb\\.uzh/.test(a.href));
    const img = d.querySelector('#detail-preview img, #detail-preview img');
    return {
      text: d.textContent.replace(/\\s+/g, ' ').slice(0, 400),
      sourceHref: link?.href || null,
      institution: /Zentralbibliothek|ETH-Bibliothek|swisstopo/.test(d.textContent),
      rights: /Public Domain|Rechte|OGD|©/i.test(d.textContent),
      previewSrc: img?.src || null,
      previewLoaded: Boolean(img && img.complete && img.naturalWidth > 0),
    };
  })()`);
  check('detail links to the original collection record', Boolean(detail.sourceHref), detail.sourceHref ?? 'no link');
  const viewerLink = await cdp.eval(`(() => { const a = [...document.querySelectorAll('#detail a')].find((n) => /content\\/zoom/.test(n.href)); return a?.href || null; })()`);
  check('detail links to the library\'s own viewer', /^https:\/\/www\.e-rara\.ch\/[a-z]+\/content\/zoom\/\d+$/.test(viewerLink || ''), viewerLink ?? 'no viewer link');
  check('detail names the holding institution and rights', detail.institution && detail.rights, detail.text.slice(0, 120));

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
  check('viewer reports the real resolution and cut-out', /Aufl\u00f6sung \d+ %/.test(zoomed.readout) && /Ausschnitt/.test(zoomed.readout), zoomed.readout);
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

  await cdp.pressKey('Escape');
  const closed = await cdp.eval(`document.querySelector('#detail')?.hidden`);
  check('Escape closes the detail panel', closed === true);
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
    const m = text.match(/Publikationsjahr\\s*(\\d{4})(?:\\s*[–-]\\s*(\\d{4}))?/);
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

  const pinOne = await pinResult(0);
  const pinTwo = await pinResult(1);
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
    await cdp.waitFor(
      `(() => { const images = [...document.querySelectorAll('#compare-view-body .app-compare__image')]; return images.length >= 2 && images.every((img) => img.complete && img.naturalWidth > 0); })()`,
      { label: 'compare images', timeout: 30_000 },
    );
  } catch {
    /* the assertion below reports the images that did (not) load */
  }
  const panes = await cdp.eval(`(() => [...document.querySelectorAll('#compare-view-body .app-compare__pane')].map((pane) => {
    const img = pane.querySelector('img');
    return {
      title: pane.querySelector('h3')?.textContent || '',
      caption: (pane.querySelector('figcaption')?.textContent || '').replace(/\\s+/g, ' ').trim(),
      img: img ? { src: img.src, w: img.naturalWidth, h: img.naturalHeight } : null,
      link: pane.querySelector('a[href]')?.href || '',
    };
  }))()`);
  const paneRecords = pinnedIds.map((id) => recordIndex.get(id));
  const paneProblems = panes
    .map((pane, index) => {
      const record = paneRecords[index];
      if (!record) return `${index}: no seed record`;
      if (pane.title !== record.title) return `${index}: title "${pane.title}" != "${record.title}"`;
      if (!pane.img || pane.img.w < 1000 || pane.img.h < 300) return `${index}: image ${pane.img ? `${pane.img.w}×${pane.img.h}` : 'missing'}`;
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
      : panes.map((pane) => `${pane.title.slice(0, 24)}:${pane.img.w}×${pane.img.h}`).join(' | '),
  );

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
    }))()`);
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
        sheetOne.label === `Blatt 1 von ${expectedTotal}` &&
        sheetOne.prevDisabled === true &&
        sheetTwo.label === `Blatt 2 von ${expectedTotal}` &&
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
      deepLink.label === `Blatt ${total} von ${total}` && deepLink.active === String(total - 1) && deepLink.strip === total && deepLink.stripHidden === false,
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
      clamped.label === `Blatt ${total} von ${total}` && clamped.sh === String(total),
      JSON.stringify(clamped),
    );

    // The strip is a real control: clicking a sheet switches the viewer and URL.
    await cdp.click('#page-strip [data-sheet="0"]');
    let stripSwitch = null;
    try {
      stripSwitch = await cdp.waitFor(
        `(() => { const label = document.querySelector('#page-label')?.textContent || ''; const sh = new URLSearchParams(location.search).get('sh'); return label === 'Blatt 1 von ${total}' && sh === null ? { label, sh } : ''; })()`,
        { label: 'strip click', timeout: 10_000 },
      );
    } catch {
      /* reported below */
    }
    check(
      'clicking a sheet in the strip switches to it (sheet 1 is the default URL state)',
      stripSwitch?.label === `Blatt 1 von ${total}` && stripSwitch?.sh === null,
      JSON.stringify(stripSwitch),
    );
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

  // Map-first shell: the map is the product, so part of it has to be visible on
  // a plain desktop viewport instead of sitting below a full-height intro block.
  const firstScreen = await cdp.eval(`(() => {
    const map = document.querySelector('#map')?.getBoundingClientRect();
    const hero = document.querySelector('.app-intro')?.getBoundingClientRect();
    return {
      vh: window.innerHeight,
      mapTop: map ? Math.round(map.top + window.scrollY) : -1,
      mapVisible: map ? Math.round(Math.min(window.innerHeight - map.top, map.height)) : 0,
      heroHeight: hero ? Math.round(hero.height) : -1,
      facts: document.querySelectorAll('#intro-facts li').length,
      jump: Boolean(document.querySelector('.app-intro__more a[href="#map"]')),
    };
  })()`);
  check(
    'the map is on the first desktop screen (map-first shell)',
    firstScreen.mapVisible > 200 && firstScreen.facts >= 4 && firstScreen.jump,
    JSON.stringify(firstScreen),
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
      /Ausschnitt/.test(markerInfo.visible),
    JSON.stringify(markerInfo),
  );
  await cdp.screenshot(path.join(OUT_DIR, '05-map-pins.png')).then(() => report.screenshots.push('05-map-pins.png'));

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

  /* --- console hygiene -------------------------------------------------- */
  const realErrors = consoleMessages.filter((m) => m.level !== 'warning' && !/favicon/i.test(m.text));
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
