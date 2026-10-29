// Loads the real background scripts into a sandbox with a fake `browser` API,
// then drives them through messages, requests and tab events.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SCRIPTS = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8")).background.scripts;
const BLOCKED = "moz-extension://test-id/ui/blocked.html";
// Arrays created inside the vm sandbox have a different prototype; copy them into this realm.
const plain = (x) => JSON.parse(JSON.stringify(x));
const EN = JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", "en", "messages.json"), "utf8"));

function makeBrowser(initial = {}, tabs = []) {
  const store = { ...initial };
  const listeners = { changed: [], request: [], updated: [], message: [] };
  const updates = [];
  const notifications = [];
  const browser = {
    notifications: { create: async (opts) => notifications.push(opts.message) },
    i18n: {
      getMessage: (key, subs = []) => {
        const entry = EN[key];
        return entry ? entry.message.replace(/\$(\d)/g, (_, i) => subs[i - 1] ?? "") : "";
      },
    },
    storage: {
      local: {
        get: async (keys) =>
          keys === null ? { ...store } : Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (patch) => {
          const changes = {};
          for (const [k, v] of Object.entries(patch)) {
            changes[k] = { oldValue: store[k], newValue: v };
            store[k] = v;
          }
          listeners.changed.forEach((fn) => fn(changes, "local"));
        },
      },
      onChanged: { addListener: (fn) => listeners.changed.push(fn) },
    },
    webRequest: { onBeforeRequest: { addListener: (fn, filter, extra) => listeners.request.push({ fn, filter, extra }) } },
    tabs: {
      query: async () => tabs,
      update: async (id, props) => updates.push({ id, url: props.url }),
      onUpdated: { addListener: (fn) => listeners.updated.push(fn) },
    },
    runtime: {
      getURL: (p) => "moz-extension://test-id/" + p,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
    },
  };
  return { browser, store, listeners, updates, notifications };
}

