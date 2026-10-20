import test from "node:test";
import assert from "node:assert/strict";
import { stanfordRecord, parseEnvelope } from "../scripts/stanford-records.mjs";
import {
  openImageRights,
  locRecord,
  leventhalRecord,
  usgsRecord,
  catalogueResponse,
} from "../src/worker/catalogue.js";

// Representative institutional schema fixtures, not imported collection records.
const metadata = () => ({
  id: "stanford-ab123cd4567",
  dct_title_s: "An undated map",
  dct_accessRights_s: "Public",
  gbl_resourceClass_sm: ["Maps"],
  dct_rights_sm: ["This work is in the public domain."],
  dct_license_sm: ["https://creativecommons.org/publicdomain/mark/1.0/"],
  dct_references_s: JSON.stringify({
    "http://schema.org/url": "https://purl.stanford.edu/ab123cd4567",
  }),
});
test("rights-cleared scans survive missing dates, thumbnails, extents and alignment", () => {
  const record = stanfordRecord(metadata(), "fixture.json");
  assert.ok(record);
  for (const field of ["yearStart", "yearEnd", "thumbnail", "extent", "geo"])
    assert.equal(record[field], null);
  assert.equal(record.georeference, undefined);
  assert.match(record.metadataSource, /blob\/[a-f0-9]{40}\/fixture.json$/);
});
test("public access never substitutes for reusable image rights", () => {
  for (const patch of [
    { dct_license_sm: [] },
    { dct_rights_sm: [] },
    { dct_accessRights_s: "Restricted" },
    { dct_license_sm: ["https://creativecommons.org/licenses/by-nc/4.0/"] },
    { dct_rights_sm: ["All rights reserved."] },
  ])
    assert.equal(
      stanfordRecord({ ...metadata(), ...patch }, "fixture.json"),
      null,
    );
  assert.equal(openImageRights("No known restrictions"), null);
  assert.equal(
    openImageRights("Publicly accessible. Copyright undetermined."),
    null,
  );
  assert.equal(
    openImageRights("https://creativecommons.org/licenses/by-nc/4.0/"),
    null,
  );
  assert.ok(openImageRights("This work is in the public domain."));
});
test("bounding boxes are discovery metadata, not invented raster transforms", () => {
  assert.equal(parseEnvelope("ENVELOPE(-181,10,20,0)"), null);
  const record = stanfordRecord(
    { ...metadata(), dcat_bbox: "ENVELOPE(-10,10,20,0)" },
    "fixture.json",
  );
  assert.deepEqual(record.extent, { west: -10, east: 10, north: 20, south: 0 });
  assert.equal(record.georeference, undefined);
});
test("original collection adapters require rights evidence and canonical source links", () => {
  const item = {
    id: "https://www.loc.gov/item/123/",
    title: "Map of the world",
    date: "1850",
    image_url: [],
  };
  assert.equal(locRecord(item), null);
  assert.equal(
    locRecord({
      ...item,
      rights_advisory: "This work is in the public domain.",
    }).yearStart,
    1850,
  );
  assert.equal(
    locRecord({
      ...item,
      id: "https://evil.example/item/123/",
      rights_advisory: "This work is in the public domain.",
    }),
    null,
  );
  assert.equal(
    leventhalRecord({ id: "commonwealth:abcd123", title: "Boston" }),
    null,
  );
  const boston = leventhalRecord({
    id: "commonwealth:abcd123",
    title: "Boston",
    rights_ss: ["This work is in the public domain."],
  });
  assert.equal(boston.providerId, "leventhal");
  const usgs = usgsRecord({
    sourceId: "123",
    title: "Boston, MA",
    metaUrl: "https://www.sciencebase.gov/catalog/item/123",
    boundingBox: { minX: -72, maxX: -71, minY: 42, maxY: 43 },
  });
  assert.equal(
    usgs.georeference,
    undefined,
    "a product footprint is never used as a transform",
  );
  assert.match(usgs.rights, /public domain/);
});
test("federated catalogue bounds requests and withholds unclear rights", async () => {
  const original = globalThis.fetch,
    originalCaches = globalThis.caches;
  const tasks = [];
  const seen = [];
  globalThis.caches = {
    default: { match: async () => undefined, put: async () => {} },
  };
  globalThis.fetch = async (url) => {
    seen.push(new URL(url));
    return Response.json({
      response: {
        docs: [
          {
            id: "commonwealth:abcd123",
            title: "Boston",
            rights_ss: ["This work is in the public domain."],
          },
          {
            id: "commonwealth:abcd124",
            title: "Boston",
            rights_ss: ["All rights reserved."],
          },
        ],
        numFound: 2,
      },
    });
  };
  try {
    const ctx = { waitUntil: (p) => tasks.push(p) };
    assert.equal(
      (
        await catalogueResponse(
          new Request("https://atlas.test/api/catalogue?source=evil&q=Boston"),
          ctx,
        )
      ).status,
      400,
    );
    const response = await catalogueResponse(
      new Request(
        "https://atlas.test/api/catalogue?source=leventhal&q=Boston&page=999999999",
      ),
      ctx,
    );
    const body = await response.json();
    assert.equal(body.records.length, 1);
    assert.equal(body.withheld, 1);
    assert.equal(seen[0].hostname, "collections.leventhalmap.org");
    assert.equal(seen[0].searchParams.get("per_page"), "12");
    assert.equal(body.page, 10000);
    await Promise.all(tasks);
  } finally {
    globalThis.fetch = original;
    globalThis.caches = originalCaches;
  }
});

test("LoC live records resolve lccn item ids and the division free-use statement", () => {
  const division =
    "The content of the Library of Congress Geography and Map Division digitized collections is free to use and reuse unless a Rights Advisory statement is present that indicates otherwise. Credit Line: Library of Congress, Geography and Map Division.";
  const record = locRecord({
    id: "http://lccn.loc.gov/99447025",
    title: "Western border states",
    date: "1861",
    partof: [{ title: "civil war maps" }, { title: "geography and map division" }],
    rights: [division],
    image_url: [
      "https://tile.loc.gov/image-services/iiif/service:gmd:g3882m:g3882m:g99447025/full/pct:25/0/default.jpg",
    ],
  });
  assert.ok(record, "an lccn.loc.gov item reference is resolvable");
  assert.equal(record.id, "loc:99447025");
  assert.equal(record.recordUrl, "https://www.loc.gov/item/99447025/");
  assert.match(record.rights, /free to use and reuse/);
  const httpItem = locRecord({
    id: "http://www.loc.gov/item/2009581124/",
    title: "Campaigns of the American Civil War",
    date: "1914",
    partof: [{ title: "civil war maps" }, { title: "geography and map division" }],
    rights: [division],
  });
  assert.ok(httpItem, "search summaries use plain-http www.loc.gov item URLs");
  assert.equal(httpItem.id, "loc:2009581124");
  assert.equal(httpItem.recordUrl, "https://www.loc.gov/item/2009581124/");
  assert.equal(
    locRecord({
      id: "http://lccn.loc.gov/99447025",
      title: "Restricted",
      partof: [{ title: "geography and map division" }],
      rights: [division],
      rights_advisory: "In copyright. Permission required.",
    }),
    null,
    "a restrictive Rights Advisory still wins",
  );
  assert.equal(
    locRecord({
      id: "http://lccn.loc.gov/99447025",
      title: "No division provenance",
      partof: [{ title: "catalog" }],
      rights: [division],
    }),
    null,
    "the division statement is not a general LoC licence",
  );
});
