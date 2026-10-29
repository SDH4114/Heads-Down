const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeDomain, isBlocked } = require("../src/matcher.js");
const { hashPassword, verifyPassword, timerActive } = require("../src/lock.js");

test("normalizeDomain strips scheme, www, path, port and case", () => {
  assert.equal(normalizeDomain("https://www.YouTube.com/watch?v=1"), "youtube.com");
  assert.equal(normalizeDomain("tiktok.com:443/foo"), "tiktok.com");
  assert.equal(normalizeDomain("  *.reddit.com "), "reddit.com");
  assert.equal(normalizeDomain("user@site.org"), "site.org");
  assert.equal(normalizeDomain("localhost"), "localhost");
  assert.equal(normalizeDomain("Example.com."), "example.com");
});

test("normalizeDomain converts IDN to punycode, matching real hostnames", () => {
  const d = normalizeDomain("пример.рф");
  assert.equal(d, new URL("https://пример.рф/").hostname);
  assert.equal(isBlocked("https://www.пример.рф/", { active: true, mode: "blocklist", blocklist: [d] }), true);
});

test("normalizeDomain: leading dots, empty labels, IP shorthand", () => {
  assert.equal(normalizeDomain(".youtube.com"), "youtube.com");
  assert.equal(normalizeDomain("..youtube.com"), "youtube.com");
  assert.equal(normalizeDomain("192.168.1.10"), "192.168.1.10");
  for (const bad of ["x..com", "5", "1.2", 5]) assert.equal(normalizeDomain(bad), "", String(bad));
});

test("cleanList and salvageList", () => {
  const { cleanList, salvageList } = require("../src/matcher.js");
  assert.deepEqual(cleanList(["YouTube.com", "www.youtube.com", "tiktok.com"]), ["youtube.com", "tiktok.com"]);
  assert.throws(() => cleanList(["ok.com", "bad one", "x..y"]), /Not a domain: bad one, x\.\.y/);
  assert.throws(() => cleanList("ok.com"), /array/);
  assert.deepEqual(salvageList(["ok.com", "bad one", null, 7]), ["ok.com"]);
  assert.deepEqual(salvageList("nope"), []);
});

test("normalizeDomain rejects junk", () => {
  for (const bad of ["", "   ", "youtube", "about:blank", "moz-extension://abc/x.html", "has space.com"]) {
    assert.equal(normalizeDomain(bad), "", bad);
  }
});

const block = (mode, list, enabled = true) => ({
  active: enabled,
  mode,
  blocklist: mode === "blocklist" ? list : [],
  allowlist: mode === "allowlist" ? list : [],
});

test("blocklist blocks domain and subdomains only", () => {
  const s = block("blocklist", ["youtube.com"]);
  assert.equal(isBlocked("https://youtube.com/", s), true);
  assert.equal(isBlocked("https://www.youtube.com/watch", s), true);
  assert.equal(isBlocked("https://m.youtube.com/", s), true);
  assert.equal(isBlocked("https://notyoutube.com/", s), false);
  assert.equal(isBlocked("https://youtube.com.evil.net/", s), false);
  assert.equal(isBlocked("https://example.com/", s), false);
});

test("allowlist blocks everything except listed domains", () => {
  const s = block("allowlist", ["example.org"]);
  assert.equal(isBlocked("https://example.org/test", s), false);
  assert.equal(isBlocked("https://app.example.org/", s), false);
  assert.equal(isBlocked("https://youtube.com/", s), true);
});

test("empty lists: blocklist blocks nothing, allowlist blocks all web", () => {
  assert.equal(isBlocked("https://youtube.com/", block("blocklist", [])), false);
  assert.equal(isBlocked("https://youtube.com/", block("allowlist", [])), true);
});

test("inactive focus and non-web pages are never blocked", () => {
  assert.equal(isBlocked("https://youtube.com/", block("blocklist", ["youtube.com"], false)), false);
  const all = block("allowlist", []);
  for (const url of ["about:addons", "moz-extension://id/ui/blocked.html", "file:///tmp/a.html", "not a url"]) {
    assert.equal(isBlocked(url, all), false, url);
  }
});

test("password hash verifies only the right password", async () => {
  const { hash, salt } = await hashPassword("secret1");
  assert.equal(await verifyPassword("secret1", hash, salt), true);
  assert.equal(await verifyPassword("secret2", hash, salt), false);
  assert.equal(await verifyPassword(undefined, hash, salt), false);
  const again = await hashPassword("secret1");
  assert.notEqual(again.salt, salt, "salt must be random");
});

test("timerActive compares against an absolute end time", () => {
  assert.equal(timerActive(2000, 1000), true);
  assert.equal(timerActive(1000, 1000), false);
  assert.equal(timerActive(null, 1000), false);
});
