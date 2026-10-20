# Withheld bundled scopes — metadata-reuse decision (2026-10-20)

These scopes were harvested and verified for **image** rights, but they do not
have a primary metadata-reuse licence or another substantiated basis for bulk
redistribution of their catalogue records. The final-hour steering (12:00 UTC,
2026-10-20) requires an unresolved scope to be withheld from the shipped reusable
catalogue rather than left publicly served as “pending”. This directory keeps
the full harvested records and evidence outside `public/`, so Cloudflare does not
serve them. Nothing here is loaded by the site.

| Scope | Records | Image rights retained per record | Why withheld |
| --- | ---: | --- | --- |
| Doria / National Library of Finland (`doria.json`) | 1,662 | 1,269 PDM 1.0, 365 CC0, 28 explicit plain public-domain statements | `https://www.doria.fi/page/terms` returns HTTP 200 with an empty static body; `/page/about` is an unfilled template. The OAI-PMH endpoint is documented and readable, but no repository-wide metadata licence or redistribution grant was found. `sources.json` previously recorded this as `unresolved-pending`. |
| Leventhal Map & Education Center / Boston Public Library (`leventhal.json`) | 10,242 | 10,231 per-item “No known copyright restrictions / no known restrictions on use”, 11 CC BY 4.0 with credit | `https://www.digitalcommonwealth.org/copyright` states it “places no restrictions on public domain material” but does not grant a metadata licence; `https://www.digitalcommonwealth.org/api` documents machine access only. The per-item statements are image/item rights, not a bulk metadata grant. |
| Digital Commonwealth partner-held scope (`digitalcommonwealth.json`) | 972 | 823 no-known-restrictions, 136 CC0, 13 NoC-US | Same Digital Commonwealth service and terms as the BPL scope. Seven named holding institutions do not each grant a metadata licence through this aggregation. |

The full records remain in this directory exactly as harvested, including their
verbatim rights statements, licence URIs, original record URLs and retrieval
dates. The provider entries moved here in `sources-withheld.json` keep the
endpoints actually used and the evidence URLs.

The primary-policy quotes gathered in the 12:10–12:16 UTC re-check, the reasons
they are not a redistribution licence, and the restoration criteria are in
`coordination/metadata-rights-decision-20261020.md`. They confirm the decision
below; they do not clear any scope.

## Minimal ids and primary evidence links

- Doria: `doria:84494` — <https://www.doria.fi/handle/10024/84494> — image
  “Public domain ; PDM 1.0 ; CC0”; `doria:123025` — “Les royaumes de Suede…”.
  Evidence probed 2026-10-20: `https://www.doria.fi/oai/request?verb=Identify`
  (HTTP 200 XML, repository name Doria), `https://www.doria.fi/page/terms`
  (HTTP 200, empty body).
- Leventhal/BPL: `leventhal:commonwealth:3f462s124` —
  <https://collections.leventhalmap.org/search/commonwealth:3f462s124>;
  CC BY example `leventhal:commonwealth:pn89hd845` (CC BY 4.0, credited).
  Evidence: <https://www.digitalcommonwealth.org/copyright> and
  <https://www.digitalcommonwealth.org/api>.
- Digital Commonwealth partners: `digitalcommonwealth:commonwealth:z890vr23m`
  — <https://collections.leventhalmap.org/search/commonwealth:z890vr23m>.
  Same two Digital Commonwealth policy pages.

## Restoring a scope

A future iteration may restore a scope only after it records an applicable
primary metadata-reuse permission (URL, scope, date retrieved) or another
substantiated redistribution basis in `public/data/sources.json`, moves the
shard back into `public/data/records/`, adds it to `records.json.shards`, and
re-enables the browser/endpoint verification. Withholding does not change the
image-rights determinations and does not release any image for a new use.

The launch baseline (Stanford, e-rara, swisstopo, LoC) is untouched. SLUB is
kept because its primary digital-collections terms explicitly license the
digital objects under PDM 1.0 with a source citation; USGS is kept on the
official U.S. public-domain statement.
