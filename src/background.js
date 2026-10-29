// Single gatekeeper: blocks navigation and is the only place that changes settings.
// Rules live in policy.js (pure); this file holds the effects: listeners, tabs, timers, storage.
// Firefox (MV2) runs it as a persistent background page and blocks with webRequest. Chrome and
// Edge (MV3) run it as a service worker that can stop at any time and block with declarativeNetRequest.
const { lock, storage, policy, i18n } = FG;
const { t } = i18n;
const { fail } = policy;

// Present only in the Chromium build, which requests the declarativeNetRequest permission.
const dnr = browser.declarativeNetRequest;

let state = null;
const ready = storage.load().then((s) => (state = s));

// Changes written elsewhere (or by an older copy of this page) are re-validated on the way in.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !state) return;
  const merged = { ...state };
  for (const [key, { newValue }] of Object.entries(changes)) merged[key] = newValue;
  replaceState(storage.sanitize(merged, Date.now()).state);
});

// A storage event can arrive before or after save() resolves. Apply effects once in either order,
// including when settings were written by another extension page or an older background copy.
function replaceState(next) {
  const changed = (key) => JSON.stringify(state[key]) !== JSON.stringify(next[key]);
  const runChanged = changed("pomodoroRun");
  const rulesChanged = ["enabled", "mode", "blocklist", "allowlist", "timerEnd"].some(changed);
  state = next;
  if (runChanged) onPomodoroTick();
  if (runChanged || rulesChanged) {
    syncRules();
    sweepTabs();
  }
}

const blockReason = (url) => policy.blockReason(state, url, Date.now());
const publicState = () => policy.publicState(state, Date.now());
const timerOn = () => policy.timerOn(state, Date.now());

const blockedPage = (url) => browser.runtime.getURL("ui/blocked.html") + "?url=" + encodeURIComponent(url);

function decide(details) {
  return blockReason(details.url) ? { redirectUrl: blockedPage(details.url) } : {};
}

if (!dnr) {
  browser.webRequest.onBeforeRequest.addListener(
    (details) => (state ? decide(details) : ready.then(() => decide(details), () => ({}))),
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["blocking"]
  );
}

// Chromium: redirect rules are precomputed (src/dnr.js), so they are rebuilt after every change
// and at every timer or phase end. Dynamic rules persist, so blocking also works before the
// service worker starts. Updates run one at a time, each with the latest state.
let rulesSync = Promise.resolve();
let appliedRules = null; // JSON of the rules this worker last wrote; null after a restart

function syncRules() {
  if (!dnr) return rulesSync;
  rulesSync = rulesSync
    .then(async () => {
      const now = Date.now();
      const rules = FG.dnr.redirectRules(state, now, browser.runtime.getURL("ui/blocked.html"));
      const json = JSON.stringify(rules);
      if (json !== appliedRules) {
        const old = await dnr.getDynamicRules();
        await dnr.updateDynamicRules({ removeRuleIds: old.map((r) => r.id), addRules: rules });
        appliedRules = json;
      }
      await scheduleWake(now);
    })
    .catch((error) => console.error("Could not update blocking rules:", error));
  return rulesSync;
}

// A setTimeout works while the worker runs; the alarm wakes a stopped worker. Its name carries
// the boundary, so a fresh worker knows which phase change it still has to announce.
const WAKE = "wake:";
let wakeTimer = null;

async function scheduleWake(now) {
  clearTimeout(wakeTimer);
  wakeTimer = null;
  const at = FG.dnr.nextChange(state, now);
  if (at) wakeTimer = setTimeout(() => onWake(at), Math.min(2147483647, Math.max(250, at - Date.now() + 250)));
  await browser.alarms.clearAll();
  if (at) await browser.alarms.create(WAKE + at, { when: at + 250 });
}

function onWake(boundary) {
  syncRules();
  const status = publicState().pomodoroStatus;
  if (status && status.phaseStart >= boundary) phaseChanged(status);
}

if (dnr) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (!alarm.name.startsWith(WAKE)) return;
    ready.then(() => onWake(Number(alarm.name.slice(WAKE.length))), () => {});
  });
}

