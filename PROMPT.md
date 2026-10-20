> Current sourcing run: follow [SOURCING_PROMPT.md](SOURCING_PROMPT.md) and the latest
> [SOURCING_STEERING.md](SOURCING_STEERING.md). The older product brief below is
> historical context; its four-agent count and completed UI/border work are superseded.

# Build a global historical atlas in English

**Priority correction from the user, 2026-10-19:** the current German, Zürich-first
site is the wrong product direction. Build a global English-language historical
atlas comparable in experience to https://www.oldmapsonline.org/en, including
its **History / TimeMap-style map of changing historical borders**. The Canton
Zürich design system is a visual reference for typography, spacing, hierarchy,
and restrained interaction styling. It is not the product's identity, language,
geographic scope, logo, or default destination.

This correction supersedes older coordination decisions, German UI expectations,
Swiss-only defaults, and tests that encode that interpretation. Preserve useful
existing functionality, but prioritize correcting the actual product over adding
more polish to the previous direction. Deliver a usable **Cloudflare Workers**
application, with these three required outcomes:

1. **Global and English:** English interface throughout, a worldwide initial map,
   global basemap and place search, and archival content spanning continents.
2. **Original identity:** choose a coherent English product name and original
   atlas-themed logo together. Remove the current canton-like shield/diagonal
   blue-and-white flag mark from the header and favicon. Do not use or approximate
   the canton coat of arms, lion, flag, government logo, or official branding.
3. **Historical borders:** a prominent, working world-history map with a year
   selector/timeline that changes actual territorial polygons and labels over time.
   The existing scan browser, IIIF viewer, and map-sheet footprints do not satisfy
   this requirement. This feature is required, not an optional later enhancement.

## Four agents, one shared result

You are one of four Shurik swarm members, all running
`opencode-go/deepseek-v4.1-flash` with `max` reasoning. Coordinate with the other
members to build one coherent application. **Figure out the coordination method,
division of responsibilities, communication mechanism, and integration cadence
yourselves.** Use your supplied swarm identity to distinguish members. Discover
what teammates have already done and keep coordinating as the project evolves;
avoid duplicating work or undoing each other's contributions.

**Commit and push completed, validated changes directly to `main`.** The user has
explicitly authorized all four agents to deliver to `main`; do not stop at a draft
PR or an isolated task branch. **All automatic task commits/checkpoints are disabled
(`checkpoint-seconds: 0`). You are responsible for all product commits and pushes.**
Save meaningful progress frequently. Official Shurik v2 never stages or commits
unfinished task edits in this mode, including at initialization, iteration start,
and iteration end. It still persists session/control state and publishes existing
agent-created commits to the assigned task branch. Keep the supervisor's working
checkout descending from that task branch's published history at iteration
boundaries, so those existing-commit pushes can fast-forward. Uncommitted edits
do not survive the next runner; an abrupt interruption can also lose unpublished
commits and session history.
The workflow uses the official `igor-makarov/shurik@v2` lifecycle.
Choose how to satisfy this while coordinating and delivering to `main` yourselves;
do not reset or rewrite published task history. Preserve Shurik's lifecycle and
control branches. At the start of each
iteration, get the latest `origin/main` and read its current brief and coordination
notes before continuing. Choose a way to handle concurrent Git
work together. Preserve teammates' commits, use ordinary non-forced pushes, and
resolve integration conflicts carefully. Do not rewrite `main` history or weaken
branch protections. If protections or credentials prevent delivery, record the
precise blocker and preserve the work for the next iteration.

## Research the experience and use original sources

Inspect both the original's **Maps** and **History** experiences, including
https://www.oldmapsonline.org/en/history and its linked TimeMap view. Understand
how the world map, selected year, changing political territories, region labels,
place search, archival maps, details, and original collection links fit together.
Use a browser and screenshots when available. Recreate useful behavior in an
original implementation; the archive-map browser alone is incomplete.

**Go to the original sources instead of just scraping OldMapsOnline.** Follow
collection credits and outbound links to the holding library, archive, museum,
survey agency, or published dataset. Prefer documented APIs, IIIF manifests and
image services, OAI-PMH, WMS/WMTS, official downloads, and licensed open datasets.
Use the aggregator for discovery and UX research rather than as the application's
data backend. Do not depend on undocumented private aggregator endpoints.

