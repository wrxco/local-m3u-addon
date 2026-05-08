#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { parseM3u, toM3u } from "../src/m3u.js";
import { auditEntries } from "../src/audit.js";

const args = parseArgs(process.argv.slice(2));

if (!args.input) {
  usage();
  process.exit(1);
}

const inputPath = path.resolve(args.input);
const outDir = path.resolve(args.outDir || "reports");
const text = await fs.readFile(inputPath, "utf8");
const entries = parseM3u(text);
const result = auditEntries(entries, {
  allowDomains: args.allowDomain,
  denyDomains: args.denyDomain
});

await fs.mkdir(outDir, { recursive: true });

const base = path.basename(inputPath).replace(/\.(m3u8?|txt)$/i, "");
const reportPath = path.join(outDir, `${base}.audit.json`);
const csvPath = path.join(outDir, `${base}.audit.csv`);
const cleanPath = path.join(outDir, `${base}.clean.m3u8`);
const reviewPath = path.join(outDir, `${base}.review.m3u8`);

await fs.writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`);
await fs.writeFile(csvPath, toCsv(result.entries));
await fs.writeFile(cleanPath, toM3u(result.entries.filter((entry) => entry.audit.status === "keep")));
await fs.writeFile(reviewPath, toM3u(result.entries.filter((entry) => entry.audit.status !== "drop")));

console.log(`Audited ${result.summary.total} entries`);
console.log(`keep=${result.summary.keep} review=${result.summary.review} drop=${result.summary.drop}`);
console.log(`report=${reportPath}`);
console.log(`csv=${csvPath}`);
console.log(`clean=${cleanPath}`);
console.log(`review=${reviewPath}`);

function parseArgs(argv) {
  const parsed = {
    allowDomain: [],
    denyDomain: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--input" || arg === "-i") {
      parsed.input = next;
      index += 1;
    } else if (arg === "--out-dir" || arg === "-o") {
      parsed.outDir = next;
      index += 1;
    } else if (arg === "--allow-domain") {
      parsed.allowDomain.push(next);
      index += 1;
    } else if (arg === "--deny-domain") {
      parsed.denyDomain.push(next);
      index += 1;
    } else if (!parsed.input) {
      parsed.input = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function toCsv(entries) {
  const header = ["status", "score", "name", "group", "url", "signals"];
  const rows = entries.map((entry) => [
    entry.audit.status,
    String(entry.audit.score),
    entry.name,
    entry.group,
    entry.url,
    entry.audit.signals.map((item) => item.code).join("|")
  ]);

  return `${[header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function usage() {
  console.log(`Usage: node bin/audit-playlist.js --input /path/to/playlist.m3u8 [--out-dir reports]

Options:
  --allow-domain DOMAIN   Treat a domain as explicitly allowed. Can be repeated.
  --deny-domain DOMAIN    Treat a domain as explicitly denied. Can be repeated.

Outputs:
  *.audit.json            Full structured report.
  *.audit.csv             Spreadsheet-friendly review list.
  *.clean.m3u8            Entries classified as keep.
  *.review.m3u8           Entries classified as keep or review.`);
}
