import test from "node:test";
import assert from "node:assert/strict";
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
