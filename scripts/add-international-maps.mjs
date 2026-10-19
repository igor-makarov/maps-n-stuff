#!/usr/bin/env node
/** Merge the audited international selection into a harvested catalogue. No network. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function addInternationalMaps(recordsDoc, sourcesDoc) {
  const selection = JSON.parse(await readFile(new URL('../data/international-maps.json', import.meta.url), 'utf8'));
  const records = selection.maps.map((map) => {
    const [classification, identifier] = map.digitalId.split('.');
    const service = `https://tile.loc.gov/image-services/iiif/service:gmd:${classification.slice(0, 5)}:${classification}:${identifier}`;
    return {
      id: `loc:${map.id}`,
      title: map.title,
      yearStart: map.year, yearEnd: map.year,
      depictedYearStart: null, depictedYearEnd: null,
      creators: map.creators,
      providerId: 'loc', institution: 'Library of Congress, Geography and Map Division',
      rights: map.rights ?? 'Free to use and reuse unless otherwise stated in the original record’s Rights Advisory.',
      recordUrl: `https://www.loc.gov/item/${map.id}/`,
      viewerUrl: `https://www.loc.gov/resource/${map.digitalId}/`,
      thumbnail: `${service}/full/304,/0/default.jpg`,
      imageService: service,
      iiifManifest: `https://www.loc.gov/item/${map.id}/manifest.json`,
      type: 'map', collection: 'World maps — Library of Congress',
      subjectPlace: map.subjectPlace, languages: [map.language],
      extent: null, geo: map.anchor ?? null,
      geoNote: map.anchor
        ? 'Approximate place anchor for orientation, based on the named catalogue location. It is not the map’s centre or boundary; the map extent has not been verified.'
        : 'No verified geographic extent or point is available. Browse the original record for details.',
      metadataSource: `https://www.loc.gov/item/${map.id}/`,
    };
  });
  recordsDoc.records = [...recordsDoc.records.filter((r) => r.providerId !== 'loc'), ...records];
  recordsDoc.selection ??= {};
  recordsDoc.selection['loc:international'] = { considered: records.length, kept: records.length, rule: selection.method };
  sourcesDoc.providers = sourcesDoc.providers.filter((p) => p.id !== 'loc');
  sourcesDoc.providers.push({
    id: 'loc', name: 'Library of Congress',
    operator: 'Library of Congress, United States',
    homepage: 'https://www.loc.gov/maps/',
    rights: 'See each original catalogue record for its Rights Advisory. Geography and Map Division material is generally free to use and reuse unless otherwise stated.',
    attribution: 'Library of Congress, Geography and Map Division',
    retrieved: selection.retrieved,
    api: { catalogue: 'https://www.loc.gov/item/{id}/?fo=json', manifest: 'https://www.loc.gov/item/{id}/manifest.json', image: 'https://tile.loc.gov/image-services/iiif/', documentation: 'https://www.loc.gov/apis/' },
    method: selection.method,
  });
  // Display names are ours. Original titles, institution names and rights stay in the records.
  for (const provider of sourcesDoc.providers) {
    if (provider.id === 'e-rara') provider.name = 'e-rara — digitised maps from Swiss libraries';
    if (provider.id === 'swisstopo') provider.name = 'swisstopo — Swiss historical map layers';
  }
  sourcesDoc.note = 'Historical maps from primary institutional catalogues, including a curated international Library of Congress selection. Coverage varies by region and period; metadata keeps original titles and rights statements.';
  return { recordsDoc, sourcesDoc };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = resolve(process.argv[2] || 'public/data');
  const recordsDoc = JSON.parse(await readFile(resolve(dir, 'records.json'), 'utf8'));
  const sourcesDoc = JSON.parse(await readFile(resolve(dir, 'sources.json'), 'utf8'));
  await addInternationalMaps(recordsDoc, sourcesDoc);
  await writeFile(resolve(dir, 'records.json'), JSON.stringify(recordsDoc, null, 2) + '\n');
  await writeFile(resolve(dir, 'sources.json'), JSON.stringify(sourcesDoc, null, 2) + '\n');
  console.log(`Catalogue: ${recordsDoc.records.length} maps, ${sourcesDoc.providers.length} providers`);
}
