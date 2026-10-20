/**
 * Static integration checks for the Workers site.
 *
 * These catch the failure mode that hurts most in a four-agent build: the shell,
 * the modules, the data and the Worker silently drifting apart. Everything here
 * is offline and reads the repository as Cloudflare's build would see it
 * (`public/` static assets + `src/worker/index.js`).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => readFile(path.join(root, rel), 'utf8');

const html = await read('public/index.html');
const css = {
  tokens: await read('public/styles/zh-tokens.css'),
  base: await read('public/styles/zh-base.css'),
  components: await read('public/styles/zh-components.css'),
  app: await read('public/styles/app.css'),
};
const allCss = Object.values(css).join('\n');
const modules = Object.fromEntries(
  await Promise.all(
    (await readdir(path.join(root, 'public/app')))
      .filter((name) => name.endsWith('.js'))
      .map(async (name) => [name, await read(`public/app/${name}`)]),
  ),
);
const workerEntry = await read('src/worker/index.js');
// The allowlist lives in its own module (a Workers entrypoint may only export its
// default handler), so proxy checks read both files.
const worker = `${workerEntry}\n${await read('src/worker/allowlist.js')}`;
const wrangler = await read('wrangler.jsonc');
const pkg = JSON.parse(await read('package.json'));

test('detail reuse links consume direct original scans and documents', () => {
  // Doria and SLUB publish direct JPEG/PDF originals, not IIIF services. The
  // reuse section used to say "no image service" for those records.
  assert.match(modules['detail.js'], /record\.imageUrl/);
  assert.match(modules['detail.js'], /record\?\.documents/);
  assert.match(modules['detail.js'], /Open original scan/);
  assert.match(modules['detail.js'], /Original PDF/);
});

test('index.html is a semantic app shell (landmarks, language, skip link)', () => {
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /<html[^>]+lang="en"/, 'the global UI declares English');
  assert.match(html, /<a[^>]+class="[^"]*skip[^"]*"[^>]+href="#main"/, 'keyboard users need a skip link');
  for (const landmark of ['<header', '<main', '<footer', '<nav']) {
    assert.ok(html.includes(landmark), `missing landmark ${landmark}`);
  }
  assert.match(html, /<main[^>]+id="main"[^>]*/);
  assert.match(html, /<h1[^>]*>/, 'exactly one page heading');
  assert.equal((html.match(/<h1/g) ?? []).length, 1);
  assert.match(html, /<meta[^>]+name="viewport"[^>]+width=device-width/, 'responsive viewport');
  assert.match(html, /<meta[^>]+name="description"/);
});

