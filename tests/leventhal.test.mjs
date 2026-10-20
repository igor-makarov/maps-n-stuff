/**
 * Leventhal/Boston Public Library rights gate.
 *
 * The bulk importer must never turn public access into reuse permission: a
 * record is admitted only for an affirmative rights determination, and the
 * catalogue's verbatim statements are kept.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichCcBy, rightsBasis, recordOf, rightsEvidence } from '../scripts/harvest-leventhal.mjs';

const base = {
  id: 'commonwealth:abc123',
  attributes: {
    title_info_primary_tsi: 'A chart of Boston harbour',
    genre_basic_ssim: ['Maps'],
    type_of_resource_ssim: ['Cartographic'],
    physical_location_ssim: ['Boston Public Library'],
    collection_name_ssim: ['Boston and New England Maps'],
    date_start_dtsi: '1775-01-01T00:00:00Z',
    date_end_dtsi: '1775-12-31T23:59:59Z',
    identifier_iiif_manifest_ss: 'https://ark.digitalcommonwealth.org/ark:/50959/abc123/manifest',
    exemplary_image_ssi: 'commonwealth:img123',
    identifier_uri_ss: 'https://ark.digitalcommonwealth.org/ark:/50959/abc123',
    rights_ss: 'No known copyright restrictions.',
    license_ss: 'No known restrictions on use.',
    reuse_allowed_ssi: 'no restrictions',
    name_tsim: ['Des Barres, Joseph F. W.'],
    subject_point_geospatial: ['42.36,-71.06'],
  },
};

test('the BPL no-known-restrictions determination is admitted', () => {
  assert.equal(rightsBasis(base.attributes), 'no-known-restrictions');
  const record = recordOf(structuredClone(base));
  assert.equal(record.id, 'leventhal:commonwealth:abc123');
  assert.equal(record.rights, 'No known copyright restrictions. No known restrictions on use.');
  assert.equal(record.yearStart, 1775);
  assert.deepEqual(record.geo, { lat: 42.36, lon: -71.06 });
  assert.match(record.thumbnail, /^https:\/\/iiif\.digitalcommonwealth\.org\/iiif\/2\/commonwealth:img123\/full\/304,\/0\/default\.jpg$/);
});

test('rights-not-evaluated, contact-host and all-rights-reserved records are withheld', () => {
  for (const [rights, license, reuse] of [
    ['Rights status not evaluated.', 'No known restrictions on use.', 'no restrictions'],
    ['No known copyright restrictions.', 'Contact host institution for more information.', 'contact host'],
    ['Copyright (c) Example.', 'All rights reserved.', 'all rights reserved'],
    ['No known copyright restrictions.', 'This work is licensed for use under a Creative Commons Attribution Non-Commercial License (CC BY-NC).', 'creative commons'],
    ['Under copyright.', 'No known restrictions on use.', 'no restrictions'],
    // An open label in a second field cannot cancel an explicit restriction.
    ['Under copyright. All rights reserved.', 'CC0', 'no restrictions'],
  ]) {
    const attributes = { ...base.attributes, rights_ss: rights, license_ss: license, reuse_allowed_ssi: reuse };
    assert.equal(rightsBasis(attributes), null, `${rights} / ${license} must be withheld`);
  }
});

test('an open licence elsewhere cannot override an explicit all-rights-reserved statement', () => {
  // Reproduced from the steering review: contradictory evidence must withhold,
  // not select the permissive half of the pair.
  assert.equal(
    rightsBasis({ rights_ss: 'Under copyright. All rights reserved.', license_ss: 'CC0', reuse_allowed_ssi: 'no restrictions' }),
    null,
  );
  assert.equal(
    rightsBasis({ rights_ss: 'No known copyright restrictions.', license_ss: 'All rights reserved.', reuse_allowed_ssi: 'no restrictions' }),
    null,
  );
  // A real CC0 waiver is still admitted: its legal text is not a restriction.
  const waiver = {
    rights_ss: 'Public domain',
    license_ss: 'This work is in the public domain under a Creative Commons No Rights Reserved License (CC0).',
  };
  assert.equal(rightsBasis(waiver), 'cc0');
});

test('CC0, NoC-US and CC BY are admitted; non-commercial CC licences are not', () => {
  const cc0 = { ...base.attributes, rights_ss: 'Public domain', license_ss: 'This work is in the public domain under a Creative Commons No Rights Reserved License (CC0).' };
  assert.equal(rightsBasis(cc0), 'cc0');
  const noc = { ...base.attributes, rights_ss: 'No Copyright - United States. http://rightsstatements.org/vocab/NoC-US/1.0/' };
  assert.equal(rightsBasis(noc), 'no-copyright-us');
  const by = { ...base.attributes, license_ss: 'This work is licensed for use under a Creative Commons Attribution License (CC BY).' };
  assert.equal(rightsBasis(by), 'cc-by');
  const nc = { ...base.attributes, license_ss: 'This work is licensed for use under a Creative Commons Attribution Non-Commercial Share Alike License (CC BY-NC-SA).' };
  assert.equal(rightsBasis(nc), null);
});

test('partner-held items and non-map documents are not imported', () => {
  const partner = structuredClone(base);
  partner.attributes.physical_location_ssim = ['British Library'];
  assert.equal(recordOf(partner), null);
  const photo = structuredClone(base);
  photo.attributes.genre_basic_ssim = ['Photographs'];
  assert.equal(recordOf(photo), null);
  const outside = structuredClone(base);
  outside.attributes.collection_name_ssim = ['Unrelated collection'];
  assert.equal(recordOf(outside), null);
});

test('rights evidence keeps the catalogue statements and never invents a licence URI', () => {
  const evidence = rightsEvidence(base.attributes, 'commonwealth:abc123');
  assert.equal(evidence.rightsStatement, 'No known copyright restrictions.');
  assert.equal(evidence.licenseStatement, 'No known restrictions on use.');
  assert.equal(evidence.rightsUrl, undefined, 'no licence URI is stated, so none may be fabricated');
  assert.equal(evidence.rightsPolicyUrl, 'https://www.digitalcommonwealth.org/copyright');
  assert.equal(evidence.metadataSource, 'https://collections.leventhalmap.org/search/commonwealth:abc123.json');
  const record = recordOf(structuredClone(base));
  assert.equal(record.rightsPolicyUrl, 'https://www.digitalcommonwealth.org/copyright');
  assert.equal(record.creditLine, 'Norman B. Leventhal Map & Education Center at the Boston Public Library');
});

test('an item-level CC BY licence URI is retained verbatim', () => {
  const attributes = {
    ...base.attributes,
    rights_ss: '(c) Example Holder',
    license_ss: 'This work is licensed for use under a Creative Commons Attribution License (CC BY).',
    license_uri_ss: 'https://creativecommons.org/licenses/by/4.0/',
  };
  const record = recordOf({ ...structuredClone(base), attributes });
  assert.equal(record.rightsBasis, 'cc-by');
  assert.equal(record.rightsUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(record.licenseStatement, 'This work is licensed for use under a Creative Commons Attribution License (CC BY).');
  assert.equal(record.rights, '(c) Example Holder This work is licensed for use under a Creative Commons Attribution License (CC BY).');
});

test('CC BY manifest enrichment adds the stated credit and version without touching other bases', async () => {
  const cc = recordOf({
    ...structuredClone(base),
    attributes: {
      ...base.attributes,
      license_ss: 'This work is licensed for use under a Creative Commons Attribution License (CC BY).',
    },
  });
  const plainRecord = recordOf(structuredClone(base));
  const fetched = [];
  const enriched = await enrichCcBy([cc, plainRecord], async (url) => {
    fetched.push(url);
    return {
      license: 'http://creativecommons.org/licenses/by/4.0/',
      attribution: 'Reproduction from Example, imagery courtesy of the Leventhal Map & Education Center.',
    };
  });
  assert.deepEqual(fetched, [cc.iiifManifest], 'only the CC BY item is fetched');
  assert.deepEqual(enriched, [cc.id]);
  assert.equal(cc.rightsUrl, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(cc.licenseVersion, '4.0');
  assert.match(cc.attribution, /Reproduction from Example/);
  assert.equal(cc.rightsEvidenceSource, cc.iiifManifest);
  assert.equal(plainRecord.attribution, undefined);
});

test('a failed CC BY manifest leaves the catalogue evidence intact and records the gap', async () => {
  const cc = recordOf({
    ...structuredClone(base),
    attributes: {
      ...base.attributes,
      license_ss: 'This work is licensed for use under a Creative Commons Attribution License (CC BY).',
      license_uri_ss: 'https://creativecommons.org/licenses/by/4.0/',
    },
  });
  const enriched = await enrichCcBy([cc], async () => {
    throw new Error('503 upstream');
  });
  assert.deepEqual(enriched, []);
  assert.equal(cc.rightsUrl, 'https://creativecommons.org/licenses/by/4.0/', 'the search-feed URI is retained');
  assert.equal(cc.licenseVersion, undefined, 'an unknown version stays unknown');
  assert.match(cc.rightsEvidenceNote, /503 upstream/);
});
