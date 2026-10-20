# Data sources — registry, rights and verification evidence

## Current global atlas (2026-10-20)

The current implementation and verification limits are documented in
[global integration notes](global-integration.md). The bundle contains **31,637
records** from six bundled providers: 23,945 USGS Historical Topographic Map
Collection sheets, 4,464 Stanford public-domain maps, 3,045 e-rara maps, 105
SLUB Dresden maps, 51 Library of Congress records and 27 swisstopo entries. The
Library of Congress and USGS slices are verified partial imports, not the whole
institutions; both record their resumable cursors.

Three further scopes were harvested with per-item **image** rights evidence but
are **withheld** from the shipped catalogue because no primary metadata-reuse
licence or other substantiated redistribution basis was established for their
catalogue records: Doria / National Library of Finland (1,662), Leventhal /
Boston Public Library (10,242) and the Digital Commonwealth partner-held scope
(972). Their full records, provider endpoints and policy evidence are retained
under `research/withheld/` (not served) and are not counted above. Image rights
for those scopes are unchanged and are not a grant for this metadata reuse. There are **117 native Stanford COGs plus 23,945 USGS GeoTIFF records**;
the USGS raster samples (8/8 live range reads, 8/8 parsed and 8/8 projected by the
browser renderer on each of the three slices) are representative, not a claim
that every one of the 23,945 was individually opened.

The English UI uses global OSM/Nominatim and NASA Blue Marble satellite imagery.
Swiss reference maps and the Swiss search fallback have been removed. Five
historical Swiss overlays remain as ordinary regional holdings. An alignment,
known extent, publication date or thumbnail is optional for catalogue admission;
compatible image rights and a primary source identity are required.

The sections below preserve the historical source-verification log. Old
Swiss defaults and catalogue counts are superseded by the current notes above.

## 1. e-rara — digitised prints of Swiss libraries (Zentralbibliothek Zürich)

| Field | Value |
| --- | --- |
| Provider record (interface) | <https://www.e-rara.ch/> — ZB Zürich interface `zuz` |
| Primary record URL | `https://www.e-rara.ch/doi/10.3931/e-rara-<id>` (DOI resolves to the title page) |
| Identifiers used | e-rara title id / DOI suffix (`e-rara-22142031`), IIIF title id, IIIF image id |
| Metadata endpoint | `https://www.e-rara.ch/oai?verb=ListRecords&metadataPrefix=oai_dc&set=<setSpec>` (OAI-PMH 2.0, `oai_dc`; sets used: `zuz`, `landkarten`, `cartesgeneve`, `museecarto` — `ListSets` is paginated, 105 sets in 11 pages) |
| Discovery endpoint (SRU) | `https://www.e-rara.ch/sru?operation=searchRetrieve&version=1.2&query=<cql>&startRecord=<n>&maximumRecords=100&recordSchema=mods` (standard SRU 1.2 with CQL; the search indexes that answer are `dc.title`, `dc.subject` and `dc.creator` — `dc.type`, `dc.genre`, `dc.format` and `dc.coverage` always answer 0 records). MODS records state the IIIF id and holding corpus verbatim (`<vl:id>`, `<vl:prefix>`) plus a `<coordinates>` statement; a hit is confirmed with `oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai:www.e-rara.ch:<titleId>` before it becomes a record |
| IIIF manifest (Presentation API 2.0) | `https://www.e-rara.ch/i3f/v20/<titleId>/manifest` |
| IIIF image service (Image API 2, level 2) | `https://www.e-rara.ch/i3f/v20/<imageId>/full/<size>/0/default.jpg` |
| Holding institution | per record from the manifest `Besitzende Institution` — in the seed (213 records): Zentralbibliothek Zürich (92), ETH-Bibliothek Zürich (79), swisstopo (27 overlays), Universitätsbibliothek Bern (13), Universitätsbibliothek Basel (1), Bibliothèque de Genève (1). The registry's `institutions` list is derived from the harvested records, so it cannot drift; a set whose manifests do not name an institution (see `museecarto` below) contributes no record. When a manifest omits the field, the library is taken from the **corpus the catalogue itself states** (`<vl:prefix>` of an SRU hit, the `setSpec` of an OAI set, or the `og:url` of the DOI landing page — `zuz`, `zut`, `bes_1`, `gep_r`); a corpus the harvest cannot name produces no record, and the drop is listed in `records.json.skipped` (no library is ever defaulted) |
| Rights | per record from `dc:rights` — the seed set is `PDM 1.0` (Public Domain Mark) |
| Attribution | “Zentralbibliothek Zürich via e-rara” |
| Related collection context | <https://www.zb.uzh.ch/de/sammlungen/spezialsammlungen/karten-und-panoramen> (ZB Zürich, Karten und Panoramen) |

Verification evidence (curl headers):

```
GET https://www.e-rara.ch/i3f/v20/3602/manifest      -> 200 application/json, access-control-allow-origin: *
GET https://www.e-rara.ch/i3f/v20/3604/full/200/0/default.jpg -> 200 image/jpeg   (no CORS header)
GET https://www.zb.uzh.ch/de/sammlungen/…/karten-und-panoramen -> 200
```

Consequence for the app: IIIF **manifests** can be fetched from the browser
(CORS `*`); **images** are loaded as plain `<img>` (no CORS needed). `/api/fetch`
exists only as a fallback and is restricted to `www.e-rara.ch/i3f/**`.

Field mapping (nothing invented):

