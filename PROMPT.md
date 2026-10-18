# Build an OldMapsOnline experience with Canton Zürich design

Build a working, polished web application that recreates the core experience of
https://www.oldmapsonline.org/ using the official **Canton Zürich (Kanton Zürich)**
design style guide. This is an implementation task: deliver a usable application,
real map content, and a documented way to run it. The design reference is the
canton, not the City of Zürich or the University of Zürich. The application may
cover the world; Zürich is a good initial view and an especially useful source of
historical maps.

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
PR or an isolated task branch. Shurik still maintains a separate task/checkpoint
branch for each member; preserve that lifecycle and its control state while
integrating the actual product on `main`. Choose a way to handle concurrent Git
work together. Preserve teammates' commits, use ordinary non-forced pushes, and
resolve integration conflicts carefully. Do not rewrite `main` history or weaken
branch protections. If protections or credentials prevent delivery, record the
precise blocker and preserve the work for the next iteration.

## Research the experience and use original sources

Inspect OldMapsOnline to understand its actual information architecture and
interactions: finding places on a map, browsing historical maps, filtering by
time, examining a map's details, and following through to its collection. Use a
browser and screenshots when available. Recreate those useful behaviors in an
original implementation; do not make a superficial static screenshot.

**Go to the original sources instead of just scraping OldMapsOnline.** Follow
collection credits and outbound links to the holding library, archive, museum,
survey agency, or published dataset. Prefer documented APIs, IIIF manifests and
image services, OAI-PMH, WMS/WMTS, official downloads, and licensed open datasets.
Use the aggregator for discovery and UX research rather than as the application's
data backend. Do not depend on undocumented private aggregator endpoints.

Useful starting points to investigate and verify:

- ZB Zürich's map collections:
  https://www.zb.uzh.ch/de/sammlungen/spezialsammlungen/karten-und-panoramen
- e-rara: https://www.e-rara.ch/ and ZB's interface catalogue:
  https://data.zb.uzh.ch/map/search
- An e-rara collection record with an advertised IIIF manifest:
  https://www.e-rara.ch/zuz/content/titleinfo/22142031
  and https://www.e-rara.ch/i3f/v20/22142031/manifest
- swisstopo's official geoservices:
  https://www.swisstopo.admin.ch/en/geoservices-with-swisstopo-geodata
  and https://www.swisstopo.admin.ch/en/digital-maps
- The Swiss federal map viewer and its linked service documentation:
  https://map.geo.admin.ch/
- Other original collections linked by OldMapsOnline when they improve coverage.

Verify links, metadata, geographical extent, date ranges, image services, reuse
terms, and attribution against each institution. Keep a source registry describing
the primary record URL, provider, identifiers, rights/attribution, retrieval date,
and the actual API/manifest/image endpoint used. Distinguish publication dates
from dates depicted. Do not invent map metadata or coordinates. Use caching,
bounded fetching, and polite requests. Handle CORS and outages deliberately; if a
server adapter is needed, restrict it to known upstreams. Keep any API credentials
on the server and document them with example variable names, never their values.

## Apply the actual Canton Zürich design system

Read the official guidance and its linked implementation resources:

- Design system:
  https://www.zh.ch/de/webangebote-entwickeln-und-gestalten.html
- Resources and links to official frontend code:
  https://www.zh.ch/de/webangebote-entwickeln-und-gestalten/inhalt/designsystem/community/ressourcen.html
- Official frontend repository:
  https://github.com/Kanton-Zurich/frontend-designsystem
- Corporate design:
  https://www.zh.ch/de/politik-staat/kanton/kantonale-verwaltung/corporatedesign.html

Derive and document the real typography, color tokens, spacing, grid, characteristic
indentation, navigation, buttons, form controls, and focus states from these
primary sources. A generic blue-and-white theme is insufficient. Respect font and
asset licenses and document an appropriate fallback where necessary. Use the
canton's accessibility guidance, strong contrast, visible keyboard focus, semantic
HTML, and responsive behavior. Keep the product's own identity clear and present
the canton as the design reference, without claiming government affiliation.

## Product expectations

Choose a practical maintainable stack together. Prioritize a complete vertical
slice early, then expand and polish it:

- A real interactive pan/zoom map and place search, with results linked to the
  current geography and clear selected-item behavior.
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

Run the appropriate build, type/lint checks, and meaningful tests for the product.
Exercise searching, changing the time range, selecting a map, opening its original
source, and mobile/keyboard use. Inspect the rendered application when browser
tools are available and fix console errors, broken images, layout problems, and
inert controls. Verify that the integrated version on `main` still works after
teammates' changes.

Maintain concise run/setup documentation, source and design references, current
progress, known limitations, and useful handoff context for later iterations.
Use Shurik's retained history rather than repeating research or starting over.
Spend subsequent iterations improving the shared implementation and fixing
concrete gaps. Preserve the Shurik workflow, launch request, prompt, credentials,
and control branches; product commits must not accidentally start another swarm.