// webRequest misses pages restored from the back/forward cache, so check every committed URL too.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!state || !changeInfo.url) return;
  if (blockReason(changeInfo.url)) {
    browser.tabs.update(tabId, { url: blockedPage(changeInfo.url) }).catch(() => {});
  }
});

// Tabs opened before blocking started are not caught by webRequest, so sweep them.
async function sweepTabs() {
  let tabs;
  try {
    tabs = await browser.tabs.query({});
  } catch (error) {
    console.warn("Could not check open tabs:", error);
    return;
  }
  for (const tab of tabs) {
    if (tab.url && blockReason(tab.url)) {
      browser.tabs.update(tab.id, { url: blockedPage(tab.url) }).catch(() => {});
    }
  }
}

// Pomodoro phase changes: notify and sweep tabs. In Firefox the background page is persistent,
// so a plain setTimeout is enough; blocking itself never depends on it firing on time.
// In Chromium a stopped worker loses these, and onWake announces the change instead.
let phaseTimer = null;
let lastPhaseKey = null;
let announcedKey = null; // the phase change last notified, so the timeout and the alarm notify once

const phaseKey = (phase) => `${phase.phase}:${phase.phaseEnd}`;

function phaseChanged(phase) {
  const key = phaseKey(phase);
  if (key === announcedKey) return;
  announcedKey = key;
  notify(phaseText(phase.phase, state.pomodoroRun));
  sweepTabs();
}

function phaseText(phase, run) {
  if (phase === "work") return t("notifyWork", run.workMin);
  if (phase === "break") return t("notifyBreak", run.shortMin);
  return t("notifyLongBreak", run.longMin);
}

function notify(message) {
  // Chromium requires iconUrl and does not accept SVG for it.
  const iconUrl = browser.runtime.getURL("icons/icon-128.png");
  browser.notifications
    .create({ type: "basic", iconUrl, title: t("extName"), message })
    .catch(() => {});
}

function onPomodoroTick() {
  clearTimeout(phaseTimer);
  phaseTimer = null;
  const phase = policy.pomodoroStatus(state, Date.now());
  if (!phase) {
    lastPhaseKey = null;
    return;
  }
  const key = phaseKey(phase);
  if (lastPhaseKey !== null && key !== lastPhaseKey) phaseChanged(phase);
  lastPhaseKey = key;
  // A clock rollback can put the end beyond setTimeout's signed 32-bit delay limit.
  phaseTimer = setTimeout(onPomodoroTick, Math.min(2147483647, Math.max(250, phase.phaseEnd - Date.now() + 250)));
}

async function assertUnlocked(password) {
  for (;;) {
    if (timerOn()) fail("errTimerLocked");
    const { passwordHash, passwordSalt, passwordIterations } = state;
    if (!passwordHash) return;
    const valid = await lock.verifyPassword(password, passwordHash, passwordSalt, passwordIterations);
    // storage.onChanged is outside the message queue and can change the lock during PBKDF2.
    if (timerOn()) fail("errTimerLocked");
    if (passwordHash !== state.passwordHash || passwordSalt !== state.passwordSalt || passwordIterations !== state.passwordIterations) continue;
    if (!valid) fail("errWrongPassword");
    return;
  }
}

async function commit(patch) {
  await storage.save(patch);
  replaceState({ ...state, ...patch });
}

async function applyUpdate(patch, password) {
  const clean = policy.changedOnly(policy.validatePatch(patch), state);
  if (!Object.keys(clean).length) return publicState();
  if (!policy.isTightening(clean, state)) await assertUnlocked(password);
  await commit(clean);
  return publicState();
}

// Handlers that change state run one at a time. Without this, two requests could both pass
// their checks against the old state (e.g. two timers, the shorter one committing last).
let queue = Promise.resolve();
function serial(fn) {
  return (msg) => {
    const result = queue.then(() => fn(msg));
    queue = result.catch(() => {});
    return result;
  };
}