// Fake clock and timers: `advance(ms)` moves time forward and fires due timeouts,
// so pomodoro phases can be tested without waiting and without keeping Node alive.
function makeClock(start = Date.UTC(2026, 0, 1, 9)) {
  let now = start;
  let timers = [];
  let nextId = 1;
  class FakeDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  return {
    Date: FakeDate,
    setTimeout: (fn, ms) => (timers.push({ id: nextId, at: now + ms, fn }), nextId++),
    clearTimeout: (id) => (timers = timers.filter((t) => t.id !== id)),
    pending: () => timers.length,
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

async function boot(initial, tabs, clock = makeClock()) {
  const env = makeBrowser(initial, tabs);
  const ctx = vm.createContext({
    browser: env.browser,
    crypto,
    URL,
    TextEncoder,
    console,
    Date: clock.Date,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  for (const file of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, file), "utf8"), ctx, { filename: file });
  const send = (type, payload = {}) => env.listeners.message[0]({ type, ...payload });
  await send("getState"); // waits for initial load
  await new Promise((r) => setImmediate(r)); // let the startup tab sweep finish
  const request = async (url) => {
    const res = await env.listeners.request[0].fn({ url, type: "main_frame" });
    return res && res.redirectUrl ? "blocked" : "allowed";
  };
  const advance = async (ms) => {
    clock.advance(ms);
    await new Promise((r) => setImmediate(r));
  };
  return { ...env, send, request, clock, advance };
}

const MIN = 60 * 1000;

test("listener is registered as blocking for main frames", async () => {
  const { listeners } = await boot();
  assert.deepEqual(plain(listeners.request[0].filter.types), ["main_frame"]);
  assert.deepEqual(plain(listeners.request[0].extra), ["blocking"]);
});

test("blocklist: off by default, blocks after enabling, redirect carries original url", async () => {
  const b = await boot();
  assert.equal((await b.send("update", { patch: { blocklist: ["YouTube.com", "https://www.tiktok.com/@x"] } })).ok, true);
  assert.deepEqual(plain(b.store.blocklist), ["youtube.com", "tiktok.com"]);
  assert.equal(await b.request("https://www.youtube.com/"), "allowed", "focus is off");

  await b.send("update", { patch: { enabled: true } });
  assert.equal(await b.request("https://m.youtube.com/watch?v=1"), "blocked");
  assert.equal(await b.request("https://example.com/"), "allowed");
  const res = await b.listeners.request[0].fn({ url: "https://tiktok.com/a" });
  assert.equal(res.redirectUrl, BLOCKED + "?url=" + encodeURIComponent("https://tiktok.com/a"));
});

test("allowlist: only listed sites open", async () => {
  const b = await boot({ enabled: true, mode: "allowlist", allowlist: ["example.org"] });
  assert.equal(await b.request("https://example.org/x"), "allowed");
  assert.equal(await b.request("https://youtube.com/"), "blocked");
});

test("invalid list entries are rejected, not dropped", async () => {
  const b = await boot();
  const res = await b.send("update", { patch: { blocklist: ["youtube.com", "not a domain"] } });
  assert.equal(res.ok, false);
  assert.match(res.error, /not a domain/);
  assert.deepEqual(plain(b.store.blocklist), []);
});

test("password: needed to loosen, not to tighten", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  assert.equal((await b.send("setPassword", { newPassword: "abc" })).ok, false, "too short");
  assert.equal((await b.send("setPassword", { newPassword: "secret" })).ok, true);
  assert.equal(b.store.passwordHash.length, 64);
  assert.ok(!JSON.stringify(b.store).includes("secret"), "plain password must not be stored");

  assert.equal((await b.send("update", { patch: { enabled: true } })).ok, true, "enable without password");
  assert.equal((await b.send("addSite", { url: "https://tiktok.com/x" })).ok, true, "block more without password");
  assert.deepEqual(plain(b.store.blocklist), ["youtube.com", "tiktok.com"]);

  for (const patch of [{ enabled: false }, { blocklist: [] }, { mode: "allowlist" }, { allowlist: ["a.com"] }]) {
    const res = await b.send("update", { patch });
    assert.equal(res.ok, false, JSON.stringify(patch));
    assert.equal(res.error, "Wrong password.");
  }
  assert.equal((await b.send("update", { patch: { enabled: false }, password: "nope" })).ok, false);
  assert.equal((await b.send("update", { patch: { enabled: false }, password: "secret" })).ok, true);

  assert.equal((await b.send("setPassword", { newPassword: "other1" })).ok, false, "change needs old password");
  assert.equal((await b.send("removePassword", { password: "secret" })).ok, true);
  assert.equal((await b.send("update", { patch: { blocklist: [] } })).ok, true);
});

test("options form resend with unchanged values does not need the password", async () => {
  const b = await boot({ blocklist: ["youtube.com"], allowlist: ["a.com"] });
  await b.send("setPassword", { newPassword: "secret" });
  const form = { mode: "blocklist", enabled: true, blocklist: ["youtube.com", "x.com"], allowlist: ["a.com"] };
  assert.equal((await b.send("update", { patch: form })).ok, true);
});

test("timer: blocks while running, locks loosening, survives restart, can only extend", async () => {
  const clock = makeClock();
  const b = await boot({ blocklist: ["youtube.com"] }, [], clock);
  assert.equal((await b.send("startTimer", { minutes: 0 })).ok, false);
  assert.equal((await b.send("startTimer", { minutes: 1.5 })).ok, false, "whole minutes only");
  const started = await b.send("startTimer", { minutes: 30 });
  assert.equal(started.ok, true);
  assert.equal(b.store.enabled, false, "timer must not touch the enabled flag");
  assert.equal(await b.request("https://youtube.com/"), "blocked");

  for (const [type, payload] of [
    ["update", { patch: { mode: "allowlist" } }],
    ["update", { patch: { blocklist: [] } }],
    ["setPassword", { newPassword: "secret" }],
  ]) {
    const res = await b.send(type, payload);
    assert.equal(res.ok, false, type);
    assert.match(res.error, /Timer is running/);
  }
  assert.equal((await b.send("addSite", { url: "https://tiktok.com" })).ok, true, "blocking more is allowed");
  assert.equal((await b.send("startTimer", { minutes: 10 })).ok, false, "cannot shorten");
  assert.equal((await b.send("startTimer", { minutes: 60 })).ok, true, "can extend");

  // Simulated restart: a new background instance reads the stored timerEnd.
  const restarted = await boot({ ...b.store }, [], clock);
  assert.equal(await restarted.request("https://youtube.com/"), "blocked");
  assert.ok((await restarted.send("getState")).state.timerEnd > clock.Date.now());
});

// Regression: sites stayed blocked after the timer ended, because starting it set enabled=true.
test("after the timer ends, sites open again if focus was off", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  await b.send("startTimer", { minutes: 1 });
  assert.equal(await b.request("https://youtube.com/"), "blocked");
  await b.advance(MIN + 1);
  assert.equal((await b.send("getState")).state.timerEnd, null);
  assert.equal(await b.request("https://youtube.com/"), "allowed");
  assert.equal((await b.send("check", { url: "https://youtube.com/" })).state.reason, null);
});

