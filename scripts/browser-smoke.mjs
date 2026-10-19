#!/usr/bin/env node
/**
 * Headless browser smoke check (development tool, not part of the build).
 *
 * Uses the Chromium binary on the runner and the DevTools protocol via Node's
 * built-in WebSocket – no npm dependencies. Collects console errors, failed
 * requests and a DOM snapshot, then writes a screenshot.
 *
 *   node scripts/browser-smoke.mjs [url] [--out /tmp/shot.png] [--wait 8000]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const url = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://127.0.0.1:8787/';
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const out = arg('--out', '/tmp/browser-smoke.png');
const wait = Number(arg('--wait', 9000));
const port = Number(arg('--port', 9333));

const binary = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(Boolean);
const userDataDir = await mkdtemp(path.join(tmpdir(), 'cdp-'));
const child = spawn(
  binary,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-sandbox',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function endpoint(pathname) {
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${pathname}`);
      if (res.ok) return res.json();
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  throw new Error(`CDP endpoint ${pathname} not reachable`);
}

const version = await endpoint('/json/version');
const targets = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
const ws = new WebSocket(targets.webSocketDebuggerUrl ?? (await endpoint('/json/list'))[0].webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (message) => {
  const data = JSON.parse(message.data);
  if (data.id && pending.has(data.id)) {
    pending.get(data.id)(data);
    pending.delete(data.id);
  } else if (data.method) events.push(data);
};
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const messageId = ++id;
    pending.set(messageId, resolve);
    ws.send(JSON.stringify({ id: messageId, method, params }));
  });

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
const mobile = process.argv.includes('--mobile');
await send('Emulation.setDeviceMetricsOverride', {
  width: mobile ? 390 : 1440,
  height: mobile ? 844 : 1000,
  deviceScaleFactor: 1,
  mobile,
  screenWidth: mobile ? 390 : 1440,
  screenHeight: mobile ? 844 : 1000,
});
await send('Page.navigate', { url });
await sleep(wait);

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return res.result?.result?.value;
};

const snapshot = await evaluate(`(() => ({
  title: document.title,
  resultCount: document.querySelector('#result-count')?.textContent?.trim(),
  results: [...document.querySelectorAll('#result-list button')].slice(0, 3).map((b) => b.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80)),
  resultCount2: document.querySelectorAll('#result-list li').length,
  mapTiles: document.querySelectorAll('.map-tile').length,
  mapTilesWithPixels: [...document.querySelectorAll('.map-tile')].filter((i) => i.naturalWidth > 0).length,
  overlayTiles: document.querySelectorAll('.map-overlay-tile').length,
  markers: document.querySelectorAll('.map-marker').length,
  suggestions: document.querySelectorAll('#place-suggestions li').length,
  sourceList: document.querySelectorAll('#source-list dt').length,
  introFacts: [...document.querySelectorAll('.zh-facts__value')].map((n) => n.textContent),
  introText: document.querySelector('#intro-count')?.textContent,
  introTags: [...document.querySelectorAll('#intro-tags li')].map((n) => n.textContent),
  states: [...document.querySelectorAll('.zh-state')].filter((n) => !n.hidden).map((n) => n.textContent.trim().slice(0, 120)),
  overlayOptions: document.querySelectorAll('#overlay-select option').length,
  bodyFont: getComputedStyle(document.body).fontFamily,
  h1Font: getComputedStyle(document.querySelector('h1')).fontFamily,
  primaryButtonBg: getComputedStyle(document.querySelector('.zh-button')).backgroundColor,
  mapHeight: document.querySelector('[data-map]')?.clientHeight,
  docHeight: document.documentElement.scrollHeight,
  horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
  focusRing: (() => { const b = document.querySelector('.zh-button'); b.focus(); return getComputedStyle(b).outlineStyle + ' ' + getComputedStyle(b).outlineColor; })(),
}))()`);

// Exercise the interactive paths: place search, year filter, viewport filter,
// comparison layer, selection and the detail view with its IIIF preview.
const interaction = await evaluate(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = {};

  // 1. Place search (swisstopo via the worker) – type, wait for suggestions, choose one.
  const place = document.querySelector('#place-input');
  place.focus();
  place.value = 'Bern';
  place.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(2500);
  out.suggestions = document.querySelectorAll('#place-suggestions li').length;
  out.placeStatus = document.querySelector('#place-status')?.textContent?.trim().slice(0, 90);
  document.querySelector('#place-suggestions button')?.click();
  await sleep(900);
  out.placeChosen = document.querySelector('#place-input')?.value;
  out.urlWithPlace = location.search.includes('place=');

  // 2. Year range.
  const from = document.querySelector('#year-from');
  from.value = 1800;
  from.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(700);
  out.afterYear = document.querySelector('#result-count')?.textContent?.trim();

  // 3. Viewport filter (needs the map to know its bounds).
  const viewport = document.querySelector('#viewport-filter');
  viewport.checked = true;
  viewport.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(600);
  out.viewportHint = document.querySelector('#viewport-count')?.textContent?.trim();
  out.viewportCount = document.querySelectorAll('#result-list li').length;
  viewport.checked = false;
  viewport.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(400);

  // 4. Comparison layer: pick the Zeitreise layer and change opacity.
  const overlay = document.querySelector('#overlay-select');
  overlay.value = 'ch.swisstopo.zeitreihen';
  overlay.dispatchEvent(new Event('change', { bubbles: true }));
  await sleep(2500);
  out.overlayTiles = document.querySelectorAll('.map-overlay-tile').length;
  out.overlayTilesLoaded = [...document.querySelectorAll('.map-overlay-tile')].filter((i) => i.naturalWidth > 0).length;
  out.overlayTimeFieldVisible = !document.querySelector('#overlay-time-field')?.hidden;
  out.overlayTimeLabel = document.querySelector('#overlay-time-output')?.textContent?.trim();
  const opacity = document.querySelector('#overlay-opacity');
  opacity.value = '45';
  opacity.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(200);
  out.overlayOpacityApplied = getComputedStyle(document.querySelector('.map-layer--overlay')).opacity;
  out.urlHasOverlay = location.search.includes('ov=');

  // 5. Select a result and open the detail view.
  const first = document.querySelector('#result-list button');
  first?.click();
  await sleep(3000);
  const detail = document.querySelector('#detail');
  const preview = document.querySelector('#detail-preview img');
  out.detailVisible = detail ? !detail.hidden : false;
  out.detailTitle = document.querySelector('.app-detail__title')?.textContent?.slice(0, 80);
  out.facts = document.querySelectorAll('.app-detail__facts dt').length;
  out.originalLink = document.querySelector('.app-detail__actions a')?.href;
  out.previewSrc = preview?.getAttribute('src');
  out.previewLoaded = preview ? preview.naturalWidth > 0 : false;
  out.pageLabel = document.querySelector('#page-label')?.textContent;
  out.selectedInUrl = location.search.includes('sel=');
  out.markers = document.querySelectorAll('.map-marker').length;
  out.activeElementTag = document.activeElement?.tagName;

  // 6. Keyboard: close the panel with Escape.
  document.querySelector('#detail')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(400);
  out.detailClosedByEsc = document.querySelector('#detail')?.hidden;
  return out;
})()`);

const consoleErrors = events
  .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error'))
  .map((e) => e.params.exceptionDetails?.text ?? e.params.entry?.text);
const failedRequests = events
  .filter((e) => e.method === 'Network.loadingFailed')
  .map((e) => `${e.params.type} ${e.params.errorText}`);

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
if (shot.result?.data) await writeFile(out, Buffer.from(shot.result.data, 'base64'));

console.log(JSON.stringify({ url, chromium: version.Browser, snapshot, interaction, consoleErrors, failedRequests, screenshot: out }, null, 1));
child.kill('SIGKILL');
ws.close();
process.exit(0);
