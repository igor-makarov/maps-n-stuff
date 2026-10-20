# Metadata-reuse evidence and decision — 2026-10-20

Observed runner time when this note was first written: **2026-10-20T12:16Z**
(`date -u` on the GitHub runner; all primary pages below were fetched in the
same session between 12:10 and 12:16 UTC). The note was reconciled with the
merged decision of 12:15 UTC after `origin/main` published the withholding
commit `7fd2bff9`; it records **evidence**, not a clearance.

## Outcome on the merged tree

Three scopes are **withheld** from the shipped reusable catalogue because no
primary metadata-reuse licence or other substantiated redistribution basis was
established for bulk catalogue redistribution:

| Scope | Records | Shipped? | Status |
| --- | ---: | --- | --- |
| Doria / National Library of Finland | 1,662 | no — `research/withheld/doria.json` | `metadataReuse.status = "withheld"` |
| Leventhal / Boston Public Library | 10,242 | no — `research/withheld/leventhal.json` | `metadataReuse.status = "withheld"` |
| Digital Commonwealth partner holdings (7 institutions) | 972 | no — `research/withheld/digitalcommonwealth.json` | `metadataReuse.status = "withheld"` |

**SLUB Dresden stays bundled** (105 records): its primary digital-collections
terms explicitly license the digital objects under Public Domain Mark 1.0 with a
source citation, which the merged decision accepted as the basis for the
factual descriptions published with those PDM objects. Its structured
`metadataReuse` entry is `basis-recorded`.

This closes the earlier `unresolved-pending` state in the sense the 12:00 UTC
steering required: no affected scope is left publicly served as “pending”.
Image rights are a separate decision and are unchanged. Nothing here labels an
image or a catalog record as CC0/PDM beyond what the institution itself states.

## 1. Digital Commonwealth / Boston Public Library / Leventhal

Primary pages retrieved 2026-10-20:

- <https://www.digitalcommonwealth.org/api>
  > "APIs (Application Programming Interface) provide programmatic machine-based
  > interaction with metadata and image content from items in the Digital
  > Commonwealth collections, allowing this content to be used in other
  > applications and data services."
  The same page documents the OAI-PMH feed
  (`https://oai.digitalcommonwealth.org/catalog/oai`) and the JSON item/search
  views.
- <https://www.digitalcommonwealth.org/copyright>
  > "Digital Commonwealth provides access to copyrighted materials strictly for
  > noncommercial educational and research purposes and places no restrictions on
  > public domain material."
  > "Digital Commonwealth does not charge permission fees for use of such
  > material and does not grant or deny permission to publish or otherwise
  > distribute material in its collections."
  The page adds that, unless terms are clearly stated for an individual item,
  visitors must seek permission from the copyright owner.

Assessment: the API sentence is an affirmative statement of machine access and
an intended use in applications, but it is **not a licence to redistribute the
catalogue metadata in bulk**, and the copyright page explicitly declines to
grant or deny publication/distribution permission for collection material. The
per-item statements (no-known-copyright/no-restrictions, NoC-US, CC0, CC BY)
are image/item rights, not a metadata licence. No separate metadata licence was
found. The scope therefore remains withheld; the quotes are retained here for a
future clearance review, not treated as clearance.

## 2. Doria / National Library of Finland

Primary evidence retrieved 2026-10-20:

- Per-item OAI-MODS `GetRecord`, e.g.
  <https://www.doria.fi/oai/request?verb=GetRecord&metadataPrefix=mods&identifier=oai:www.doria.fi:10024/84494>
  (HTTP 200, 12:12:30Z server response) states the item's use-and-reproduction
  condition as:
  > `<mods:accessCondition type="useAndReproduction">http://creativecommons.org/publicdomain/zero/1.0/</mods:accessCondition>`
  > `<mods:accessCondition type="useAndReproduction">Public Domain</mods:accessCondition>`
- <https://www.doria.fi/page/terms> answers HTTP 200 but the body contains only
  the unfilled template placeholders `StaticPageBodyHead` / `StaticPageBodyPara`;
  <https://www.doria.fi/page/about> is likewise an unfilled template.

Assessment: the per-item CC0 1.0 / Public Domain condition is a use-and-
reproduction statement for the described digital object; Doria publishes no
repository-wide metadata licence or bulk-redistribution grant, and the empty
terms page supplies no additional permission to cite. The factual description
alone is not treated here as a substantiated redistribution basis for the
database as a whole. The scope remains withheld.

## 3. SLUB Dresden (kept)

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
statement and the `slubarchiv:copyrightStatus=publicdomain` corroboration; 56
rights-reserved/CNE objects are withheld. The 105-record scope is kept, with the
PDM statement applied only to the objects that state it.

## What this note does not do

- It does not restore, relabel or release any withheld record or image.
- It does not make the metadata files CC0/PDM and does not remove attribution.
- It does not clear any image that the item-level gate withholds.
- It does not convert a registry listing into evidence of coverage.

## Restoration criteria

A future iteration may move a withheld shard back into `public/data/records/`
and set it bundled only after recording an applicable primary metadata-reuse
permission or another substantiated redistribution basis in
`public/data/sources.json`, with URL, scope and retrieval date, and after
re-running the image/rights and browser verification. Until then the full
records and evidence stay under `research/withheld/` and are not served.

## Verification

- `public/data/sources.json`: the three scopes are `bundled: false` with
  `metadataReuse.status = "withheld"`, the evidence above and this note linked;
  SLUB is `basis-recorded` with the two primary quotes. No provider entry says
  `unresolved-pending`.
- `tests/data.test.mjs` asserts the withheld statuses/evidence, the SLUB basis,
  and the absence of the pending marker; it does not weaken the withheld-scope
  test published with `7fd2bff9`.
- `npm run check` / `npm test` are run on the merged tree after reconciliation;
  the result is in the member-0 note and the commit that adds this file.
