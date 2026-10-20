/**
 * Bootstrap for Meridian Atlas. Loads the data, wires the optional UI modules and
 * degrades gracefully when one of them is missing (coordination D4).
 */

import { createBus, createStore } from './store.js';
import { el, qs, formatYearRange, setStatus, copyText } from './dom.js';
import { loadOverlays, loadRecords, loadSources, yearBounds } from './records.js';

const bus = createBus();
const store = createStore();

const ctx = {
  store,
  bus,
  dom: { el, qs },
  data: {
    records: [],
    sources: [],
    overlays: [],
    recordIndex: new Map(),
    years: { min: 1500, max: 1900 },
    loadErrors: [],
  },
  moduleErrors: [],
};

const optionalModules = [
  ['map', './map.js'],
  ['search', './search.js'],
  ['results', './results.js'],
  ['detail', './detail.js'],
  ['compare', './compare.js'],
  ['history', './history.js'],
  ['georeference', './georeference.js'],
  ['collections', './collections.js'],
];

async function initModules() {
  const loaded = [];
  ctx.moduleApis = {};
  for (const [name, specifier] of optionalModules) {
    try {
      const module = await import(specifier);
      if (typeof module.init === 'function') {
        // Modules may return a small API (used by the browser checks); the shell
        // only stores it, it never reaches into another module's internals.
        ctx.moduleApis[name] = await module.init(ctx);
        loaded.push(name);
      }
    } catch (err) {
      // A missing/failing module must not stop the rest of the app — but it must
      // not be invisible either: report it in the UI (see reportModuleProblems).
      console.warn(`[meridian-atlas] module "${name}" not available`, err);
      ctx.moduleErrors.push({ name, message: err?.message || String(err) });
    }
  }
  ctx.modules = loaded;
  bus.emit('app:ready', ctx);
}

/**
 * A failing optional module leaves a visible, honest notice instead of a
 * silently dead control (a broken search.js once threw during import and the
 * module simply disappeared). `document.documentElement.dataset.moduleErrors`
 * exposes the same fact to tests and monitoring.
 */
function reportModuleProblems() {
  const problems = ctx.moduleErrors ?? [];
  document.documentElement.dataset.moduleErrors = problems.map((p) => p.name).join(',');
  if (problems.length === 0) return;
  const host = qs('#app-notices');
  if (!host) return;
  host.hidden = false;
  host.className = 'zh-state zh-state--error';
  host.replaceChildren(
    el('span', { class: 'zh-state__title', text: 'One feature is temporarily unavailable.' }),
    el('span', {
      text:
        `Affected: ${problems.map((p) => p.name).join(', ')}. ` +
        'Other features remain available. Reload the page to try again.',
    }),
  );
}

/**
 * “Suchlink kopieren”: the whole filter/selection state is already in the URL
 * (see store.js), so sharing a search only needs a way to copy it — useful on a
 * phone, where selecting the address bar by hand is painful.
 */
function wirePermalinkCopy() {
  const button = qs('#permalink-copy');
  const status = qs('#permalink-status');
  if (!button) return;
  button.addEventListener('click', async () => {
    const ok = await copyText(window.location.href);
    setStatus(
      status,
      ok
        ? 'View link copied, including filters, map position and selection.'
        : 'Could not copy. Copy the address from your browser to share this view.',
      ok ? 'success' : 'warn',
    );
  });
}

