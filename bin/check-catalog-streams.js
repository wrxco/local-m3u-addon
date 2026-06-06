#!/usr/bin/env node

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  usage();
  process.exit(0);
}

if (!args.catalogUrl) {
  usage();
  process.exit(1);
}

const catalogUrl = new URL(args.catalogUrl);
const timeoutMs = Number(args.timeout || 10000);
const concurrency = Number(args.concurrency || 8);
const pageSize = Number(args.pageSize || 100);

const catalogItems = await fetchAllCatalogItems(catalogUrl);
const checks = [];

console.log(`Catalog: ${catalogUrl.href}`);
console.log(`Items: ${catalogItems.length}`);
console.log(`Testing streams with concurrency=${concurrency}, timeout=${timeoutMs}ms`);
console.log("");

await runPool(catalogItems, concurrency, async (item, itemIndex) => {
  const streamUrl = streamEndpointFor(catalogUrl, item);
  const streams = await fetchStreams(streamUrl);

  if (streams.length === 0) {
    checks.push({
      item,
      itemIndex,
      streamEndpoint: streamUrl,
      stream: null,
      result: {
        ok: false,
        status: "NO_STREAMS",
        detail: "Stream endpoint returned no streams."
      }
    });
    printCheck(checks.at(-1));
    return;
  }

  for (const stream of streams) {
    const result = await testStream(stream.url);
    checks.push({ item, itemIndex, streamEndpoint: streamUrl, stream, result });
    printCheck(checks.at(-1));
  }
});

printSummary(checks);

async function fetchAllCatalogItems(url) {
  const items = [];
  let skip = Number(url.searchParams.get("skip") || 0);

  while (true) {
    const pageUrl = new URL(url);
    pageUrl.searchParams.set("skip", String(skip));
    const data = await fetchJson(pageUrl.href);
    const metas = Array.isArray(data.metas) ? data.metas : [];
    items.push(...metas);

    if (metas.length < pageSize) break;
    skip += pageSize;
  }

  return items;
}

async function fetchStreams(url) {
  try {
    const data = await fetchJson(url);
    return Array.isArray(data.streams) ? data.streams : [];
  } catch (error) {
    return [
      {
        title: "stream endpoint",
        url,
        endpointError: error.message
      }
    ];
  }
}

async function testStream(url) {
  if (!url) {
    return {
      ok: false,
      status: "NO_URL",
      detail: "Stream has no URL."
    };
  }

  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        "range": "bytes=0-65535",
        "user-agent": "local-m3u-addon-stream-checker/0.1"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    const finalUrl = response.url || url;
    const statusCode = response.status;
    const text = await response.text();
    const sample = text.slice(0, 4096);

    if (!response.ok) {
      return {
        ok: false,
        status: `HTTP_${statusCode}`,
        detail: `${statusCode} ${response.statusText}`,
        contentType,
        finalUrl
      };
    }

    if (sample.includes("#EXTM3U")) {
      return {
        ok: true,
        status: "HLS",
        detail: hlsDetail(sample),
        contentType,
        finalUrl
      };
    }

    if (/html/i.test(contentType) || /<html/i.test(sample)) {
      return {
        ok: false,
        status: "HTML",
        detail: "Returned an HTML page, not a direct playable stream.",
        contentType,
        finalUrl
      };
    }

    if (/mpegurl|application\/vnd\.apple/i.test(contentType)) {
      return {
        ok: true,
        status: "PLAYLIST",
        detail: "Playlist-like content type.",
        contentType,
        finalUrl
      };
    }

    return {
      ok: true,
      status: "REACHABLE",
      detail: "URL responded successfully, but did not look like HLS.",
      contentType,
      finalUrl
    };
  } catch (error) {
    return {
      ok: false,
      status: error.name === "TimeoutError" ? "TIMEOUT" : "ERROR",
      detail: error.message
    };
  }
}

function hlsDetail(sample) {
  const variants = [...sample.matchAll(/RESOLUTION=([0-9]+x[0-9]+)/g)].map((match) => match[1]);
  if (variants.length > 0) return `HLS variants: ${variants.join(", ")}`;
  if (sample.includes("#EXTINF")) return "HLS media playlist.";
  return "HLS playlist.";
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "local-m3u-addon-stream-checker/0.1" }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  return response.json();
}

function streamEndpointFor(catalogUrl, item) {
  const match = catalogUrl.pathname.match(/^\/catalog\/([^/]+)\//);
  const type = item.type || match?.[1] || "tv";
  return `${catalogUrl.origin}/stream/${encodeURIComponent(type)}/${encodeURIComponent(item.id)}.json`;
}

function printCheck(check) {
  const mark = check.result.ok ? "OK " : "BAD";
  const streamTitle = check.stream?.title || "no stream";
  const channel = check.item?.name || "(unknown)";
  const url = check.stream?.url || "";
  console.log(`${mark}  ${channel}  |  ${streamTitle}`);
  console.log(`     ${check.result.status}: ${check.result.detail}`);
  console.log(`     stream endpoint: ${check.streamEndpoint}`);
  if (url) console.log(`     tested URL: ${url}`);
  if (check.result.finalUrl && check.result.finalUrl !== url) console.log(`     final: ${check.result.finalUrl}`);
}

function printSummary(checks) {
  const ok = checks.filter((check) => check.result.ok).length;
  const bad = checks.length - ok;
  const byStatus = countBy(checks, (check) => check.result.status);
  const badChecks = checks.filter((check) => !check.result.ok);

  console.log("");
  console.log("Summary");
  console.log("=======");
  console.log(`Catalog items: ${catalogItems.length}`);
  console.log(`Streams checked: ${checks.length}`);
  console.log(`Working: ${ok}`);
  console.log(`Failing: ${bad}`);
  console.log("");
  console.log("By status:");
  for (const [status, count] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${status.padEnd(12)} ${count}`);
  }

  if (badChecks.length > 0) {
    console.log("");
    console.log("Failures:");
    for (const check of badChecks) {
      const streamTitle = check.stream?.title || "no stream";
      console.log(`- ${check.item.name} | ${streamTitle} | ${check.result.status}`);
      console.log(`  stream endpoint: ${check.streamEndpoint}`);
      console.log(`  tested URL: ${check.stream?.url || ""}`);
    }
  }
}

function countBy(items, keyFn) {
  return items.reduce((acc, item) => {
    const key = keyFn(item);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

async function runPool(items, limit, worker) {
  let index = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, limit) }, async () => {
      while (index < items.length) {
        const current = index;
        index += 1;
        await worker(items[current], current);
      }
    })
  );
}

function parseArgs(argv) {
  const parsed = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--timeout") {
      parsed.timeout = requireValue(arg, next);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--concurrency") {
      parsed.concurrency = requireValue(arg, next);
      index += 1;
    } else if (arg === "--page-size") {
      parsed.pageSize = requireValue(arg, next);
      index += 1;
    } else if (!parsed.catalogUrl) {
      parsed.catalogUrl = arg;
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
  console.log(`Usage: node bin/check-catalog-streams.js CATALOG_URL

Example:
  node bin/check-catalog-streams.js https://manny.example/catalog/tv/usa_locals.json

Options:
  --timeout MS          Per-request timeout. Default: 10000.
  --concurrency COUNT  Concurrent stream checks. Default: 8.
  --page-size COUNT    Catalog page size for pagination. Default: 100.

Fetches every catalog page, calls /stream/<type>/<id>.json for each item, tests
each returned stream URL, and prints a command-line report.`);
}
