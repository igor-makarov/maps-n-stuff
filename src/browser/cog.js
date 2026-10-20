import { fromUrl } from "geotiff";
import proj4 from "proj4";
import { toProj4 } from "geotiff-geokeys-to-proj4";

export function inverseAffine(image, reference) {
  const field = (name) =>
    image.fileDirectory?.getValue?.(name) ?? image.fileDirectory?.[name];
  const matrix =
    image.fileDirectory?.getValue?.("ModelTransformation") ??
    image.fileDirectory?.ModelTransformation;
  const tie = field("ModelTiepoint");
  const scale = field("ModelPixelScale");
  if (!matrix && !(tie && scale) && reference) {
    const inverse = inverseAffine(reference);
    return (x, y) => {
      const p = inverse(x, y);
      return [
        (p[0] * image.getWidth()) / reference.getWidth(),
        (p[1] * image.getHeight()) / reference.getHeight(),
      ];
    };
  }
  let a, b, c, d, e, f;
  if (matrix)
    [a, b, c, d, e, f] = [
      matrix[0],
      matrix[1],
      matrix[3],
      matrix[4],
      matrix[5],
      matrix[7],
    ];
  else if (tie && scale)
    [a, b, c, d, e, f] = [
      scale[0],
      0,
      tie[3] - tie[0] * scale[0],
      0,
      -scale[1],
      tie[4] + tie[1] * scale[1],
    ];
  else {
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    [a, b, c, d, e, f] = [
      resolution[0],
      0,
      origin[0],
      0,
      resolution[1],
      origin[1],
    ];
  }
  const det = a * e - b * d;
  if (![a, b, c, d, e, f, det].every(Number.isFinite) || Math.abs(det) < 1e-30)
    throw new Error("The raster has no usable pixel transformation.");
  const offset = image.getGeoKeys()?.GTRasterTypeGeoKey === 2 ? 0.5 : 0;
  return (x, y) => [
    (e * (x - c) - b * (y - f)) / det + offset,
    (-d * (x - c) + a * (y - f)) / det + offset,
  ];
}
export function rasterProjection(keys) {
  if (!keys?.GTModelTypeGeoKey)
    throw new Error(
      "The raster does not state its coordinate reference system.",
    );
  const normalized = { ...keys };
  // A projected GeoTIFF may also name its underlying geographic CRS. The
  // converter otherwise treats these legal tags as two competing coordinate
  // systems.
  if (keys.GTModelTypeGeoKey === 1 && keys.ProjectedCSTypeGeoKey) {
    if (
      keys.ProjectedCSTypeGeoKey === 32767 &&
      keys.ProjCoordTransGeoKey
    ) {
      // 32767 means "user-defined": the explicit Proj* parameters define the
      // projection, while the geographic CRS still supplies the ellipsoid and
      // datum. Drop the meaningless placeholder, not the datum.
      delete normalized.ProjectedCSTypeGeoKey;
    } else if (keys.ProjectedCSTypeGeoKey !== 32767) {
      delete normalized.GeographicTypeGeoKey;
    }
  }
  const definition = toProj4(normalized);
  if (!definition.proj4 || Object.keys(definition.errors).length)
    throw new Error(
      "This raster CRS needs additional definition or datum information. Open the original GeoTIFF in a GIS viewer.",
    );
  const project = proj4("EPSG:4326", definition.proj4);
  const scale = definition.conversionParameters;
  if (
    ![scale.x, scale.y].every((value) => Number.isFinite(value) && value !== 0)
  )
    throw new Error("Invalid raster coordinate units.");
  return (lon, lat) => {
    const p = project.forward([lon, lat]);
    return [p[0] / scale.x, p[1] / scale.y];
  };
}
export function viewportLocation(view, width, height, x, y) {
  const tiles = 2 ** view.zoom;
  const cx = ((view.lon + 180) / 360) * tiles * 256;
  const s = Math.sin(
    (Math.max(-85.05112878, Math.min(85.05112878, view.lat)) * Math.PI) / 180,
  );
  const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * tiles * 256;
  const tx = (cx - width / 2 + x) / (tiles * 256);
  const ty = (cy - height / 2 + y) / (tiles * 256);
  return [
    tx * 360 - 180,
    (Math.atan(Math.sinh(Math.PI * (1 - 2 * ty))) * 180) / Math.PI,
  ];
}
const opened = new Map();
async function openRaster(url) {
  if (!opened.has(url))
    opened.set(
      url,
      fromUrl(`/api/raster?url=${encodeURIComponent(url)}`, {
        allowFullFile: false,
        cacheSize: 32,
        blockSize: 65536,
      }).catch((error) => {
        opened.delete(url);
        throw error;
      }),
    );
  if (opened.size > 3) opened.delete(opened.keys().next().value);
  return opened.get(url);
}
export async function renderCog(
  canvas,
  layer,
  view,
  { cancelled = () => false } = {},
) {
  const tiff = await openRaster(layer.url);
  const first = await tiff.getImage();
  const project = rasterProjection(first.getGeoKeys());
  const fullWidth = Math.max(1, canvas.clientWidth),
    fullHeight = Math.max(1, canvas.clientHeight);
  const width = Math.min(800, Math.round(fullWidth)),
    height = Math.max(1, Math.round((fullHeight * width) / fullWidth));
  const location = (x, y) =>
    viewportLocation(
      view,
      fullWidth,
      fullHeight,
      (x / width) * fullWidth,
      (y / height) * fullHeight,
    );
  const source = (x, y) => project(...location(x, y));
  const perimeter = [];
  for (let i = 0; i <= 12; i++)
    for (const p of [
      [(i / 12) * width, 0],
      [(i / 12) * width, height],
      [0, (i / 12) * height],
      [width, (i / 12) * height],
    ]) {
      try {
        const q = source(...p);
        if (q.every(Number.isFinite)) perimeter.push(q);
      } catch {
        /* Outside the source projection. */
      }
    }
  if (!perimeter.length)
    throw new Error("The current view is outside this raster projection.");
  const firstInverse = inverseAffine(first);
  const firstPoints = perimeter.map((p) => firstInverse(...p));
  const desired = Math.max(
    (Math.max(...firstPoints.map((p) => p[0])) -
      Math.min(...firstPoints.map((p) => p[0]))) /
      width,
    (Math.max(...firstPoints.map((p) => p[1])) -
      Math.min(...firstPoints.map((p) => p[1]))) /
      height,
  );
  let image = first;
  const count = await tiff.getImageCount();
  for (let i = 1; i < count; i++) {
    if (cancelled()) return;
    const candidate = await tiff.getImage(i);
    if (first.getWidth() / candidate.getWidth() <= desired) image = candidate;
  }
  const inverse = inverseAffine(image, first);
  const points = perimeter.map((p) => inverse(...p));
  const minX = Math.max(0, Math.floor(Math.min(...points.map((p) => p[0]))));
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
  const maxX = Math.min(
    image.getWidth(),
    Math.ceil(Math.max(...points.map((p) => p[0]))),
  );
  const maxY = Math.min(
    image.getHeight(),
    Math.ceil(Math.max(...points.map((p) => p[1]))),
  );
  if (maxX <= minX || maxY <= minY) {
    canvas.width = width;
    canvas.height = height;
    return { outside: true };
  }
  const sw = Math.min(1400, maxX - minX),
    sh = Math.min(1400, maxY - minY);
  const data = await image.readRGB({
    window: [minX, minY, maxX, maxY],
    width: sw,
    height: sh,
    enableAlpha: true,
    interleave: true,
  });
  if (cancelled()) return;
  const channels = data.length / (sw * sh);
  if (![3, 4].includes(channels))
    throw new Error("This raster does not supply supported map colour bands.");
  const output = new ImageData(width, height);
  const nodata = image.getGDALNoData();
  for (let y = 0; y < height; y++) {
    if (cancelled()) return;
    for (let x = 0; x < width; x++) {
      let p;
      try {
        p = inverse(...source(x + 0.5, y + 0.5));
      } catch {
        continue;
      }
      if (!p.every(Number.isFinite)) continue;
      const sx = Math.floor(((p[0] - minX) / (maxX - minX)) * sw),
        sy = Math.floor(((p[1] - minY) / (maxY - minY)) * sh);
      if (sx < 0 || sx >= sw || sy < 0 || sy >= sh) continue;
      const si = (sy * sw + sx) * channels,
        di = (y * width + x) * 4;
      if (
        nodata != null &&
        data[si] === nodata &&
        data[si + 1] === nodata &&
        data[si + 2] === nodata
      )
        continue;
      output.data[di] = data[si];
      output.data[di + 1] = data[si + 1];
      output.data[di + 2] = data[si + 2];
      output.data[di + 3] = channels === 4 ? data[si + 3] : 255;
    }
    if (y % 24 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (cancelled()) return;
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(output, 0, 0);
  return {
    width,
    height,
    sourceWidth: image.getWidth(),
    sourceHeight: image.getHeight(),
  };
}