test('the shell loads every asset locally (no CDN or font host dependency)', () => {
  const externalRefs = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
  for (const url of externalRefs) {
    assert.ok(!/\.(js|css|woff2?|png|svg)(\?|$)/.test(url), `asset must be served from the Workers site: ${url}`);
  }
  assert.ok(!/fonts\.googleapis|cdn\.jsdelivr|unpkg\.com|cdnjs/.test(html), 'no third-party CDN');
  assert.ok(!/@import\s+url\((?:"|')?https?:/.test(allCss), 'no remote CSS imports');
  const fonts = (allCss.match(/url\(['"]?([^'")]+)['"]?\)/g) ?? []).filter((u) => /woff2?/.test(u));
  assert.ok(fonts.length > 0, 'the design system typography needs locally served webfonts');
  for (const font of fonts) assert.ok(!/https?:/.test(font), `font must be local: ${font}`);
});

test('the design system tokens are the canton Zürich values, not a generic blue', () => {
  const expected = {
    '#0070b4': 'canton blue',
    '#00407c': 'dark blue',
    '#009ee0': 'turquoise/cyan',
    '#b01657': 'bordeaux',
  };
  for (const [hex, label] of Object.entries(expected)) {
    assert.ok(css.tokens.toLowerCase().includes(hex), `token ${label} (${hex}) missing from zh-tokens.css`);
  }
  for (const grey of ['#333', '#666', '#f0f0f0']) {
    assert.ok(css.tokens.toLowerCase().includes(grey), `grey scale value ${grey} missing`);
  }
  assert.match(css.tokens, /--zh-font|font-family/i, 'typography tokens');
  assert.match(allCss, /--zh-(space|size)/, 'spacing/size scale tokens');
  assert.match(css.tokens, /border-radius:\s*0\.?0?1?\w*\s*;|--zh-radius/, 'the canton design uses a 1px button radius');
  assert.match(css.base, /:focus-visible/, 'visible keyboard focus is mandatory');
  assert.match(css.base, /prefers-reduced-motion/, 'reduced-motion support');
  assert.match(allCss, /@media\s*\(min-width/, 'responsive breakpoints');
});

test('every UI selectors used by the app modules exists in the shell', () => {
  const selectors = new Set();
  for (const source of Object.values(modules)) {
    for (const match of source.matchAll(/qs\('([^']+)'/g)) selectors.add(match[1]);
  }
  // Ids the modules render themselves (inside #detail-body) instead of the shell.
  const dynamic = new Set([
    '#compare-sync',
    '#compare-sync-hint',
    '#detail-preview',
    '#detail-pin',
    '#detail-overlay',
    '#detail-status',
    '#page-label',
    '#page-jump',
    '#page-jump-wrap',
    '#page-nav',
    '#page-next',
    '#page-prev',
    '#page-strip',
    '#preview-meta',
    '#reuse-links',
    '#viewer-resolution',
    '#viewer-reset',
    '#viewer-status',
    '#viewer-zoom-in',
    '#viewer-zoom-out',
  ]);
  for (const selector of selectors) {
    if (dynamic.has(selector)) continue;
    if (selector.startsWith('#')) {
      assert.ok(html.includes(`id="${selector.slice(1)}"`), `module queries ${selector} but the shell has no such id`);
    } else if (selector.startsWith('[')) {
      const attr = selector.slice(1, -1).split('=')[0];
      assert.ok(html.includes(attr), `module queries ${selector} but the shell has no such attribute`);
    }
  }
  // And the reverse: no stale hooks in the shell that no module uses.
  for (const id of ['place-input', 'place-suggestions', 'result-list', 'year-from', 'year-to', 'provider-filters', 'type-filters', 'overlay-select', 'detail', 'detail-body', 'map']) {
    assert.ok(html.includes(`id="${id}"`), `contracted hook #${id} is missing`);
  }
});

test('the shell ships a visible loading state that the bootstrap always ends', () => {
  // A slow seed must not look like an empty result list, and a failed seed must
  // not keep claiming to load (maps-1, iteration 7-17): the block lives in
  // index.html, the bootstrap ends it on success *and* on failure. The runtime
  // behaviour is driven by scripts/browser-check.mjs; this keeps the markup and
  // the two paths in the bootstrap from drifting apart offline.
  assert.match(html, /id="results-loading"/, 'the loading block must be in the shell');
  assert.match(html, /id="result-list"[^>]*aria-busy="true"/, 'the list must be busy while it loads');
  assert.match(html, /class="zh-spinner"/, 'the cantonal loading circle is the indicator');
  assert.match(css.app, /\.zh-state--loading/, 'the loading variant must have a rule');
  assert.match(modules['main.js'], /function finishLoading\(/, 'the bootstrap owns ending the state');
  assert.match(modules['main.js'], /qs\('#results-loading'\)/, 'it hides the block');
  assert.match(modules['main.js'], /setAttribute\('aria-busy', 'false'\)/, 'and clears the busy flag');
  assert.match(modules['main.js'], /Catalogue unavailable/, 'the outage path must replace the “loading” claim');
});

test('the shell only references entry points that exist', async () => {
  const scripts = [...html.matchAll(/<script[^>]+src="(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(scripts.includes('/app/main.js'), 'the app must be bootstrapped by a module script');
  for (const file of await readdir(path.join(root, 'public/app'))) {
    assert.ok(file.endsWith('.js'));
  }
  const main = modules['main.js'];
  for (const specifier of ['store.js', 'dom.js', 'records.js']) {
    assert.ok(main.includes(specifier), `main.js must import ${specifier}`);
    assert.ok(Object.keys(modules).includes(specifier), `${specifier} must exist`);
  }
  for (const optional of ['map.js', 'search.js', 'results.js', 'detail.js']) {
    assert.ok(main.includes(optional), `optional module ${optional} is not wired in main.js`);
    assert.ok(optional in modules, `optional module ${optional} is missing`);
  }
  // The IIIF detail viewer uses the pure helper module (coordination/README.md).
  assert.ok('iiif.js' in modules, 'public/app/iiif.js must exist');
  assert.match(modules['detail.js'], /from '\.\/iiif\.js'/, 'detail.js builds image requests through iiif.js');
  // Every upstream JSON request goes through the one documented ladder.
  assert.ok('upstream.js' in modules, 'public/app/upstream.js must exist');
  assert.match(modules['detail.js'], /from '\.\/upstream\.js'/, 'detail.js loads manifests through upstream.js');
});

test('modules only talk to the contracted context (ctx.store/ctx.bus/ctx.data)', () => {
  // Helper modules are imported by the UI modules and expose no init(ctx).
  const helpers = new Set(['main.js', 'dom.js', 'store.js', 'records.js', 'iiif.js', 'upstream.js']);
  for (const [name, source] of Object.entries(modules)) {
    if (helpers.has(name)) continue;
    assert.match(source, /export function init\(ctx\)/, `${name}: modules expose init(ctx)`);
    // The URL stays the source of truth for shared state. One documented
    // exception: the comparison list (“Merkliste”, the brief's saved maps) may
    // also be kept device-locally under its versioned key — a link that carries
    // `?cmp=` always wins over it, and only record ids are stored.
    const storageOk =
      name === 'compare.js' && /kartenzeit\.cmp\.v1/.test(source) && !/document\.cookie/.test(source);
    assert.ok(!/localStorage/.test(source) || storageOk, `${name}: no hidden localStorage state (URL is the source of truth)`);
    assert.ok(!/document\.cookie/.test(source), `${name}: no cookie writes`);
  }
});

test('worker configuration matches the Cloudflare Workers static-assets contract', () => {
  assert.match(wrangler, /"main"\s*:\s*"src\/worker\/index\.js"/);
  assert.match(wrangler, /"directory"\s*:\s*"\.\/public"/);
  assert.match(wrangler, /"binding"\s*:\s*"ASSETS"/);
  assert.match(wrangler, /"run_worker_first"\s*:\s*\[\s*"\/api\/\*"\s*\]/, 'only /api/* should invoke the Worker');
  assert.match(wrangler, /"compatibility_date"\s*:\s*"\d{4}-\d{2}-\d{2}"/);
  assert.ok(pkg.scripts.dev && pkg.scripts.build && pkg.scripts.test && pkg.scripts['dry-run'], 'documented npm scripts');
  assert.match(pkg.scripts['dry-run'], /wrangler deploy --dry-run/, 'deployment is verified without credentials');
  assert.ok(pkg.devDependencies.wrangler, 'wrangler is pinned in devDependencies');
  assert.ok(pkg.type === 'module');
});

test('the Worker is not an open proxy and holds no credentials', () => {
  const hosts = [...worker.matchAll(/host:\s*'([^']+)'/g)].map((m) => m[1]);
  assert.ok(hosts.length >= 3);
  for (const host of hosts) {
    // The worldwide gazetteer is the one non-Swiss upstream the app talks to;
    // it is admitted for `/search` only (see src/worker/allowlist.js).
    assert.ok(
      /^(api3|wmts|data)\.geo\.admin\.ch$|^www\.e-rara\.ch$|^nominatim\.openstreetmap\.org$|^www\.loc\.gov$|^tile\.loc\.gov$|^(purl|stacks)\.stanford\.edu$|^collections\.leventhalmap\.org$|^iiif\.digitalcommonwealth\.org$|^ark\.digitalcommonwealth\.org$/.test(host),
      `unexpected proxy host ${host}`,
    );
  }
  assert.ok(!/oldmapsonline/i.test(worker), 'no aggregator endpoints');
  for (const secret of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'ACCOUNT_ID', 'API_KEY', 'SECRET']) {
    assert.ok(!worker.includes(secret) && !wrangler.includes(secret), `no ${secret} in the Workers sources`);
  }
});

test('repository ships no credentials or generated deployment state', async () => {
  const ignored = await read('.gitignore');
  for (const entry of ['.dev.vars', '.env', 'node_modules', 'dist', '.wrangler']) {
    assert.ok(ignored.includes(entry), `.gitignore must exclude ${entry}`);
  }
  const tracked = await readdir(root);
  assert.ok(!tracked.includes('.dev.vars'), 'no .dev.vars committed');
});

test('the app is reachable through the documented scripts', () => {
  assert.match(pkg.scripts.dev, /wrangler dev/, 'npm run dev starts the Workers preview');
  assert.match(pkg.scripts.test, /node --test/, 'tests run on the Node test runner without extra deps');
});

test('global atlas branding stays independent of the design reference', async () => {
  assert.match(html, /<title>Meridian Atlas/);
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.doesNotMatch(header, /Kartenzeit|Kanton|Zürich|coat.of.arms/i, 'the header identifies the atlas itself');
  const icon = await read('public/favicon.svg');
  assert.match(icon, /<title>Meridian Atlas<\/title>/);
  assert.doesNotMatch(icon, /Kartenzeit|Kanton|Zürich/);
  const headers = await read('public/_headers');
  assert.match(headers, /img-src[^;]+https:\/\/tile\.openstreetmap\.org/);
  assert.match(headers, /img-src[^;]+https:\/\/tile\.loc\.gov/);
  // A published provider's plain <img> thumbnails must not be blocked by our own
  // CSP. The Doria import shipped 1,662 thumbnail URLs while this origin was
  // missing; pin every direct-image provider that the catalogue actually uses.
  assert.match(headers, /img-src[^;]+https:\/\/www\.doria\.fi/);
  assert.match(headers, /img-src[^;]+https:\/\/digital\.slub-dresden\.de/);
});
