# Playlist Format

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

- `tvg-id`: optional channel/program-guide identifier.
- `tvg-name`: optional display name from the source playlist.
- `tvg-logo`: optional logo URL.
- `group-title`: optional category/genre shown in the catalog filters.

Notes:

- Direct HLS URLs ending in `.m3u8` are the most reliable.
- Web page URLs, short links, tokenized links, and login-protected links may not work.
- This add-on does not scrape pages, add cookies, bypass auth, resolve DRM, or proxy media.
