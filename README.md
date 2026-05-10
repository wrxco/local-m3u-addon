# Local M3U Add-on

A small self-hosted add-on that turns a local M3U/M3U8 playlist into manifest/catalog/meta/stream endpoints for Omni/Stremio-style clients.

Bring your own playlist. This project does not include channel lists, scrape websites, resolve protected links, bypass auth, proxy media, or handle DRM. It only exposes URLs that are already present in your playlist.

## Quick Start

Copy the example playlist:

```sh
cp playlists/example.m3u8 playlists/local.m3u8
```

Edit `playlists/local.m3u8`, then start the server:

```sh
npm start
```

Install this add-on URL in your client:

```text
http://127.0.0.1:7000/manifest.json
```

## Playlist Format

Use a standard UTF-8 M3U/M3U8 file. Each entry should have a `#EXTINF` line followed by one playable URL:

```m3u
#EXTM3U

#EXTINF:-1 tvg-id="Channel.example" tvg-name="Channel Name" tvg-logo="https://example.com/logo.png" group-title="News",Channel Name
https://example.com/live/channel.m3u8
```

Recommended fields:

- `tvg-id`: optional channel/program-guide identifier.
- `tvg-name`: optional source display name.
- `tvg-logo`: optional logo URL.
- `group-title`: optional category/genre.

Entries with the same `tvg-id`/`tvg-name` and logo are grouped into one catalog item with multiple stream choices. For example, `PBS Kids - HD`, `PBS Kids - TVPass HD`, and `PBS Kids - TVPass SD` can appear as one `PBS Kids` item with three playable streams.

`group-title` also matters when cloning an existing manifest: imported catalog ids such as `usa`, `usa_locals`, or `247` can map directly to matching playlist groups.

See [docs/playlist-format.md](docs/playlist-format.md) for the full playlist semantics, grouping rules, catalog mapping, genre filtering, and poster-card behavior.

## Docker

Build and run with Docker. Use absolute bind-mount paths on servers where the Compose file lives outside this repo; Docker may create a directory if a relative file mount points at a missing host path.

```sh
cp playlists/example.m3u8 playlists/local.m3u8
mkdir -p resources
docker build -t local-m3u-addon .
docker run --rm \
  -p 7000:7000 \
  -v "$PWD/playlists/local.m3u8:/data/playlist.m3u8:ro" \
  -v "$PWD/resources:/data/resources:ro" \
  -e ADDON_NAME="My Local Add-on" \
  local-m3u-addon
```

Or use Docker Compose:

```sh
cp playlists/example.m3u8 playlists/local.m3u8
mkdir -p resources
docker compose up --build
```

Then install:

```text
http://localhost:7000/manifest.json
```

For another machine on your network, replace `localhost` with that machine's IP address or hostname.

### Optional Reverse Proxy

Traefik is not required. The plain Docker and Compose examples above publish port `7000` directly and are enough for local or LAN use.

If you already run Traefik or another reverse proxy on the same Docker host, you usually do not need to publish port `7000` with a `ports:` block. Put the add-on on the same Docker network as the proxy and route to internal container port `7000`.

Example Traefik service shape:

```yaml
services:
  local-m3u-addon:
    build: /absolute/path/to/local-m3u-addon
    environment:
      HOST: 0.0.0.0
      PORT: 7000
      PLAYLIST_PATH: /data/playlist.m3u8
      STATIC_DIR: /data/resources
      STATIC_PATH_PREFIX: /resources
      MANIFEST_PATH: /data/manifest.json
    volumes:
      - /absolute/path/to/playlists/local.m3u8:/data/playlist.m3u8:ro
      - /absolute/path/to/resources:/data/resources:ro
      - /absolute/path/to/config/manifest.local.json:/data/manifest.json:ro
    networks:
      - traefik
    labels:
      - traefik.enable=true
      - traefik.docker.network=traefik
      - traefik.http.routers.local-m3u-addon.rule=Host(`m3u.example.com`)
      - traefik.http.routers.local-m3u-addon.entrypoints=websecure
      - traefik.http.routers.local-m3u-addon.tls=true
      - traefik.http.services.local-m3u-addon.loadbalancer.server.port=7000
    restart: unless-stopped

networks:
  traefik:
    external: true
```

## Configuration

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` locally, `0.0.0.0` in Docker | Bind address. |
| `PORT` | `7000` | HTTP port. |
| `PLAYLIST_PATH` | `playlists/local.m3u8` locally, `/data/playlist.m3u8` in Docker | Playlist file to expose. |
| `ADDON_NAME` | `My Local Add-on` | Display name in the client. |
| `ADDON_ID` | `local.m3u.addon` | Add-on identifier. |
| `ADDON_TYPE` | `tv` | Content type used in catalog/meta/stream routes. |
| `CATALOG_ID` | `local_channels` | Catalog identifier. |
| `PAGE_SIZE` | `100` | Number of catalog items returned per page. |
| `STATIC_DIR` | `resources` locally, `/data/resources` in Docker | Optional directory of static files to serve, such as local channel logos. |
| `STATIC_PATH_PREFIX` | `/resources` | URL path prefix for static files. |
| `MANIFEST_PATH` | unset | Optional JSON file with an imported manifest to clone. |

The playlist is reloaded when the file changes.

## Manifest Import

You can import an existing add-on manifest and serve it as your local add-on's manifest:

```sh
npm run import-manifest -- https://example.com/manifest.json \
  --out config/manifest.local.json
