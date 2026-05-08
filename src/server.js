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

let cache = {
  mtimeMs: 0,
  entries: [],
  byId: new Map(),
  groups: []
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    const entries = await loadPlaylist();

    if (url.pathname === "/" || url.pathname === "/manifest.json") {
      return json(res, manifest(entries));
    }

    const catalogMatch = url.pathname.match(/^\/catalog\/([^/]+)\/([^/]+)\.json$/);
    if (catalogMatch) {
      const [, type, catalogId] = catalogMatch;
      if (type !== ADDON_TYPE || catalogId !== CATALOG_ID) return json(res, { metas: [] });
      return json(res, catalog(entries, url.searchParams));
    }

    const metaMatch = url.pathname.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/);
    if (metaMatch) {
      const [, type, id] = metaMatch;
      if (type !== ADDON_TYPE) return json(res, { meta: null });
      return json(res, { meta: toMeta(cache.byId.get(decodeURIComponent(id))) });
    }

    const streamMatch = url.pathname.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/);
    if (streamMatch) {
      const [, type, id] = streamMatch;
      if (type !== ADDON_TYPE) return json(res, { streams: [] });
      const entry = cache.byId.get(decodeURIComponent(id));
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
  return {
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
  };
}

function catalog(entries, searchParams) {
  const query = (searchParams.get("search") || "").trim().toLowerCase();
  const genre = (searchParams.get("genre") || "").trim();
  const skip = Number(searchParams.get("skip") || 0);
  const filtered = entries.filter((entry) => {
    if (genre && entry.group !== genre) return false;
    if (query && !entry.name.toLowerCase().includes(query)) return false;
    return true;
  });

  return {
    metas: filtered.slice(skip, skip + PAGE_SIZE).map(toPreview)
  };
}

function toPreview(entry) {
  return {
    id: entry.id,
    type: ADDON_TYPE,
    name: entry.name,
    poster: entry.logo || undefined,
    logo: entry.logo || undefined,
    genres: entry.group ? [entry.group] : undefined
  };
}

function toMeta(entry) {
  if (!entry) return null;
  return {
    ...toPreview(entry),
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
