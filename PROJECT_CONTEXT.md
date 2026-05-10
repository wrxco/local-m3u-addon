# Project Context

This project came from a discussion about building a small, local Omni/Stremio-style add-on for personal M3U/M3U8 playlists.

## Decisions

- The add-on is intentionally neutral and minimal: it exposes playlist entries, but does not scrape sites, bypass authentication, resolve protected links, proxy media, or handle DRM.
- The core server lives in `src/server.js`.
- Playlist parsing lives in `src/m3u.js`.
- Playlist review heuristics live in `src/audit.js`.
- The CLI audit tool lives in `bin/audit-playlist.js`.
- Existing add-on manifests can be cloned with `bin/import-manifest.js`; the server then uses the imported resources, types, and catalogs while serving local playlist data.
- Playlist logo resources can be localized with `bin/prepare-playlist.js`, which downloads remote `tvg-logo` assets into `resources/` and rewrites a local ignored playlist copy.
- Docker support is included so the server can be deployed quickly to another system.
- Users should drop in a standard UTF-8 M3U/M3U8 playlist with `#EXTINF` metadata followed by playable URLs. The playlist is treated as stream variants that can group into one catalog item with multiple stream choices. See `docs/playlist-format.md`.
- Logos can be served from a local `resources/` directory and are rendered into generated PNG poster cards under `/poster/v2/<type>/<id>.png` for Omni grid views.

## Add-on Shape

The server exposes a Stremio/EMET/Omni-style endpoint set:

- `/manifest.json`
- `/catalog/tv/local_channels.json`
- `/meta/tv/<id>.json`
- `/stream/tv/<id>.json`
- `/poster/v2/tv/<id>.png`
- `/resources/<path>`
- `/health.json`

When a manifest is imported, catalog/type route ids come from that manifest. Imported catalog ids are matched against playlist `group-title` values, with a special `search` catalog spanning all local playlist entries.

## Provenance And Safety Notes

The original exploration involved a third-party playlist and a claim that stream lists were generated from `iptv-org/iptv`.

A spot comparison against a fresh checkout of `iptv-org/iptv` found partial overlap, not full equivalence:

- Some direct public/local links matched iptv-org.
- Some third-party or short-link entries did not.
- Being present in iptv-org is a useful provenance signal, but not a legal opinion or final authorization guarantee.

The audit tool is conservative by design. It flags things like short links, raw IPs, non-direct web endpoints, nonstandard ports, event/PPV wording, and commercial-channel names for review or drop.

## Publishing Notes

This folder is intended to be the publishable project. Generated local artifacts such as `reports/`, `logs/`, `resources/`, `playlists/local*.m3u8`, `config/*.local.json`, `.DS_Store`, and unrelated scratch docs are ignored.
