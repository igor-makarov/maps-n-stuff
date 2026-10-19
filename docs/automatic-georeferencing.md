# Automatic georeferencing options

Checked 19 October 2026. Georeferencing is strongly preferred, not required for
including a properly licensed scan. These methods can expand overlay coverage
after import; approximate catalogue location is not an image alignment.

| Method | Suitable material | Evidence and limits |
| --- | --- | --- |
| **Grid/sheet recognition** | Consistent topographic series with known sheet layouts, coordinate labels or recoverable sheet IDs/projection. | [Gede and Varga](https://ica-proc.copernicus.org/articles/4/38/2021/) use OpenCV frame detection, Tesseract sheet-ID recognition and GDAL. Their 1,147-sheet Hungarian evaluation reports 75.9% ID recognition; this is series-specific, not a generic ground-accuracy guarantee. |
| **Street-name OCR + street geometry** | Urban insurance maps with readable labels and persistent streets in modern reference data. | [Mapsnap](https://github.com/danvk/mapsnap) targets Sanborns and matches OCR labels against OSM. It produces Allmaps-compatible IIIF Georeference Annotations. It needs a known city/region; it is not a universal map geolocator. |
| **Transfer alignment from another historical map** | Overlapping maps/editions of the same area with recognizable common features. | [Vaienti et al., 2025](https://doi.org/10.1080/15230406.2025.2566789), with [replication code](https://github.com/BeatriceVaienti/georeferencing_propagation), use SuperPoint/SuperGlue, RANSAC and Delaunay consistency to propagate GCPs from aligned anchors to target maps. Suitable anchors are essential. |
| **Road/cadastral/river matching** | Maps with a legible persistent network. | [Pope and Frean, GIScience 2025](https://drops.dagstuhl.de/entities/document/10.4230/LIPIcs.GIScience.2025.11) match salient line intersections to cadastral data. [MaRE](https://github.com/luftj/MaRE) matches segmented map symbols to OSM for topographic series; its repository flags unlicensed third-party code and requests contact before reuse, so it should not be vendored as freely licensed software. |

Mapsnap is a concrete Sanborn candidate: Apache-2.0 application code, CLI,
automatic masks and Allmaps output. Its README reports a September 2026 run on
20 volumes using a coverage-weighted score for fits within 25 feet minus gross
error penalties. That score is not a generic success rate. For example, the
reported Champaign 1915 result places 27/33 pages; the placement fraction and
the separate weighted accuracy score are different quantities. These are the
project's measurements, not measurements on this site's collection.

The propagation repository is MIT for its own code but includes separate
pretrained-network repositories. Check dependency and model-weight licences
before commercial use. The scanned maps and reference data also retain their
own rights; an algorithm does not provide image reuse permission.

Recommended workflow:

1. Include eligible scans, distinguishing missing location, approximate
   catalogue location, automatic alignment and reviewed alignment.
2. Reuse permitted native transforms or existing Allmaps annotations first.
3. Evaluate separate pipelines by map family: sheet/grid recognition for
   regular topographic series, Mapsnap for Sanborns, anchor matching for related
   historical editions. Do not assume one model works across the whole archive.
4. Test a representative pilot with known ground truth and difficult examples.
   Measure placement coverage, held-out landmark errors relative to scale,
   gross errors, compute cost and manual correction time. Permit abstention;
   a confident wrong overlay is a failed result.
5. Keep GCPs, masks, transform/model versions and provenance in a supported
   format such as IIIF Georeference Annotations, with a correction path in
   Allmaps or an equivalent tool. Label automatic results until reviewed.

Changed streets/rivers, obsolete names, multiple insets, decorative borders,
unknown projections and historical distortions remain difficult. OCR or a
vision-language model can propose places/points, but these still need geometric
verification. Low residuals on fitting points are not independent accuracy tests.

Run batch processing outside Worker requests and the routine CF site build;
serve approved versioned artifacts through the catalogue/storage architecture.
No automatic georeferencing tool was installed or run during this research.
