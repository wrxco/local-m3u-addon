# Playlist Format And Semantics

Drop in a standard UTF-8 M3U/M3U8 playlist. The server expects a `#EXTINF` line followed by one playable URL.

Minimum entry:

```m3u
#EXTM3U

#EXTINF:-1,Channel Name
https://example.com/live/channel.m3u8
```

Recommended entry:

```m3u
#EXTM3U

#EXTINF:-1 tvg-id="Channel.example" tvg-name="Channel Name" tvg-logo="https://example.com/logo.png" group-title="News",Channel Name
https://example.com/live/channel.m3u8
```

Supported metadata:

- `tvg-id`: channel/program-guide identifier. Variants with the same `tvg-id` are grouped together.
- `tvg-name`: source display name. Used as a fallback grouping identity when `tvg-id` is empty.
- `tvg-logo`: logo URL. Used for local poster-card generation and as part of the grouping key.
- `group-title`: catalog partition/category. Imported manifest catalog ids can map directly to this value.

## Playlist Semantics

For Omni/Stremio-style clients, the playlist is treated as a small content model, not only a flat list of stream URLs.

Each `#EXTINF` entry describes one stream variant. The server groups related variants into one catalog item, then exposes the individual URLs as stream choices.

Example:

```m3u
#EXTM3U

#EXTINF:-1 tvg-id="PBS.KIDS.HD.us2" tvg-name="PBS.KIDS.HD.us2" tvg-logo="https://manny.example/resources/logos/usa/pbskids.png" group-title="usa",PBS Kids - HD
https://example.com/pbs-hd.m3u8
#EXTINF:-1 tvg-id="PBS.KIDS.HD.us2" tvg-name="PBS.KIDS.HD.us2" tvg-logo="https://manny.example/resources/logos/usa/pbskids.png" group-title="usa",PBS Kids - TVPass HD
https://example.com/pbs-tvpass-hd
#EXTINF:-1 tvg-id="PBS.KIDS.HD.us2" tvg-name="PBS.KIDS.HD.us2" tvg-logo="https://manny.example/resources/logos/usa/pbskids.png" group-title="usa",PBS Kids - TVPass SD
https://example.com/pbs-tvpass-sd
```

This becomes one catalog item:

```text
PBS Kids
```

With three stream choices:

```text
HD
TVPass HD
TVPass SD
```

## Grouping Rules

Entries are grouped when these values match:

- `group-title`
- `tvg-id`, or `tvg-name` when `tvg-id` is empty
- `tvg-logo`

The display name after the comma is cleaned into a channel name plus a stream variant:

| Playlist name | Catalog item | Stream title |
| --- | --- | --- |
| `PBS Kids - HD` | `PBS Kids` | `HD` |
| `PBS Kids - TVPass HD` | `PBS Kids` | `TVPass HD` |
| `PBS Kids - TVPass SD` | `PBS Kids` | `TVPass SD` |

The suffix parser recognizes common quality/source suffixes after ` - `, including `HD`, `SD`, `FHD`, `UHD`, `4K`, `TVPass HD`, and `Arion HD`.

## Catalog Mapping

When you import a manifest, catalog ids are used to partition the playlist by `group-title`.

For example, if the imported manifest contains:

```json
{
  "type": "tv",
  "id": "usa",
  "name": "United States TV"
}
```

Then this route:

```text
/catalog/tv/usa.json
```

serves entries with:

```m3u
group-title="usa"
```

The special imported catalog id `search` searches across all local playlist entries.

## Genres And Filters

Imported manifests often provide genre options such as `Kids`, `News`, `Sports`, or state names. The server exposes those catalog options from the imported manifest, then filters local playlist entries using derived tags.

Some tags are inferred from channel names and ids:

| Inferred tag | Example matches |
| --- | --- |
| `Kids` | `kids`, `pbs.kids`, `nick`, `disney`, `cartoon`, `boomerang`, `family` |
| `News` | `news`, `cnbc`, `cnn`, `fox news`, `weather` |
| `Sports` | `sports`, `espn`, `nfl`, `nba`, `mlb`, `nhl`, `tennis`, `golf` |
| `Movies` | `movie`, `hbo`, `showtime`, `starz`, `cinemax`, `hallmark` |
| `Documentaries` | `documentary`, `history`, `science`, `nat geo`, `smithsonian` |
| `Music` | `music`, `mtv`, `vh1`, `cmt` |
| `Crime` | `crime`, `court`, `investigation` |
| `Lifestyle` | `food`, `travel`, `home`, `hgtv`, `diy`, `lifestyle`, `tlc` |

## Logos And Poster Cards

The `tvg-logo` value is used in two ways:

- It remains available as the item `logo`.
- It is rendered into a generated purple PNG poster card at `/poster/v2/<type>/<id>.png`.

The generated poster is what Omni uses in grid views. The source logo is resized to fit inside the poster without cropping or distortion.

Transparent PNG logos usually work best. SVG, WebP, JPEG, and PNG may work as source assets if the server can fetch and rasterize them.

Use `npm run prepare-playlist` to download remote `tvg-logo` assets into `resources/` and rewrite a local playlist copy so it references this add-on's `/resources/...` endpoint. Failed downloads are reported and left on their original remote URLs.

## Best Practices

- Use a stable `tvg-id` for all variants of the same channel.
- Keep all variants of a channel in the same `group-title`.
- Use the same `tvg-logo` for variants you want grouped.
- Put source/quality variants after ` - ` in the display name.
- Prefer `PBS Kids - HD` over putting quality/source data in `tvg-id`.
- When cloning an existing manifest, align playlist `group-title` values with manifest catalog ids such as `usa`, `usa_locals`, `247`, or `events`.
- Keep local logos under `resources/` and serve them through this add-on when you want stable poster generation.

Notes:

- Direct HLS URLs ending in `.m3u8` are the most reliable.
- Web page URLs, short links, tokenized links, and login-protected links may not work.
- This add-on does not scrape pages, add cookies, bypass auth, resolve DRM, or proxy media.
