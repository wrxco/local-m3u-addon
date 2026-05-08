import crypto from "node:crypto";

const ATTRIBUTE_RE = /([A-Za-z0-9_-]+)="([^"]*)"/g;

export function parseM3u(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let pending = null;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("#EXTINF")) {
      pending = parseExtinf(line, index + 1);
      continue;
    }

    if (line.startsWith("#")) continue;

    if (pending) {
      const url = line;
      const id = stableId(`${pending.name}\n${url}`);
      entries.push({
        id,
        name: pending.name || url,
        duration: pending.duration,
        attributes: pending.attributes,
        group: pending.attributes["group-title"] || "",
        logo: pending.attributes["tvg-logo"] || "",
        url,
        line: index + 1
      });
      pending = null;
    }
  }

  return entries;
}

export function parseExtinf(line, lineNumber = 0) {
  const commaIndex = line.indexOf(",");
  const header = commaIndex === -1 ? line : line.slice(0, commaIndex);
  const name = commaIndex === -1 ? "" : line.slice(commaIndex + 1).trim();
  const durationMatch = header.match(/^#EXTINF:([^,\s]*)/);
  const duration = durationMatch ? durationMatch[1] : "";
  const attributes = {};

  for (const match of header.matchAll(ATTRIBUTE_RE)) {
    attributes[match[1]] = match[2];
  }

  return { name, duration, attributes, line: lineNumber };
}

export function toM3u(entries) {
  const lines = ["#EXTM3U", ""];

  for (const entry of entries) {
    const attrs = { ...entry.attributes };
    if (entry.logo && !attrs["tvg-logo"]) attrs["tvg-logo"] = entry.logo;
    if (entry.group && !attrs["group-title"]) attrs["group-title"] = entry.group;
    const attrText = Object.entries(attrs)
      .filter(([, value]) => value !== undefined && value !== null && value !== "")
      .map(([key, value]) => `${key}="${String(value).replaceAll('"', "'")}"`)
      .join(" ");
    const prefix = attrText ? `#EXTINF:-1 ${attrText}` : "#EXTINF:-1";
    lines.push(`${prefix},${entry.name}`, entry.url);
  }

  lines.push("");
  return lines.join("\n");
}

function stableId(value) {
  return crypto.createHash("sha1").update(value).digest("hex").slice(0, 16);
}
