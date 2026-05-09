import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { parseM3u } from "./m3u.js";

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

    if (url.pathname === "/" || url.pathname === "/manifest.json") {
      return json(res, manifest(entries));
    }

    const catalogMatch = url.pathname.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (catalogMatch) {
      const [, type, catalogId] = catalogMatch;
      if (!supportsCatalog(type, catalogId, entries)) return json(res, { metas: [] });
      return json(res, catalog(entries, url.searchParams, type));
    }

    const metaMatch = url.pathname.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      if (!supportsType(type, entries)) return json(res, { meta: null });
      const entry = cache.byId.get(resolveEntryId(decodeURIComponent(id), type, entries));
      return json(res, { meta: toMeta(entry, type, entries) });
    }

    const streamMatch = url.pathname.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      if (!supportsType(type, entries)) return json(res, { streams: [] });
      const entry = cache.byId.get(resolveEntryId(decodeURIComponent(id), type, entries));
      return json(res, { streams: entry ? [toStream(entry)] : [] });
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
  const entries = parseM3u(text);
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

function catalog(entries, searchParams, type = ADDON_TYPE) {
  const query = (searchParams.get("search") || "").trim().toLowerCase();
  const genre = (searchParams.get("genre") || "").trim();
  const skip = Number(searchParams.get("skip") || 0);
  const filtered = entries.filter((entry) => {
    if (genre && entry.group !== genre) return false;
    if (query && !entry.name.toLowerCase().includes(query)) return false;
    return true;
  });

  return {
    metas: filtered.slice(skip, skip + PAGE_SIZE).map((entry) => toPreview(entry, type, entries))
  };
}

function toPreview(entry, type = ADDON_TYPE, entries = cache.entries) {
  return {
    id: toClientId(entry.id, type, entries),
    type,
    name: entry.name,
    poster: entry.logo || undefined,
    logo: entry.logo || undefined,
    genres: entry.group ? [entry.group] : undefined
  };
}

function toMeta(entry, type = ADDON_TYPE, entries = cache.entries) {
  if (!entry) return null;
  return {
    ...toPreview(entry, type, entries),
    description: `${entry.group || "Local playlist"} stream from your local M3U playlist.`,
    background: entry.logo || undefined
  };
}

function toStream(entry) {
  return {
    title: entry.group ? `${entry.group} - ${entry.name}` : entry.name,
    url: entry.url
  };
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
