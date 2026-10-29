const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ui = (file) => fs.readFileSync(path.join(__dirname, "..", "ui", file), "utf8");
const flush = () => new Promise(setImmediate);
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.dataset = {};
    this.style = { setProperty() {} };
    const classes = new Set();
    this.classList = {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => on ? classes.add(c) : classes.delete(c),
    };
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  async fire(type) {
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const fn of this.listeners[type] || []) await fn(event);
    return event;
  }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  focus() {}
  select() {}
  showModal() { this.open = true; }
  close() { this.open = false; this.fire("close"); }
  remove() { this.removed = true; }
}

function load(page, onMessage, tabUrl = "https://example.com") {
  const elements = Object.fromEntries([...ui(page + ".html").matchAll(/id="([^"]+)"/g)].map((m) => [m[1], new Element()]));
  const radios = { mode: ["blocklist", "allowlist"], "pomo-rules": ["custom", "main"] };
  const radioEls = Object.fromEntries(Object.entries(radios).map(([name, values]) => [name, Object.fromEntries(values.map((v) => [v, new Element("input")]))]));
  const document = new Element("document");
  document.body = new Element("body");
  document.createElement = (tag) => new Element(tag);
  document.getElementById = (id) => elements[id];
  document.querySelectorAll = () => [];
  document.querySelector = (selector) => {
    const m = selector.match(/name="([^"]+)"/);
    if (!m) return null;
    const value = selector.match(/value="([^"]+)"/);
    return value ? radioEls[m[1]][value[1]] : Object.values(radioEls[m[1]]).find((el) => el.checked);
  };
  // Native radios uncheck their siblings when selected.
  for (const group of Object.values(radioEls)) for (const el of Object.values(group)) {
    let selected = false;
    Object.defineProperty(el, "checked", { get: () => selected, set: (v) => {
      if (v) for (const sibling of Object.values(group)) if (sibling !== el) sibling.checked = false;
      selected = v;
    } });
  }
  const window = new Element("window");
  const ctx = vm.createContext({ document, window, URL, URLSearchParams, Date, console,
    FG: { i18n: { t: (key) => key, applyI18n() {} } },
    browser: { runtime: { sendMessage: onMessage, getURL: (p) => "moz-extension://ours/" + p },
      storage: { onChanged: { addListener() {} } }, tabs: { query: async () => [{ url: tabUrl }] } },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1, clearTimeout() {}, confirm: () => true,
  });
  vm.runInContext(ui("common.js"), ctx);
  vm.runInContext(ui(page + ".js"), ctx);
  return { ctx, elements, document };
}

const state = () => ({ enabled: false, mode: "blocklist", blocklist: [], allowlist: [], timerEnd: null,
  timerMinutes: 50, now: Date.now(), hasPassword: false, pomodoroStatus: null,
  pomodoro: { workMin: 25, shortMin: 5, longMin: 20, cycles: 4, useMainRules: false, blocklist: [] } });

for (const [id, value, next] of [["blocklist", "first.com", "later.com"], ["pomo-work", "30", "40"]]) {
  test(`save preserves ${id} edits made while its request is pending`, async () => {
    const saved = state();
    const pending = deferred();
    const { elements: el } = load("options", async (msg) => {
      if (msg.type === "getState") return { ok: true, state: saved };
      await pending.promise;
      if (msg.type === "update") saved.blocklist = ["first.com"];
      else saved.pomodoro.workMin = 30;
      return { ok: true, state: saved };
    });
    await flush();
    el[id].value = value;
    const saving = el.save.fire("click");
    await flush();
    el[id].value = next;
    pending.resolve();
    await saving;
    assert.equal(el[id].value, next);
    assert.equal(el.savebar.classList.contains("hidden"), false);
  });
}

test("popup adds the original site from its own blocked page", async () => {
  let added;
  const { elements } = load("popup", async (msg) => {
    if (msg.type === "addSite") added = msg.url;
    return { ok: true, state: state() };
  }, "moz-extension://ours/ui/blocked.html?url=https%3A%2F%2Fexample.com%2Fwatch");
  await flush();
  await elements["add-site"].fire("click");
  await flush();
  assert.equal(added, "https://example.com/watch");
});

test("password dialog cannot be dismissed while its action is pending", async () => {
  const { ctx, document } = load("popup", async () => ({ ok: true, state: state() }));
  await flush();
  const pending = deferred();
  let settled = false;
  const result = ctx.formDialog({ title: "Unlock", submitLabel: "Unlock", action: () => pending.promise });
  result.then(() => { settled = true; });
  const dlg = document.body.children.at(-1);
  const form = dlg.children[0];
  const buttons = form.children.at(-1);
  const submitting = form.fire("submit");
  await flush();
  assert.equal(buttons.children[0].disabled, true);
  assert.equal((await dlg.fire("cancel")).defaultPrevented, true);
  assert.equal(settled, false);
  pending.resolve({ saved: true });
  await submitting;
  assert.equal((await result).saved, true);
});

test("Pomodoro does not start with stale settings when edited during its pre-start save", async () => {
  const saved = state();
  const pending = deferred();
  let started = false;
  const { elements: el } = load("options", async (msg) => {
    if (msg.type === "savePomodoro") {
      await pending.promise;
      saved.pomodoro.workMin = 30;
    }
    if (msg.type === "startPomodoro") started = true;
    return { ok: true, state: saved };
  });
  await flush();
  el["pomo-work"].value = "30";
  const starting = el["pomo-start"].fire("click");
  await flush();
  el["pomo-work"].value = "40";
  pending.resolve();
  await starting;
  await flush();
  assert.equal(started, false);
  assert.equal(el["pomo-work"].value, "40");
});

for (const page of ["options", "popup"]) {
  test(`${page} confirms enabling focus with an empty allowlist`, async () => {
    const saved = { ...state(), mode: "allowlist" };
    let changed = false;
    const { ctx, elements: el, document } = load(page, async (msg) => {
      if (msg.type === "update") changed = true;
      return { ok: true, state: saved };
    });
    await flush();
    ctx.confirm = () => false;
    if (page === "options") {
      el.enabled.checked = true;
      await el.enabled.fire("change");
    } else {
      await el.toggle.fire("click");
    }
    await flush();
    assert.equal(changed, false);
    if (page === "popup") assert.equal(document.body.children.at(-1)?.tag, "dialog");
    else assert.equal(el.enabled.checked, false);
  });
}

test("options refreshes an untouched timer duration and preserves pending input", async () => {
  let saved = state();
  const { ctx, elements: el } = load("options", async () => ({ ok: true, state: saved }));
  await flush();
  assert.equal(String(el.minutes.value), "50");
  saved = { ...saved, timerMinutes: 20 };
  await ctx.refresh();
  assert.equal(String(el.minutes.value), "20");
  el.minutes.value = "35";
  saved = { ...saved, timerMinutes: 10 };
  await ctx.refresh();
  assert.equal(el.minutes.value, "35");
});
