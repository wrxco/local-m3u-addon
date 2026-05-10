import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseM3u, toM3u } from "../src/m3u.js";
import { auditEntries } from "../src/audit.js";

test("parseM3u reads extinf metadata and URLs", () => {
  const entries = parseM3u(`#EXTM3U

#EXTINF:-1 tvg-id="pbs" tvg-logo="https://example.test/logo.png" group-title="kids",PBS Kids
https://example.test/pbs/index.m3u8
`);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "PBS Kids");
  assert.equal(entries[0].group, "kids");
  assert.equal(entries[0].logo, "https://example.test/logo.png");
  assert.equal(entries[0].attributes["tvg-id"], "pbs");
  assert.match(entries[0].id, /^[a-f0-9]{16}$/);
});

test("toM3u writes entries back to playlist format", () => {
  const [entry] = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="samples",Sample
https://example.test/live.m3u8
`);

  const output = toM3u([entry]);
  assert.match(output, /#EXTM3U/);
  assert.match(output, /group-title="samples",Sample/);
  assert.match(output, /https:\/\/example\.test\/live\.m3u8/);
});

test("audit keeps direct HLS and drops denied domains", () => {
  const entries = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="kids",PBS Kids
https://example.test/live.m3u8
#EXTINF:-1 group-title="usa",Some TVPass Entry
https://tvpass.org/live/WNET/hd
`);

  const result = auditEntries(entries, { allowDomains: ["example.test"] });
  assert.equal(result.summary.keep, 1);
  assert.equal(result.summary.drop, 1);
  assert.equal(result.entries[0].audit.status, "keep");
  assert.equal(result.entries[1].audit.status, "drop");
});

test("audit flags raw IPs and non-direct HLS URLs for review", () => {
  const entries = parseM3u(`#EXTM3U
#EXTINF:-1 group-title="local",Local Station
http://23.237.104.106:8080/live/channel
`);

  const result = auditEntries(entries);
  assert.equal(result.entries[0].audit.status, "review");
  assert.deepEqual(
    result.entries[0].audit.signals.map((signal) => signal.code),
    ["raw-ip", "nonstandard-port", "not-direct-hls"]
  );
});

test("server groups duplicate channel entries into multiple streams", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "local-m3u-addon-"));
  const playlistPath = path.join(tmp, "playlist.m3u8");
  const manifestPath = path.join(tmp, "manifest.json");
  const port = 7600 + Number(process.pid % 1000);

  await fs.writeFile(
    playlistPath,
    `#EXTM3U
#EXTINF:-1 tvg-id="PBS.KIDS.HD.us2" tvg-name="PBS.KIDS.HD.us2" tvg-logo="https://example.test/pbskids.png" group-title="usa",PBS Kids - HD
https://example.test/pbs/hd.m3u8
#EXTINF:-1 tvg-id="PBS.KIDS.HD.us2" tvg-name="PBS.KIDS.HD.us2" tvg-logo="https://example.test/pbskids.png" group-title="usa",PBS Kids - TVPass HD
https://tvpass.example/live/WNET/hd
#EXTINF:-1 tvg-id="PBS.KIDS.HD.us2" tvg-name="PBS.KIDS.HD.us2" tvg-logo="https://example.test/pbskids.png" group-title="usa",PBS Kids - TVPass SD
https://tvpass.example/live/WNET/sd
`
  );

  await fs.writeFile(
    manifestPath,
    JSON.stringify({
      id: "example.clone",
      name: "Example Clone",
      resources: ["catalog", "meta", "stream"],
      types: ["tv"],
      catalogs: [
        {
          type: "tv",
          id: "usa",
          name: "United States TV",
          extra: [{ name: "genre", isRequired: false, options: ["Kids"] }]
        }
      ]
    })
  );

  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PLAYLIST_PATH: playlistPath,
      MANIFEST_PATH: manifestPath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(child, port);

    const catalog = await getJson(`http://127.0.0.1:${port}/catalog/tv/usa/genre=Kids.json`);
    assert.equal(catalog.metas.length, 1);
    assert.equal(catalog.metas[0].name, "PBS Kids");
    assert.ok(catalog.metas[0].poster.startsWith(`http://127.0.0.1:${port}/poster/v2/tv/`));
    assert.ok(catalog.metas[0].poster.endsWith(".png"));
    assert.equal(catalog.metas[0].posterShape, "poster");
    assert.equal(catalog.metas[0].logo, "https://example.test/pbskids.png");
    assert.deepEqual(catalog.metas[0].genres, ["usa", "Kids"]);

    const poster = await fetch(catalog.metas[0].poster);
    assert.equal(poster.headers.get("content-type"), "image/png");
    assert.ok((await poster.arrayBuffer()).byteLength > 1000);

    const streams = await getJson(`http://127.0.0.1:${port}/stream/tv/${catalog.metas[0].id}.json`);
    assert.deepEqual(
      streams.streams.map((stream) => [stream.title, stream.quality]),
      [
        ["HD", "720p"],
        ["TVPass HD", "720p"],
        ["TVPass SD", "480p"]
      ]
    );
  } finally {
    child.kill();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

async function waitForServer(child, port) {
  const deadline = Date.now() + 3000;
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  while (Date.now() < deadline) {
    try {
      await getJson(`http://127.0.0.1:${port}/health.json`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error(`server did not start: ${stderr}`);
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}
