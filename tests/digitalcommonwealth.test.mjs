/**
 * Digital Commonwealth partner-held maps: the consortium scope must complement
 * the BPL/Leventhal scope, name the contributing institution, and apply the
 * same affirmative-rights gate without relabelling a statement.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { recordOf } from '../scripts/harvest-leventhal.mjs';

const base = {
  id: 'commonwealth:abc123',
  attributes: {
    title_info_primary_tsi: 'A plan of the town',
    genre_basic_ssim: ['Maps'],
    type_of_resource_ssim: ['Cartographic'],
    physical_location_ssim: ['Massachusetts Archives'],
    collection_name_ssim: ['Massachusetts Archives maps'],
    date_start_dtsi: '1800-01-01T00:00:00Z',
    date_end_dtsi: '1800-12-31T23:59:59Z',
    identifier_iiif_manifest_ss: 'https://ark.digitalcommonwealth.org/ark:/50959/abc123/manifest',
    exemplary_image_ssi: 'commonwealth:img123',
    rights_ss: 'No known copyright restrictions.',
    license_ss: 'No known restrictions on use.',
    reuse_allowed_ssi: 'no restrictions',
  },
};

test('a partner-held affirmative record is admitted with its own institution and provider', () => {
  const record = recordOf(structuredClone(base), { scope: 'partner' });
  assert.equal(record.id, 'digitalcommonwealth:commonwealth:abc123');
  assert.equal(record.providerId, 'digitalcommonwealth');
  assert.equal(record.institution, 'Massachusetts Archives');
  assert.equal(record.creditLine, 'Massachusetts Archives');
  assert.equal(record.rightsStatement, 'No known copyright restrictions.');
  assert.equal(record.rightsUrl, undefined, 'no licence URI is fabricated');
  assert.equal(record.rightsPolicyUrl, 'https://www.digitalcommonwealth.org/copyright');
});

test('BPL-held records stay in the Leventhal scope and private collectors are not institutions', () => {
  const bpl = structuredClone(base);
  bpl.attributes.physical_location_ssim = ['Boston Public Library'];
  assert.equal(recordOf(bpl, { scope: 'partner' }), null);
  assert.equal(recordOf(structuredClone(base), { scope: 'bpl' }), null);
  const privateCollection = structuredClone(base);
  privateCollection.attributes.physical_location_ssim = ['Private Collection'];
  assert.equal(recordOf(privateCollection, { scope: 'partner' }), null);
});

test('the partner scope uses the same affirmative-rights gate', () => {
  const nc = structuredClone(base);
  nc.attributes.license_ss = 'This work is licensed for use under a Creative Commons Attribution Non-Commercial Share Alike License (CC BY-NC-SA).';
  nc.attributes.reuse_allowed_ssi = 'creative commons';
  assert.equal(recordOf(nc, { scope: 'partner' }), null);
  const evaluated = structuredClone(base);
  evaluated.attributes.rights_ss = 'Rights status not evaluated.';
  assert.equal(recordOf(evaluated, { scope: 'partner' }), null);
  const contact = structuredClone(base);
  contact.attributes.license_ss = 'Contact host institution for more information.';
  contact.attributes.reuse_allowed_ssi = 'contact host';
  assert.equal(recordOf(contact, { scope: 'partner' }), null);
});
