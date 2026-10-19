/** Product-owned labels are English; historic titles and names remain source transcriptions. */
export const COLLECTION_LABELS = new Map([
  ["Übersichtskarten von Europa und der Welt", "Maps of Europe and the world"],
  [
    "Schweizer Landkarten aus vier Jahrhunderten",
    "Swiss maps across four centuries",
  ],
  [
    "Grundrisse und Situationspläne der Stadt Zürich",
    "Zurich city plans and site maps",
  ],
  ["Pläne aus Zürich (Stadt und Umgebung)", "Zurich city and surroundings"],
  [
    "Zürich und Umgebung (Kanton, Stadt und See)",
    "Zurich canton, city and lake",
  ],
  ["Karten von Genf und seiner Umgebung", "Geneva and surroundings"],
  [
    "Karte des Kantons Zürich 1:25 000 (Wildkarte)",
    "Wild map of Zurich canton, 1:25,000",
  ],
  ["Zeitreise – Kartenwerke", "Historical topographic maps"],
  ["Siegfriedkarte 1:25 000", "Siegfried map series, 1:25,000"],
  ["SWISSIMAGE Zeitreise (Luftbilder)", "Historical aerial imagery"],
  ["Siegfriedkarte 1:25 000 (1870–1949)", "Siegfried map series, 1870–1949"],
  ["Dufourkarte Erstausgabe", "Dufour map, first edition"],
  [
    "SWISSIMAGE HIST (historische Luftbilder)",
    "Historical aerial imagery — Switzerland",
  ],
]);
export const OVERLAY_LABELS = new Map([
  ["ch.swisstopo.zeitreihen", "Swiss historical topographic maps"],
  ["ch.swisstopo.hiks-siegfried", "Siegfried historical map series"],
  ["ch.swisstopo.hiks-dufour", "Dufour map, first edition"],
  [
    "ch.swisstopo.swissimage-product",
    "Historical aerial imagery — Switzerland",
  ],
  ["ch.swisstopo.swissimage-product_1946", "Swiss aerial imagery, 1946"],
]);
export const SWISS_RIGHTS =
  "Swiss Open Government Data; attribution © swisstopo required.";
export function formatCatalogue(recordsDoc, sourcesDoc, overlaysDoc) {
  for (const record of recordsDoc.records) {
    if (COLLECTION_LABELS.has(record.collection)) {
      record.originalCollection ??= record.collection;
      record.collection = COLLECTION_LABELS.get(record.collection);
    }
    // Preserve search aliases when running on an already translated snapshot.
    record.originalCollection ??= [...COLLECTION_LABELS].find(
      ([, english]) => english === record.collection,
    )?.[0];
    if (record.providerId === "swisstopo") {
      record.title = record.title
        .replace(
          "Zeitreise – Kartenwerke, Ausgabe",
          "Historical topographic map, edition",
        )
        .replace(
          "Siegfriedkarte 1:25 000, Ausgabe",
          "Siegfried map 1:25,000, edition",
        )
        .replace(
          "SWISSIMAGE Zeitreise, Luftbild",
          "Historical aerial imagery,",
        );
      record.rights = SWISS_RIGHTS;
      if (record.overlay) record.overlay.attribution = "© swisstopo";
    }
  }
  for (const source of sourcesDoc.providers) {
    if (source.id === "e-rara")
      source.name = "e-rara — historic maps and atlases";
    if (source.id === "swisstopo") source.name = "swisstopo";
    if (source.id === "swisstopo") {
      delete source.endpoints?.basemapTemplate;
      delete source.endpoints?.search;
      delete source.api?.searchServer;
      source.apiHosts = (source.apiHosts ?? []).filter(
        (host) => host !== "api3.geo.admin.ch",
      );
      if (source.api?.mapViewer)
        source.api.mapViewer = source.api.mapViewer.replace(
          "lang=de",
          "lang=en",
        );
    }
    for (const collection of source.collections ?? []) {
      if (COLLECTION_LABELS.has(collection.name))
        collection.name = COLLECTION_LABELS.get(collection.name);
    }
  }
  overlaysDoc.overlays = overlaysDoc.overlays.filter(
    (layer) => !layer.id.startsWith("ch.swisstopo.pixelkarte-"),
  );
  for (const layer of overlaysDoc.overlays) {
    if (OVERLAY_LABELS.has(layer.id)) {
      layer.sourceTitle ??= layer.title;
      layer.title = OVERLAY_LABELS.get(layer.id);
      layer.license = SWISS_RIGHTS;
      layer.attribution = "© swisstopo";
      layer.historical = true;
      layer.coverage = "Switzerland";
    }
  }
  if (overlaysDoc.license?.includes("Quellenangabe"))
    overlaysDoc.license = SWISS_RIGHTS;
  return { recordsDoc, sourcesDoc, overlaysDoc };
}
