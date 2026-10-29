// Locale consistency: both languages have the same keys and placeholders,
// and every key used in code or HTML exists.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LOCALES = ["en", "ru"];
const messages = Object.fromEntries(
  LOCALES.map((l) => [l, JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", l, "messages.json"), "utf8"))])
);
const placeholders = (msg) => (msg.match(/\$\d/g) || []).sort().join(",");

function sourceFiles(dir, ext) {
  return fs
    .readdirSync(path.join(ROOT, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => fs.readFileSync(path.join(ROOT, dir, f), "utf8"));
}

test("en and ru have the same keys", () => {
  assert.deepEqual(Object.keys(messages.ru).sort(), Object.keys(messages.en).sort());
});

test("translations keep the same placeholders", () => {
  for (const [key, { message }] of Object.entries(messages.en)) {
    assert.equal(placeholders(messages.ru[key].message), placeholders(message), key);
  }
});

test("no empty messages", () => {
  for (const l of LOCALES) for (const [key, v] of Object.entries(messages[l])) assert.ok(v.message.trim(), `${l}:${key}`);
});

test("every key used in HTML and JS exists", () => {
  const used = new Set();
  for (const html of sourceFiles("ui", ".html")) {
    for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)) used.add(m[1]);
  }
  for (const js of [...sourceFiles("ui", ".js"), ...sourceFiles("src", ".js")]) {
    for (const m of js.matchAll(/\b(?:t|fail)\(\s*"([A-Za-z_]+)"\s*[,)]/g)) used.add(m[1]);
    for (const m of js.matchAll(/"((?:st|btn|reason|phase|summary|title)[A-Z][A-Za-z]*)"/g)) used.add(m[1]);
  }
  for (const f of ["workMin", "shortMin", "longMin", "cycles"]) used.add("pomo_" + f);
  const missing = [...used].filter((k) => !(k in messages.en));
  assert.deepEqual(missing, []);
});

test("no unused keys", () => {
  const sources = [
    ...sourceFiles("ui", ".html"),
    ...sourceFiles("ui", ".js"),
    ...sourceFiles("src", ".js"),
    fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"),
  ].join("\n");
  const dynamic = (k) => k.startsWith("pomo_"); // built as "pomo_" + field
  const unused = Object.keys(messages.en).filter(
    (k) => !dynamic(k) && !sources.includes(`"${k}"`) && !sources.includes(`__MSG_${k}__`)
  );
  assert.deepEqual(unused, []);
});

test("manifest strings are localized", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.default_locale, "en");
  for (const field of [manifest.name, manifest.description]) {
    const key = field.match(/^__MSG_(\w+)__$/)[1];
    for (const l of LOCALES) assert.ok(messages[l][key], `${l}:${key}`);
  }
});
