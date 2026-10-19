import { build } from "esbuild";
import { readFile, writeFile, readdir } from "node:fs/promises";
const result = await build({
  entryPoints: ["src/browser/cog.js"],
  outfile: "public/vendor/cog.js",
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  legalComments: "eof",
  metafile: true,
});
const packages = new Set(
  Object.keys(result.metafile.inputs)
    .map((file) => file.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//)?.[1])
    .filter(Boolean),
);
// The Worker bundles the Allmaps annotation parser and its schema dependency.
packages.add("node_modules/@allmaps/annotation");
packages.add("node_modules/zod");
const notices = [];
for (const directory of [...packages].sort()) {
  const pkg = JSON.parse(await readFile(`${directory}/package.json`, "utf8"));
  const names = (await readdir(directory)).filter((name) =>
    /^(licen[cs]e|copying|notice)(\.|$)/i.test(name),
  );
  const fallback = {
    "geotiff-geokeys-to-proj4": "geotiff-geokeys-to-proj4.txt",
    lerc: "lerc-apache-2.0.txt",
  }[pkg.name];
  if (!names.length && !fallback)
    throw new Error(`Missing redistribution notice: ${pkg.name}`);
  const texts = names.length
    ? await Promise.all(
        names.map((name) => readFile(`${directory}/${name}`, "utf8")),
      )
    : [await readFile(`vendor-licenses/${fallback}`, "utf8")];
  if (pkg.name === "lerc")
    texts.unshift(
      "Copyright 2015–2021 Esri. Contributors: Johannes Schmid, Chayanika Khatua, Wenxue Ju.",
    );
  notices.push(
    `${pkg.name} ${pkg.version} (${pkg.license ?? "see licence"})\n${texts.join("\n")}`,
  );
}
await writeFile(
  "public/vendor/NOTICE.txt",
  notices.join("\n\n--------------------\n\n"),
);
console.log("Built the browser GeoTIFF decoder and CRS renderer.");
