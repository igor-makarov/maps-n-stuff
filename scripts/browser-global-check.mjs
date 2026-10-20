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
import { writeArrayBuffer } from 'geotiff';

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
  // The big catalogue finishes loading before the optional modules have all
  // initialised. Wait for that contract explicitly instead of racing it.
  await waitFor(`(async()=>{const ctx = ${atlas};return Array.isArray(ctx.modules) && (ctx.modules.length === 8 || ctx.moduleErrors.length > 0);})()`);
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
  let targets = [];
  for (let i = 0; i < 120; i++) {
    try {
      targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      if (Array.isArray(targets) && targets.length && targets[0].webSocketDebuggerUrl) break;
    } catch {}
    await sleep(250);
  }
  if (!targets[0]?.webSocketDebuggerUrl) throw new Error('Chromium DevTools target did not become ready');
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
  await check('All eight app modules initialise successfully', `(async()=>{ const ctx = ${atlas}; return ctx.moduleErrors.length === 0 && ctx.modules.length === 8; })()`);
  await check('Search-sharing help is in English', `document.querySelector('#permalink-status').textContent.includes('Your filters are saved in the address')`);
  await evaluate(`(async()=>{(${atlas}).store.update({q:'world',at:'47.3769,8.5417',viewport:'1'});})()`);
  await waitFor(`document.querySelector('#result-count').textContent.includes('At selected location')`);
  await check('Location and viewport filter summaries are English', `document.querySelector('#result-count').textContent.includes('In current map view') && document.querySelector('#result-count').textContent.includes('“world”') && !/Ausschnitt|im Map/.test(document.querySelector('#result-count').textContent)`);
  await go();
  await evaluate(`(async()=>{(${atlas}).store.update({lat:0,lon:0});})()`);
  await check('The map can be centred on the equator', `(async()=>{const ctx=${atlas};return ctx.map.getView().lat===0 && ctx.store.getState().lat===0;})()`);
  await go('?from=2300&to=2500');
  await check('Shared year ranges are clamped to the actual catalogue span', `(async()=>{const ctx=${atlas};return ctx.store.getState().from===ctx.data.years.max && ctx.store.getState().to===ctx.data.years.max;})()`);
  await go();
  await evaluate(`(async()=>{const ctx=${atlas};const r=ctx.data.records.find(r=>r.languages?.includes('ger'));window.originalGermanTitle=r.title;ctx.store.update({selected:r.id});})()`);
  await waitFor(`!document.querySelector('#detail').hidden`);
  await check('Language metadata has English names and original titles are preserved', `(()=>{const term=[...document.querySelectorAll('#detail dt')].find(n=>n.textContent==='Language');return term?.nextElementSibling.textContent.includes('German') && document.querySelector('#detail').textContent.includes(window.originalGermanTitle);})()`);
  await go();
  await check('Rights-cleared global import includes unaligned and undated scans', `(async()=>{ const r=(${atlas}).data.records; return r.length>=4685 && r.filter(v=>v.providerId==='stanford').length===4464 && r.some(v=>v.yearStart===null&&!v.georeference); })()`);
  await waitFor(`document.querySelectorAll('#result-list .zh-result').length>0 && document.querySelector('#results-more')`);
  await check('Large result lists start with a bounded page', `document.querySelectorAll('#result-list .zh-result').length<=100 && !document.querySelector('#results-more').hidden`);
  await evaluate(`document.querySelector('#results-more').click()`);
  await waitFor(`document.querySelectorAll('#result-list .zh-result').length>100`);
  await check('More results expands the catalogue page', `document.querySelectorAll('#result-list .zh-result').length===200`);
  await go('?base=satellite');
  await check('Satellite choice uses NASA globally and states source resolution', `(async()=>{const ctx=${atlas};return ctx.map.getView().base==='satellite' && document.querySelector('#map').textContent.includes('NASA') && document.querySelector('#map-attribution-extra').textContent.includes('500');})()`);
  await go();
  // A generated, explicitly synthetic GeoTIFF verifies the actual browser
  // decoder, range handling, projection and canvas painting without asserting
  // that a blocked institutional image server has been reached.
  const pixels=[];
  for(let y=0;y<16;y++)for(let x=0;x<16;x++)pixels.push(x<8?240:10,x<8?10:240,20);
  const fixture=Buffer.from(await writeArrayBuffer(pixels,{width:16,height:16,PhotometricInterpretation:2,SamplesPerPixel:3,BitsPerSample:[8,8,8],GTModelTypeGeoKey:2,GeographicTypeGeoKey:4326,GTRasterTypeGeoKey:1,ModelPixelScale:[2.5,2.5,0],ModelTiepoint:[0,0,0,-20,40,0]})).toString('base64');
  await evaluate(`(async()=>{
    const ctx=${atlas};window.originalRasterFetch=window.fetch;
    const bytes=Uint8Array.from(atob(${JSON.stringify(fixture)}),c=>c.charCodeAt(0));
    window.fetch=async(input,init={})=>{
      if(String(typeof input==='string'?input:input.url).includes('/api/raster?')){
        const range=new Headers(init.headers).get('range')?.match(/bytes=(\\d+)-(\\d+)/);
        if(!range)throw new Error('Expected a bounded raster byte range');
        const start=Number(range[1]),end=Math.min(Number(range[2]),bytes.length-1);
        return new Response(bytes.slice(start,end+1),{status:206,headers:{'content-range':'bytes '+start+'-'+end+'/'+bytes.length,'accept-ranges':'bytes','content-length':String(end-start+1)}});
      }
      return window.originalRasterFetch(input,init);
    };
    const layer=ctx.data.overlays.find(v=>v.kind==='cog');ctx.store.update({overlay:layer.id,lat:20,lon:-5,zoom:5});
  })()`);
  const rasterPixel=`(()=>{const c=document.querySelector('.map-raster');return c?.getContext('2d').getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data;})()`;
  await waitFor(`document.querySelector('#alignment-status')?.textContent.includes('Provider-supplied georeferencing') && (${rasterPixel})[0]>200`);
  await check('Synthetic native GeoTIFF decodes, projects and paints the correct colour', `(${rasterPixel})[3]===255 && (${rasterPixel})[1]<50`);
  await evaluate(`(async()=>{(${atlas}).store.update({lon:5});})()`);
  await waitFor(`(${rasterPixel})[1]>200`);
  await check('Raster projection follows map panning', `(${rasterPixel})[0]<50`);
  await evaluate(`(async()=>{const ctx=${atlas};ctx.bus.emit('overlay:opacity',{opacity:0});})()`);
  await check('Raster opacity supports a fully transparent overlay', `document.querySelector('.map-raster').style.opacity==='0'`);
  await evaluate(`window.fetch=window.originalRasterFetch`);
  await go();
  await check('A bundled USGS record keeps its original GeoTIFF georeference', `(async()=>{ const ctx=${atlas}; const r=ctx.data.records.find(v=>v.providerId==='usgs'&&v.georeference?.kind==='cog'); return !!r && r.georeference.url.includes('prd-tnm.s3.amazonaws.com/StagedProducts/Maps/HistoricalTopo/GeoTIFF/') && r.georeference.status==='provider-supplied' && r.downloads?.some(d=>d.label==='GeoTIFF'); })()`);
  await evaluate(`(async()=>{ const ctx=${atlas}; const r=ctx.data.records.find(v=>v.providerId==='usgs'&&v.georeference?.kind==='cog'); ctx.store.update({selected:r.id}); })()`);
  await waitFor(`!document.querySelector('#detail').hidden && document.querySelector('#detail [data-show-raster]')`);
  await evaluate(`document.querySelector('#detail [data-show-raster]').click()`);
  await check('USGS GeoTIFF opens from the record without a fabricated overlay entry', `(async()=>{ const ctx=${atlas}; const s=ctx.store.getState(); const layer=ctx.data.overlays.find(v=>v.id===s.overlay); return !!layer && layer.kind==='cog' && layer.recordId.startsWith('usgs:') && layer.url.includes('prd-tnm.s3.amazonaws.com') && document.querySelector('.map-raster').hidden===false; })()`);
  await go();
  await evaluate(`(async()=>{window.catalogueSizeBefore=(${atlas}).data.records.length;})()`);
  await evaluate(`window.originalCollectionFetch=window.fetch;window.fetch=async(input,init)=>String(input).includes('/api/catalogue?')?Response.json({records:[{id:'leventhal:commonwealth:fixture123',providerId:'leventhal',title:'Harbour plan',yearStart:1200,yearEnd:1200,creators:[],institution:'Fixture library',rights:'This work is in the public domain.',recordUrl:'https://collections.leventhalmap.org/search/commonwealth:fixture123',thumbnail:null,type:'map',collection:'Fixture collection',extent:null,geoNote:'Synthetic adapter test, not an imported map.'}],withheld:1,nextPage:null}):window.originalCollectionFetch(input,init);document.querySelector('#collection-source').value='leventhal';document.querySelector('#collection-query').value='Fixture Boston';document.querySelector('#collection-search').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));`);
  await waitFor(`document.querySelector('[data-record-id="leventhal:commonwealth:fixture123"]')`);
  await check('Original collection searches merge admitted records and update filters', `(async()=>{const ctx=${atlas};return ctx.data.records.length===window.catalogueSizeBefore+1 && ctx.store.getState().provider==='leventhal' && document.querySelector('#collection-status').textContent.includes('1 map added');})()`);
  await check('Imported full-text matches stay visible without changing their titles', `document.querySelector('[data-record-id="leventhal:commonwealth:fixture123"]').textContent.includes('Harbour plan') && document.querySelector('#intro-count').textContent===String(window.catalogueSizeBefore+1) && document.querySelector('#year-from').min==='1200'`);
  await evaluate(`window.fetch=(input,init)=>String(input).includes('/api/catalogue?')?new Promise(resolve=>{window.finishStaleSearch=()=>resolve(Response.json({records:[{id:'loc:stale-fixture',providerId:'loc',title:'Stale fixture',yearStart:1800,yearEnd:1800,creators:[],institution:'Fixture library',rights:'Public domain',recordUrl:'https://www.loc.gov/item/stale-fixture/',type:'map'}]}));}):window.originalCollectionFetch(input,init);document.querySelector('#collection-source').value='loc';document.querySelector('#collection-source').dispatchEvent(new Event('change'));document.querySelector('#collection-query').value='Stale fixture';document.querySelector('#collection-search').dispatchEvent(new Event('submit',{cancelable:true}));document.querySelector('#collection-source').value='usgs';document.querySelector('#collection-source').dispatchEvent(new Event('change'));`);
  await evaluate(`(async()=>{window.finishStaleSearch();await new Promise(resolve=>setTimeout(resolve,80));})()`);
  await check('Changing collection discards an older search response', `(async()=>{const ctx=${atlas};return !ctx.data.recordIndex.has('loc:stale-fixture') && ctx.store.getState().provider==='leventhal' && !document.querySelector('#collection-submit').disabled;})()`);
  await check('USGS search clearly uses the visible map area', `document.querySelector('#collection-query').disabled && document.querySelector('#collection-submit').textContent==='Search this map area'`);
  await evaluate(`window.fetch=window.originalCollectionFetch`);
  await go();
  const outage=await send('Page.addScriptToEvaluateOnNewDocument',{source:`const fetchNormally=window.fetch;window.fetch=(input,init)=>String(input).includes('/data/records.json')?Promise.resolve(new Response('{}',{status:503})):fetchNormally(input,init);`});
  await go('?view=history&year=1914');
  await waitFor(`document.querySelector('#hz-canvas')?.getAttribute('aria-label').includes('1914')`);
  await check('A catalogue outage leaves map navigation and historical borders usable', `(async()=>{const ctx=${atlas};return ctx.modules.length===8 && ctx.moduleErrors.length===0 && !document.querySelector('#app-notices').hidden && document.querySelector('#app-notices').textContent.includes('catalogue could not be loaded') && ctx.moduleApis.history.state.features.length>100;})()`);
  await send('Page.removeScriptToEvaluateOnNewDocument',{identifier:outage.identifier});
  await go();
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