function renderIntro() {
  // The count appears in the lead paragraph and again in “Über das Projekt”,
  // where the full wording stands (the lead is clamped on small screens).
  const count = String(ctx.data.records.length);
  for (const node of document.querySelectorAll('#intro-count, [data-record-count]')) {
    node.textContent = count;
  }

  // Facts strip: only statements the data actually supports. Two hosts exist:
  // the hero band (hidden below 600 px) and the “Über das Projekt” card, which
  // takes the figures over on phones so the map stays within reach.
  const factsItems = (() => {
    const providersInUse = new Set(ctx.data.records.map((r) => r.providerId));
    const withManifest = ctx.data.records.filter((r) => r.iiifManifest).length;
    return [
      ['Archive maps', `${ctx.data.records.length}`],
      ['Period', `${ctx.data.years.min}–${ctx.data.years.max}`],
      ['Providers', `${providersInUse.size}`],
      ['IIIF previews', `${withManifest}`],
    ].map(([term, value]) =>
      el('li', {}, [el('span', { class: 'zh-facts__value', text: value }), el('span', { class: 'zh-facts__term', text: term })]),
    );
  })();
  const collections = new Set(ctx.data.records.map((r) => r.collection).filter(Boolean)).size;
  const withExtent = ctx.data.records.filter((r) => r.extent).length;
  const factsTitle = `${collections} collections · ${withExtent} of ${ctx.data.records.length} records with documented extents · ${ctx.data.overlays.length} aligned map layers`;
  for (const facts of document.querySelectorAll('#intro-facts, #about-facts')) {
    facts.replaceChildren(...factsItems.map((item) => item.cloneNode(true)));
    // The compact strip on a phone carries the same honest detail as a title.
    facts.title = factsTitle;
  }

  const tagList = qs('#intro-tags');
  if (tagList) {
    const providersInUse = new Set(ctx.data.records.map((r) => r.providerId));
    tagList.replaceChildren(
      ...ctx.data.sources
        .filter((source) => providersInUse.has(source.id))
        .map((source) =>
          el('li', {}, [el('span', { class: 'zh-tag zh-tag--blue', text: source.name?.split('–')[0]?.trim() || source.id })]),
        ),
      el('li', {}, [el('span', { class: 'zh-tag zh-tag--turquoise', text: `${ctx.data.overlays.length} aligned map layers` })]),
    );
  }
  const sourceList = qs('#source-list');
  if (sourceList) {
    const entries = [];
    for (const source of ctx.data.sources) {
      entries.push(el('dt', { text: source.name || source.id }));
      entries.push(
        el('dd', {}, [
          source.attribution ? el('span', { text: `${source.attribution}. ` }) : null,
          source.rights ? el('span', { text: `${source.rights} ` }) : null,
          source.homepage ? el('a', { href: source.homepage, rel: 'noopener', text: source.homepage.replace(/^https?:\/\//, '') }) : null,
          source.api?.oai ? el('div', { html: `<small>OAI-PMH: <code>${source.api.oai.split(' ')[0]}</code></small>` }) : null,
        ]),
      );
    }
    sourceList.replaceChildren(...entries);
  }
  // Honest provenance: the page says when the seed was last harvested. The
  // timestamp comes from records.json, not from the visitor's clock.
  const stand = qs('#data-stand');
  if (stand && ctx.data.generatedAt) {
    const [year, month, day] = String(ctx.data.generatedAt).slice(0, 10).split('-');
    if (year && month && day) {
      stand.textContent = `Catalogue updated: ${year}-${month}-${day}. See Sources for provenance and rights.`;
      stand.hidden = false;
    }
  }
  const state = qs('#results-state');
  if (state && ctx.data.loadErrors.length > 0) {
    state.hidden = false;
    state.className = 'zh-state zh-state--error';
    state.textContent = `Data check: ${ctx.data.loadErrors.length} incomplete fields. See Sources for details.`;
  }
}

/** View switch (shell-owned): list only, map only or both. */
function initViewSwitch() {
  const buttons = [...document.querySelectorAll('[data-view]')];
  if (buttons.length === 0) return;

  const apply = (view) => {
    document.body.classList.remove('app-view--split', 'app-view--list', 'app-view--map');
    document.body.classList.add(`app-view--${view}`);
    for (const button of buttons) button.setAttribute('aria-pressed', String(button.dataset.view === view));
  };

  for (const button of buttons) {
    button.addEventListener('click', () => ctx.store.update({ view: button.dataset.view }));
  }
  ctx.store.subscribe((next, changed) => {
    if (changed.includes('view')) apply(next.view);
  });
  apply(ctx.store.getState().view);
}

/**
 * “Nach oben” (cantonal `mdl-back2top`): the button only exists once the page is
 * scrolled, and it moves focus to the content start after scrolling, so a
 * keyboard user is not stranded on a control that has just been hidden.
 */
function wireBackToTop() {
  const button = qs('#back-to-top');
  if (!button) return;
  const visible = () => window.scrollY >= Math.max(600, window.innerHeight * 1.5);
  const sync = () => {
    button.hidden = !visible();
  };
  window.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync, { passive: true });
  button.addEventListener('click', () => {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    const main = qs('#main');
    if (main && typeof main.focus === 'function') main.focus({ preventScroll: true });
    sync();
  });
  sync();
}

/**
 * The results area starts with a visible loading state (see index.html): the
 * seed is one JSON file, and on a slow connection the difference between “the
 * app is working” and a blank panel. Both paths below end it — the data, or the
 * failure — so the page never keeps claiming to load.
 */
function finishLoading() {
  const loading = qs('#results-loading');
  if (loading) loading.hidden = true;
  const list = qs('#result-list');
  if (list) list.setAttribute('aria-busy', 'false');
}

async function main() {
  document.documentElement.dataset.app = 'meridian-atlas';
  initViewSwitch();

  // Data first: every module can rely on ctx.data being populated.
  try {
    const [{ records, errors, generatedAt }, sources, overlays] = await Promise.all([loadRecords(), loadSources(), loadOverlays()]);
    ctx.data.records = records;
    ctx.data.sources = sources.providers;
    ctx.data.overlays = overlays.overlays;
    ctx.data.recordIndex = new Map(records.map((r) => [r.id, r]));
    ctx.data.years = yearBounds(records);
    ctx.data.generatedAt = generatedAt;
    ctx.data.loadErrors = errors;
    finishLoading();
    bus.emit('records:loaded', { records, sources: sources.providers, overlays: overlays.overlays });
  } catch (err) {
    // The raw message (a browser string like “Failed to fetch”) stays in the
    // console and in the title attribute; the visible text is plain English.
    console.error('[meridian-atlas] data load failed', err);
    finishLoading();
    const count = qs('#result-count');
    if (count) count.textContent = 'Catalogue unavailable';
    const state = qs('#app-notices');
    if (state) {
      state.hidden = false;
      state.className = 'zh-state zh-state--error';
      state.title = String(err?.message || err);
      state.replaceChildren(
        el('span', { class: 'zh-state__title', text: 'The map catalogue could not be loaded.' }),
        el('span', { text: 'Map navigation and historical borders remain available. Reload the page to retry the catalogue.' }),
      );
    }
    bus.emit('records:error', { error: err });
  }

  renderIntro();
  bus.on('records:loaded', renderIntro);
  wirePermalinkCopy();
  wireBackToTop();
  await initModules();
  reportModuleProblems();

  // Diagnostics for the console and for curious users of the API.
  console.info(
    `[meridian-atlas] ${ctx.modules?.length ?? 0} modules: ${(ctx.modules ?? []).join(', ')} · ` +
      `${ctx.data.records.length} records · ${ctx.data.overlays.length} overlays (${ctx.data.generatedAt ?? 'undated'})`,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((err) => console.error('[meridian-atlas] startup failed', err));
  });
} else {
  main().catch((err) => console.error('[meridian-atlas] startup failed', err));
}

export { bus, store, ctx, main };
