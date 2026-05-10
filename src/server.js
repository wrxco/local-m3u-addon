import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { parseM3u } from "./m3u.js";
import crypto from "node:crypto";
import sharp from "sharp";

const PORT = Number(process.env.PORT || 7000);
const HOST = process.env.HOST || "127.0.0.1";
const PLAYLIST_PATH = path.resolve(process.env.PLAYLIST_PATH || "playlists/local.m3u8");
const ADDON_ID = process.env.ADDON_ID || "local.m3u.addon";
const ADDON_NAME = process.env.ADDON_NAME || "My Local Add-on";
const ADDON_TYPE = process.env.ADDON_TYPE || "tv";
const CATALOG_ID = process.env.CATALOG_ID || "local_channels";
const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const STATIC_DIR = path.resolve(process.env.STATIC_DIR || "resources");
const STATIC_PATH_PREFIX = normalizePathPrefix(process.env.STATIC_PATH_PREFIX || "/resources");
const MANIFEST_PATH = process.env.MANIFEST_PATH ? path.resolve(process.env.MANIFEST_PATH) : "";
const MANIFEST_OVERRIDE = await loadManifestOverride();

let cache = {
  mtimeMs: 0,
  entries: [],
  byId: new Map(),
  groups: []
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);

    if (url.pathname.startsWith(`${STATIC_PATH_PREFIX}/`)) {
      return serveStatic(req, res, url.pathname);
    }

    const entries = await loadPlaylist();
    const baseUrl = publicBaseUrl(req);

    const posterMatch = url.pathname.match(/^\/poster\/([^/]+)\/([^/]+)\.(?:png|svg)$/);
    if (posterMatch) {
      const [, type, id] = posterMatch;
      if (!supportsType(type, entries)) return png(res, await posterPng(null), 404);
      const entry = cache.byId.get(resolveEntryId(decodeURIComponent(id), type, entries));
      return png(res, await posterPng(entry));
    }

    if (url.pathname === "/" || url.pathname === "/manifest.json") {
      return json(res, manifest(entries));
    }

    const catalogMatch = url.pathname.match(/^\/catalog\/([^/]+)\/([^/.]+)(?:\/(.+))?\.json$/);
    if (catalogMatch) {
      const [, type, catalogId, extraPath = ""] = catalogMatch;
      if (!supportsCatalog(type, catalogId, entries)) return json(res, { metas: [] });
      return json(res, catalog(entries, requestExtras(url.searchParams, extraPath), type, catalogId, baseUrl));
    }

    const metaMatch = url.pathname.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      if (!supportsType(type, entries)) return json(res, { meta: null });
      const entry = cache.byId.get(resolveEntryId(decodeURIComponent(id), type, entries));
      return json(res, { meta: toMeta(entry, type, entries, baseUrl) });
    }

    const streamMatch = url.pathname.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      if (!supportsType(type, entries)) return json(res, { streams: [] });
      const entry = cache.byId.get(resolveEntryId(decodeURIComponent(id), type, entries));
      return json(res, { streams: entry ? toStream(entry) : [] });
    }

    if (url.pathname === "/health.json") {
      return json(res, {
        ok: true,
        playlist: PLAYLIST_PATH,
        entries: entries.length,
        groups: cache.groups
      });
    }

    return json(res, { error: "Not found" }, 404);
  } catch (error) {
    return json(res, { error: error.message }, 500);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`${ADDON_NAME} listening on http://${HOST}:${PORT}/manifest.json`);
  console.log(`Playlist: ${PLAYLIST_PATH}`);
});

async function loadPlaylist() {
  const stat = await fs.stat(PLAYLIST_PATH);
  if (stat.mtimeMs === cache.mtimeMs) return cache.entries;

  const text = await fs.readFile(PLAYLIST_PATH, "utf8");
  const entries = groupChannels(parseM3u(text));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const groups = [...new Set(entries.map((entry) => entry.group).filter(Boolean))].sort();
  cache = { mtimeMs: stat.mtimeMs, entries, byId, groups };
  return entries;
}

