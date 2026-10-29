// Single gatekeeper: blocks navigation and is the only place that changes settings.
// Rules live in policy.js (pure); this file holds the effects: listeners, tabs, timers, storage.
const { lock, storage, policy, i18n } = FG;
const { t } = i18n;
const { fail } = policy;

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
  if (runChanged || rulesChanged) sweepTabs();
}

const blockReason = (url) => policy.blockReason(state, url, Date.now());
const publicState = () => policy.publicState(state, Date.now());
const timerOn = () => policy.timerOn(state, Date.now());

const blockedPage = (url) => browser.runtime.getURL("ui/blocked.html") + "?url=" + encodeURIComponent(url);

function decide(details) {
  return blockReason(details.url) ? { redirectUrl: blockedPage(details.url) } : {};
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => (state ? decide(details) : ready.then(() => decide(details), () => ({}))),
  { urls: ["<all_urls>"], types: ["main_frame"] },
  ["blocking"]
);

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

// Pomodoro phase changes: notify and sweep tabs. The background page is persistent (MV2),
// so a plain setTimeout is enough; blocking itself never depends on it firing on time.
let phaseTimer = null;
let lastPhaseKey = null;

function phaseText(phase, run) {
  if (phase === "work") return t("notifyWork", run.workMin);
  if (phase === "break") return t("notifyBreak", run.shortMin);
  return t("notifyLongBreak", run.longMin);
}

function notify(message) {
  browser.notifications
    .create({ type: "basic", title: t("extName"), message })
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
  const key = `${phase.phase}:${phase.phaseEnd}`;
  if (lastPhaseKey !== null && key !== lastPhaseKey) {
    notify(phaseText(phase.phase, state.pomodoroRun));
    sweepTabs();
  }
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
  check: async ({ url }) => ({ ...publicState(), reason: blockReason(String(url || "")) }),

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

browser.runtime.onMessage.addListener(async (msg) => {
  try {
    await ready;
    const handler = msg && typeof msg.type === "string" && Object.hasOwn(handlers, msg.type) && handlers[msg.type];
    if (!handler) return { ok: false, error: t("errUnknownRequest") };
    return { ok: true, state: await handler(msg) };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
});

ready.then(() => {
  onPomodoroTick();
  sweepTabs();
}).catch((error) => {
  console.error("Could not load settings:", error);
});