| Record field | Upstream source |
| --- | --- |
| `title` | IIIF manifest `label` (verbatim); falls back to `dc:title` |
| `creators` | `oai_dc` `dc:creator` (verbatim, may be empty) |
| `yearStart`/`yearEnd` | publication year from `dc:date`, else parsed from the manifest `Impressum` |
| `depictedYearStart`/`depictedYearEnd` | only when the record itself states a survey/map date; otherwise `null` (never derived from the publication year). The harvest accepts exactly one anchored phrase from the e-rara manifest — “in den Jahren 1843-1851 gemachten Aufnahmen” — and stores the verbatim match in `depictedSource`; 27 of the 213 records (all Zürich Wildkarte sheets and the 1852 canton map, printed 1853) carry it. A bare “Aufnahmen von 1852-1865” is *rejected*: on those sheets that range is the engraving, not the survey, and 35 cached manifests contain exactly that trap. Records whose *title* names a different map year (e.g. “Stadtplan von Winterthur vom Jahre 1755”, published 1919) keep the publication year as `yearStart` and `depictedYearStart: null`; the title is shown verbatim, so the difference is visible instead of guessed |
| `institution` | manifest `Besitzende Institution` (first institution before the comma) |
| `shelfmark` | the part of the manifest `Besitzende Institution` after the comma, verbatim (`Zentralbibliothek Zürich, 4 Lb 06: 9` → `4 Lb 06: 9`); all 186 of the 213 records that come from e-rara state one (swisstopo states no signature), the others show “nicht angegeben” in the detail view |
| `recordUrl` | the DOI landing page (`https://www.e-rara.ch/doi/10.3931/e-rara-<id>`) |
| `thumbnail` | IIIF thumbnail from the manifest (`…/full/304/0/default.jpg`) |
| `imageService` | IIIF Image API 2 service id of the first canvas |
| `rights` | verbatim `dc:rights` (the seed set is `PDM 1.0`) |
| `extent` / `geo` | parsed from the manifest `Kartendaten` statement; `geo` is the centre of that stated bbox, never a guessed point |
| `imprint`, `collection`, `sheet` | manifest `Impressum`; the OAI set / sheet name from the manifest label |
| `imageService` | IIIF Image API 2 service id of the first canvas |
| `canvasCount` | number of canvases in the manifest (`sequences[0].canvases.length`) — every one of the 172 e-rara records states it, 34 of them are real multi-sheet works (2–65 sheets); swisstopo overlay editions have none |
| `viewerUrl` | the library's own deep-zoom viewer: the DOI landing page states the holding corpus in `og:url` (`http://www.e-rara.ch/<corpus>/<id>`); the harvest keeps only the corpus after checking `<id>` against the manifest title id and stores `https://www.e-rara.ch/<corpus>/content/zoom/<id>`. For SRU-discovered records the corpus comes verbatim from the catalogue record (`<vl:prefix>`), so no landing page request is needed. Corpora in the seed: `zuz` 87, `zut` 70, `bes_1` 8, `gep_r` 1 — 166 of the 172 e-rara records state one; the six without a catalogue-stated corpus (a Sammelband and five sheets) keep the DOI landing page as their link instead, nothing is constructed. Nothing is constructed when neither states it. For the same title and year the ZB Zürich copy is preferred, so the cantonal library — the design reference's own — keeps the duplicate (see below) |

Selection rule (no hand-picked titles): every map record of an OAI set that is
not a series volume, with a cap per set (ZB Wildkarte 26 sheets,
`landkarten` 56, `cartesgeneve` 14) and a documented **candidate window** per set.
A record is kept only when the manifest
states a `Kartendaten` bbox and an upstream year; duplicates of the same work are
dropped by leading title. The per-set numbers (`considered`, `consideredInWindow`,
`kept`, `rule`) are
written into `records.json.selection`, so the rule that produced the set can be
read from the data itself.

### Zürich plans, the Zürich region and the city plans via SRU (7-14, extended 7-15 and 7-18)

The OAI sets are unsorted *ingest* order, so single sheets and city plans are hard
to reach by paging them (pages 32–50 of `zuz` yield three map candidates, all the
same 16th-century atlas). The platform's own **SRU 1.2** service searches the
catalogue instead, so the harvest asks it seven documented CQL questions, grouped
into three sets, and keeps the results that survive the same gates as every other
record:

```
dc.title=Plan  and dc.subject=Zürich      104 hits  → “Pläne aus Zürich (Stadt und Umgebung)”, cap 48 (all 92 candidates pooled)
dc.title=Karte and dc.subject=Zürich       63 hits  → same set

dc.title=Umgebung  and dc.subject=Zürich   45 hits  → “Zürich und Umgebung (Kanton, Stadt und See)”, cap 16, ≤ 3/decade
dc.subject=Zürichsee                       25 hits  → same set
dc.title=Stadtplan and dc.subject=Zürich    2 hits  → same set

dc.title=Grundriss and dc.subject=Zürich   32 hits  → “Grundrisse und Situationspläne der Stadt Zürich”, cap 14, ≤ 3/decade
dc.title=Situationsplan and dc.subject=Zürich 16 hits → same set
```

`dc.title=Ansicht and dc.subject=Zürich` (43 hits) and
`dc.title=Vogelschau and dc.subject=Zürich` (2 hits) were probed on 2026-10-18
and yield **no map record with a stated extent** (they answer facade views and
viewsheds of buildings), so they are deliberately not queried.

**Extended 7-18 (measured on this runner).** The plan set now pools *every*
candidate the two queries answer instead of the 44 oldest: 92 candidates with a
stated year and `<coordinates>`, all of them confirmed through `GetRecord` + manifest,
47 of which pass the gates and are kept (cap 48). The 45 dropped candidates are
duplicate editions of a title already kept for the same year, series volumes without
a stated `Kartendaten` extent, or model/series records without a map year — none is
dropped for space. Probed and *not* changed: the region and city sets stay at 11 and
10 records because their candidate pools are exhausted, not their caps — raising
their per-decade rule from 3 to 9 leaves both counts unchanged. The world set stays
at 21 (a quota of 9 would add two more sheets of the same three decades).

Three sets instead of one on purpose: a 1705 fortress plan and a 1838 city plan
are the same kind of “small area, one sheet” object, and inside a single set they
would displace each other's decade (the per-decade rule below). `dc.title=Grundriss`
also answers lake, forest and estate plans (Murten, Schwamendingen, Bischofszell, a
cantonal hospital farm) — the canton window and the extent gate remove them.

Gates, in order: map genre and a stated publication year and a stated MODS
`<coordinates>` statement in the SRU record (a candidate without them never costs
a manifest request) → not already in the seed → `oai?verb=GetRecord` confirms the
record (`dc:rights`, DOI, map type, year) → the IIIF manifest must state a
`Kartendaten` extent and the holding institution → **the centre of that stated
extent must lie inside the canton of Zürich's bounding box** → one entry per title
and year, oldest first.

All three sets share one title/year dedupe, so a sheet two searches find is kept
once. The plans set is capped at 18 records; the region and city-plan sets are
capped at 16 and 14 **and at three records per publication decade**, because that
material clusters in a few decades — with a plain oldest-first cap the whole 20th
century of the region set fell out of the selection again.

The catalogue often lists the same sheet in several corpora (`zuz` Zentralbibliothek
Zürich, `zut` ETH-Bibliothek). Candidates are therefore ordered by year, then by
**`zuz` first** (the canton's central library, the design reference's own), then by
catalogue id — a documented tie-break instead of “whichever the search returned
first”. Copies whose catalogued titles differ (e.g. the same 1800 city plan bound in
a Bern `Helvetia` volume) are kept as separate records: they are separate upstream
items with their own shelfmark, DOI and institution.

The canton window is not a guess: it is read at harvest time from swisstopo's own
gazetteer (`SearchServer?searchText=Zürich&type=locations&origins=kantone`, the
GG25 canton layer) and stored in
`records.json.selection['e-rara:sru-zurich-plans'].cantonWindow` and
`…['e-rara:sru-zurich-region'].cantonWindow` — 2026-10-18:
`8.35184 … 8.995768 E / 47.1557 … 47.697043 N`. It prevents a keyword hit for a
Switzerland- or Germany-wide map (e.g. “Helvetia universa: 28. Karte von der
Schweiz”, “Germania universa: 7”) from entering a Zürich set: those four
candidates were kept in the first run and are excluded now — as are the region
hits outside the canton that the new queries return (`Stadtplan von Riga`, the
1840 “Rigi-Berg und seine Umgebungen”, Baden and Luzern surroundings, Lugano
1913). If the gazetteer cannot be reached, the whole SRU set is skipped rather
than shipped ungated.