```

If the target server does not have Node/npm installed, run the importer through Docker:

```sh
docker run --rm \
  -v "$PWD:/app" \
  -w /app \
  node:22-alpine \
  node bin/import-manifest.js https://example.com/manifest.json \
    --out config/manifest.local.json
```

Or run it inside an already rebuilt add-on container that has a writable config mount:

```sh
docker compose exec local-m3u-addon sh -lc \
  'node /app/bin/import-manifest.js https://example.com/manifest.json --out /data/config/manifest.local.json'
docker compose restart local-m3u-addon
```

The generated `config/manifest.local.json` is ignored by Git. The importer clones the manifest JSON, including resources, types, catalogs, and presentation metadata. The local server then serves your local playlist entries through the imported catalog/type route shape.

When an imported catalog id matches a playlist `group-title`, that catalog serves only entries from that group. For example, an imported catalog id of `usa` serves entries with `group-title="usa"`. An imported catalog id of `search` searches across all local playlist entries.

To use it locally:

```sh
MANIFEST_PATH=config/manifest.local.json npm start
```

To use it in Docker, mount the imported file and set `MANIFEST_PATH`:

```yaml
environment:
  MANIFEST_PATH: /data/manifest.json
volumes:
  - /absolute/path/to/config/manifest.local.json:/data/manifest.json:ro
```

The manifest file is read at server startup. Restart or recreate the container after importing a new manifest.

## Playlist Resource Preparation

If your playlist references remote logos, prepare a self-contained local copy before running the add-on:

```sh
npm run prepare-playlist -- \
  --input /path/to/source-playlist.m3u8 \
  --out playlists/local.m3u8 \
  --resources-dir resources \
  --public-base-url https://m3u.example.com
```

This helper:

- finds unique `tvg-logo` URLs
- downloads them into `resources/`
- writes `resources/logo-map.json`
- rewrites a local playlist copy so logos point at `https://m3u.example.com/resources/...`
- leaves failed logo URLs unchanged so the playlist does not point at missing local files

If the target server does not have Node/npm installed, run it through Docker:

```sh
docker run --rm \
  -v "$PWD:/app" \
  -w /app \
  node:22-alpine \
  node bin/prepare-playlist.js \
    --input /app/source-playlist.m3u8 \
    --out playlists/local.m3u8 \
    --resources-dir resources \
    --public-base-url https://m3u.example.com
```

The prepared playlist and resources are ignored by Git by default.

## Static Resources

You can host local logos or other playlist assets from the same add-on server. Put files under `resources/` and reference them from the playlist with `/resources/...` URLs:

```m3u
#EXTINF:-1 tvg-logo="http://127.0.0.1:7000/resources/logos/example.png" group-title="samples",Example Channel
https://example.com/live/channel.m3u8
```

In Docker, mount the resource directory read-only:

```sh
docker run --rm \
  -p 7000:7000 \
  -v "$PWD/playlists/local.m3u8:/data/playlist.m3u8:ro" \
  -v "$PWD/resources:/data/resources:ro" \
  local-m3u-addon
```

The server also generates Omni-friendly PNG poster cards at `/poster/v2/<type>/<id>.png`. These cards use the `tvg-logo` source image, fit it into a purple poster, and avoid cropping or distortion.

## Endpoints

- `/manifest.json`
- `/catalog/tv/local_channels.json`
- `/meta/tv/<id>.json`
- `/stream/tv/<id>.json`
- `/poster/<version>/<type>/<id>.png`
- `/resources/<path>`
- `/health.json`

The endpoint shape follows the general manifest/catalog/meta/stream pattern used by Stremio-style and EMET/Omni-compatible add-ons. If `MANIFEST_PATH` points to an imported manifest, catalog/type route ids come from that manifest.

## Playlist Audit Tool

This repo also includes a conservative playlist audit helper:

```sh
npm run audit -- --input /path/to/playlist.m3u8 --out-dir reports
```

Outputs:

- `reports/<name>.audit.json`: full structured report.
- `reports/<name>.audit.csv`: spreadsheet-friendly review list.
- `reports/<name>.clean.m3u8`: entries classified as `keep`.
- `reports/<name>.review.m3u8`: entries classified as `keep` or `review`.

You can tune domains:

```sh
npm run audit -- --input /path/to/playlist.m3u8 \
  --allow-domain example.com \
  --deny-domain short-link.example
```

The audit output is not a legal opinion. It is a triage tool to help spot brittle or questionable entries such as short links, raw IPs, non-direct web endpoints, nonstandard ports, event/PPV wording, and commercial-channel names that deserve rights/source review.