test("after the timer ends, focus that was on stays on", async () => {
  const b = await boot({ enabled: true, blocklist: ["youtube.com"] });
  await b.send("startTimer", { minutes: 1 });
  await b.advance(MIN + 1);
  assert.equal(await b.request("https://youtube.com/"), "blocked");
  assert.equal((await b.send("check", { url: "https://youtube.com/" })).state.reason, "focus");
});

// Regression: the timer length was not remembered.
test("timer length is saved and returned", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  assert.equal((await b.send("getState")).state.timerMinutes, 50, "default");
  await b.send("startTimer", { minutes: 15 });
  assert.equal(b.store.timerMinutes, 15);
  const restarted = await boot({ ...b.store }, [], b.clock);
  assert.equal((await restarted.send("getState")).state.timerMinutes, 15);

  assert.equal((await restarted.send("saveTimerMinutes", { minutes: 40 })).ok, true, "saved without starting");
  assert.equal(restarted.store.timerMinutes, 40);
  assert.equal(restarted.store.timerEnd, b.store.timerEnd, "does not start or change a timer");
  assert.equal((await restarted.send("saveTimerMinutes", { minutes: 0 })).ok, false);
});

test("check reports why a url is blocked", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  const reason = async (url) => (await b.send("check", { url })).state.reason;
  assert.equal(await reason("https://youtube.com/"), null);
  await b.send("startTimer", { minutes: 5 });
  assert.equal(await reason("https://youtube.com/"), "timer");
  assert.equal(await reason("https://example.com/"), null);
  assert.equal((await b.send("check", {})).state.reason, null);
});

// Regression: with focus on, the block page said "until the timer ends", but the site stayed blocked.
test("focus on + timer reports focus, the reason that outlasts the timer", async () => {
  const b = await boot({ enabled: true, blocklist: ["youtube.com"] });
  await b.send("startTimer", { minutes: 5 });
  assert.equal((await b.send("check", { url: "https://youtube.com/" })).state.reason, "focus");
});

test("lock timer refuses to start when it would block everything or nothing", async () => {
  const allow = await boot({ mode: "allowlist" });
  assert.match((await allow.send("startTimer", { minutes: 5 })).error, /block every website/);
  const block = await boot();
  assert.match((await block.send("startTimer", { minutes: 5 })).error, /block nothing/);
  // ...but an empty blocklist is fine to lock a running Pomodoro.
  await block.send("savePomodoro", { config: { ...POMO } });
  await block.send("startPomodoro");
  assert.equal((await block.send("startTimer", { minutes: 5 })).ok, true);
});

// Regression: two timer requests in flight both checked the old end; the shorter could win.
test("concurrent timer starts never shorten the lock", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  const [long, short] = await Promise.all([
    b.send("startTimer", { minutes: 60 }),
    b.send("startTimer", { minutes: 10 }),
  ]);
  assert.equal(long.ok, true);
  assert.equal(short.ok, false);
  assert.equal(b.store.timerEnd, b.clock.Date.now() + 60 * MIN);
});

