#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

if (!args.input || !args.report || !args.out) {
  usage();
  process.exit(1);
}

const inputPath = path.resolve(args.input);
const reportPath = path.resolve(args.report);
const outPath = path.resolve(args.out);
const playlist = await fs.readFile(inputPath, "utf8");
const report = JSON.parse(await fs.readFile(reportPath, "utf8"));
const badUrls = new Set(
  (report.checks || [])
    .filter((check) => check.ok === false && check.testedUrl)
    .map((check) => normalizeUrl(check.testedUrl))
);

const result = prunePlaylist(playlist, badUrls);

await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, result.text);

console.log(`Input: ${inputPath}`);
console.log(`Report: ${reportPath}`);
console.log(`Output: ${outPath}`);
console.log(`Bad stream URLs: ${badUrls.size}`);
console.log(`Entries kept: ${result.kept}`);
console.log(`Entries removed: ${result.removed}`);

if (result.removedEntries.length > 0) {
  console.log("");
  console.log("Removed:");
  for (const entry of result.removedEntries.slice(0, 50)) {
    console.log(`- ${entry.name}`);
    console.log(`  ${entry.url}`);
  }
  if (result.removedEntries.length > 50) {
    console.log(`...and ${result.removedEntries.length - 50} more`);
  }
}

function prunePlaylist(text, badUrls) {
  const lines = text.split(/\r?\n/);
  const output = [];
  const removedEntries = [];
  let kept = 0;
  let removed = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed.startsWith("#EXTINF")) {
      output.push(line);
      continue;
    }

    const extinf = line;
    const passthrough = [];
    let cursor = index + 1;

    while (cursor < lines.length) {
      const candidate = lines[cursor];
      const candidateTrimmed = candidate.trim();
      if (!candidateTrimmed) {
        passthrough.push(candidate);
        cursor += 1;
        continue;
      }
      if (candidateTrimmed.startsWith("#")) {
        passthrough.push(candidate);
        cursor += 1;
        continue;
      }
      break;
    }

    const url = lines[cursor] || "";
    if (badUrls.has(normalizeUrl(url.trim()))) {
      removed += 1;
      removedEntries.push({ name: extinfName(extinf), url: url.trim() });
      index = cursor;
      continue;
    }

    kept += 1;
    output.push(extinf, ...passthrough);
    if (cursor < lines.length) {
      output.push(url);
      index = cursor;
    }
  }

  return {
    text: output.join("\n").replace(/\n*$/g, "\n"),
    kept,
    removed,
    removedEntries
  };
}

function extinfName(line) {
  const commaIndex = line.indexOf(",");
  return commaIndex === -1 ? line : line.slice(commaIndex + 1).trim();
}

function normalizeUrl(value) {
  return String(value || "").trim();
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--input" || arg === "-i") {
      parsed.input = requireValue(arg, next);
      index += 1;
    } else if (arg === "--report" || arg === "--bad-streams") {
      parsed.report = requireValue(arg, next);
      index += 1;
    } else if (arg === "--out" || arg === "-o") {
      parsed.out = requireValue(arg, next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
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
  console.log(`Usage: node bin/prune-playlist.js --input playlist.m3u8 --report stream-check.json --out playlist.pruned.m3u8

Options:
  --input, -i PATH          Source playlist.
  --report PATH            JSON report from check-catalog-streams --json-out.
  --bad-streams PATH       Alias for --report.
  --out, -o PATH            Output playlist path.

Removes complete #EXTINF + URL entries whose stream URL failed in the checker
report. The source playlist is not modified.`);
}
