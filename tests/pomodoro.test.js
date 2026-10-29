const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULTS, validateConfig, phaseAt } = require("../src/pomodoro.js");

const MIN = 60 * 1000;
const run = (over = {}) => ({ ...DEFAULTS, startedAt: 0, ...over });
const at = (r, minutes) => {
  const p = phaseAt(r, minutes * MIN);
  return [p.phase, p.cycle, (p.phaseEnd - minutes * MIN) / MIN];
};

test("defaults match the requested schedule", () => {
  assert.equal(DEFAULTS.cycles, 4);
  assert.equal(DEFAULTS.longMin, 20);
});

test("phase sequence with defaults (25/5, long 20 after 4 work sessions)", () => {
  const r = run();
  assert.deepEqual(at(r, 0), ["work", 1, 25]);
  assert.deepEqual(at(r, 24.5), ["work", 1, 0.5]);
  assert.deepEqual(at(r, 25), ["break", 1, 5]);
  assert.deepEqual(at(r, 30), ["work", 2, 25]);
  assert.deepEqual(at(r, 60), ["work", 3, 25]);
  assert.deepEqual(at(r, 85), ["break", 3, 5]);
  assert.deepEqual(at(r, 90), ["work", 4, 25]);
  assert.deepEqual(at(r, 115), ["longBreak", 4, 20]); // 4*25 + 3*5 = 115
  assert.deepEqual(at(r, 134), ["longBreak", 4, 1]);
  assert.deepEqual(at(r, 135), ["work", 1, 25]); // round = 135 minutes
  assert.deepEqual(at(r, 135 * 3 + 26), ["break", 1, 4]);
});

test("phaseEnd is absolute and exact", () => {
  const r = run({ startedAt: 1000 });
  assert.equal(phaseAt(r, 1000 + 10 * MIN).phaseEnd, 1000 + 25 * MIN);
  assert.equal(phaseAt(r, 1000 + 26 * MIN).phaseEnd, 1000 + 30 * MIN);
});

test("single cycle: work then long break only", () => {
  const r = run({ cycles: 1, workMin: 10, longMin: 3 });
  assert.deepEqual(at(r, 5), ["work", 1, 5]);
  assert.deepEqual(at(r, 10), ["longBreak", 1, 3]);
  assert.deepEqual(at(r, 13), ["work", 1, 10]);
});

test("clock before start counts as the start", () => {
  assert.equal(phaseAt(run({ startedAt: 10 * MIN }), 0).phase, "work");
});

test("validateConfig accepts numeric strings and fills defaults", () => {
  const c = validateConfig({ workMin: "50", shortMin: "10", useMainRules: 1 });
  assert.equal(c.workMin, 50);
  assert.equal(c.shortMin, 10);
  assert.equal(c.longMin, 20);
  assert.equal(c.cycles, 4);
  assert.equal(c.useMainRules, true);
});

test("validateConfig rejects out-of-range and fractional values", () => {
  for (const bad of [{ workMin: 0 }, { workMin: 181 }, { shortMin: 1.5 }, { longMin: "" }, { cycles: 13 }, { cycles: NaN }]) {
    assert.throws(() => validateConfig(bad), /whole number/, JSON.stringify(bad));
  }
});

test("clock before start keeps the absolute first phase boundary", () => {
  const r = run({ startedAt: 10 * MIN });
  assert.equal(phaseAt(r, 0).phaseEnd, 35 * MIN);
  assert.equal(phaseAt(r, 5 * MIN).phaseEnd, 35 * MIN);
});
