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
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
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

  /* --- 3a. IIIF deep zoom (region requests) ---------------------------- */
  const singleSheet = await cdp.eval(`(() => ({ nav: document.querySelector('#page-nav')?.hidden, label: document.querySelector('#page-label')?.textContent }))()`);
  check('sheet navigation is hidden for a single-sheet record', singleSheet.nav === true, JSON.stringify(singleSheet));

  const fullSheetSrc = await cdp.eval(`document.querySelector('.app-viewer__image')?.src || ''`);
  await cdp.eval(`document.querySelector('#viewer-zoom-in').click(); document.querySelector('#viewer-zoom-in').click(); true`);
  await sleep(2500);
  const zoomed = await cdp.eval(`(() => {
    const img = document.querySelector('.app-viewer__image');
    const stage = document.querySelector('#viewer-stage');
    return {
      src: img?.src || '',
      decodeW: img?.naturalWidth || 0,
      decodeH: img?.naturalHeight || 0,
      readout: document.querySelector('#viewer-resolution')?.textContent || '',
      stageW: Math.round(stage?.getBoundingClientRect().width || 0),
    };
  })()`);
  check(
    'detail viewer asks the image service for the visible region (deep zoom)',
    /e-rara\.ch\/i3f\/v\d+\/\d+\/\d+,\d+,\d+,\d+\/\d+,\/0\/default\.jpg$/.test(zoomed.src) && zoomed.decodeW >= Math.min(300, zoomed.stageW),
    JSON.stringify(zoomed).slice(0, 220),
  );
  check('viewer reports the real resolution and cut-out', /Aufl\u00f6sung \d+ %/.test(zoomed.readout) && /Ausschnitt/.test(zoomed.readout), zoomed.readout);
  await cdp.screenshot(path.join(OUT_DIR, '02b-detail-zoom.png')).then(() => report.screenshots.push('02b-detail-zoom.png'));

  await cdp.eval(`document.querySelector('#viewer-stage').focus()`);
  await cdp.pressKey('ArrowRight');
  await cdp.pressKey('ArrowRight');
  await sleep(1800);
  const pannedSrc = await cdp.eval(`document.querySelector('.app-viewer__image')?.src || ''`);
  check('viewer pans with the arrow keys', pannedSrc !== zoomed.src && /\d+,\d+,\d+,\d+\//.test(pannedSrc), pannedSrc.slice(-60));

  await cdp.pressKey('Home');
  await sleep(1800);
  const resetSrc = await cdp.eval(`document.querySelector('.app-viewer__image')?.src || ''`);
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
      appliedPeriod.from === '1816' &&
      appliedPeriod.to === '1816' &&
      appliedPeriod.count >= 1 &&
      appliedPeriod.state.length > 0,
    JSON.stringify(appliedPeriod),
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

  /* --- 8. WCAG 2.2 AA contrast sweep of the visible UI ------------------ */
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: `${BASE_URL}/` });
  await cdp.waitFor(`document.querySelectorAll('#result-list > *').length > 0`, { label: 'contrast sweep page' });
  await sleep(1200);
  const contrast = await cdp.eval(CONTRAST_SWEEP);
  check('visible text meets WCAG 2.2 AA contrast', contrast.badCount === 0, describeContrast(contrast));

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
