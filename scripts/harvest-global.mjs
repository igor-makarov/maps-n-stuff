#!/usr/bin/env node
/** Reproduce the complete explicitly PD map subset from a pinned, CC0 institutional catalogue. */
import { readFile, writeFile, readdir, mkdir, access } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  stanfordRecord,
  STANFORD_PROVIDER,
  STANFORD_REPOSITORY,
  STANFORD_REVISION,
} from "./stanford-records.mjs";
import { formatCatalogue } from "./catalogue-format.mjs";
import { LIVE_PROVIDERS } from "../src/worker/catalogue.js";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const arg = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const checkout = resolve(
  arg("--input") ?? join(root, ".cache/stanford-catalogue"),
);
const output = resolve(arg("--out") ?? join(root, "public/data"));
const offline = args.includes("--offline");
try {
  await access(join(checkout, ".git"));
} catch {
  if (offline)
    throw new Error(
      "No pinned metadata checkout. Run the online global harvest once, or supply --input.",
    );
  await mkdir(checkout, { recursive: true });
  await exec("git", ["init", checkout]);
  await exec("git", [
    "-C",
    checkout,
    "remote",
    "add",
    "origin",
    `${STANFORD_REPOSITORY}.git`,
  ]);
  await exec(
    "git",
    ["-C", checkout, "fetch", "--depth", "1", "origin", STANFORD_REVISION],
    { maxBuffer: 1024 * 1024 },
  );
  await exec("git", ["-C", checkout, "checkout", "--detach", "FETCH_HEAD"]);
}
const revision = (
  await exec("git", ["-C", checkout, "rev-parse", "HEAD"])
).stdout.trim();
if (revision !== STANFORD_REVISION)
  throw new Error(
    `Metadata revision mismatch: expected ${STANFORD_REVISION}, found ${revision}.`,
  );
const licence = await readFile(join(checkout, "LICENSE"), "utf8");
if (!licence.includes("CC0 1.0 Universal"))
  throw new Error("Metadata redistribution licence not established.");
async function* jsonFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* jsonFiles(path);
    else if (entry.name.endsWith(".json")) yield path;
  }
}
let considered = 0;
const imported = [];
for await (const path of jsonFiles(join(checkout, "metadata-aardvark"))) {
  considered++;
  const record = stanfordRecord(
    JSON.parse(await readFile(path, "utf8")),
    relative(checkout, path).split("\\").join("/"),
  );
  if (record) imported.push(record);
}
if (!imported.length)
  throw new Error("No eligible records; leaving the last catalogue unchanged.");
const read = async (name) =>
  JSON.parse(await readFile(join(output, name), "utf8"));
const recordsDoc = await read("records.json");
const sourcesDoc = await read("sources.json");
const overlaysDoc = await read("overlays.json");
recordsDoc.records = [
  ...recordsDoc.records.filter((record) => record.providerId !== "stanford"),
  ...imported,
].sort(
  (a, b) =>
    (a.yearStart ?? Infinity) - (b.yearStart ?? Infinity) ||
    a.id.localeCompare(b.id),
);
recordsDoc.generatedAt = new Date().toISOString();
recordsDoc.method =
  "Primary institutional metadata: e-rara, swisstopo, Library of Congress, and the complete explicitly public-domain map subset of Stanford’s pinned CC0 catalogue. No geographic, decade or count quota is applied to Stanford.";
recordsDoc.selection["stanford:public-domain"] = {
  considered,
  kept: imported.length,
  sourceRevision: revision,
  metadataLicence: "CC0 1.0",
  rule: "All public Map-class records with explicit per-item PDM/CC0 image rights, original links and stated identity. No bbox or georeferencing requirement; conflicting/restricted rights are excluded.",
};
sourcesDoc.providers = [
  ...sourcesDoc.providers.filter((source) => source.id !== "stanford"),
  { ...STANFORD_PROVIDER, retrieved: recordsDoc.generatedAt.slice(0, 10) },
];
for (const source of LIVE_PROVIDERS) {
  const existing = sourcesDoc.providers.find((value) => value.id === source.id);
  if (existing) existing.liveSearch = source.api.catalogue;
  else
    sourcesDoc.providers.push({
      ...source,
      mode: "live-search",
      method:
        "Fetched on explicit user search. This registry entry does not claim any bundled records or completed live verification.",
    });
}
sourcesDoc.generatedAt = recordsDoc.generatedAt;
overlaysDoc.overlays = overlaysDoc.overlays.filter(
  (layer) => layer.providerId !== "stanford",
);
overlaysDoc.overlays.push(
  ...imported
    .filter((record) => record.georeference)
    .map((record) => ({
      id: `cog-${record.id.split(":")[1]}`,
      kind: "cog",
      providerId: "stanford",
      title: record.title,
      recordId: record.id,
      url: record.georeference.url,
      extent: record.extent,
      attribution: "Stanford University Libraries",
      license: record.rights,
      historical: true,
      timeValues: [],
      ...(record.depictedYearStart
        ? { mapYear: record.depictedYearStart }
        : {}),
    })),
);
formatCatalogue(recordsDoc, sourcesDoc, overlaysDoc);
await writeFile(
  join(output, "records.json"),
  JSON.stringify(recordsDoc) + "\n",
);
await writeFile(
  join(output, "sources.json"),
  JSON.stringify(sourcesDoc, null, 2) + "\n",
);
await writeFile(
  join(output, "overlays.json"),
  JSON.stringify(overlaysDoc, null, 2) + "\n",
);
console.log(
  `Imported ${imported.length} public-domain Stanford maps from ${considered} metadata records; ${imported.filter((record) => record.georeference).length} native COG overlays. Total: ${recordsDoc.records.length}.`,
);
