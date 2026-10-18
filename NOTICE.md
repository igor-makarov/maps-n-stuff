# Credits, licences and attribution — Kartenzeit

Kartenzeit is an independent demonstration project. It is **not** a website of
the Canton of Zürich or of any holding library. The canton's design system is
the *design reference*; no cantonal logo, coat of arms or other protected
asset is used.

| Component | Where | Rights |
| --- | --- | --- |
| Application source (`public/app/**`, `public/styles/**`, `src/**`, `scripts/**`, `tests/**`) | this repository | MIT — see [LICENSE](LICENSE) |
| Typeface **Inter** (Regular, Black woff2) | `public/fonts/` | SIL Open Font License 1.1 — [LICENSE-Inter-OFL.txt](public/fonts/LICENSE-Inter-OFL.txt), deliberately shipped with the files |
| Design tokens and component geometry derived from the **Kanton Zürich frontend design system** | `public/styles/zh-tokens.css`, `docs/design-system.md` | Upstream repository is Apache-2.0 (<https://github.com/Kanton-Zurich/frontend-designsystem>). No upstream code, SCSS or asset is redistributed here; documented values (colours, sizes, breakpoints) are re-expressed as our own `--zh-*` custom properties and credited. |
| **Leaflet 1.9.4** (vendored, *currently unused* — the map is our own implementation in `public/app/map.js`) | `public/vendor/leaflet/` | BSD-2-Clause, © 2010–2023 Volodymyr Agafonkin, © 2010–2011 CloudMade. Kept for reference; remove together with the directory if it stays unused. |
| **swisstopo** geodata (base map, Zeitreise/Siegfried/Dufour/ SWISSIMAGE historical layers, place search) | fetched at runtime from `wmts.geo.admin.ch`, `api3.geo.admin.ch` | Free reuse under the Swiss OGD terms; attribution “© swisstopo” is rendered in the map corner and repeated in the detail panel and footer. No tile imagery is redistributed in this repository. |
| **e-rara.ch** digitised maps and metadata | `public/data/records.json` (metadata + links), images fetched at runtime from `www.e-rara.ch` | Per-record rights (mostly Public Domain Mark 1.0) are copied verbatim into each record and shown in the result list, the detail panel and the comparison view; metadata is CC0 upstream. Holding libraries are named per record (Zentralbibliothek Zürich, ETH-Bibliothek Zürich, Bibliothèque de Genève). No digitised imagery is redistributed in this repository. |

Source-by-source evidence (primary record URLs, identifiers, endpoints, CORS
behaviour, retrieval dates, publication vs. depicted dates) is in
[docs/data-sources.md](docs/data-sources.md); the registry itself is served at
`/data/sources.json`.

## Attribution in the product

- Map corner: `© swisstopo` (per active base/historical layer, including the
  comparison layer's own edition and attribution).
- Result list / detail panel / comparison panes: holding institution, rights
  statement and a link to the original collection record.
- Footer: data providers, font licence and the “independent project” note.

If you deploy this application, keep those attributions visible: they are part
of the upstream terms of use, not decoration.
