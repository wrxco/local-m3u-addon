#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (!args.input || !args.publicBaseUrl) {
  usage();
  process.exit(1);
}

const inputPath = path.resolve(args.input);
const outPath = path.resolve(args.out || "playlists/local.m3u8");
const resourcesDir = path.resolve(args.resourcesDir || "resources");
const publicBaseUrl = args.publicBaseUrl.replace(/\/+$/g, "");
const text = await fs.readFile(inputPath, "utf8");
const logoUrls = [...new Set([...text.matchAll(/tvg-logo="([^"]+)"/g)].map((match) => match[1]).filter(isHttpUrl))];
const logoMap = new Map();
const failures = [];

await fs.mkdir(resourcesDir, { recursive: true });

await runPool(logoUrls, Number(args.concurrency || 12), async (logoUrl) => {
  const relativePath = resourcePathForLogo(logoUrl);
  const targetPath = path.join(resourcesDir, relativePath);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const publicUrl = `${publicBaseUrl}/resources/${relativePath.split(path.sep).map(encodeURIComponent).join("/")}`;

  if (await exists(targetPath)) {
    logoMap.set(logoUrl, publicUrl);
    return;
  }

  try {
    const response = await fetch(logoUrl, {
      redirect: "follow",
      headers: { "user-agent": "local-m3u-addon-resource-preparer/0.1" }
    });

    if (!response.ok) {
      failures.push({ url: logoUrl, status: response.status });
      return;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(targetPath, bytes);
    logoMap.set(logoUrl, publicUrl);
  } catch (error) {
    failures.push({ url: logoUrl, error: error.message });
  }
});

const rewritten = text.replace(/tvg-logo="([^"]+)"/g, (match, logoUrl) => {
  return logoMap.has(logoUrl) ? `tvg-logo="${logoMap.get(logoUrl)}"` : match;
});

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, rewritten);

const mapPath = path.join(resourcesDir, "logo-map.json");
await fs.writeFile(mapPath, `${JSON.stringify(Object.fromEntries(logoMap), null, 2)}\n`);

console.log(`Read ${inputPath}`);
console.log(`Found ${logoUrls.length} unique logo URLs`);
console.log(`Wrote playlist ${outPath}`);
console.log(`Wrote logo map ${mapPath}`);
console.log(`Downloaded or reused ${logoMap.size} logos`);
if (failures.length > 0) {
  console.log(`Failed ${failures.length} logos`);
  for (const failure of failures.slice(0, 20)) {
    console.log(`- ${failure.url}: ${failure.status || failure.error}`);
  }
}

function resourcePathForLogo(logoUrl) {
  const url = new URL(logoUrl);
  const parts = url.pathname.split("/").filter(Boolean).map(safePathPart);
  const logosIndex = parts.indexOf("logos");
  const selected = logosIndex === -1 ? ["logos", ...parts.slice(-2)] : parts.slice(logosIndex);
  return path.join(...selected);
}

function safePathPart(value) {
  return decodeURIComponent(value).replaceAll("/", "_").replaceAll("\\", "_");
}

async function runPool(items, concurrency, worker) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, concurrency) }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await worker(item);
      }
    })
  );
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input" || arg === "-i") {
      parsed.input = requireValue(arg, next);
      index += 1;
    } else if (arg === "--out" || arg === "-o") {
      parsed.out = requireValue(arg, next);
      index += 1;
    } else if (arg === "--resources-dir") {
      parsed.resourcesDir = requireValue(arg, next);
      index += 1;
    } else if (arg === "--public-base-url") {
      parsed.publicBaseUrl = requireValue(arg, next);
      index += 1;
    } else if (arg === "--concurrency") {
      parsed.concurrency = requireValue(arg, next);
      index += 1;
    } else if (!parsed.input) {
      parsed.input = arg;
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
  console.log(`Usage: node bin/prepare-playlist.js --input playlist.m3u8 --public-base-url https://m3u.example.com

Options:
  --input, -i PATH          Source playlist to read.
  --out, -o PATH            Rewritten local playlist path. Default: playlists/local.m3u8.
  --resources-dir PATH      Local resource output directory. Default: resources.
  --public-base-url URL     Public add-on origin used for rewritten tvg-logo URLs.
  --concurrency COUNT       Concurrent logo downloads. Default: 12.

Downloads remote tvg-logo assets, writes them under resources/, and rewrites
the playlist to point at this add-on's /resources/... endpoint.`);
}