function manifest(entries) {
  const genres = [...new Set(entries.map((entry) => entry.group).filter(Boolean))].sort();
  return applyManifestOverride({
    id: ADDON_ID,
    version: "0.1.0",
    name: ADDON_NAME,
    description: "Local M3U playlist wrapper. Drop your own playlist into playlists/local.m3u8.",
    resources: [
      "catalog",
      { name: "meta", types: [ADDON_TYPE], idPrefixes: [] },
      "stream"
    ],
    types: [ADDON_TYPE],
    catalogs: [
      {
        id: CATALOG_ID,
        type: ADDON_TYPE,
        name: "Local Playlist",
        extra: [
          { name: "search", isRequired: false },
          { name: "genre", isRequired: false, options: genres },
          { name: "skip", isRequired: false }
        ]
      }
    ]
  });
}

function catalog(entries, extras, type = ADDON_TYPE, catalogId = CATALOG_ID, baseUrl = "") {
  const query = (extras.get("search") || "").trim().toLowerCase();
  const genre = (extras.get("genre") || "").trim();
  const skip = Number(extras.get("skip") || 0);
  const catalogGroup = catalogGroupForId(catalogId, entries);
  if (catalogGroup === null) return { metas: [] };

  const filtered = entries.filter((entry) => {
    if (catalogGroup && entry.group !== catalogGroup) return false;
    if (genre && !matchesGenre(entry, genre, catalogGroup)) return false;
    if (query && !entry.name.toLowerCase().includes(query)) return false;
    return true;
  });

  return {
    metas: filtered.slice(skip, skip + PAGE_SIZE).map((entry) => toPreview(entry, type, entries, baseUrl))
  };
}

function toPreview(entry, type = ADDON_TYPE, entries = cache.entries, baseUrl = "") {
  const clientId = toClientId(entry.id, type, entries);
  return {
    id: clientId,
    type,
    name: entry.name,
    poster: posterUrl(type, clientId, baseUrl),
    posterShape: "poster",
    logo: entry.logo || undefined,
    genres: entry.genres?.length ? entry.genres : entry.group ? [entry.group] : undefined
  };
}

function toMeta(entry, type = ADDON_TYPE, entries = cache.entries, baseUrl = "") {
  if (!entry) return null;
  return {
    ...toPreview(entry, type, entries, baseUrl),
    description: `${entry.group || "Local playlist"} stream from your local M3U playlist.`
  };
}

function toStream(entry) {
  return entry.streams.map((stream) => ({
    title: stream.title,
    url: stream.url,
    quality: stream.quality,
    description: stream.description
  }));
}

function json(res, body, status = 200) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store"
  });
  res.end(payload);
}

function png(res, body, status = 200) {
  res.writeHead(status, {
    "content-type": "image/png",
    "content-length": String(body.length),
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=86400"
  });
  res.end(body);
}

async function serveStatic(req, res, pathname) {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, {
      "allow": "GET, HEAD",
      "access-control-allow-origin": "*"
    });
    return res.end();
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(pathname.slice(STATIC_PATH_PREFIX.length)).replace(/^\/+/, "");
  } catch {
    return json(res, { error: "Bad static resource path" }, 400);
  }

  const filePath = path.resolve(STATIC_DIR, relativePath);
  if (filePath !== STATIC_DIR && !filePath.startsWith(`${STATIC_DIR}${path.sep}`)) {
    return json(res, { error: "Static resource path is outside the resource directory" }, 403);
  }

  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) return json(res, { error: "Static resource not found" }, 404);

  res.writeHead(200, {
    "content-type": contentType(filePath),
    "content-length": String(stat.size),
    "access-control-allow-origin": "*",
    "cache-control": "public, max-age=86400"
  });

  if (req.method === "HEAD") return res.end();
  return createReadStream(filePath).pipe(res);
}

function normalizePathPrefix(value) {
  const prefix = `/${String(value).replace(/^\/+|\/+$/g, "")}`;
  return prefix === "/" ? "/resources" : prefix;
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return {
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".webp": "image/webp"
  }[extension] || "application/octet-stream";
}