// Regression: a loosening update awaiting its password check could commit inside a just-started lock.
test("a lock timer started during a password check wins", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  await b.send("setPassword", { newPassword: "secret" });
  const [loosen, timer] = await Promise.all([
    b.send("update", { patch: { blocklist: [] }, password: "secret" }),
    b.send("startTimer", { minutes: 5 }),
  ]);
  // Serialized: the update runs first and commits, then the timer refuses (nothing left to block).
  assert.equal(loosen.ok, true);
  assert.equal(timer.ok, false);
  const [timer2, loosen2] = await Promise.all([
    b.send("update", { patch: { blocklist: ["youtube.com"] } }),
    b.send("update", { patch: { blocklist: [] }, password: "secret" }),
  ]);
  assert.equal(timer2.ok, true);
  assert.equal(loosen2.ok, true);
});

test("addSite inside the queue extends the latest list", async () => {
  const b = await boot({ blocklist: ["a.com"] });
  await Promise.all([b.send("addSite", { url: "https://b.com/" }), b.send("addSite", { url: "https://c.com/" })]);
  assert.deepEqual(plain(b.store.blocklist).sort(), ["a.com", "b.com", "c.com"]);
});

test("storage.onChanged values are re-validated", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  b.listeners.changed[0]({ pomodoroRun: { newValue: { cycles: 0, startedAt: 1 } } }, "local");
  assert.equal(await b.request("https://example.com/"), "allowed", "corrupt run must not crash blocking");
  assert.equal((await b.send("getState")).state.pomodoroStatus, null);
});

test("corrupt stored data does not break blocking and is repaired on load", async () => {
  const b = await boot({
    mode: "weird",
    blocklist: ["youtube.com", "not a domain", 5],
    allowlist: "nope",
    pomodoroRun: { workMin: 25, startedAt: 0 }, // missing fields: would make phaseAt return NaN
    pomodoro: { workMin: -3 },
    timerMinutes: "x",
    passwordHash: "abcd", // salt missing: keeping the hash would lock the user out
  });
  assert.equal(await b.request("https://example.com/"), "allowed");
  const s = (await b.send("getState")).state;
  assert.equal(s.mode, "blocklist");
  assert.deepEqual(plain(s.blocklist), ["youtube.com"]);
  assert.deepEqual(plain(s.allowlist), []);
  assert.ok(["work", "break", "longBreak"].includes(s.pomodoroStatus.phase), "partial run filled with defaults");
  assert.ok(Number.isFinite(s.pomodoroStatus.phaseEnd));
  assert.equal(s.pomodoro.workMin, 25);
  assert.equal(s.timerMinutes, 50);
  assert.equal(s.hasPassword, false);
  assert.equal(b.store.schemaVersion, 1, "repaired state is written back");
});

test("v0.1 migration: focus left on by an old timer is turned off once", async () => {
  const clock = makeClock();
  const old = await boot({ enabled: true, blocklist: ["youtube.com"], timerEnd: clock.Date.now() - MIN }, [], clock);
  assert.equal(old.store.enabled, false);
  assert.equal(await old.request("https://youtube.com/"), "allowed");
  // Current-schema data is left alone.
  const current = await boot({ ...old.store, enabled: true, timerEnd: clock.Date.now() - MIN }, [], clock);
  assert.equal(current.store.enabled, true);
});

test("password iterations are stored and used for verification", async () => {
  const b = await boot({ blocklist: ["youtube.com"] });
  await b.send("setPassword", { newPassword: "secret" });
  assert.equal(b.store.passwordIterations, 200000);
  // Simulate a hash made with different iterations by an older/newer version.
  const { hash, salt } = await require("../src/lock.js").hashPassword("other1", null, 1000);
  const r = await boot({ ...b.store, passwordHash: hash, passwordSalt: salt, passwordIterations: 1000 });
  assert.equal((await r.send("update", { patch: { blocklist: [] }, password: "other1" })).ok, true);
});

test("errors are localized messages, not keys", async () => {
  const b = await boot();
  const res = await b.send("savePomodoro", { config: { ...POMO, workMin: 0 } });
  assert.equal(res.error, "Work length must be a whole number from 1 to 180.");
});

