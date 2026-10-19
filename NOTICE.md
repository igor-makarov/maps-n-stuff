# Credits, licences and attribution — Meridian Atlas

Meridian Atlas is an independent historical atlas. It is **not** a website of
the Canton of Zürich or of any holding library. The canton's design system is
the *design reference*; no cantonal logo, coat of arms or other protected
asset is used.

| Component | Where | Rights |
| --- | --- | --- |
| Application source (`public/app/**`, `public/styles/**`, `src/**`, `scripts/**`, `tests/**`) | this repository | MIT — see [LICENSE](LICENSE) |
| Typeface **Inter** (Regular, Black woff2) | `public/fonts/` | SIL Open Font License 1.1 — [LICENSE-Inter-OFL.txt](public/fonts/LICENSE-Inter-OFL.txt), deliberately shipped with the files |
| Design tokens and component geometry derived from the **Kanton Zürich frontend design system** | `public/styles/zh-tokens.css`, `docs/design-system.md` | Upstream repository is Apache-2.0 (<https://github.com/Kanton-Zurich/frontend-designsystem>). No upstream code, SCSS or asset is redistributed here; documented values (colours, sizes, breakpoints) are re-expressed as our own `--zh-*` custom properties and credited. |
| **OpenStreetMap** basemap and worldwide place search | `tile.openstreetmap.org`, `nominatim.openstreetmap.org` | © OpenStreetMap contributors, ODbL; attribution is shown on the map and in the sources panel. |
| **Library of Congress** international map selection | `data/international-maps.json`, catalogue records and runtime IIIF images | Per-record rights and holding collection are stated in the detail view. Source titles, dates and identifiers are transcribed from primary catalogue metadata. Images are linked, not redistributed. |
| **swisstopo** geodata (base map, Zeitreise/Siegfried/Dufour/ SWISSIMAGE historical layers, place search) | fetched at runtime from `wmts.geo.admin.ch`, `api3.geo.admin.ch` | Free reuse under the Swiss OGD terms; attribution “© swisstopo” is rendered in the map corner and repeated in the detail panel and footer. No tile imagery is redistributed in this repository. |
| **historical-basemaps** world-boundary dataset (History view) | `public/data/history/**` (a simplified derivative, bundled), `scripts/harvest-history.mjs`, `public/app/history.js` | Upstream <https://github.com/aourednik/historical-basemaps> at pinned commit `da7a4b735ecef70aebdc9c73e409d8a2500d50f3` is **GPL-3.0-or-later**. The bundled derivative is redistributed under the same licence; the upstream licence text ships as `public/data/history/LICENSE-GPL-3.0.txt` and the revision + simplification are recorded in `public/data/history/index.json`. The application source stays MIT; the bundled *data* is GPL. Attribution “© André Ourednik and contributors” and the licence are rendered in the History view. |
| **e-rara.ch** digitised maps and metadata | `public/data/records.json` (metadata + links), images fetched at runtime from `www.e-rara.ch` | Per-record rights (mostly Public Domain Mark 1.0) are copied verbatim into each record and shown in the result list, the detail panel and the comparison view; metadata is CC0 upstream. Holding libraries are named per record — in the current seed **Zentralbibliothek Zürich**, **ETH-Bibliothek Zürich**, **Universitätsbibliothek Bern** and **Bibliothèque de Genève**; the registry's `institutions` list is derived from the harvested records (`/data/sources.json`), and the detail panel prints the shelfmark as the holding library states it. No digitised imagery is redistributed in this repository. |

Source-by-source evidence (primary record URLs, identifiers, endpoints, CORS
behaviour, retrieval dates, publication vs. depicted dates) is in
[docs/data-sources.md](docs/data-sources.md); the registry itself is served at
`/data/sources.json`.

## Attribution in the product

- Map corner: `© OpenStreetMap contributors` for the worldwide basemap; `© swisstopo` for Swiss layers (including the
  comparison layer's own edition and attribution).
- Result list / detail panel / comparison panes: holding institution, rights
  statement and a link to the original collection record.
- Footer: data providers, font licence and the “independent project” note.

If you deploy this application, keep those attributions visible: they are part
of the upstream terms of use, not decoration.
