/**
 * Bootstrap for Kartenzeit. Loads the data, wires the optional UI modules and
 * degrades gracefully when one of them is missing (coordination D4).
 */

import { createBus, createStore } from './store.js';
import { el, qs, formatYearRange } from './dom.js';
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
      console.warn(`[kartenzeit] module "${name}" not available`, err);
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
    el('span', { class: 'zh-state__title', text: 'Eine Teilfunktion ist derzeit nicht verfügbar.' }),
    el('span', {
      text:
        `Betroffen: ${problems.map((p) => p.name).join(', ')}. ` +
        'Die übrigen Funktionen laufen weiter. Bitte die Seite neu laden; bleibt es dabei, ist ein Fehler im Client gemeldet.',
    }),
  );
}

function renderIntro() {
  const count = qs('#intro-count');
  if (count) count.textContent = String(ctx.data.records.length);

  // Facts strip: only statements the data actually supports.
  const facts = qs('#intro-facts');
  if (facts) {
    const providersInUse = new Set(ctx.data.records.map((r) => r.providerId));
    const withManifest = ctx.data.records.filter((r) => r.iiifManifest).length;
    const collections = new Set(ctx.data.records.map((r) => r.collection).filter(Boolean)).size;
    facts.replaceChildren(
      ...[
        ['Digitalisate', `${ctx.data.records.length}`],
        ['Zeitraum', `${ctx.data.years.min}–${ctx.data.years.max}`],
        ['Anbieter', `${providersInUse.size}`],
        ['IIIF-Bildservice', `${withManifest}`],
      ].flatMap(([term, value]) => [
        el('li', {}, [el('span', { class: 'zh-facts__value', text: value }), el('span', { class: 'zh-facts__term', text: term })]),
      ]),
    );
    // Honest, additive detail: only shown when it is not simply the total.
    const withExtent = ctx.data.records.filter((r) => r.extent).length;
    facts.title = `${collections} Sammlungen · ${withExtent} von ${ctx.data.records.length} Datensätzen mit Kartenausschnitt · ${ctx.data.overlays.length} georeferenzierte swisstopo-Kartenwerke`;
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
      el('li', {}, [el('span', { class: 'zh-tag zh-tag--turquoise', text: `${ctx.data.overlays.length} swisstopo-Kartenwerke` })]),
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
  const state = qs('#results-state');
  if (state && ctx.data.loadErrors.length > 0) {
    state.hidden = false;
    state.className = 'zh-state zh-state--error';
    state.textContent = `Datenprüfung: ${ctx.data.loadErrors.length} Feld(er) unvollständig – bitte Quellenregister prüfen.`;
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

async function main() {
  document.documentElement.dataset.app = 'kartenzeit';
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
    bus.emit('records:loaded', { records, sources: sources.providers, overlays: overlays.overlays });
  } catch (err) {
    console.error('[kartenzeit] data load failed', err);
    const state = qs('#results-state') || qs('#map-fallback');
    if (state) {
      state.hidden = false;
      state.className = 'zh-state zh-state--error';
      state.replaceChildren(
        el('span', { class: 'zh-state__title', text: 'Die Datensätze konnten nicht geladen werden.' }),
        el('span', { text: `Grund: ${err?.message || err}. Bitte die Seite neu laden; die Rohdaten liegen unter /data/records.json.` }),
      );
    }
    bus.emit('records:error', { error: err });
    return; // still initialise modules so the map/search part is usable
  }

  renderIntro();
  await initModules();
  reportModuleProblems();

  // Diagnostics for the console and for curious users of the API.
  console.info(
    `[kartenzeit] ${ctx.modules?.length ?? 0} Modul(e): ${(ctx.modules ?? []).join(', ')} · ` +
      `${ctx.data.records.length} Datensätze · ${ctx.data.overlays.length} Kartenwerke (${ctx.data.generatedAt ?? 'ohne Datum'})`,
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    main().catch((err) => console.error('[kartenzeit] startup failed', err));
  });
} else {
  main().catch((err) => console.error('[kartenzeit] startup failed', err));
}

export { bus, store, ctx, main };
