// Pure URL/domain matching. Works as a browser global (FG.matcher) and as a Node module for tests.
(function (root) {
  // "https://www.YouTube.com/watch?v=1" -> "youtube.com"; returns "" for junk input.
  // Parsing through URL gives the same punycode form as real hostnames ("пример.рф" -> "xn--...").
  function normalizeDomain(input) {
    if (typeof input !== "string") return "";
    // "*.x.com" and cookie-style ".x.com" both mean x.com and its subdomains.
    let s = input.trim().toLowerCase().replace(/^\*\./, "").replace(/^\.+/, "");
    if (!s) return "";
    if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "http://" + s;
    let url;
    try {
      url = new URL(s);
    } catch {
      return "";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
    if (!host.includes(".") && host !== "localhost") return "";
    if (host.split(".").some((label) => !label)) return ""; // "x..com", ".x.com" never match
    // The URL parser turns "5" or "1.2" into IPv4 ("0.0.0.5"); accept an IP only if typed in full.
    if (/^\d+(\.\d+){3}$/.test(host)) {
      const authority = s.slice(s.indexOf("://") + 3).split(/[/?#]/, 1)[0];
      const typedHost = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "").replace(/\.$/, "").replace(/^www\./, "");
      if (typedHost !== host) return "";
    }
    return host;
  }

  // Domain entry matches the host itself and every subdomain of it.
  function hostMatches(host, domain) {
    return host === domain || host.endsWith("." + domain);
  }

  function matchesAny(host, list) {
    return (list || []).some((d) => hostMatches(host, d));
  }

  // Only web pages are subject to blocking; browser and extension pages are always allowed.
  function isBlocked(url, state) {
    if (!state || !state.active) return false;
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (state.mode === "allowlist") return !matchesAny(host, state.allowlist);
    return matchesAny(host, state.blocklist);
  }

  // Normalizes a user list. Throws listing every bad entry, so typos are not dropped silently.
  function cleanList(list) {
    if (!Array.isArray(list)) throw new Error("List must be an array.");
    const bad = list.filter((d) => !normalizeDomain(d));
    if (bad.length) throw new Error("Not a domain: " + bad.join(", "));
    return [...new Set(list.map(normalizeDomain))];
  }

  // Lenient variant for stored data: keeps valid entries, drops the rest.
  function salvageList(list) {
    return Array.isArray(list) ? [...new Set(list.map(normalizeDomain).filter(Boolean))] : [];
  }

  const api = { normalizeDomain, hostMatches, isBlocked, cleanList, salvageList };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.FG = root.FG || {}).matcher = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
