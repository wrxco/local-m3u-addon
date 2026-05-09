#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (!args.url) {
  usage();
  process.exit(1);
}

const response = await fetch(args.url, {
  redirect: "follow",
  headers: { "user-agent": "local-m3u-addon-manifest-importer/0.1" }
});

if (!response.ok) {
  throw new Error(`Could not fetch manifest: HTTP ${response.status}`);
}

const manifest = await response.json();
if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
  throw new Error("Manifest response must be a JSON object.");
}

const imported = safeManifestOverride(manifest, args);
const outPath = path.resolve(args.out || "config/manifest.local.json");
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, `${JSON.stringify(imported, null, 2)}\n`);

console.log(`Imported manifest metadata from ${args.url}`);
console.log(`Wrote ${outPath}`);
console.log("Set MANIFEST_PATH to this file when running the server.");

function safeManifestOverride(manifest, options) {
  const imported = pickFields(manifest, [
    "id",
    "version",
    "name",
    "description",
    "logo",
    "background",
    "contactEmail",
    "behaviorHints"
  ]);

  if (options.id) imported.id = options.id;
  if (options.name) imported.name = options.name;

  if (Array.isArray(manifest.catalogs) && manifest.catalogs[0]) {
    const catalog = pickFields(manifest.catalogs[0], ["name"]);
    if (Object.keys(catalog).length > 0) imported.catalogs = [catalog];
  }

  return imported;
}

function pickFields(source, keys) {
  return Object.fromEntries(
    keys
      .filter((key) => typeof source[key] === "string" || isPlainObject(source[key]))
      .map((key) => [key, source[key]])
  );
}

function isPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--out" || arg === "-o") {
      parsed.out = requireValue(arg, next);
      index += 1;
    } else if (arg === "--id") {
      parsed.id = requireValue(arg, next);
      index += 1;
    } else if (arg === "--name") {
      parsed.name = requireValue(arg, next);
      index += 1;
    } else if (!parsed.url) {
      parsed.url = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function requireValue(arg, value) {
  if (!value || value.startsWith("-")) throw new Error(`${arg} requires a value.`);
  return value;
}

function usage() {
  console.log(`Usage: node bin/import-manifest.js MANIFEST_URL [--out config/manifest.local.json]

Options:
  --id VALUE      Override the imported add-on id.
  --name VALUE    Override the imported add-on name.
  --out PATH      Output manifest override path.

The importer keeps presentation metadata only. Routes, resources, types, and
catalog ids remain controlled by this local add-on server.`);
}