test("expired timer no longer locks", async () => {
  const clock = makeClock();
  const b = await boot({ blocklist: ["youtube.com"], timerEnd: clock.Date.now() - 1000 }, [], clock);
  assert.equal((await b.send("getState")).state.timerEnd, null);
  assert.equal(await b.request("https://youtube.com/"), "allowed");
});

const POMO = { workMin: 25, shortMin: 5, longMin: 20, cycles: 4, useMainRules: false, blocklist: ["youtube.com"] };

test("pomodoro: blocks only during work, follows the schedule, notifies phases", async () => {
  const b = await boot();
  assert.equal((await b.send("savePomodoro", { config: POMO })).ok, true);
  assert.equal((await b.send("startPomodoro")).ok, true);
  assert.equal((await b.send("startPomodoro")).ok, false, "already running");

  const phase = async () => (await b.send("getState")).state.pomodoroStatus;
  assert.equal((await phase()).phase, "work");
  assert.equal(await b.request("https://youtube.com/"), "blocked");
  assert.equal((await b.send("check", { url: "https://youtube.com/" })).state.reason, "pomodoro");
  assert.equal(await b.request("https://example.com/"), "allowed");

  await b.advance(25 * MIN);
  assert.equal((await phase()).phase, "break");
  assert.equal(await b.request("https://youtube.com/"), "allowed", "break opens sites");

  await b.advance(5 * MIN);
  assert.equal((await phase()).phase, "work");
  assert.equal((await phase()).cycle, 2);
  assert.equal(await b.request("https://youtube.com/"), "blocked");

  // Through work 4: 25+5+25+5+25 = 85 more minutes lands at the start of the long break.
  await b.advance(30 * MIN + 30 * MIN + 25 * MIN);
  const long = await phase();
  assert.equal(long.phase, "longBreak");
  assert.equal(long.cycle, 4);
  assert.equal(long.phaseEnd, b.clock.Date.now() + 20 * MIN);
  assert.equal(await b.request("https://youtube.com/"), "allowed");

  // +1s: phase-change notifications fire 250 ms after the boundary.
  await b.advance(20 * MIN + 1000);
  const next = await phase();
  assert.deepEqual([next.phase, next.cycle], ["work", 1], "a new round starts after the long break");

  assert.equal(b.notifications[0], "Work: 25 min. Distracting sites are blocked.");
  assert.ok(b.notifications.includes("Break: 5 min. Sites are open."));
  assert.ok(b.notifications.includes("Long break: 20 min. Well done."));
  assert.equal(b.notifications.length, 1 + 8, "start + one per phase change");
});

test("pomodoro: sweeps open tabs when work starts", async () => {
  const tabs = [{ id: 7, url: "https://youtube.com/watch" }];
  const b = await boot({}, tabs);
  await b.send("savePomodoro", { config: POMO });
  await b.send("startPomodoro");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.updates.map((u) => u.id), [7]);
  // Advance in two steps so each async sweep sees its own phase (sweeps run 250 ms after a boundary).
  await b.advance(25 * MIN + 1000); // break: nothing to sweep
  assert.equal(b.updates.length, 1);
  await b.advance(5 * MIN); // work again
  assert.equal(b.updates.length, 2);
});

test("pomodoro: can use the main rules instead of its own list", async () => {
  const b = await boot({ mode: "allowlist", allowlist: ["example.org"] });
  await b.send("savePomodoro", { config: { ...POMO, useMainRules: true, blocklist: [] } });
  await b.send("startPomodoro");
  assert.equal(await b.request("https://youtube.com/"), "blocked", "main allowlist applied during work");
  assert.equal(await b.request("https://example.org/"), "allowed");
  assert.equal(await b.request("https://example.com/"), "blocked");
});