function applyManifestOverride(baseManifest) {
  if (!MANIFEST_OVERRIDE) return baseManifest;

  const imported = pickFields(MANIFEST_OVERRIDE, [
    "id",
    "version",
    "name",
    "description",
    "logo",
    "background",
    "contactEmail",
    "behaviorHints"
  ]);

  if (Array.isArray(MANIFEST_OVERRIDE.resources)) imported.resources = MANIFEST_OVERRIDE.resources;
  if (Array.isArray(MANIFEST_OVERRIDE.types)) imported.types = MANIFEST_OVERRIDE.types;
  if (Array.isArray(MANIFEST_OVERRIDE.catalogs)) imported.catalogs = MANIFEST_OVERRIDE.catalogs;

  return {
    ...baseManifest,
    ...imported
  };
}

function supportsCatalog(type, catalogId, entries) {
  return manifest(entries).catalogs.some((catalogItem) => {
    return catalogItem.type === type && catalogItem.id === catalogId;
  });
}

function supportsType(type, entries) {
  return manifest(entries).types.includes(type);
}

function toClientId(entryId, type, entries) {
  const prefix = idPrefixForType(type, entries);
  return prefix && !entryId.startsWith(prefix) ? `${prefix}${entryId}` : entryId;
}

function resolveEntryId(clientId, type, entries) {
  if (cache.byId.has(clientId)) return clientId;

  const prefix = idPrefixForType(type, entries);
  if (prefix && clientId.startsWith(prefix)) return clientId.slice(prefix.length);

  return clientId;
}

function idPrefixForType(type, entries) {
  const resources = manifest(entries).resources || [];
  for (const resource of resources) {
    if (!isPlainObject(resource)) continue;
    if (!Array.isArray(resource.idPrefixes) || resource.idPrefixes.length === 0) continue;
    if (Array.isArray(resource.types) && !resource.types.includes(type)) continue;
    const prefix = resource.idPrefixes.find((value) => typeof value === "string" && value.length > 0);
    if (prefix) return prefix;
  }
  return "";
}

function catalogGroupForId(catalogId, entries) {
  if (catalogId === CATALOG_ID && !MANIFEST_OVERRIDE) return "";
  if (cache.groups.includes(catalogId)) return catalogId;
  if (MANIFEST_OVERRIDE && catalogId === "search") return "";
  if (MANIFEST_OVERRIDE) return null;
  return "";
}

function matchesGenre(entry, genre, catalogGroup) {
  const normalizedGenre = normalizeToken(genre);
  if (!normalizedGenre) return true;
  if (entry.genres?.some((item) => normalizeToken(item) === normalizedGenre)) return true;
  if (!catalogGroup && normalizeToken(entry.group) === normalizedGenre) return true;
  return false;
}

function requestExtras(searchParams, extraPath) {
  const extras = new URLSearchParams(searchParams);
  if (!extraPath) return extras;

  for (const part of extraPath.split("&")) {
    const equalsIndex = part.indexOf("=");
    if (equalsIndex === -1) continue;
    const key = decodeURIComponent(part.slice(0, equalsIndex));
    const value = decodeURIComponent(part.slice(equalsIndex + 1));
    extras.set(key, value);
  }

  return extras;
}

function publicBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host || `${HOST}:${PORT}`;
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
}

function posterUrl(type, clientId, baseUrl) {
  return `${baseUrl}/poster/${encodeURIComponent(type)}/${encodeURIComponent(clientId)}.png`;
}

