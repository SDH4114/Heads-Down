const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const SRC = fs.readFileSync(path.join(__dirname, "..", "src", "compat.js"), "utf8");

function run(globals) {
  const ctx = vm.createContext({ ...globals });
  vm.runInContext(SRC, ctx);
  return ctx;
}

test("Chromium before 148: browser becomes an alias of chrome", () => {
  const chrome = { runtime: {} };
  assert.equal(run({ chrome }).browser, chrome);
});

test("Firefox and Chrome 148+: an existing browser is kept", () => {
  const browser = { runtime: {} };
  assert.equal(run({ browser, chrome: { runtime: {} } }).browser, browser);
});

test("a web page's chrome object without runtime is not aliased", () => {
  assert.equal(run({ chrome: {} }).browser, undefined);
});