Result: **18 + 11 + 10 records** (`considered` 92, 24 and 35 candidates with a
stated extent). The plans set is city plans (“Plan der Stadt Zürich nach
Breitinger”, 1852–1867), the canton maps of 1852/1858/1860 (the ZB copy of the
1:25 000 work has 35 sheets), the 1754 “Plan des Zürich-Sees”, the 1768–1793
military exercise plans, Oberstrass 1869 and an 1871 Zürich project plan. The
region set adds the 18th-century lake material (1766 “Prospectus unius partis
lacus Tigurini”, 1780 “Le lac de Zürich avec ses environs”, both
Universitätsbibliothek Bern), the Übersichtspläne of 1875/1876/1879/1881, the 1896
“Spezialkarte des Zürichsee's mit Umgebung”, the 1908 Zürichsee basin and
Turbenthal sheets and the 1919 Randmoränen and Winterthur city plan. The city-plan
set adds the fortress ground plans of **1696 and 1705**, the 1800 “Grundriss der
Stadt Zürich und der umliegenden Gegend” (ZB and a Bern volume copy), the 1826
Schwamendingen forest plan, the 1838 city plan, the 1847 Altstetten irrigation
site and the 1881 exhibition/quay and 1890 tramway Situationspläne — so the e-rara
part of the seed reached **1696–1919** instead of 1754–1871 (and spans **1547–1920**
since the `landkarten` widening below).

### Overview maps outside Switzerland (7-16)

Every record of the three Zürich sets lies inside the canton, so a visitor who
searched or panned outside Switzerland found nothing. Six more CQL questions
answer continent- and world-wide overview maps and became the fourth set,
`e-rara:sru-world-overview`:

```
dc.subject=Europa  and dc.title=Karte   30 hits
dc.title=Erdkarte / dc.title=Weltkarte  (world maps)
dc.subject=Afrika  and dc.title=Karte
dc.subject=Amerika and dc.title=Karte
dc.subject=Asien   and dc.title=Karte
```

The gates are the same as for the Zürich sets (map genre, stated year, stated
MODS `<coordinates>`, `GetRecord` confirmation, IIIF manifest with a holding
institution and a `Kartendaten` extent, one entry per title and year, at most
three records per publication decade), with **two mirrored rules** that also keep
the sets disjoint:

- the centre of the record's own stated extent must lie **outside** the canton
  window (the Zürich sets require the opposite), so one keyword hit can never
  appear in both;
- the extent must span **at least 5°** of latitude or longitude — that is what
  makes a sheet an overview map rather than a local one.

Result (7-20 harvest): **twelve** SRU questions answer 187 hits, 120 of them
candidates with a stated year and coordinates, 37 pass the area gate and **21 are
kept, 1787–1914**, held by ETH-Bibliothek (14), Universitätsbibliothek Bern (6)
and ZB Zürich (1) — the 1787 “Europa universalis”, the 1788 “India anterior”, the
1797 “Dania regnum”, the 1795–1805 “Germania universa” post maps, the 1845/1847
austrian geological overviews, the 1850 Levant coast, the 1860/1900 “General-Karte
von Italien”, the 1873/1875 coal and geological maps of Austria-Hungary, the 1902
Hungarian crown-lands map and the 1914 Franco-German and Italian front sheets.
The set is skipped entirely when the gazetteer is unreachable, like the Zürich
sets — the window is not optional.

### The world set becomes a country spread (7-20)

The set pooled six continent/world keywords and kept 21 of 39 candidates, so the
world view outside Switzerland was thin. The same catalogue answers **country
keywords**, probed on 2026-10-19 with the same SRU query shape — Deutschland 62
hits, Italien 20, Frankreich 17, Oesterreich-Ungarn 13 (the catalogue's own
German subject heading; `Österreich` answers nothing), Spanien 7,
Grossbritannien 4 — while Niederlande (2 hits, its maps span ~3.5° and cannot pass
the 5° area gate), Preussen (12, but also Deutschland hits), Russland (2),
Indien/China/Japan (1 each) and Australien (0) were probed and left out; the
probe numbers are kept in the set's comment. Six country questions were added to
the six existing ones.

Because Deutschland alone answers a third of the pool, the selection is no longer
a plain year sort: the pooled candidates are picked **in rounds over the query
groups** with a **quota of 7 per keyword**, so every keyword contributes its
earliest kept sheet before a productive keyword offers its next one. The earlier
“a per-query quota was probed and rejected” note applied to the six-keyword pool,
where only the Europe query answered many records; with twelve keywords the
rounds are what keep the country spread. The 5°-span gate, the outside-canton
window, the one-entry-per-title-and-year rule and the three-per-decade cap are
unchanged. Harvest output: 187 hits → 120 candidates → 37 pass the area gate →
21 kept; the seed stays 199 records.

### Every stated hemisphere is respected — the world set becomes global (7-21)

`parseBbox` read the second longitude and latitude of the catalogue's
`Kartendaten` statement as if they were always E/N. Two consequences, measured
against the 199-record seed before the fix (27 of the 376 cached statements
change):

- six committed records had an **invented** extent: the 1787 “Neue Karte von
  Europa” and five more Europe maps were placed at 25 °E–60 °E although the
  catalogue states `W 25°00'-E 60°00'`;
- every map reaching into the western or southern hemisphere was **dropped**,
  because no second `N` existed to read — every Südamerika, Africa and
  Central-America sheet, and the whole-globe sheets (`W 180°-E 180°/N 90°-S 90°`).