test("pomodoro: validation and start guard", async () => {
  const b = await boot();
  for (const bad of [{ workMin: 0 }, { shortMin: 61 }, { longMin: 2.5 }, { cycles: "x" }, { blocklist: ["bad domain"] }]) {
    assert.equal((await b.send("savePomodoro", { config: { ...POMO, ...bad } })).ok, false, JSON.stringify(bad));
  }
  await b.send("savePomodoro", { config: { ...POMO, blocklist: [] } });
  const res = await b.send("startPomodoro");
  assert.equal(res.ok, false, "custom rules with an empty list would block nothing");
  assert.match(res.error, /Add sites/);
  await b.send("savePomodoro", { config: { ...POMO, useMainRules: true } });
  assert.match((await b.send("startPomodoro")).error, /main blocklist is empty/);
  await b.send("savePomodoro", { config: { ...POMO, blocklist: [] } });
  assert.deepEqual(plain((await b.send("getState")).state.pomodoro), { ...POMO, blocklist: [] });
});

test("pomodoro: a running pomodoro uses its snapshot, not later edits", async () => {
  const b = await boot();
  await b.send("savePomodoro", { config: POMO });
  await b.send("startPomodoro");
  await b.send("savePomodoro", { config: { ...POMO, workMin: 50, blocklist: ["tiktok.com"] } });
  assert.equal(await b.request("https://youtube.com/"), "blocked");
  assert.equal(await b.request("https://tiktok.com/"), "allowed");
  await b.advance(25 * MIN);
  assert.equal((await b.send("getState")).state.pomodoroStatus.phase, "break");
});

test("pomodoro: stopping needs the password and is refused during a lock timer", async () => {
  const b = await boot();
  await b.send("savePomodoro", { config: POMO });
  await b.send("setPassword", { newPassword: "secret" });
  await b.send("startPomodoro");
  assert.equal((await b.send("stopPomodoro", {})).error, "Wrong password.");
  await b.send("startTimer", { minutes: 5 });
  assert.match((await b.send("stopPomodoro", { password: "secret" })).error, /Timer is running/);
  await b.advance(5 * MIN + 1);
  assert.equal((await b.send("stopPomodoro", { password: "secret" })).ok, true);
  assert.equal((await b.send("getState")).state.pomodoroStatus, null);
  assert.equal(await b.request("https://youtube.com/"), "allowed");
  assert.equal(b.clock.pending(), 0, "phase timer is cleared on stop");
});

test("pomodoro: survives restart mid-run", async () => {
  const b = await boot();
  await b.send("savePomodoro", { config: POMO });
  await b.send("startPomodoro");
  await b.advance(27 * MIN); // inside the first break
  const restarted = await boot({ ...b.store }, [], b.clock);
  const st = (await restarted.send("getState")).state.pomodoroStatus;
  assert.deepEqual([st.phase, st.cycle], ["break", 1]);
  assert.equal(st.phaseEnd, b.clock.Date.now() + 3 * MIN);
  await restarted.advance(3 * MIN);
  assert.equal(await restarted.request("https://youtube.com/"), "blocked");
});

test("startup and enable sweep open tabs; tab url changes are caught", async () => {
  const tabs = [
    { id: 1, url: "https://youtube.com/watch" },
    { id: 2, url: "https://example.com/" },
    { id: 3, url: "about:addons" },
  ];
  const b = await boot({ enabled: true, blocklist: ["youtube.com"] }, tabs);
  assert.deepEqual(b.updates.map((u) => u.id), [1], "startup sweep");

  b.listeners.updated[0](2, { url: "https://www.youtube.com/" }); // e.g. bfcache restore
  b.listeners.updated[0](2, { status: "complete" });
  b.listeners.updated[0](2, { url: "https://example.com/other" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(b.updates.map((u) => u.id), [1, 2]);
});

test("addSite refuses non-web pages; unknown messages fail cleanly", async () => {
  const b = await boot();
  assert.equal((await b.send("addSite", { url: "about:addons" })).ok, false);
  assert.equal((await b.send("addSite", { url: BLOCKED })).ok, false);
  assert.equal((await b.send("addSite", {})).ok, false);
  assert.equal((await b.send("nope")).ok, false);
  assert.equal((await b.listeners.message[0](undefined)).ok, false);
});
