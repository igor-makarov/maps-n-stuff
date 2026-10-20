# Metadata-reuse decision — 2026-10-20 (member 0)

Observed runner time when the decision was recorded: **2026-10-20T12:16Z**
(`date -u` on the GitHub runner; all primary pages below were fetched in the
same session between 12:10 and 12:16 UTC).

This closes the `unresolved-pending` metadata status that the 12:00 UTC steering
required to be decided during the run. It covers **Digital Commonwealth
(BPL/Leventhal and the seven partner institutions)** and **Doria / National
Library of Finland**, and records the basis for **SLUB Dresden** as well. It is a
recorded basis, **not a licence claim**: no provider publishes a standalone
metadata licence for these scopes and none is invented here. Image rights remain
a separate, per-item gate and are unchanged.

## Decision

Status for all three scopes: **`basis-recorded`**. The catalogue keeps the
records; it does not label their metadata as CC0/PDM or as "cleared by a
licence". The basis consists of (a) the factual character of the redistributed
description fields, (b) the institution's affirmative publication of those
records for machine reuse, and (c) a per-item rights condition that is retained
verbatim and, for images, still gates admission. If any institution later states
a restriction on catalogue data, the affected records must be withheld pending
review rather than re-labelled.

## 1. Digital Commonwealth / Boston Public Library / Leventhal

Primary pages retrieved 2026-10-20:

- <https://www.digitalcommonwealth.org/api>
  > "APIs (Application Programming Interface) provide programmatic machine-based
  > interaction with metadata and image content from items in the Digital
  > Commonwealth collections, allowing this content to be used in other
  > applications and data services."
  The same page documents the OAI-PMH feed
  (`https://oai.digitalcommonwealth.org/catalog/oai`) and JSON item/search
  views. This is the institution's own statement of purpose for the metadata
  feed: reuse in other applications and data services, not merely human reading.
- <https://www.digitalcommonwealth.org/copyright>
  > "Digital Commonwealth provides access to copyrighted materials strictly for
  > noncommercial educational and research purposes and places no restrictions on
  > public domain material."
  > "Digital Commonwealth does not charge permission fees for use of such
  > material and does not grant or deny permission to publish or otherwise
  > distribute material in its collections."
  The page also says that, unless terms are clearly stated for an individual
  item, visitors must seek permission from the copyright owner. We therefore do
  **not** read this as a blanket image grant; every admitted image still carries
  an affirmative item determination (no-known-copyright/no-restrictions, NoC-US,
  CC0, CC BY) and restrictive items stay withheld.

Basis recorded: the redistributed fields are the factual catalogue description
(title, creator, date, publisher, language, identifiers, holding, links) that
Digital Commonwealth/BPL publish through a documented API explicitly intended
for use in other applications and data services; no separate rights in those
description fields are asserted. No metadata licence is claimed.

Limits: applies to the descriptive fields and links only. It does not cover an
image whose own statement is restrictive; the existing per-item image gate and
verbatim rights wording are unchanged.

## 2. Doria / National Library of Finland

Primary evidence retrieved 2026-10-20:

- Per-item OAI-MODS `GetRecord`, e.g.
  <https://www.doria.fi/oai/request?verb=GetRecord&metadataPrefix=mods&identifier=oai:www.doria.fi:10024/84494>
  (HTTP 200, 12:12:30Z server response) states the item's use-and-reproduction
  condition as:
  > `<mods:accessCondition type="useAndReproduction">http://creativecommons.org/publicdomain/zero/1.0/</mods:accessCondition>`
  > `<mods:accessCondition type="useAndReproduction">Public Domain</mods:accessCondition>`
  Every admitted Doria record keeps its verbatim PDM/CC0/plain-public-domain
  statement (`rights`, `rightsBasis`, `rightsUrl`), and restrictive or
  conflicting statements are withheld.
- <https://www.doria.fi/page/terms> answers HTTP 200 but the body contains only
  the unfilled template placeholders `StaticPageBodyHead` / `StaticPageBodyPara`;
  <https://www.doria.fi/page/about> is likewise an unfilled template. There is no
  repository-wide metadata licence or bulk-redistribution grant to cite.

Basis recorded: the National Library of Finland supplies each admitted item with
a CC0 1.0 / Public Domain use-and-reproduction condition and publishes the
description through the documented OAI-PMH interface (`oai_dc`, `mods`, `ore`).
The redistributed fields are the factual description of the item (title,
creator, date, publisher, language, URN, handle). No separate metadata licence
is published and none is asserted.

Limits: the CC0/PDM condition belongs to the described item as stated by Doria;
this note does not relabel the catalogue metadata itself CC0. Only records whose
own statement is PDM/CC0/plain public domain are admitted.

## 3. SLUB Dresden

Primary page retrieved 2026-10-20:
<https://nutzungshinweis.slub-dresden.de/> ("Nutzungsbestimmungen für die
Digitalen Sammlungen"):

> "Die Lizenz-, Rechte- oder Nutzungshinweise der SLUB werden für jede Kollektion
> und sukzessive für jedes Objekt angegeben."
>
> "Diese digitalen Objekte werden daher in der Regel unter der Public Domain Mark
> 1.0 zugänglich gemacht. Sie dürfen diese Werke kopieren, verändern, verbreiten
> und aufführen, sogar zu kommerziellen Zwecken, ohne irgendwie um Erlaubnis
> bitten zu müssen."

The policy also requires the source citation (SLUB Dresden, PURL/URN, licence) on
reuse. Every imported SLUB object carries an explicit PDM 1.0 MODS/DFG-viewer
statement and the SLUB/DFG-viewer `slubarchiv:copyrightStatus=publicdomain`
corroboration; 56 rights-reserved/CNE objects are withheld.

Basis recorded: the redistributed description is the factual catalogue data
published with a PDM 1.0 object whose policy permits copying, modification,
distribution and performance, including commercially, with attribution. SLUB
publishes no separate metadata licence; none is asserted.

Limits: only PDM-admitted objects; the PDM statement is not stretched to
rights-reserved or unevaluated objects, and the required attribution/URN stays on
each record.

## What this does not do

- It does not make the metadata files CC0/PDM and does not remove attribution.
- It does not clear any image that the item-level gate withholds.
- It does not cover a provider outside the three scopes above (USGS and LoC rely
  on their own U.S. public-domain statements recorded per record; Stanford uses
  its pinned CC0 metadata revision; e-rara/swisstopo keep their stated terms).
- It does not convert a registry entry into evidence of coverage.

## Verification

- `public/data/sources.json` now carries `status: "basis-recorded"`, the primary
  URLs, exact quotes, limits and this note for the three scopes; no shipped
  provider entry says `unresolved-pending`.
- `tests/data.test.mjs` asserts the new structured basis and that the old pending
  marker is gone.
- `npm test` and `npm run check` are run on the merged tree after this change;
  the result is recorded in the member-0 note and the final status addendum.
