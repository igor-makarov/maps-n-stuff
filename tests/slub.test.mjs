/**
 * SLUB Dresden OAI-PMH `maps` harvest regressions.
 *
 * The feed is METS with MODS and a DFG-viewer rights block. These tests pin the
 * parser, the Public Domain Mark gate and the no-invention rules: a record
 * without a stated date, extent or creator must not acquire one, and a
 * restrictive or undetermined statement must stay out of the reusable
 * catalogue even when another field is permissive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  creatorsOf,
  idOf,
  issuedYears,
  recordFrom,
  recordsOf,
  rightsGate,
  titleOf,
} from '../scripts/harvest-slub.mjs';

const pdmRecord = `<record>
  <header>
    <identifier>oai:de:slub-dresden:db:id-285992066</identifier>
    <datestamp>2024-01-07T18:12:43Z</datestamp>
    <setSpec>maps</setSpec>
  </header>
  <metadata>
    <mets:mets xmlns:mets="http://www.loc.gov/METS/" xmlns:mods="http://www.loc.gov/mods/v3"
      xmlns:dv="http://dfg-viewer.de/" xmlns:slubarchiv="http://slubarchiv.slub-dresden.de/rights1"
      xmlns:xlink="http://www.w3.org/1999/xlink">
      <mets:dmdSec>
        <mets:mdWrap MDTYPE="MODS"><mets:xmlData><mods:mods>
          <mods:titleInfo>
            <mods:title>Atlas selectus von allen Königreichen und Ländern der Welt</mods:title>
            <mods:subTitle>zum beqvemen Gebrauch in Schulen</mods:subTitle>
          </mods:titleInfo>
          <mods:name type="personal">
            <mods:namePart type="family">Schreiber</mods:namePart>
            <mods:namePart type="given">Johann Georg</mods:namePart>
            <mods:displayForm>Schreiber, Johann Georg</mods:displayForm>
            <mods:role><mods:roleTerm type="code" authority="marcrelator">aut</mods:roleTerm></mods:role>
          </mods:name>
          <mods:name type="corporate">
            <mods:displayForm>SLUB Dresden</mods:displayForm>
            <mods:role><mods:roleTerm type="code" authority="marcrelator">own</mods:roleTerm></mods:role>
          </mods:name>
          <mods:name type="corporate">
            <mods:displayForm>LDP Sachsen</mods:displayForm>
            <mods:role><mods:roleTerm type="code" authority="marcrelator">fnd</mods:roleTerm></mods:role>
          </mods:name>
          <mods:originInfo eventType="publication">
            <mods:place><mods:placeTerm type="text">Leipzig</mods:placeTerm></mods:place>
            <mods:publisher>Schreibern</mods:publisher>
            <mods:dateIssued encoding="iso8601" keyDate="yes">1730</mods:dateIssued>
          </mods:originInfo>
          <mods:language><mods:languageTerm type="code" authority="rfc3066">ger</mods:languageTerm></mods:language>
          <mods:physicalDescription><mods:extent>[149] Bl.</mods:extent></mods:physicalDescription>
          <mods:identifier type="purl">http://digital.slub-dresden.de/id285992066</mods:identifier>
          <mods:identifier type="urn">urn:nbn:de:bsz:14-db-id2859920663</mods:identifier>
          <mods:location><mods:shelfLocator>Geogr.A.201.m</mods:shelfLocator></mods:location>
          <mods:accessCondition type="use and reproduction" xlink:href="http://creativecommons.org/publicdomain/mark/1.0/">Public Domain Mark 1.0</mods:accessCondition>
          <mods:accessCondition type="restriction on access" xlink:href="http://purl.org/coar/access_right/c_abf2">Open Access</mods:accessCondition>
          <mods:accessCondition type="slubRightsRecord"><slubarchiv:rightsRecord>
            <slubarchiv:copyrightStatus>publicdomain</slubarchiv:copyrightStatus>
          </slubarchiv:rightsRecord></mods:accessCondition>
        </mods:mods></mets:xmlData></mets:mdWrap>
      </mets:dmdSec>
      <mets:amdSec>
        <mets:rightsMD><mets:mdWrap><mets:xmlData><dv:rights>
          <dv:owner>Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden</dv:owner>
          <dv:license>pdm</dv:license>
        </dv:rights></mets:xmlData></mets:mdWrap></mets:rightsMD>
        <mets:digiprovMD><mets:mdWrap><mets:xmlData><dv:links>
          <dv:presentation>https://digital.slub-dresden.de/id285992066</dv:presentation>
        </dv:links></mets:xmlData></mets:mdWrap></mets:digiprovMD>
      </mets:amdSec>
      <mets:fileSec>
        <mets:fileGrp USE="THUMBS"><mets:file><mets:FLocat xlink:href="https://digital.slub-dresden.de/data/kitodo/atlasevoa_285992066/atlasevoa_285992066_tif/jpegs/00000001.tif.thumbnail.jpg"/></mets:file></mets:fileGrp>
        <mets:fileGrp USE="DEFAULT"><mets:file><mets:FLocat xlink:href="https://digital.slub-dresden.de/data/kitodo/atlasevoa_285992066/atlasevoa_285992066_tif/jpegs/00000001.tif.medium.jpg"/></mets:file></mets:fileGrp>
        <mets:fileGrp USE="ORIGINAL">
          <mets:file><mets:FLocat xlink:href="https://digital.slub-dresden.de/data/kitodo/atlasevoa_285992066/atlasevoa_285992066_tif/jpegs/00000001.tif.original.jpg"/></mets:file>
          <mets:file><mets:FLocat xlink:href="https://digital.slub-dresden.de/data/kitodo/atlasevoa_285992066/atlasevoa_285992066_tif/jpegs/00000002.tif.original.jpg"/></mets:file>
        </mets:fileGrp>
        <mets:fileGrp USE="DOWNLOAD"><mets:file><mets:FLocat xlink:href="https://digital.slub-dresden.de/data/kitodo/atlasevoa_285992066/atlasevoa_285992066_tif/jpegs/00000001.tif.pdf"/></mets:file></mets:fileGrp>
      </mets:fileSec>
    </mets:mets>
  </metadata>
</record>`;

test('SLUB METS parser keeps the item’s own facts', () => {
  assert.equal(idOf(pdmRecord), '285992066');
  assert.deepEqual(titleOf(pdmRecord), {
    title: 'Atlas selectus von allen Königreichen und Ländern der Welt',
    subtitle: 'zum beqvemen Gebrauch in Schulen',
  });
  assert.deepEqual(creatorsOf(pdmRecord), ['Schreiber, Johann Georg'], 'holder and funder roles are not creators');
  assert.deepEqual(issuedYears(pdmRecord), { start: 1730, end: 1730 });
  assert.equal(recordsOf(`<OAI-PMH>${pdmRecord}</OAI-PMH>`).length, 1);
});

test('SLUB recordFrom retains original fields, preview and original scan', () => {
  const { record } = recordFrom(pdmRecord);
  assert.equal(record.id, 'slub:285992066');
  assert.equal(record.title, 'Atlas selectus von allen Königreichen und Ländern der Welt');
  assert.equal(record.subtitle, 'zum beqvemen Gebrauch in Schulen');
  assert.deepEqual(record.creators, ['Schreiber, Johann Georg']);
  assert.equal(record.providerId, 'slub');
  assert.equal(record.institution, 'Sächsische Landesbibliothek - Staats- und Universitätsbibliothek Dresden');
  assert.equal(record.rightsBasis, 'pdm');
  assert.equal(record.rightsUrl, 'https://creativecommons.org/publicdomain/mark/1.0/');
  assert.match(record.recordUrl, /^https:\/\/digital\.slub-dresden\.de\/id285992066$/);
  assert.equal(record.thumbnail, undefined, 'no thumbnail ships while SLUB blocks browser subresource loads');
  assert.match(record.imageUrl, /\.original\.jpg$/);
  assert.match(record.imageNote, /Anubis/);
  assert.equal(record.yearStart, 1730);
  assert.equal(record.yearEnd, 1730);
  assert.equal(record.physicalExtent, '[149] Bl.');
  assert.equal(record.shelfmark, 'Geogr.A.201.m');
  assert.equal(record.urn, 'urn:nbn:de:bsz:14-db-id2859920663');
  assert.ok(record.documents[0].endsWith('.pdf'));
  assert.equal(record.geo, undefined, 'no place is invented');
  assert.equal(typeof record.physicalExtent, 'string', 'the verbatim physical extent is kept');
  assert.equal(record.iiifManifest, undefined, 'no IIIF service is invented');
});

test('SLUB rights gate admits only an affirmative Public Domain Mark', () => {
  assert.equal(rightsGate({
    useStatements: [{ text: 'Public Domain Mark 1.0', href: 'http://creativecommons.org/publicdomain/mark/1.0/' }],
    copyrightStatus: ['publicdomain'],
    viewerLicences: ['pdm'],
  }).basis, 'pdm');
  // The licence may also be corroborated by the viewer fields when the MODS
  // statement is absent.
  assert.equal(rightsGate({ copyrightStatus: ['publicdomain'], viewerLicences: ['pdm'] }).basis, 'pdm');
  // Undetermined, restricted and contradictory records are withheld.
  assert.equal(rightsGate({ useStatements: [{ text: 'Freier Zugang - Rechte vorbehalten 1.0', href: 'http://nutzungshinweis.slub-dresden.de/fz-rv/1.0/' }], copyrightStatus: ['undefined'] }).basis, null);
  assert.equal(rightsGate({ useStatements: [{ text: 'Copyright Not Evaluated', href: 'http://rightsstatements.org/vocab/CNE/1.0/' }] }).basis, null);
  assert.equal(rightsGate({
    useStatements: [{ text: 'Public Domain Mark 1.0 ; All rights reserved', href: 'http://creativecommons.org/publicdomain/mark/1.0/' }],
    copyrightStatus: ['publicdomain'],
  }).basis, null);
  assert.equal(rightsGate({}).basis, null);
});

test('SLUB recordFrom withholds a record without a scan or record URL', () => {
  const noScan = pdmRecord.replace(/<mets:fileGrp USE="ORIGINAL">[\s\S]*?<\/mets:fileGrp>/, '');
  assert.equal(recordFrom(noScan).record, null);
  const noUrl = pdmRecord
    .replace(/<dv:presentation>[^<]+<\/dv:presentation>/, '')
    .replace(/<mods:identifier type="purl">[^<]+<\/mods:identifier>/, '');
  assert.equal(recordFrom(noUrl).record, null);
});

test('SLUB recordFrom does not invent a missing date or extent', () => {
  const undated = pdmRecord
    .replace(/<mods:dateIssued[^>]*>1730<\/mods:dateIssued>/, '')
    .replace(/<mods:physicalDescription>[\s\S]*?<\/mods:physicalDescription>/, '');
  const { record } = recordFrom(undated);
  assert.equal(record.yearStart, undefined);
  assert.equal(record.physicalExtent, undefined);
  assert.equal(record.geo, undefined);
});