const handlers = {
  getState: async () => publicState(),

  // Used by the blocked page to show why it is blocked and when the site is open again.
  // In Chromium a just-woken worker may still have rules from before a timer or phase ended;
  // refreshing them here makes "Open site" work as soon as the page offers it.
  check: async ({ url }) => {
    await syncRules();
    return { ...publicState(), reason: blockReason(String(url || "")) };
  },

  update: serial(({ patch, password }) => applyUpdate(patch, password)),

  // Reads the current list inside the queue, so it never extends a stale copy.
  addSite: serial(({ url, password }) => {
    const domain = /^https?:/i.test(url || "") && FG.matcher.normalizeDomain(url);
    if (!domain) fail("errNoDomain");
    const key = state.mode === "allowlist" ? "allowlist" : "blocklist";
    return applyUpdate({ [key]: [...state[key], domain] }, password);
  }),

  setPassword: serial(async ({ newPassword, password }) => {
    await assertUnlocked(password);
    if (typeof newPassword !== "string" || newPassword.length < 4) fail("errPasswordShort");
    const { hash, salt, iterations } = await lock.hashPassword(newPassword);
    await assertUnlocked(password);
    await commit({ passwordHash: hash, passwordSalt: salt, passwordIterations: iterations });
    return publicState();
  }),

  removePassword: serial(async ({ password }) => {
    await assertUnlocked(password);
    await commit({ passwordHash: null, passwordSalt: null });
    return publicState();
  }),

  // Starting or extending a timer only adds restrictions, so no password is needed.
  // It can never be shortened: the new end must be later than the current one.
  startTimer: serial(async ({ minutes }) => {
    const m = policy.parseTimerMinutes(minutes);
    // An empty allowlist would block the whole web; an empty blocklist would lock settings while
    // blocking nothing. The latter is fine only to lock a running Pomodoro so it cannot be stopped.
    if (state.mode === "allowlist" && !state.allowlist.length) fail("errTimerAllowlistEmpty");
    if (state.mode === "blocklist" && !state.blocklist.length && !state.pomodoroRun) fail("errTimerBlocklistEmpty");
    const end = Date.now() + m * 60 * 1000;
    if (timerOn() && end <= state.timerEnd) fail("errTimerExtendOnly");
    await commit({ timerEnd: end, timerMinutes: m });
    return publicState();
  }),

  // Remembers the timer length as soon as it is typed, not only when a timer starts.
  saveTimerMinutes: serial(async ({ minutes }) => {
    await commit({ timerMinutes: policy.parseTimerMinutes(minutes) });
    return publicState();
  }),

  // Saving pomodoro settings never loosens a running pomodoro (it uses its own snapshot),
  // so it needs no password.
  savePomodoro: serial(async ({ config }) => {
    let clean;
    try {
      clean = FG.pomodoro.validateConfig(config);
    } catch (e) {
      fail("errPomodoroField", t("pomo_" + e.field), e.min, e.max);
    }
    clean.blocklist = policy.cleanList(clean.blocklist || []);
    await commit({ pomodoro: clean });
    return publicState();
  }),

  startPomodoro: serial(async () => {
    if (state.pomodoroRun) fail("errPomodoroRunning");
    const cfg = state.pomodoro;
    policy.assertPomodoroBlocksSomething(cfg, state);
    await commit({ pomodoroRun: { ...cfg, startedAt: Date.now() } });
    notify(phaseText("work", cfg));
    return publicState();
  }),

  // Stopping removes blocking, so it follows the same rules as any loosening change.
  stopPomodoro: serial(async ({ password }) => {
    if (!state.pomodoroRun) return publicState();
    await assertUnlocked(password);
    await commit({ pomodoroRun: null });
    return publicState();
  }),
};

async function respond(msg) {
  try {
    await ready;
    const handler = msg && typeof msg.type === "string" && Object.hasOwn(handlers, msg.type) && handlers[msg.type];
    if (!handler) return { ok: false, error: t("errUnknownRequest") };
    return { ok: true, state: await handler(msg) };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

// sendResponse + `return true` works in Firefox and every Chromium version; returning a promise
// from the listener only works in Chrome 148+.
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  respond(msg).then(sendResponse);
  return true;
});

ready.then(() => {
  onPomodoroTick();
  sweepTabs();
  syncRules();
}).catch((error) => {
  console.error("Could not load settings:", error);
});
