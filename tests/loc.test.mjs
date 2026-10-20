import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  locItemRecord,
  locRejection,
  locResumeState,
  locRightsBasis,
  locThumbnail,
  locYearRange,
} from '../scripts/harvest-loc.mjs';

const divisionRights =
  'The content of the Library of Congress Geography and Map Division digitized collections is free to use and reuse unless a Rights Advisory statement is present that indicates otherwise.';

function item(overrides = {}) {
  return {
    id: 'http://www.loc.gov/item/99447025/',
    title: 'Western border states',
    date: '1861',
    partof: [
      { title: 'civil war maps' },
      { title: 'geography and map division' },
    ],
    rights: [divisionRights],
    image_url: [
      'https://tile.loc.gov/storage-services/service/gmd/g3882m/g3882m/g99447025.gif',
      'https://tile.loc.gov/image-services/iiif/service:gmd:g3882m:g3882m:g99447025/full/pct:25/0/default.jpg#h=100&w=100',
    ],
    iiif_manifest_url: 'https://www.loc.gov/item/99447025/manifest.json',
    contributor_names: ['Hotchkiss, Jedediah'],
    created_published: ['[1861]'],
    languages: [{ english: 'https://www.loc.gov/search/?fa=language:english' }],
    subjects: [{ 'united states': 'https://www.loc.gov/search/?fa=subject:united+states' }],
    call_number: ['G3881 1861 .H6'],
    source_modified: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

test('builds a record from a division item and keeps the verbatim rights text', () => {
  const record = locItemRecord({ item: item() });
  assert.equal(record.id, 'loc:99447025');
  assert.equal(record.providerId, 'loc');
  assert.equal(record.institution, 'Library of Congress, Geography and Map Division');
  assert.equal(record.rights, divisionRights);
  assert.equal(record.rightsBasis, 'division-free-to-use-and-reuse');
  assert.equal(record.yearStart, 1861);
  assert.equal(record.yearEnd, 1861);
  assert.deepEqual(record.creators, ['Hotchkiss, Jedediah']);
  assert.equal(record.collection, 'Civil War Maps');
  assert.equal(
    record.thumbnail,
    'https://tile.loc.gov/image-services/iiif/service:gmd:g3882m:g3882m:g99447025/full/pct:25/0/default.jpg',
  );
  assert.equal(
    record.imageService,
    'https://tile.loc.gov/image-services/iiif/service:gmd:g3882m:g3882m:g99447025',
  );
  assert.equal(record.recordUrl, 'https://www.loc.gov/item/99447025/');
});

test('accepts the Sanborn collection public-domain statement on its own evidence', () => {
  const sanborn = item({
    id: 'http://www.loc.gov/item/sanborn06198_040/',
    date: '1942',
    partof: [{ title: 'sanborn maps' }, { title: 'geography and map division' }],
    rights: [
      'The content of the Library of Congress online Sanborn Maps Collection is in the public domain and is free to use and reuse.',
    ],
  });
  const record = locItemRecord({ item: sanborn });
  assert.ok(record);
  assert.equal(record.rightsBasis, 'sanborn-public-domain');
  assert.equal(record.collection, 'Sanborn Fire Insurance Maps');
  assert.equal(record.yearStart, 1942);
});

test('withholds an item whose Rights Advisory states a restriction', () => {
  const restricted = item({ rights_advisory: 'In copyright. Permission required.' });
  assert.equal(locRightsBasis(restricted), null);
  assert.equal(locItemRecord({ item: restricted }), null);
  assert.match(locRejection(restricted), /rights advisory/);
});

test('withholds public access without an affirmative rights statement', () => {
  const noRights = item({ rights: [] });
  assert.equal(locRightsBasis(noRights), null);
  assert.equal(locItemRecord({ item: noRights }), null);
});

test('requires the Geography and Map Division provenance', () => {
  const other = item({ partof: [{ title: 'catalog' }] });
  assert.equal(locRightsBasis(other), null);
  assert.match(locRejection(other), /outside Geography and Map Division/);
});

test('requires a delivered IIIF image service, not only a storage GIF', () => {
  const gifOnly = item({
    image_url: ['https://tile.loc.gov/storage-services/service/gmd/g3882m/g3882m/g99447025.gif'],
  });
  assert.equal(locItemRecord({ item: gifOnly }), null);
  assert.match(locRejection(gifOnly), /IIIF image/);
});

test('parses publication ranges and never invents a year', () => {
  assert.deepEqual(locYearRange('1861-1865'), { start: 1861, end: 1865 });
  assert.deepEqual(locYearRange('[between 1800 and 1899?]'), { start: 1800, end: 1899 });
  assert.deepEqual(locYearRange(''), { start: null, end: null });
  const undated = locItemRecord({ item: item({ date: undefined, dates: [] }) });
  assert.ok(undated);
  assert.equal(undated.yearStart, undefined);
});

test('the IIIF thumbnail parser keeps the JPEG service and drops sizing fragments', () => {
  assert.deepEqual(
    locThumbnail([
      'https://tile.loc.gov/image-services/iiif/service:gmd:a:b/full/pct:12.5/0/default.jpg#h=200&w=100',
      'https://example.invalid/image.jpg',
    ]),
    {
      thumbnail:
        'https://tile.loc.gov/image-services/iiif/service:gmd:a:b/full/pct:12.5/0/default.jpg',
      imageService: 'https://tile.loc.gov/image-services/iiif/service:gmd:a:b',
    },
  );
  assert.deepEqual(locThumbnail([]), { thumbnail: null, imageService: null });
});


test('the LoC cursor advances only after every candidate was fetched', () => {
  const documents = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const queue = documents;
  const complete = locResumeState({
    documents,
    queue,
    fetchedIds: new Set(['a', 'b', 'c']),
    startPage: 2,
    lastPage: 5,
    challenged: null,
    failed: [],
  });
  assert.equal(complete.complete, true);
  assert.equal(complete.nextPage, 6);
  assert.equal(complete.unattemptedCount, 0);

  const challenged = locResumeState({
    documents,
    queue,
    fetchedIds: new Set(['a']),
    startPage: 2,
    lastPage: 5,
    challenged: 'HTTP 429',
    failed: [{ id: 'b', error: 'HTTP 429' }],
  });
  assert.equal(challenged.complete, false);
  assert.equal(challenged.nextPage, 2, 'a challenge must replay, never skip to page 6');
  assert.equal(challenged.unattemptedCount, 2);
  assert.deepEqual(challenged.pendingItems, ['b', 'c']);
});

test('a --max-items truncation and an unattempted candidate both block the cursor', () => {
  const documents = [{ id: 'a' }, { id: 'b' }];
  const truncated = locResumeState({
    documents,
    queue: [{ id: 'a' }],
    fetchedIds: new Set(['a']),
    startPage: 1,
    lastPage: 3,
    challenged: null,
    failed: [],
  });
  assert.equal(truncated.complete, false);
  assert.equal(truncated.nextPage, 1);
  assert.equal(truncated.truncatedByMaxItems, true);
  assert.deepEqual(truncated.pendingItems, ['b']);

  // A successfully fetched but explicitly withheld item is processed, so it
  // does not keep the cursor on the same page.
  const withheld = locResumeState({
    documents,
    queue: documents,
    fetchedIds: new Set(['a', 'b']),
    startPage: 1,
    lastPage: 3,
    challenged: null,
    failed: [],
  });
  assert.equal(withheld.complete, true);
  assert.equal(withheld.nextPage, 4);
});

test('the bundled shard omits the eight dead general-map image services', async () => {
  const shard = JSON.parse(
    await readFile(new URL('../public/data/records/loc.json', import.meta.url), 'utf8'),
  );
  const dead = [
    'loc:00561384',
    'loc:88694044',
    'loc:gm71005209',
    'loc:2006458330',
    'loc:2003682776',
    'loc:2001620473',
    'loc:2001620477',
    'loc:2009580102',
  ];
  for (const id of dead) {
    const record = shard.records.find((value) => value.id === id);
    assert.ok(record, `${id} must stay in the catalogue`);
    // The advertised tile.loc.gov service answered 404 on 2026-10-20. Keeping
    // it would render a broken image; the record and viewer links must remain.
    assert.equal(record.thumbnail, undefined, `${id}: dead thumbnail must not return`);
    assert.equal(record.imageService, undefined, `${id}: dead image service must not return`);
    assert.match(record.imageNote, /HTTP 404/);
    assert.ok(record.recordUrl.startsWith('https://www.loc.gov/item/'));
    assert.ok(record.viewerUrl.startsWith('https://www.loc.gov/resource/'));
    assert.ok(record.rights.length > 0);
  }
  const verification = shard.selection.verification;
  assert.equal(verification.checked, 51);
  assert.equal(verification.imageInfoOk, 43);
  assert.equal(verification.withheldDeadImageServices, 8);
  assert.deepEqual(verification.deadImageServiceIds, dead);
  // The 42 kept services are the ones that answered; do not let a future
  // rebuild silently restore a whole-item service without the collection class.
  const kept = shard.records.filter((record) => record.imageService);
  assert.equal(kept.length, 43);
  for (const record of kept) {
    assert.match(record.imageService, /^https:\/\/tile\.loc\.gov\/image-services\/iiif\/service:gmd:/);
    assert.match(record.imageService, /:gmd(?:\d+m?|3m):/);
  }
});