async function posterPng(entry) {
  const logo = await logoBuffer(entry?.logo);
  const svg = posterSvg(entry, Boolean(logo));
  const image = sharp(Buffer.from(svg));

  if (!logo) return image.png().toBuffer();

  const fittedLogo = await sharp(logo)
    .resize(400, 300, { fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();

  return image
    .composite([{ input: fittedLogo, left: 56, top: 126 }])
    .png()
    .toBuffer();
}

async function logoBuffer(logo) {
  if (!logo) return null;

  try {
    const response = await fetch(logo);
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function posterSvg(entry, hasLogo = false) {
  const image = hasLogo
    ? ""
    : `<circle cx="256" cy="290" r="52" fill="#d7b7ff" opacity="0.75"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="768" viewBox="0 0 512 768">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a4009f"/>
      <stop offset="1" stop-color="#6f0077"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="16" stdDeviation="18" flood-color="#120018" flood-opacity="0.35"/>
    </filter>
  </defs>
  <rect width="512" height="768" rx="52" fill="url(#bg)"/>
  <rect x="34" y="80" width="444" height="420" rx="34" fill="#08050c" opacity="0.18"/>
  <g filter="url(#shadow)">
    ${image}
  </g>
</svg>`;
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

async function loadManifestOverride() {
  if (!MANIFEST_PATH) return null;

  try {
    return JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8"));
  } catch (error) {
    console.warn(`Could not load manifest override from ${MANIFEST_PATH}: ${error.message}`);
    return null;
  }
}

function groupChannels(entries) {
  const grouped = new Map();

  for (const entry of entries) {
    const key = channelKey(entry);
    const baseName = channelName(entry.name);
    const existing = grouped.get(key);
    const stream = toChannelStream(entry, baseName);

    if (existing) {
      existing.streams.push(stream);
      existing.sourceNames.push(entry.name);
      existing.genres = mergeGenres(existing.genres, channelGenres(entry));
      continue;
    }

    grouped.set(key, {
      id: stableId(key),
      name: baseName,
      group: entry.group,
      logo: entry.logo,
      attributes: entry.attributes,
      sourceNames: [entry.name],
      genres: channelGenres(entry),
      streams: [stream],
      line: entry.line
    });
  }

  return [...grouped.values()];
}

function channelKey(entry) {
  const tvgId = entry.attributes["tvg-id"] || "";
  const tvgName = entry.attributes["tvg-name"] || "";
  return [
    normalizeToken(entry.group),
    normalizeToken(tvgId || tvgName || channelName(entry.name)),
    normalizeToken(entry.logo)
  ].join("|");
}

function channelName(name) {
  return name
    .replace(/\s+-\s+(?:tvpass\s+)?(?:arion\s+)?(?:hd|sd|fhd|uhd|4k)\b.*$/i, "")
    .replace(/\s+\((?:hd|sd|fhd|uhd|4k)\)$/i, "")
    .trim() || name;
}

function toChannelStream(entry, baseName) {
  const variant = entry.name.replace(baseName, "").replace(/^\s+-\s*/, "").trim();
  const quality = streamQuality(entry.name);
  return {
    title: variant || quality || "Default",
    url: entry.url,
    quality,
    description: quality || undefined
  };
}

function streamQuality(name) {
  if (/\b(?:4k|uhd)\b/i.test(name)) return "4K";
  if (/\bfhd\b/i.test(name)) return "1080p";
  if (/\bhd\b/i.test(name)) return "720p";
  if (/\bsd\b/i.test(name)) return "480p";
  return undefined;
}

function channelGenres(entry) {
  const text = `${entry.name} ${entry.attributes["tvg-id"] || ""} ${entry.attributes["tvg-name"] || ""}`;
  const genres = [];

  if (/\b(kids|pbs\.kids|nick|disney|cartoon|boomerang|family)\b/i.test(text)) genres.push("Kids");
  if (/\b(news|cnbc|cnn|fox news|weather)\b/i.test(text)) genres.push("News");
  if (/\b(sports|espn|nfl|nba|mlb|nhl|tennis|golf|willow)\b/i.test(text)) genres.push("Sports");
  if (/\b(movie|movies|cinema|hbo|showtime|starz|cinemax|hallmark)\b/i.test(text)) genres.push("Movies");
  if (/\b(documentary|documentaries|history|science|nat ?geo|smithsonian)\b/i.test(text)) genres.push("Documentaries");
  if (/\b(music|mtv|vh1|cmt)\b/i.test(text)) genres.push("Music");
  if (/\b(crime|court|investigation)\b/i.test(text)) genres.push("Crime");
  if (/\b(food|travel|home|hgtv|diy|lifestyle|tlc)\b/i.test(text)) genres.push("Lifestyle");

  return mergeGenres([entry.group].filter(Boolean), genres);
}

function mergeGenres(...genreLists) {
  return [...new Set(genreLists.flat().filter(Boolean))];
}

function stableId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}
