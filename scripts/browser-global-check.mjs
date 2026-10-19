#!/usr/bin/env node
/** Browser regression checks for the global atlas. Requires Chromium and `npm run dev`.
 * External services are blocked deliberately: these checks exercise our UI and the
 * bundled history data, and do not claim to verify live archive images or geocoding.
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const base = process.argv[2] || 'http://127.0.0.1:8787';
const out = process.argv[3] || '/tmp/meridian-atlas-checks';
const port = 9444;
const profile = await mkdtemp(path.join(tmpdir(), 'meridian-browser-'));
await mkdir(out, { recursive: true });
const chrome = spawn('/usr/bin/chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
let ws;
const runtimeErrors = [];
let serial = 0;
let navigations = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++serial;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const result = await evaluate(expression);
      if (result) return result;
    } catch (error) {
      if (!/Execution context was destroyed|Cannot find context|Inspected target navigated/.test(error.message)) throw error;
    }
    await sleep(80);
  }
  throw new Error(`Timed out: ${expression.slice(0, 140)}`);
}
async function go(query = '') {
  const beforeNavigation = navigations;
  await send('Page.navigate', { url: `${base}/${query}` });
  const deadline = Date.now() + 15000;
  while (navigations === beforeNavigation && Date.now() < deadline) await sleep(25);
  await waitFor(`document.documentElement?.dataset.app === 'meridian-atlas' && document.querySelector('.app-modebar') && document.querySelector('#result-list')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('link[href="/styles/history.css"]')?.sheet`);
  await evaluate('document.fonts.ready');
  await evaluate('scrollTo(0,0)');
}
async function check(name, expression) {
  const result = await evaluate(expression);
  checks.push({ name, ok: Boolean(result) });
  console.log(`${result ? '✔' : '✖'} ${name}`);
  assert.ok(result, name);
}
async function shot(name) {
  const result = await send('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(out, name), Buffer.from(result.data, 'base64'));
}
const atlas = `(await import('/app/main.js')).ctx`;
const history = `(${atlas}).moduleApis.history`;
try {
  let targets;
  for (let i = 0; i < 60; i++) {
    try { targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()); break; } catch { await sleep(100); }
  }
  ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const item = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) item?.reject(new Error(message.error.message));
      else item?.resolve(message.result);
    } else if (message.method === 'Page.frameNavigated' && !message.params.frame.parentId) navigations++;
    else if (message.method === 'Runtime.exceptionThrown') runtimeErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  };
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*'] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
  await go();
  await check('English document, metadata, and original globe branding', `document.documentElement.lang === 'en' && document.title.includes('Meridian Atlas') && document.querySelector('.zh-brand__mark circle') && !document.querySelector('.zh-header').textContent.includes('Kanton')`);
  await check('All six app modules initialise successfully', `(async()=>{ const ctx = ${atlas}; return ctx.moduleErrors.length === 0 && ctx.modules.length === 6; })()`);
  await check('Archive map opens worldwide', `(async()=>{ const s = (${atlas}).store.getState(); return s.lat === 20 && s.lon === 0 && !s.base; })()`);
  await check('Worldwide basemap host is permitted by the delivered image policy', `(async()=>{ const csp = (await fetch('/')).headers.get('content-security-policy'); return csp.includes('https://tile.openstreetmap.org') && csp.includes('https://tile.loc.gov'); })()`);
  await check('The initial publication period includes early twentieth-century maps', `(async()=>{ return (${atlas}).store.getState().to >= 1920; })()`);
  await check('Global primary catalogue has Cairo, Tokyo, Mexico City and São Paulo', `(async()=>{ const {matchesQuery} = await import('/app/records.js'); const records = (${atlas}).data.records; return ['Cairo','Tokyo','Mexico City','Sao Paulo'].every(q=>records.some(r=>r.providerId === 'loc' && matchesQuery(r,q))); })()`);
  await evaluate(`document.querySelector('#text-filter').value = 'Mexico City'; document.querySelector('#text-filter').dispatchEvent(new Event('input', {bubbles:true}))`);
  await waitFor(`document.querySelector('[data-record-id="loc:00561384"]')`);
  await check('English filters find the original Mexico City record', `document.querySelector('#result-count').textContent.includes('records') && !!document.querySelector('[data-record-id="loc:00561384"]')`);
  await evaluate(`document.querySelector('[data-record-id="loc:00561384"]').click()`);
  await waitFor(`!document.querySelector('#detail').hidden`);
  await check('Detail panel retains original source and explains unknown boundaries', `document.querySelector('#detail').textContent.includes('Publication year') && document.querySelector('#detail').textContent.includes('Approximate place anchor') && !!document.querySelector('#detail a[href="https://www.loc.gov/item/00561384/"]')`);
  await evaluate(`document.querySelector('#detail [data-close], #detail button').click()`);
  await go('?view=history&year=1914');
  await waitFor(`document.querySelector('#hz-canvas')?.getAttribute('aria-label').includes('1914')`);
  await check('History uses the complete source index and real political polygons', `(async()=>{ const h = ${history}; return h.state.years.length === 54 && h.state.features.length > 100 && h.state.features.some(f=>f.name === 'German Empire' && f.parts.length); })()`);
  await check('Year timeline is visible above the map', `document.querySelector('.hz__timeline').getBoundingClientRect().bottom <= document.querySelector('.hz__mapwrap').getBoundingClientRect().top`);
  const before = await evaluate(`document.querySelector('#hz-canvas').toDataURL()`);
  await evaluate(`document.querySelector('#hz-year-input').value = '2010'; document.querySelector('#hz-year-form').requestSubmit()`);
  await waitFor(`document.querySelector('#hz-canvas')?.getAttribute('aria-label').includes('2010')`);
  await check('Changing year changes the actual polygons and shareable URL', `(async()=>{ const h = ${history}; return h.state.loadedYear === 2010 && !h.state.features.some(f=>f.name === 'German Empire') && h.state.features.some(f=>f.name === 'Germany') && new URLSearchParams(location.search).get('year') === '2010'; })()`);
  assert.notEqual(await evaluate(`document.querySelector('#hz-canvas').toDataURL()`), before, 'canvas pixels change with year');
  checks.push({name:'Canvas pixels change with the historical year', ok:true});
  await evaluate(`document.querySelector('#hz-year-input').value = '1950'; document.querySelector('#hz-year-form').requestSubmit()`);
  await waitFor(`document.querySelector('#hz-note').textContent.includes('nearest published map')`);
  await check('Gaps use an explicitly named snapshot', `document.querySelector('#hz-note').textContent.includes('1945') && document.querySelector('#hz-year-input').value.includes('1950')`);
  await evaluate(`document.querySelector('#hz-year-input').value = '1000 BCE'; document.querySelector('#hz-year-form').requestSubmit()`);
  await waitFor(`document.querySelector('#hz-canvas')?.getAttribute('aria-label').includes('1000 BCE')`);
  await check('BCE years load source polygons and persist in the URL', `(async()=>{ return (${history}).state.loadedYear === -1000 && new URLSearchParams(location.search).get('year') === '-1000'; })()`);
  await evaluate(`document.querySelector('#hz-search').value = 'Prussia'; document.querySelector('#hz-search').dispatchEvent(new Event('input', {bubbles:true}))`);
  await waitFor(`document.querySelector('#hz-search-results button')`);
  await evaluate(`document.querySelector('#hz-search-results button').click()`);
  await waitFor(`!document.querySelector('#hz-details').hidden`);
  await check('Cross-period polity search opens real source details', `document.querySelector('#hz-details').textContent.includes('Prussia') && document.querySelector('#hz-details').textContent.includes('Border precision') && !!document.querySelector('#hz-details a[href*="aourednik/historical-basemaps"]')`);
  await evaluate(`(async()=>{ (${atlas}).store.update({hv:'20.000,78.000,4.00'}); })()`);
  await check('Shared history position updates the renderer as well as the URL', `(async()=>{ const h = ${history}; return h.state.view.lat === 20 && h.state.view.lon === 78 && h.state.view.zoom === 4; })()`);
  await evaluate(`document.querySelector('[data-hz="zoom-reset"]').click()`);
  await check('World reset clears the shared window and restores automatic fitting', `(async()=>{ return (${history}).state.viewAuto && !(${atlas}).store.getState().hv; })()`);
  await evaluate(`document.querySelector('#place-quick button').click()`);
  await check('Global quick picks move the active historical map', `(async()=>{ const h = ${history}; return Math.abs(h.state.view.lat - 30.0444)<.01 && Math.abs(h.state.view.lon - 31.2357)<.01; })()`);
  await go('?view=history&year=1914');
  await waitFor(`document.querySelector('#hz-canvas')?.getAttribute('aria-label').includes('1914')`);
  await shot('history-desktop.png');
  await evaluate(`document.querySelector('[data-hz="play"]').click()`);
  await waitFor(`new URLSearchParams(location.search).get('year') !== '1914'`);
  await evaluate(`document.querySelector('[data-hz="play"]').click()`);
  await check('Timeline playback changes the drawn year and can pause', `(async()=>{ return !(${history}).state.playing && document.querySelector('[data-hz="play"]').getAttribute('aria-pressed') === 'false'; })()`);
  // Real out-of-order responses reproduce the race when scrubbing the timeline.
  await evaluate(`(async()=>{ window.savedAtlasFetch=window.fetch; window.fetch=async(...args)=>{ const url=String(args[0]); if(url.includes('world_1914.json')) await new Promise(r=>setTimeout(r,350)); return window.savedAtlasFetch(...args); }; const h=${history}; h.state.featuresByYear.delete(1914); const first = h.showYear(1914); await new Promise(r=>setTimeout(r,30)); await Promise.all([first,h.showYear(2010)]); window.fetch=window.savedAtlasFetch; })()`);
  await check('A late snapshot cannot overwrite a newer selected year', `(async()=>{ return (${history}).state.loadedYear === 2010 && document.querySelector('#hz-loading').hidden; })()`);
  for (const width of [390,320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await go('?view=history&year=2010');
    await waitFor(`document.querySelector('#hz-canvas')?.getAttribute('aria-label').includes('2010')`);
    await shot(`history-${width}px.png`);
    console.log('Layout', width, await evaluate(`JSON.stringify({top:document.querySelector('.hz__mapwrap').getBoundingClientRect().top,height:innerHeight})`));
    await check(`The map is visible on the first screen at ${width}px`, `document.querySelector('.hz__mapwrap').getBoundingClientRect().top < innerHeight - 180`);
    await check(`History fits a ${width}px phone`, `document.documentElement.scrollWidth <= innerWidth && document.querySelector('#hz-canvas').getBoundingClientRect().width <= innerWidth`);
    const zoomBeforeKeyboard = await evaluate(`(async()=>(${history}).state.view.zoom)()`);
    await evaluate(`document.querySelector('#hz-canvas').focus()`);
    await send('Input.dispatchKeyEvent', { type:'keyDown', key:'+', code:'Equal', text:'+' });
    await send('Input.dispatchKeyEvent', { type:'keyUp', key:'+', code:'Equal' });
    await check(`Keyboard zoom works on a ${width}px phone`, `(async()=>{ return (${history}).state.view.zoom > ${zoomBeforeKeyboard}; })()`);
    await evaluate(`document.querySelector('[data-hz="zoom-in"]').scrollIntoView({block:'center'})`);
    await check(`Pointer controls remain above the canvas at ${width}px`, `(() => { const b = document.querySelector('[data-hz="zoom-in"]'); const r=b.getBoundingClientRect(); return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button') === b; })()`);
    if(width === 390) { await evaluate('scrollTo(0,0)'); await shot('history-mobile.png'); }
    await go();
    await check(`Archive view fits a ${width}px phone`, `document.documentElement.scrollWidth <= innerWidth`);
  }
  assert.deepEqual(runtimeErrors, [], 'no uncaught JavaScript errors');
  checks.push({name:'No uncaught browser exceptions',ok:true});
} catch (err) {
  checks.push({name:'Browser run completed',ok:false,error:err.message});
  console.error(err);
  process.exitCode = 1;
} finally {
  await writeFile(path.join(out,'report.json'),JSON.stringify({checks,runtimeErrors,externalServices:'blocked; live endpoint checks are separate'},null,2));
  console.log(`${checks.filter(c=>c.ok).length}/${checks.length} checks passed. Report: ${out}/report.json`);
  ws?.close();
  chrome.kill();
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:150}).catch(()=>{});
}
