import net from "node:net";

const DEFAULT_DENY_DOMAINS = new Set([
  "tvpass.org",
  "arion1.short.gy",
  "short.gy",
  "bit.ly",
  "tinyurl.com",
  "t.co"
]);

const REVIEW_KEYWORDS = [
  "ppv",
  "event",
  "events",
  "ufc",
  "boxing",
  "wwe"
];

const SUSPICIOUS_CHANNEL_KEYWORDS = [
  "hbo",
  "showtime",
  "cinemax",
  "starz",
  "espn",
  "nfl",
  "nba",
  "mlb",
  "nick",
  "disney",
  "cartoon network",
  "animal planet"
];

export function auditEntries(entries, options = {}) {
  const allowDomains = normalizeDomainSet(options.allowDomains || []);
  const denyDomains = new Set([
    ...DEFAULT_DENY_DOMAINS,
    ...normalizeDomainSet(options.denyDomains || [])
  ]);

  const audited = entries.map((entry) => {
    const signals = inspectEntry(entry, { allowDomains, denyDomains });
    return {
      ...entry,
      audit: {
        status: classify(signals),
        score: scoreSignals(signals),
        signals
      }
    };
  });

  const summary = audited.reduce(
    (acc, entry) => {
      acc.total += 1;
      acc[entry.audit.status] += 1;
      return acc;
    },
    { total: 0, keep: 0, review: 0, drop: 0 }
  );

  return { entries: audited, summary };
}

export function inspectEntry(entry, { allowDomains = new Set(), denyDomains = new Set() } = {}) {
  const signals = [];
  const parsed = safeUrl(entry.url);
  const name = `${entry.name} ${entry.group}`.toLowerCase();

  if (!parsed) {
    signals.push(signal("invalid-url", "drop", "URL is not parseable."));
    return signals;
  }

  const hostname = parsed.hostname.toLowerCase();
  const hostnameNoWww = hostname.replace(/^www\./, "");

  if (allowDomains.has(hostnameNoWww)) {
    signals.push(signal("allow-domain", "keep", "Domain is on the explicit allow list."));
  }

  if (denyDomains.has(hostnameNoWww)) {
    signals.push(signal("deny-domain", "drop", "Domain is on the deny list."));
  }

  if (net.isIP(hostnameNoWww)) {
    signals.push(signal("raw-ip", "review", "URL uses a raw IP address instead of a named service."));
  }

  if (parsed.port && !["80", "443"].includes(parsed.port)) {
    signals.push(signal("nonstandard-port", "review", "URL uses a nonstandard HTTP port."));
  }

  if (/\.m3u8($|[?#])/.test(parsed.pathname + parsed.search)) {
    signals.push(signal("direct-hls", "keep", "URL points directly at an HLS playlist."));
  } else {
    signals.push(signal("not-direct-hls", "review", "URL may require a third-party resolver or redirect."));
  }

  for (const word of REVIEW_KEYWORDS) {
    if (name.includes(word)) {
      signals.push(signal("event-or-ppv-keyword", "drop", `Name/group contains "${word}".`));
      break;
    }
  }

  for (const word of SUSPICIOUS_CHANNEL_KEYWORDS) {
    if (name.includes(word)) {
      signals.push(signal("commercial-channel-keyword", "review", `Name/group contains "${word}".`));
      break;
    }
  }

  if (entry.logo && !safeUrl(entry.logo)) {
    signals.push(signal("invalid-logo", "review", "Logo URL is not parseable."));
  }

  return signals;
}

function classify(signals) {
  if (signals.some((item) => item.severity === "drop")) return "drop";
  if (signals.some((item) => item.severity === "review")) return "review";
  return "keep";
}

function scoreSignals(signals) {
  return signals.reduce((score, item) => {
    if (item.severity === "drop") return score - 100;
    if (item.severity === "review") return score - 10;
    return score + 10;
  }, 0);
}

function signal(code, severity, message) {
  return { code, severity, message };
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normalizeDomainSet(domains) {
  return new Set(domains.map((domain) => domain.toLowerCase().replace(/^www\./, "")));
}
