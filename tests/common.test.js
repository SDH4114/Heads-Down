const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "ui", "common.js"), "utf8");
const I18N = fs.readFileSync(path.join(ROOT, "src", "i18n.js"), "utf8");
const MESSAGES = {
  en: JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", "en", "messages.json"), "utf8")),
  ru: JSON.parse(fs.readFileSync(path.join(ROOT, "_locales", "ru", "messages.json"), "utf8")),
};

// Loads i18n.js + common.js like a UI page does, with a fake browser in the given locale.
function load(response, locale = "en") {
  const sent = [];
  const getMessage = (key, subs = []) => {
    const entry = MESSAGES[locale][key];
    return entry ? entry.message.replace(/\$(\d)/g, (_, i) => subs[i - 1] ?? "") : "";
  };
  const ctx = vm.createContext({
    browser: {
      runtime: { sendMessage: async (msg) => (sent.push(msg), response) },
      i18n: { getMessage },
    },
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    Date,
  });
  ctx.globalThis = ctx;
  vm.runInContext(I18N, ctx);
  vm.runInContext(SRC, ctx);
  return { ctx, sent };
}

const fakeEl = () => {
  const classes = new Set();
  return { textContent: "", classList: { toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), has: (c) => classes.has(c) } };
};

test("formatRemaining", () => {
  const { ctx } = load();
  assert.equal(ctx.formatRemaining(0), "0:00");
  assert.equal(ctx.formatRemaining(-5000), "0:00");
  assert.equal(ctx.formatRemaining(1), "0:01", "rounds up partial seconds");
  assert.equal(ctx.formatRemaining(65 * 1000), "1:05");
  assert.equal(ctx.formatRemaining((2 * 3600 + 3 * 60 + 4) * 1000), "2:03:04");
});

test("send passes type and payload, returns state", async () => {
  const { ctx, sent } = load({ ok: true, state: { enabled: true } });
  const state = await ctx.send("update", { patch: { enabled: true } });
  assert.equal(state.enabled, true);
  assert.equal(sent[0].type, "update");
  assert.equal(sent[0].patch.enabled, true);
});

test("send throws background errors and missing responses", async () => {
  await assert.rejects(load({ ok: false, error: "Wrong password." }).ctx.send("x"), /Wrong password/);
  await assert.rejects(load(undefined).ctx.send("x"), /No response/);
});

test("showMessage toggles error class", () => {
  const { ctx } = load();
  const el = fakeEl();
  ctx.showMessage(el, "bad", true);
  assert.equal(el.textContent, "bad");
  assert.equal(el.classList.has("error"), true);
  ctx.showMessage(el, "ok");
  assert.equal(el.classList.has("error"), false);
});

test("startCountdown: none without timer, renders and fires onDone at zero", async () => {
  const { ctx } = load();
  const el = fakeEl();
  assert.equal(ctx.startCountdown(el, { timerEnd: null, now: Date.now() }), null);

  const now = Date.now();
  let done = 0;
  ctx.startCountdown(el, { timerEnd: now + 1200, now }, () => done++);
  assert.equal(el.textContent, "0:02");
  await new Promise((r) => setTimeout(r, 2300));
  assert.equal(el.textContent, "0:00");
  assert.equal(done, 1, "onDone fires exactly once");
});

test("startCountdown can count to a custom end (pomodoro phase)", () => {
  const { ctx } = load();
  const el = fakeEl();
  const now = Date.now();
  const id = ctx.startCountdown(el, { timerEnd: null, now }, null, now + 90 * 1000);
  clearInterval(id);
  assert.equal(el.textContent, "1:30");
});

test("phaseLabel", () => {
  const { ctx } = load();
  assert.equal(ctx.phaseLabel(null), "");
  assert.equal(ctx.phaseLabel({ phase: "work", cycle: 2, cycles: 4 }), "Work 2/4");
  assert.equal(ctx.phaseLabel({ phase: "longBreak", cycle: 4, cycles: 4 }), "Long break 4/4");
  assert.equal(load(null, "ru").ctx.phaseLabel({ phase: "break", cycle: 1, cycles: 4 }), "Перерыв 1/4");
});

test("phaseProgress", () => {
  const { ctx } = load();
  const s = { phaseStart: 0, phaseEnd: 100 };
  assert.equal(ctx.phaseProgress(s, 100), 0);
  assert.equal(ctx.phaseProgress(s, 25), 0.75);
  assert.equal(ctx.phaseProgress(s, -5), 1, "clamped");
  assert.equal(ctx.phaseProgress(null, 5), 0);
  assert.equal(ctx.phaseProgress({ phaseStart: 5, phaseEnd: 5 }, 0), 0, "zero length");
});

test("startCountdown onTick receives the remaining time", () => {
  const { ctx } = load();
  const now = Date.now();
  let seen = null;
  const id = ctx.startCountdown(fakeEl(), { now }, null, now + 30 * 1000, (left) => (seen = left));
  clearInterval(id);
  assert.ok(seen > 29000 && seen <= 30000);
});

test("i18n falls back to the key when a message is missing", () => {
  const { ctx } = load();
  assert.equal(ctx.FG.i18n.t("noSuchKey"), "noSuchKey");
  assert.equal(ctx.FG.i18n.t("errNotDomain", "x"), "Not a domain: x");
});

test("startCountdown corrects for clock skew between pages and background", () => {
  const { ctx } = load();
  const el = fakeEl();
  const bgNow = Date.now() + 60 * 1000; // background clock one minute ahead
  const id = ctx.startCountdown(el, { timerEnd: bgNow + 5 * 60 * 1000, now: bgNow });
  clearInterval(id);
  assert.equal(el.textContent, "5:00");
});
