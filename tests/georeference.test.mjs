import test from "node:test";
import assert from "node:assert/strict";
import { fromArrayBuffer, writeArrayBuffer } from "geotiff";
import { generateAnnotation } from "@allmaps/annotation";
import {
  inverseAffine,
  rasterProjection,
  viewportLocation,
} from "../src/browser/cog.js";
import {
  alignmentLayers,
  resourceMatches,
} from "../src/worker/georeference.js";
const near = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected}`);
test("real GeoTIFF tags transform world coordinates back into image pixels", async () => {
  const buffer = await writeArrayBuffer(new Uint8Array(16), {
    width: 4,
    height: 4,
    GTModelTypeGeoKey: 2,
    GeographicTypeGeoKey: 4326,
    GTRasterTypeGeoKey: 1,
    ModelPixelScale: [0.5, 0.5, 0],
    ModelTiepoint: [2, 3, 0, 11, 48.5, 0],
  });
  const image = await (await fromArrayBuffer(buffer)).getImage();
  assert.deepEqual(inverseAffine(image)(11, 48.5), [2, 3]);
  const project = rasterProjection(image.getGeoKeys());
  const point = project(11, 48.5);
  near(point[0], 11);
  near(point[1], 48.5);
});
test("rotated transforms, pixel centres and overviews retain alignment", () => {
  const image = {
    fileDirectory: {
      ModelTransformation: [2, 1, 0, 10, -1, -2, 0, 50, 0, 0, 1, 0, 0, 0, 0, 1],
    },
    getGeoKeys: () => ({ GTRasterTypeGeoKey: 1 }),
    getWidth: () => 100,
    getHeight: () => 100,
  };
  const inverse = inverseAffine(image);
  assert.deepEqual(inverse(17, 42), [2, 3]);
  const overview = {
    fileDirectory: {},
    getWidth: () => 50,
    getHeight: () => 50,
  };
  assert.deepEqual(inverseAffine(overview, image)(17, 42), [1, 1.5]);
  assert.deepEqual(
    inverseAffine({ ...image, getGeoKeys: () => ({ GTRasterTypeGeoKey: 2 }) })(
      10,
      50,
    ),
    [0.5, 0.5],
  );
  assert.throws(
    () =>
      inverseAffine({
        ...image,
        fileDirectory: { ModelTransformation: Array(16).fill(0) },
      }),
    /transformation/,
  );
});
test("projected GeoTIFF coordinates agree with the global Web Mercator viewport", () => {
  const project = rasterProjection({
    GTModelTypeGeoKey: 1,
    ProjectedCSTypeGeoKey: 3857,
    GeographicTypeGeoKey: 4326,
  });
  const p = project(10, 0);
  near(p[0], 1113194.9079327357);
  near(p[1], 0);
  const center = viewportLocation(
    { lat: 30, lon: 31, zoom: 4 },
    800,
    600,
    400,
    300,
  );
  near(center[0], 31);
  near(center[1], 30);
  assert.throws(() => rasterProjection({}), /reference system/);
});
test("a user-defined USGS projection keeps its geographic datum", () => {
  // Real GeoKeys from a USGS HTMC 1:125,000 sheet (TN_Morristown_153457_1883).
  // ProjectedCSTypeGeoKey=32767 is a placeholder; the Proj* parameters define
  // the polyconic projection and GeographicTypeGeoKey=4267 supplies NAD27.
  const project = rasterProjection({
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
    GeographicTypeGeoKey: 4267,
    ProjectedCSTypeGeoKey: 32767,
    ProjectionGeoKey: 32767,
    ProjCoordTransGeoKey: 22,
    ProjLinearUnitsGeoKey: 9001,
    ProjNatOriginLongGeoKey: -83.25,
    ProjNatOriginLatGeoKey: 36,
    ProjFalseEastingGeoKey: 0,
    ProjFalseNorthingGeoKey: 0,
    ProjScaleAtNatOriginGeoKey: 1,
  });
  const p = project(-83.25, 36.25);
  assert.ok(p.every(Number.isFinite));
  assert.ok(Math.abs(p[0]) < 1, `central meridian should map to x≈0, got ${p[0]}`);
  assert.ok(p[1] > 27000 && p[1] < 29000, `expected ≈27.7 km northing, got ${p[1]}`);
});
const record = {
  id: "stanford:ab123cd4567",
  providerId: "stanford",
  institution: "Test library",
  title: "Fixture map",
  rights: "Public domain",
  extent: null,
};
const map = () => ({
  type: "GeoreferencedMap",
  id: "https://annotations.allmaps.org/maps/0123456789abcdef",
  resource: {
    id: "https://stacks.stanford.edu/image/iiif/ab123cd4567%2Fscan",
    type: "ImageService2",
    width: 100,
    height: 100,
  },
  gcps: [
    { resource: [0, 0], geo: [10, 50] },
    { resource: [100, 0], geo: [11, 50] },
    { resource: [0, 100], geo: [10, 49] },
  ],
  resourceMask: [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ],
});
test("Allmaps alignments must belong to this source image and contain valid control points", () => {
  const valid = alignmentLayers(generateAnnotation(map()), record);
  assert.equal(valid.length, 1);
  assert.equal(valid[0].controlPoints, 3);
  assert.match(valid[0].urlTemplate, /allmaps.xyz\/maps\/0123456789abcdef/);
  assert.equal(
    resourceMatches(
      record,
      "https://stacks.stanford.edu/image/iiif/zz123zz4567%2Fscan",
    ),
    false,
  );
  const wrong = map();
  wrong.resource.id = "https://evil.example/image";
  assert.deepEqual(alignmentLayers(generateAnnotation(wrong), record), []);
  const flat = map();
  flat.gcps[2].geo = [12, 50];
  assert.deepEqual(alignmentLayers(generateAnnotation(flat), record), []);
  const outside = map();
  outside.gcps[0].resource = [-1, 0];
  assert.deepEqual(alignmentLayers(generateAnnotation(outside), record), []);
});
