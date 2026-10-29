const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("../src/policy.js");
const { sanitize } = require("../src/storage.js");

const NOW = 1_000_000_000_000;
const MIN = 60 * 1000;
const base = (over = {}) => sanitize({ schemaVersion: 1, ...over }, NOW).state;

test("isTightening: only enabling and blocklist growth", () => {
  const s = base({ blocklist: ["a.com"], allowlist: ["x.com"] });
  const cases = [
    [{ enabled: true }, true],
    [{ enabled: false }, false],
    [{ blocklist: ["a.com", "b.com"] }, true],
    [{ blocklist: ["b.com"] }, false],
    [{ blocklist: [] }, false],
    [{ allowlist: ["x.com", "y.com"] }, false],
    [{ mode: "allowlist" }, false],
    [{ enabled: true, blocklist: ["a.com", "c.com"] }, true],
    [{ enabled: true, mode: "allowlist" }, false],
  ];
  for (const [changes, expected] of cases) assert.equal(policy.isTightening(changes, s), expected, JSON.stringify(changes));
});

test("changedOnly ignores unchanged fields and list order", () => {
  const s = base({ blocklist: ["a.com", "b.com"], enabled: true });
  assert.deepEqual(policy.changedOnly({ blocklist: ["b.com", "a.com"], enabled: true, mode: "blocklist" }, s), {});
  assert.deepEqual(policy.changedOnly({ enabled: false }, s), { enabled: false });
});

test("blockReason priority and phases", () => {
  const url = "https://youtube.com/";
  assert.equal(policy.blockReason(base({ blocklist: ["youtube.com"] }), url, NOW), null);
  assert.equal(policy.blockReason(base({ blocklist: ["youtube.com"], enabled: true }), url, NOW), "focus");
  assert.equal(policy.blockReason(base({ blocklist: ["youtube.com"], timerEnd: NOW + MIN }), url, NOW), "timer");
  assert.equal(policy.blockReason(base({ blocklist: ["youtube.com"], timerEnd: NOW + MIN }), url, NOW + MIN), null);
  const run = { workMin: 25, shortMin: 5, longMin: 20, cycles: 4, useMainRules: false, blocklist: ["youtube.com"], startedAt: NOW };
  const s = base({ pomodoroRun: run });
  assert.equal(policy.blockReason(s, url, NOW), "pomodoro");
  assert.equal(policy.blockReason(s, url, NOW + 26 * MIN), null);
  assert.equal(policy.blockReason(s, "https://example.com/", NOW), null);
  assert.equal(policy.blockReason(s, "about:addons", NOW), null);
});

test("publicState hides secrets and adds phaseStart", () => {
  const run = { workMin: 25, shortMin: 5, longMin: 20, cycles: 4, useMainRules: false, blocklist: ["a.com"], startedAt: NOW };
  const s = base({ passwordHash: "ab", passwordSalt: "cd", pomodoroRun: run });
  const p = policy.publicState(s, NOW + 10 * MIN);
  assert.equal(p.hasPassword, true);
  assert.ok(!("passwordHash" in p) && !("passwordSalt" in p));
  assert.equal(p.pomodoroStatus.phaseStart, NOW);
  assert.equal(p.pomodoroStatus.phaseEnd, NOW + 25 * MIN);
  assert.equal(p.pomodoroStatus.cycles, 4);
});

test("sanitize is idempotent and reports changes", () => {
  const first = sanitize({ blocklist: ["YouTube.com"] }, NOW);
  assert.equal(first.changed, true);
  const second = sanitize(first.state, NOW);
  assert.equal(second.changed, false);
  assert.deepEqual(second.state, first.state);
});

test("sanitize drops an expired timer and keeps an active one", () => {
  assert.equal(base({ timerEnd: NOW - 1 }).timerEnd, null);
  assert.equal(base({ timerEnd: NOW + 1 }).timerEnd, NOW + 1);
});