Original archival sources to investigate include the Library of Congress
(https://www.loc.gov/maps/), BnF Gallica (https://gallica.bnf.fr/), the National
Library of Scotland (https://maps.nls.uk/), the David Rumsey Map Collection
(https://www.davidrumsey.com/), and the global material already available through
e-rara (https://www.e-rara.ch/). Follow their documented APIs, IIIF services,
collection records, and reuse terms. Existing e-rara and swisstopo material can
remain as part of the collection, but Swiss institutions must not define the
product's geographic coverage or search capability.

Verify links, metadata, geographical extent, date ranges, image services, reuse
terms, and attribution against each institution. Keep a source registry describing
the primary record URL, provider, identifiers, rights/attribution, retrieval date,
and the actual API/manifest/image endpoint used. Distinguish publication dates
from dates depicted. Do not invent map metadata or coordinates. Use caching,
bounded fetching, and polite requests. Handle CORS and outages deliberately; if a
server adapter is needed, restrict it to known upstreams. Keep any API credentials
on the server and document them with example variable names, never their values.

## Deliver the missing historical-borders map

Research the original data publishers, not scraped TimeMap tiles or undocumented
private aggregator endpoints. Candidate primary sources to evaluate directly:

- André Ourednik's historical world boundaries:
  https://github.com/aourednik/historical-basemaps . The repository publishes a
  year/snapshot index, GeoJSON polygons, names, and border-precision metadata.
  Read its license, credits, methodology, and coverage before integrating it.
- CShapes, published by ETH International Conflict Research:
  https://icr.ethz.ch/data/cshapes/ . It provides dated country/territory boundaries
  for a defined modern period; verify its coverage and noncommercial/share-alike
  terms rather than assuming it covers antiquity or has unrestricted reuse.
- OpenHistoricalMap: https://www.openhistoricalmap.org/ . Follow its original
  data/API documentation, temporal tags, attribution, and coverage information.

Select suitable, reusable sources yourselves and build a reproducible pipeline
that records provenance, upstream revision, license/credit, available dates,
precision, and any simplification. Bundle or serve usable data with the Workers
app; do not leave a research note or a link in place of a functioning feature.

The history map must:

- Work at world/continent scale, with discoverable History/Borders navigation,
  a global initial view, a labeled year control, and temporal territorial polygons
  that actually change when the year changes. Include polity/region labels and
  clickable details with source information where the dataset supports them.
  Integrate the chosen source's full usable year/snapshot index, not just a few
  hard-coded demonstration years or polygons.
- Handle historical snapshots versus continuous validity ranges honestly. If a
  selected date uses a nearby snapshot, visibly identify the represented date;
  do not fabricate intermediate borders or pretend modern borders are historical.
- Support early as well as modern periods when supported by the selected sources,
  with correct BCE/CE controls where applicable. Cover multiple continents,
  show the actual available range and gaps, and distinguish approximate or
  disputed boundaries using the source's information. Do not claim complete
  worldwide coverage for every year when the data does not provide it.
- Keep historical borders distinct from raster scans, modern basemap borders,
  and archival map-sheet extents. An old map image with modern country outlines
  underneath is not the missing historical-borders feature.
- Share the selected mode/year/view in the URL, work on mobile and with keyboard
  input, preserve map usability, and provide informative loading/error states.

## Use Zürich as a restrained design reference

Read the official guidance and its linked implementation resources:

- Design system:
  https://www.zh.ch/de/webangebote-entwickeln-und-gestalten.html
- Resources and links to official frontend code:
  https://www.zh.ch/de/webangebote-entwickeln-und-gestalten/inhalt/designsystem/community/ressourcen.html
- Official frontend repository:
  https://github.com/Kanton-Zurich/frontend-designsystem
- Corporate design:
  https://www.zh.ch/de/politik-staat/kanton/kantonale-verwaltung/corporatedesign.html

Use the reference's clear typography, spacing, grid, alignment, readable forms,
restrained colors, and accessible interaction states to inform an original atlas.
Do not reproduce a government website or its heraldry. Respect font and asset
licenses, keep strong contrast and visible focus, and use semantic responsive
HTML. Move any design-source credit into a concise About/credits area; the header
and primary experience should present the atlas, not a canton-government design
disclaimer. Internal CSS names and existing deployment identifiers can remain.

## Product expectations

Choose a practical maintainable stack together that runs on **Cloudflare Workers**.
Use Workers static assets for the frontend and Workers-compatible request
handlers for any server adapters; consult the official documentation at
https://developers.cloudflare.com/workers/static-assets/ . Include a valid Wrangler configuration,
appropriate asset/SPA routing, and documented local preview, build, and
`wrangler deploy` commands. Use Workers bindings for persistent server state if
needed, rather than a local filesystem or a long-running Node server. Keep
Cloudflare credentials and other secrets out of the repository. This swarm is not
configured with Cloudflare deployment credentials. **Cloudflare will handle the
production build and deployment from `main`.** Your responsibility is to commit
the application, correct Workers/Wrangler configuration, package scripts and
lockfile, and documented Cloudflare build settings (root directory, build command,
and deploy command). Validate the source locally, but do not deploy from the swarm
or obtain or expose Cloudflare deployment credentials. Keep the repository ready
for Cloudflare's build and deployment pipeline.

Prioritize the three correction outcomes above, preserving and adapting useful
work already delivered. In addition to the required historical-borders view:

- A real global interactive pan/zoom basemap and **worldwide place search**.
  The existing swisstopo-only SearchServer and Swiss tile defaults are insufficient.
  Test cities outside Switzerland and Europe, including Cairo, Tokyo, Mexico City,
  and São Paulo. Use documented services with attribution, appropriate caching,
  and working behavior outside the Swiss tile extent.
- **English UI end to end:** page language, English product name, navigation,
  placeholders, buttons, labels, filters, dates/numbers, tooltips, accessibility
  text, errors, loading/empty states, viewer controls, and social metadata. Keep
  archival titles and source quotations in their original languages where needed;
  those are metadata, not a reason to leave the app's interface in German.
- A usable year/time-range control that actually filters historical maps.
- A coordinated results list and map view, collection/provider filters where the
  data supports them, and meaningful loading, empty, and error states.
- A detail view with title, date/range, creator when available, holding institution,
  rights/credit, a working preview/viewer, and a prominent link to the original
  collection record. Prefer IIIF or georeferenced overlays when supported.
- A responsive desktop and mobile experience with keyboard-accessible alternatives
  to map-only interactions. Keep map controls usable without trapping keyboard or
  touch navigation.
- Shareable URL state for useful searches/selections. Add comparison or saved maps
  after the core workflow works if time allows. Expose only functioning controls.
- Real records and imagery from verified sources. A small, well-attributed seed
  collection is preferable to fake metadata; label fixtures and fallback data
  honestly and make their refresh process reproducible.

## Validation and continued progress

Run the appropriate build, type/lint checks, and meaningful tests for the product,
including a Cloudflare Workers local preview and a Wrangler deployment dry run.
Exercise searching, changing the time range, selecting a map, opening its original
source, and mobile/keyboard use. Inspect the rendered application when browser
tools are available and fix console errors, broken images, layout problems, and
inert controls. Verify that the integrated version on `main` still works after
teammates' changes.

Add meaningful regression coverage for English chrome, the original logo/favicon,
global initial extent, worldwide search, worldwide basemap coverage, and historical
border changes at several verified dates across multiple continents. Demonstrate
a real change in visible territorial features/geometry, not just a year label.
Check one early date and one modern date when the chosen dataset supports them,
and test unsupported dates honestly. Update old German/Swiss-first test expectations
to the corrected product scope while preserving behavioral coverage. Screenshots
of the landing view and History view should make this correction obvious.

Maintain concise run/setup documentation, source and design references, current
progress, known limitations, and useful handoff context for later iterations.
Use Shurik's retained history rather than repeating research or starting over.
Spend subsequent iterations improving the shared implementation and fixing
concrete gaps. Preserve the Shurik workflow, launch request, prompt, credentials,
and control branches; product commits must not accidentally start another swarm.