The parser now reads the hemisphere letter of each of the four stated corners
(arc-seconds are stated upstream but are not carried into the extent — the minute
is the map view's resolution), keeps a genuine whole-globe pair, and returns no
extent for a date-line crossing (`E 155°-W 165°`, the 1781 Russian discoveries
map), which a west/east box cannot express. **An extent is never guessed.**

Result (7-21 harvest): the seed grows 199 → **213 records** (+14, nothing removed;
186 e-rara + 27 swisstopo, span 1546–2021, e-rara 1546–1920). The world set's
questions grow **12 → 20** (the eight non-European keywords Südamerika, Palästina,
Türkei, Indien, Nordamerika, Russland, Syrien, Japan — all probed, the numbers are
in the set's comment): 133 candidates, **35 kept, 1546–1914**, now a genuine world
spread — whole-globe sheets (1546, 1700, 1835, 1893), North and Central America
(1763, 1796), South America (1890 Süd-Amerika, 1898 Argentina–Chile), Africa
(1884/1885/1889), India (1853), Japan (1903) and Kleinasien (1910). Four sheets
now carry a whole-globe extent, which is why the app's point filter no longer has
an “outside every footprint” point on earth, and why a globe sheet is not coupled
to a city plan by the comparison view (see `docs/run.md`).

### One plan, two issues — a deliberate near-duplicate (7-20)

A seed-wide audit (same normalised title + year) finds exactly one pair:
`e-rara:8602422` and `e-rara:8602432`, both “Grundriss der Stadt Zürich und der
umliegenden Gegend”, 1800, Keller/Lips, ZB Zürich. Both IIIF manifests were read
side by side on 2026-10-19: they are **two real items** — `3 Lb 05: 1` is the
coloured issue (20 × 25 cm) and `3 Lb 05: 3` the black-and-white one (21 × 26 cm),
with different DOIs (`e-rara-26723` / `e-rara-26725`) and image services. The seed
keeps both on purpose; the catalogue's own copy-level records are what the two
different e-rara corpora (`landkarten` and the city-plan SRU set) contributed.

### The ETH set becomes a four-century Swiss survey (7-19)

The `landkarten` set states **2335 records**; the seed read the first 12 OAI pages
(120 records) and kept the 50 oldest candidates with a 26-record cap, so its map
was pinned to the 1780s–1830s: the 16th–18th-century Zürich sheets that the same
set holds were simply outside the window. Three bounded changes, no hand-picked
title:

1. **Read 30 pages (300 records) instead of 12** — bounded and documented.
2. **Candidate window** = the 50 oldest candidates of the first 12 pages (the
   window the set was first harvested with, so the deeper read does not lose that
   reach) **∪** 90 candidates evenly spaced over the year-sorted candidates
   (`spreadWindow`, first and last always included) → **125 candidates**, spanning
   the set's whole range instead of its first decades.
3. **Selection** = the union of two documented passes over the candidates that
   state a `Kartendaten` bbox and an upstream year: the **oldest 26** (the
   previous rule, which is where the cantonal and regional sheets outside Zürich
   sit) and a **per-decade spread** (at most 3 records per publication decade, cap
   44), which is the only way the 16th–18th-century material can appear at all.
   Duplicates are still dropped by leading title (60 characters).

Measured result of the harvest: **26 → 56 records** in the set, spanning
**1547–1900** — the 1547 “Das Zürychgow”, 1692 “Geographische … Verzeichnus”,
1698 “Zürich Gebiet”, 1718 “Delineatio aller Quartieren …”, 1738 “Nova et accurata
Agri Tigurini … tabula”, 1766 “Territorium der Republic Zürich”, 1793
“Der Zürich-See …” and the 19th-century cantonal sheets, next to the Atlas Suisse
and Ticino/Vaud/Appenzell material the previous rule already carried. The whole
seed spans **1547–2021** (it was 1696–2021) and grows 169 → **199 records**, while
the non-Zürich Swiss coverage grows 24 → 28 records instead of shrinking (the
per-decade rule alone would have dropped eight of them; the oldest-26 pass keeps
them). Six previously published sheets fall out of the set because the newly
reachable 16th–18th-century sheets take slots in the oldest-26 pass — the rule is
recorded in `records.json.selection['e-rara:landkarten']`, so the churn is
reproducible rather than a surprise.

Discovery windows (2026-10-18, updated 2026-10-19) — the sets are not map sets, so the harvest reads
a bounded sample of each and the window sizes are part of the method:

| OAI set | What it holds | Pages read | Candidate window | Kept |
| --- | --- | --- | --- | --- |
| `zuz` | the whole ZB Zürich corpus, **54,999 records** | 32 (320 records) | 72 maps | 26 Wildkarte sheets |
| `landkarten` | “Schweizer Landkarten aus vier Jahrhunderten”, **2335 records** | 30 (300) | 258 candidates; window = the 50 oldest of the first 12 pages ∪ 90 evenly spaced over the year-sorted candidates (**125**) | 56 |
| `cartesgeneve` | Geneva and surroundings | 6 (60) | 40 maps | 1 (1837 “Geneva”, Bibliothèque de Genève) |
| `museecarto` | world maps (Mappae mundi and reproductions) | 6 (54) | 20 maps | **0** |
| SRU `dc.title=Plan/Karte and dc.subject=Zürich` | Zürich plans and canton maps (single sheets, not a series) | 3 SRU pages (167 hits) | 92 candidates with year + stated extent → all 92 with a manifest request | **47** |
| SRU `dc.title=Umgebung / dc.subject=Zürichsee / dc.title=Stadtplan` + `dc.subject=Zürich` | Zürich and its surroundings, the lake, city plans | 3 SRU pages (72 hits) | 24 candidates with year + stated extent → 40 with a manifest request | **11** |
| SRU `dc.title=Grundriss / dc.title=Situationsplan` + `dc.subject=Zürich` | city ground plans (1696–1838) and site plans of Zürich | 2 SRU pages (48 hits) | 35 candidates with year + stated extent → 45 with a manifest request | **10** |
| SRU `Europa`/`Erdkarte`/`Weltkarte`/`Afrika`/`Amerika`/`Asien` + `dc.title=Karte` | overview maps of Europe and the world, **extent centre outside** the canton and ≥ 5° span | 6 SRU pages | 39 candidates with year + stated extent | **21** |

`cartesgeneve` documents a real trap: the window is sliced by *count* after
sorting by year, so a narrow window silently drops 19th-century sheets behind
older ones — the 1837 Geneva sheet disappeared at a 14-item window and is only
back because the window is 40 candidates. `museecarto` is probed on every run and
contributes **0 records**: no manifest of that set states a `Kartendaten` extent,
and its works come from several libraries, so a record would also need the holding
library to be stated by the manifest or by its catalogue corpus — no library is
ever guessed (a record without one is dropped and listed in `skipped`). Both facts are visible in `records.json.selection` and in the
`museecarto` entry of `sources.json`.

## 2. swisstopo — Federal Office of Topography geoservices

| Field | Value |
| --- | --- |
| Provider | Bundesamt für Landestopografie swisstopo |
| Geoservices entry point | <https://www.swisstopo.admin.ch/en/geoservices-with-swisstopo-geodata> |
| Digital maps | <https://www.swisstopo.admin.ch/en/digital-maps> |
| Map viewer (service documentation) | <https://map.geo.admin.ch/> |
| Historical series documentation (verified HTTP 200, 2026-10-18) | [Historische Kartenwerke](https://www.swisstopo.admin.ch/de/historische-kartenwerke) · [Digitale Siegfriedkarte](https://www.swisstopo.admin.ch/de/digitale-siegfriedkarte) · [Digitale Dufourkarte](https://www.swisstopo.admin.ch/de/digitale-dufourkarte) · [SWISSIMAGE HIST](https://www.swisstopo.admin.ch/de/orthobilder-swissimage-hist) · [SWISSIMAGE HIST 1946](https://www.swisstopo.admin.ch/de/orthobilder-swissimage-hist-1946) |
| WMTS capabilities used | `https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml` |
| WMTS tile template | `https://wmts.geo.admin.ch/1.0.0/<layerId>/default/<Time>/3857/<z>/<x>/<y>.<ext>` |
| Place search | `https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=<q>&type=locations&sr=4326&limit=<n>` (CORS `*`) |
| Rights | Open Government Data / swisstopo geoservices terms — free use **with attribution** |
| Attribution | “© swisstopo” (Zeitreise layers: © swisstopo – Zeitreise, historische Kartenwerke) |

Layers exposed by the app (`public/data/overlays.json`, from the capabilities
document):

| Layer | Title | Editions (`Time` values) |
| --- | --- | --- |
| `ch.swisstopo.zeitreihen` | Zeitreise – Kartenwerke | 178 values, `YYYYMMDD` 18441231 … 20211231 (the service advertises 1844 but serves empty tiles before 1849; the app skips such editions after probing) |
| `ch.swisstopo.hiks-siegfried` | Siegfriedkarte 1:25 000 | 80 values, `YYYY` 1870 … 1949 |
| `ch.swisstopo.hiks-dufour` | Dufourkarte Erstausgabe | `current` |
| `ch.swisstopo.swissimage-product` | SWISSIMAGE Zeitreise (Luftbilder) | 100 values, `YYYY` 1926 … 2025 + `current` |
| `ch.swisstopo.swissimage-product_1946` | SWISSIMAGE 1946 | `1946` |
| `ch.swisstopo.pixelkarte-farbe-pk25.noscale` | Landeskarte 1:25 000 | 76 |
| `ch.swisstopo.pixelkarte-farbe-pk50.noscale` | Landeskarte 1:50 000 | 90 |
| `…pk100/pk200/pk500/pk1000`, `…grau-pk1000` | Landeskarten 1:100 000 … 1:1 Mio. | 1 each |

Base maps of the application (switchable on the map, owner: zurich-maps-2):
`ch.swisstopo.pixelkarte-farbe` (default), `ch.swisstopo.pixelkarte-grau` and
`ch.swisstopo.swissimage` (air photo) — same documented WMTS template and
`3857` matrix set, each credited on the map (`© swisstopo`, `?base=` in the link).

Verification evidence:

```
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.zeitreihen/default/18831231/3857/12/2145/1434.png
    -> 200 image/png, access-control-allow-origin: *
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.hiks-siegfried/default/1900/3857/12/2145/1434.png
    -> 200 image/png  (~153 kB, Zürich sheet)
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage-product_1946/default/1946/3857/12/2145/1434.jpeg
    -> 200 image/jpeg (~24 kB, Zürich aerial)
GET https://api3.geo.admin.ch/rest/services/api/SearchServer?searchText=Zürich&type=locations&sr=4326
    -> 200 application/json (label "Zürich (ZH)", lat/lon, geom_st_box2d)
GET https://wmts.geo.admin.ch/EPSG/3857/1.0.0/WMTSCapabilities.xml
    -> 200 (1.7 MB); the three base layers are listed there with style id =
       layer id, format image/jpeg, matrix sets 3857_19 (farbig, grau) and
       3857_20 (swissimage) — retrieved 2026-10-19
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.pixelkarte-grau/default/current/3857/12/2143/1432.jpeg
    -> 200 image/jpeg, access-control-allow-origin: *
GET https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissimage/default/current/3857/12/2143/1432.jpeg
    -> 200 image/jpeg, access-control-allow-origin: *
```

Preview/thumbnail rule: every `overlay` record stores the tile URL the harvest
actually verified as non-empty (`thumbnailPlace` names the probe location, Zürich
first). Editions whose advertised tiles are empty at every probe location are left
out and listed in `records.json` `skipped` (e.g. Zeitreise 1844–1848).

Note: the `zoomlevel` attribute of some search results is a uint32 bitfield
(e.g. `4294967295`); the Worker drops implausible values instead of passing them on.

## 3. Local fixture provider

The committed registry contains only the real providers documented in this file.
Tests that need synthetic records build them in memory (`tests/records.test.mjs`
and the provider-specific regressions), so no fixture metadata can appear in the
public data or the UI.

## 4. historical-basemaps — historical borders (the History view)

The **Borders through time** view (`?view=history`, `public/app/history.js`) draws
dated territorial polygons from a primary community dataset — not from a map
aggregator, and never modern country outlines under a historical map.

| | |
| --- | --- |
| Source | `aourednik/historical-basemaps` — “Collection of georeferenced boundaries of world countries and cultural regions for use in mapping historical data on global or continental scale” |
| Homepage / repository | <https://github.com/aourednik/historical-basemaps> |
| Primary record URL | <https://github.com/aourednik/historical-basemaps/tree/da7a4b735ecef70aebdc9c73e409d8a2500d50f3> (pinned revision) |
| Provider / attribution | Historical Basemaps © André Ourednik and contributors |
| Rights | GNU GPL v3 or later (upstream `LICENSE`); the licence text is bundled at `public/data/history/LICENSE-GPL-3.0.txt` and the same statement appears in the view |
| Identifiers | upstream commit `da7a4b735ecef70aebdc9c73e409d8a2500d50f3`, upstream file names `geojson/world_<year>.geojson`; our derived files `world_<year>.json` |
| Retrieved | 2026-10-19 (`index.json.retrievedAt`); the harvest records the date in its cache manifest so an offline rebuild is byte-stable |
| Endpoints actually used | `https://raw.githubusercontent.com/aourednik/historical-basemaps/<commit>/index.json`, `…/geojson/world_<year>.geojson`, `…/geojson/places.geojson`, `…/LICENSE` — **harvest-time only**; the app reads the bundled files and has no runtime dependency on GitHub |
| Snapshot index | 54 published snapshots, `-123000 … 2010` CE (one file per year, straight from the upstream `index.json`; the app integrates all of them) |
| Fields used | `NAME` (label), `SUBJECTO` (sovereignty / colonial power), `PARTOF` (larger cultural area), `BORDERPRECISION` (1 approximate, 2 moderately precise, 3 determined by international law); `places.geojson`: `name`, `inhabitedSince`, `inhabitedUntil` |
| Our modification | Douglas–Peucker simplification per ring (tolerance 0.05°), rings below 0.02 deg² dropped except each polygon’s largest ring, coordinates quantised to integer millidegrees; all parameters and the caveat are written into `public/data/history/index.json` |

Honesty rules the view enforces (all covered by `tests/history-borders.test.mjs`):

- **Snapshots are discrete maps, not validity ranges.** A date between two
  published maps is drawn as the nearest snapshot and the interface names it
  (“Snapshot 1900 CE — the nearest published map, 1 year after 1899 CE”); a tie
  goes to the earlier map, so a map drawn for 1500 does not silently jump to 1530.
- **Coverage is per snapshot.** The view states how many polities and regions a
  snapshot actually contains; the dataset itself says it is work in progress and
  that borders before the Peace of Westphalia (1648) are conceptual.
- **Uncertainty is visible.** Approximate (1) and unstated (0) borders are drawn
  dashed, moderately precise (2) and internationally determined (3) solid, and the
  details panel spells the value out.
- **No invented geography.** Every polygon, name and date comes from the source;
  the pipeline has no hand-made fallback data.

Refresh: `npm run harvest:history` (network) or `npm run harvest:history:offline`
(cache). `scripts/validate.mjs` is the build gate over the bundle.

## 5. USGS Historical Topographic Map Collection (imported 2026-10-20)

| Field | Value |
| --- | --- |
| Provider record | <https://www.usgs.gov/programs/national-geospatial-program/historical-topographic-maps-preserving-past> |
| Catalogue item | the API's `metaUrl`, e.g. <https://www.sciencebase.gov/catalog/item/5a8a27e9e4b00f54eb3c4854> |
| Discovery API | `https://tnmaccess.nationalmap.gov/api/v1/products?datasets=Historical%20Topographic%20Maps&max=1000&offset=<n>&outputFormat=JSON` (documented at <https://tnmaccess.nationalmap.gov/api/v1/docs>) |
| Identifiers | API `sourceId` (stable ScienceBase id) → `usgs:<sourceId>` |
| Original raster | `urls.GeoTIFF` on `prd-tnm.s3.amazonaws.com`, e.g. `.../HistoricalTopo/GeoTIFF/TN/TN_Morristown_153457_1883_125000_geo.tif`; tiled GeoTIFF with 8 internal images (main + overviews) in the sampled products |
| Original PDF | `urls.GeoPDF`; retained as a download, not used for the overlay |
| Thumbnail | `previewGraphicURL` (`_tn.jpg` on the same host) |
| Rights | USGS: “USGS-authored or produced data and information are considered to be in the U.S. Public Domain.” <https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits> (retrieved 2026-10-20; the FAQ URL returns 403 to non-browser clients, the copyrights page is the primary policy used) |
| Attribution | “U.S. Geological Survey” |
| Publication dates | 1883–1994 in the bundled slice, 53 state/territory/foreign codes (adds GU; `IT` is retained verbatim from the upstream state field), scales 1:10,000, 1:12,000, 1:20,000, 1:21,120, 1:24,000, 1:100,000, 1:125,000 and 1:192,000 |

The TNM API returns about **186,061** HTMC products. The bundle imports a
reproducible prefix of 23,945 products (twenty-four 1,000-product pages; 55
products had no delivered GeoTIFF and were withheld). The prefix is split into
three registered shards (`usgs.json` 19.22 MiB / 11,947 records, `usgs-2.json`
9.71 MiB / 6,000 and `usgs-3.json` 9.74 MiB / 5,998) so no static asset
approaches the 25 MiB limit.
`records.json.selection["usgs:htmc"].resumable.nextOffset` records where the
next run continues (24000):

```
node scripts/harvest-usgs.mjs --pages 6
node scripts/harvest-usgs.mjs --start-offset 6000 --pages 6
node scripts/harvest-usgs.mjs --start-offset 12000 --pages 6 --shard usgs-2
node scripts/harvest-usgs.mjs --start-offset 18000 --pages 6 --shard usgs-3
```

`--shard <name>` selects the target shard; records already in other shards are
preserved and only the new slice is appended to the named one.

Each record keeps the product title, publication date (never the depicted
period), USGS footprint and the original GeoTIFF URL. Date evidence: every
bundled title ends in a single edition year and that year equals the API
`publicationDate` for all 23,945 records (`titleEditionYearMismatches: 0` in the
selection), so the field is not a hidden digital-upload date; no depicted or
survey date is inferred. The GeoTIFF is labelled
`georeference.kind = "cog"` with `status = "provider-supplied"` because the
product carries its own tiled pixel georeferencing; the catalogue bounding box
is **not** used as an image transform. The Worker's `/api/raster` now accepts
only the public HTMC staging prefix in addition to Stanford COGs, still
requiring a bounded byte range and rejecting redirects. This exposed and fixed
three pre-existing defects in the native-raster path: Workerd rejects
`redirect: "error"` (now `manual` plus an explicit 3xx rejection); the
“Overlay this georeferenced map” button updated the URL but never emitted
`overlay:changed` until reload; and USGS user-defined projections
(`ProjectedCSTypeGeoKey = 32767`) failed CRS conversion because the converter
saw both a placeholder projected code and the geographic datum. The CRS fix
keeps the geographic datum and drops only the 32767 placeholder. Regression
tests cover all three.

Live verification on 2026-10-20: 8/8 sampled previews returned 206
`image/jpeg`, 8/8 GeoTIFF range reads returned 206 `image/tiff` with TIFF magic
and a truthful `Content-Range`, and 8/8 were parsed by `geotiff.js` with 8
images and GeoKeys (`GTModelTypeGeoKey = 1`, user-defined projected CRS 32767
with geographic CRS 4267 in the sample). All eight passed the browser
renderer's own `rasterProjection()` conversion, not just TIFF-tag parsing; a
real end-to-end browser render of the Morristown sheet through
`/api/raster` reached “Provider-supplied georeferencing”. A representative
example:
`usgs:5a8a27e9e4b00f54eb3c4854` — “USGS 1:125000-scale Quadrangle for
Morristown, TN 1883”. Live `/api/catalogue?source=usgs` search was also verified
through the local Worker (2453 products for a Tennessee/North Carolina bbox,
12/12 records admitted with thumbnails and GeoTIFF georeferences). The upstream
TNM query is slow (about 17–29 s for a cold bbox query); the Worker timeout is
30 s, results are edge-cached for 10 minutes, and the bundled catalogue remains
usable when the upstream is unavailable.

The 186,061 total is not claimed as bundled coverage. The remaining products
stay reachable through the live USGS search and through the recorded cursor.

## 6. SLUB Dresden — Karten und Ansichten (imported 2026-10-20)

The Sächsische Landesbibliothek – Staats- und Universitätsbibliothek Dresden
publishes the documented OAI-PMH set `maps` (“Karten und Ansichten”) in
`metadataPrefix=mets`. The set reports **161 records**; **105** are imported
into `/data/records/slub.json` and 56 are withheld with reasons.

| Field | Value |
| --- | --- |
| Discovery | `https://digital.slub-dresden.de/oai/?verb=ListRecords&metadataPrefix=mets&set=maps` (7 pages, resumption tokens) |
| Record | `https://digital.slub-dresden.de/id285992066` (example); PURL/URN retained |
| Rights (item) | MODS `accessCondition type="use and reproduction"` → Public Domain Mark 1.0, corroborated by `dv:license=pdm` and `slubarchiv:copyrightStatus=publicdomain` |
| Rights (policy) | SLUB “Nutzungsbestimmungen für die Digitalen Sammlungen”, <https://nutzungshinweis.slub-dresden.de/> (retrieved 2026-10-20): digitised objects whose copyright has expired are made available under PDM 1.0; the source citation (SLUB Dresden, PURL/URN, licence) is required |
| Metadata reuse | Declared `basis-recorded` on 2026-10-20: the redistributed fields are the factual description published with a PDM 1.0 object, and SLUB's [Nutzungsbestimmungen](https://nutzungshinweis.slub-dresden.de/) states that PDM 1.0 objects may be copied, modified, distributed and performed, even commercially, with the required source citation. SLUB publishes no separate metadata licence, so none is asserted; the PDM statement is not stretched to the rights-reserved/CNE objects. Evidence: `coordination/metadata-rights-decision-20261020.md`. |
| Images | Per-item ORIGINAL JPEG and PDF bitstreams from `digital.slub-dresden.de`; no IIIF service is invented. The bitstreams sit behind SLUB’s Anubis bot check for browser user agents, so no `<img>` thumbnail is shipped (it would render a challenge page); the original scan/PDF links and the record page are exposed instead. |
| Withheld | 48 records state “Freier Zugang - Rechte vorbehalten 1.0” and 8 are `rightsstatements.org/vocab/CNE/1.0/` (Copyright Not Evaluated); none is labelled public domain |
| Verification | 24/24 sampled original JPEGs and 24/24 record pages returned HTTP 200/206 with the harvest user-agent. A Chrome user-agent receives SLUB’s Anubis challenge (`text/html`) for the same bitstream, recorded honestly in the selection’s `browserNote`; browser access is via the record page. |
| Dates | 105/105 dated, publication span 1536–1909; no depicted date, extent or place is inferred |

Example: `slub:285992066` — “Atlas selectus von allen Königreichen und Ländern
der Welt”, Johann Georg Schreiber, Leipzig 1730, 155 digitised pages, PDM 1.0.
The Kartenforum / Deutsche Fotothek search index is **not** imported: its public
index has no per-record rights field, so it remains research-only.

## Fetching policy (politeness, caching, failure behaviour)

- **Bounded harvest**: `scripts/fetch-records.mjs` requests the documented OAI-PMH
  pages (32 `zuz` + 30 `landkarten` + 6 `cartesgeneve` + 6 `museecarto`, with
  resumption tokens), thirteen SRU pages (thirteen CQL queries, 100 records
  each), one IIIF manifest and one DOI landing page per candidate title, one
  `GetRecord` confirmation per SRU candidate, and the WMTS
  capabilities document, with a descriptive `User-Agent`
  (`Kartenzeit/1.0 (Canton-Zurich design study; contact: project maintainers)`).
  At most 3 concurrent requests with a short pause between them, and every
  upstream response (including tile probes) is cached under `.cache/fetch/`
  (git-ignored) so `--offline` reproduces the committed data without network
  access; a cold full refresh takes a few minutes, a warm one ~110 s, and the
  harvest is never part of the build.
- **Edge caches in the Worker**: `/api/search/places` 5 minutes,
  `/api/fetch` 1 hour, `/api/records|layers|sources` 5 minutes.
- **Timeouts**: 8 s per upstream call (`AbortSignal.timeout`), abortable client
  fetches in the place search.
- **Allowlist**: literal host + path prefixes only (`src/worker/allowlist.js`);
  everything else is `403 host_not_allowed`. No credentials anywhere.
- **Outage behaviour**: UI states are explicit — the place search falls back to
  local title suggestions and says so; map tiles, thumbnails and IIIF previews
  degrade to labelled placeholders with a link to the provider; the record list
  keeps working from the committed JSON.

## Dates — publication vs depiction

`yearStart`/`yearEnd` are the **publication** years from the imprint;
`depictedYearStart`/`depictedYearEnd` are the dates **shown on the map** and are
only filled when the upstream statement documents them, with the verbatim
evidence in `depictedSource` (27 of the 199 records; the rest stay `null`, which the
detail panel labels “vom Anbieter nicht angegeben”). The filter uses publication
years, and the UI says so (“Zeitraum (Publikationsjahr)”), so the detail panel's
“Zeitraum dieses Blattes filtern” button also feeds the *publication* range — with
the Wildkarte sheets (published 1853, surveyed 1843–1851) a depicted-period filter
would hide the very sheet it came from. `scripts/validate.mjs` enforces the
invariants: depicted dates come in pairs, never postdate the imprint, and always
carry `depictedSource`.

## Endpoint verification (online)

`scripts/validate.mjs` and `npm test` are offline by design, so a refresh could
leave a dead link behind without any check noticing. `npm run verify:endpoints`
(`scripts/verify-endpoints.mjs`) is the online counterpart: it reads
`public/data/records.json` and `overlays.json`, collects every distinct URL they
promise (original record, library viewer, thumbnail, IIIF manifest, first-canvas
image service, WMTS preview tile), probes each one once with a descriptive
`User-Agent`, a 20 s timeout and 4 concurrent requests, prints a per-kind summary
and exits non-zero when anything stops answering 200 (`--json <file>` writes the
full report, `--offline` only lists the URLs, `--limit n` probes a prefix).

Last full run — **2026-10-19, 984 distinct URLs, 0 failures** on the 213-record
seed (default `--concurrency 4 --retries 2`; **no URL needed a retry**):

| Kind | Result |
| --- | --- |
| original record (DOI landing page / `map.geo.admin.ch` viewer) | 213/213 |
| thumbnail (IIIF `…/full/304/0/default.jpg` / WMTS tile) | 213/213 |
| library viewer (`…/content/zoom/<id>`) | 186/186 |
| IIIF manifest (`…/i3f/v20/<titleId>/manifest`) | 186/186 |
| IIIF image service (`…/info.json`) | 186/186 |

The earlier run on the 169-record seed (756 URLs) needed 23 retries at
`--concurrency 2`, so **transient 5xx are still retried: e-rara's DOI landing
pages throttle.** On the same seed at `--concurrency 4` 21 `record` URLs answered
**500** once; three consecutive hand probes of one of them answered 200, 200,
500, so those are load artefacts, not dead links. The script retries `429`, `5xx`
or a timeout a bounded number of times (`--retries n`, default 2, with a
600 ms · n backoff) and prints how many URLs needed the retry. A future full
check should keep the request rate modest (`--concurrency 2`) rather than read a
500 as a dead link.

The script is deliberately *not* part of `npm run check`: the gate stays offline,
hermetic and fast, and this check needs the network.

## Leventhal Map & Education Center — Boston Public Library (imported 2026-10-20)

> **Withheld 2026-10-20 (metadata reuse):** this scope's per-item image rights
> are documented, but no primary metadata-reuse licence or other substantiated
> redistribution basis was established. The full harvested shard and evidence
> are now in `research/withheld/` and are **not** part of the shipped catalogue
> or served assets. The counts and verification below describe the harvest,
> not current bundled coverage. See `research/withheld/README.md`.

The catalogues at `collections.leventhalmap.org` are a Blacklight application
over the Digital Commonwealth repository. The documented JSON view is
`https://collections.leventhalmap.org/search.json`; a complete cartographic
inventory is `q=&per_page=100&page=N&f%5Bgenre_basic_ssim%5D%5B%5D=Maps`
(15,233 records in 153 pages on 2026-10-20). The importer is
`scripts/harvest-leventhal.mjs` (cached pages, resumable, no dependencies).

Imported scope: every Boston Public Library record in the complete **Boston and
New England Maps**, **American Revolutionary War-Era Maps**, **Maritime Charts
and Atlases** and **Urban Maps** collections whose catalogue entry carries an
affirmative rights determination — **10,242 records**, publication years
1478–2021. Partner-held items in the same discovery feed (British Library,
Library of Congress, Clements, Phillips Academy, …) are not imported: they are
other institutions' collections. The shard is
`public/data/records/leventhal.json`; the core document keeps the selection
evidence and the provider registry.

Rights are read per record, not from public access. The bundled records have
`rights_ss` *No known copyright restrictions.* plus `license_ss` *No known
restrictions on use.* and `reuse_allowed_ssi` *no restrictions* (**10,231**), or
an explicit CC BY licence (**11**). Every record keeps the verbatim
`rightsStatement` and `licenseStatement`, a `rightsPolicyUrl` to Digital
Commonwealth's [copyright & terms page](https://www.digitalcommonwealth.org/copyright),
and a per-item `metadataSource` JSON URL. A licence URI (`rightsUrl`) is stored
only where the item states one: all 11 CC BY items name
`https://creativecommons.org/licenses/by/4.0/` in their own IIIF manifest, which
also supplies the stated `attribution`; the version (`4.0`) and credit are kept
per item. No known-copyright statement is relabelled public domain or CC0, and
no licence version is inferred when the item does not state it.

`Rights status not evaluated.`, `Contact host institution`, all-rights-reserved,
CC BY-NC/NC-SA/NC-ND, permission-required and copyright-undetermined records are
withheld and counted in `records.json.selection["leventhal:bpl"]`.

Identifiers and endpoints: record page
`https://collections.leventhalmap.org/search/commonwealth:<id>`, ARK
`https://ark.digitalcommonwealth.org/ark:/50959/<id>`, IIIF manifest
`https://ark.digitalcommonwealth.org/ark:/50959/<id>/manifest`, image service
`https://iiif.digitalcommonwealth.org/iiif/2/commonwealth:<imageId>`, thumbnail
`…/full/304,/0/default.jpg`. Attribution: *Norman B. Leventhal Map & Education
Center, Boston Public Library*. Stable example: `leventhal:commonwealth:5712tb01h`
(“Map of Washington ; map of Cincinnati”, 1880–1889). A deterministic 30-record
sample verified on 2026-10-20 returned 30/30 HTTP 200 thumbnails and 30/30
`info.json` responses; the full sample is recorded under the provider's
`verification` field in `public/data/sources.json`.

The metadata endpoints are documented at
`https://www.digitalcommonwealth.org/api`. That page states the API's purpose:
"APIs ... provide programmatic machine-based interaction with metadata and image
content from items in the Digital Commonwealth collections, allowing this
content to be used in other applications and data services." On 2026-10-20
the scope was re-reviewed and **stayed withheld**: that sentence documents
machine access, not a metadata-redistribution licence; Digital Commonwealth/BPL
publish no separate metadata licence, and the [copyright page](https://www.digitalcommonwealth.org/copyright)
places no restrictions on public-domain material while leaving each item's own
statement as the image gate. The primary quotes are retained in
`coordination/metadata-rights-decision-20261020.md` for a future clearance
review. The metadata status is `withheld`, not "pending" and not "cleared".
One upstream quirk is recorded in the harvester: an ARK manifest request with
`Accept: application/json` alone gets a 404, while `application/ld+json`
returns the IIIF manifest. The importer asks for the latter and verifies the
JSON response; it does not treat the 404 as a rights decision.

The harvest admitted the Boston Public Library scope described above; it is now **withheld** from the shipped catalogue for lack of a metadata-reuse licence. The 4,828
partner-held records in the same discovery feed remain excluded, and 163
BPL-held records are withheld by the rights/metadata gate; none is counted as
coverage. The shard is 16.73 MiB and the core is 9.57 MiB, both below
Cloudflare's per-asset limit; the loader merges shards at runtime.

## Digital Commonwealth partner collections (imported 2026-10-20)

> **Withheld 2026-10-20 (metadata reuse):** this scope's per-item image rights
> are documented, but no primary metadata-reuse licence or other substantiated
> redistribution basis was established. The full harvested shard and evidence
> are now in `research/withheld/` and are **not** part of the shipped catalogue
> or served assets. The counts and verification below describe the harvest,
> not current bundled coverage. See `research/withheld/README.md`.

Digital Commonwealth is the Massachusetts statewide digital-library service
operated by the Boston Public Library; its documented JSON/IIIF API is the same
one used by the Leventhal lane. This separate lane imports the **partner-held**
cartographic records that are outside BPL's own scope and names the contributing
institution on every record: **972 maps** from seven institutions — Massachusetts
Archives (727), Phillips Academy (136), Lucius Beebe Memorial Library (68),
New-York Historical Society (25), Filson Historical Society (13), George
Washington Presidential Library at Mount Vernon (2) and the National Archives and
Records Administration (1). Publication years span 1540–2000. The shard is
`public/data/records/digitalcommonwealth.json` (1.53 MiB).

Rights are read per record from the contributing institution's catalogue entry
with the Leventhal rights gate: 823 no-known-copyright + no-restrictions-on-use,
136 CC0 (Phillips Academy) and 13 NoC-US. Non-commercial CC licences,
rights-not-evaluated, contact-host, permission-required and all-rights-reserved
records are excluded; 157 records held by a private collector with no named
institution are also excluded rather than presented as an institution. Every
record keeps its verbatim rights/licence statement, policy URL, per-item
metadata URL and credit line. A deterministic 30-record sample (2026-10-20)
returned **30/30** thumbnail and **30/30** IIIF `info.json` HTTP 200 responses.
Example: `digitalcommonwealth:commonwealth:2227nq92q` (Massachusetts Archives).

The 4,828 partner-held records are *not* all imported: only the 972 with an
affirmative rights determination are; the rest remain visible research scope and
are not counted as coverage. This is one consortium provider with real holding
institutions, not an inflation of the provider count by splitting a feed. The
same metadata-reuse review (2026-10-20) applies here: the documented API
sentence describes machine access, not a redistribution licence, so this
partner-held scope is withheld with BPL/Leventhal and its per-item image rights
are unchanged. Evidence: `coordination/metadata-rights-decision-20261020.md`.
