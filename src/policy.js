// Pure rules: what is blocked, what a change is allowed to do, what the UI sees.
// Every function takes `now` explicitly, so one decision never sees the clock change midway.
// Browser global (FG.policy) and Node module for tests.
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const { matcher, lock, pomodoro, i18n } = isNode
    ? {
        matcher: require("./matcher.js"),
        lock: require("./lock.js"),
        pomodoro: require("./pomodoro.js"),
        i18n: require("./i18n.js"),
      }
    : root.FG;
  const { t } = i18n;

  // `code` lets the UI react to specific errors (e.g. ask for the password) without parsing text.
  const fail = (key, ...subs) => {
    throw Object.assign(new Error(t(key, ...subs)), { code: key });
  };

  const timerOn = (state, now) => lock.timerActive(state.timerEnd, now);

  // The lock timer blocks with the main rules only while it runs; it never touches `enabled`.
  const mainActive = (state, now) => state.enabled || timerOn(state, now);

  const pomodoroStatus = (state, now) => (state.pomodoroRun ? pomodoro.phaseAt(state.pomodoroRun, now) : null);

  // Why a URL is blocked: "timer" | "focus" | "pomodoro", or null if it is allowed.
  function blockReason(state, url, now) {
    const main = { ...state, active: true };
    // "focus" wins over "timer": with focus on, the site stays blocked after the timer ends,
    // so the block page must not promise otherwise.
    if (mainActive(state, now) && matcher.isBlocked(url, main)) return state.enabled ? "focus" : "timer";
    const phase = pomodoroStatus(state, now);
    if (phase && phase.phase === "work") {
      const run = state.pomodoroRun;
      const rules = run.useMainRules ? main : { active: true, mode: "blocklist", blocklist: run.blocklist };
      if (matcher.isBlocked(url, rules)) return "pomodoro";
    }
    return null;
  }

  // What the UI may see: never the password hash or salt.
  function publicState(state, now) {
    const phase = pomodoroStatus(state, now);
    return {
      enabled: state.enabled,
      mode: state.mode,
      blocklist: state.blocklist,
      allowlist: state.allowlist,
      hasPassword: Boolean(state.passwordHash),
      timerEnd: timerOn(state, now) ? state.timerEnd : null,
      timerMinutes: state.timerMinutes,
      pomodoro: state.pomodoro,
      pomodoroStatus: phase && {
        ...phase,
        cycles: state.pomodoroRun.cycles,
        phaseStart: phase.phaseEnd - phaseLength(state.pomodoroRun, phase.phase),
      },
      now,
    };
  }

  function phaseLength(run, phase) {
    const min = phase === "work" ? run.workMin : phase === "break" ? run.shortMin : run.longMin;
    return min * 60 * 1000;
  }

  function validatePatch(patch) {
    if (!patch || typeof patch !== "object") fail("errNothingToUpdate");
    const clean = {};
    if ("enabled" in patch) clean.enabled = Boolean(patch.enabled);
    if ("mode" in patch) {
      if (patch.mode !== "blocklist" && patch.mode !== "allowlist") fail("errUnknownMode");
      clean.mode = patch.mode;
    }
    for (const key of ["blocklist", "allowlist"]) {
      if (key in patch) clean[key] = cleanList(patch[key]);
    }
    return clean;
  }

  function cleanList(list) {
    if (!Array.isArray(list)) fail("errNotAList");
    const bad = list.filter((d) => !matcher.normalizeDomain(d));
    if (bad.length) fail("errNotDomain", bad.join(", "));
    return matcher.cleanList(list);
  }

  const sameList = (a, b) => a.length === b.length && a.every((d) => b.includes(d));

  // Keeps only the keys that actually change, so the options page can send the whole form.
  function changedOnly(clean, state) {
    const out = {};
    for (const [key, value] of Object.entries(clean)) {
      const same = Array.isArray(value) ? sameList(value, state[key]) : value === state[key];
      if (!same) out[key] = value;
    }
    return out;
  }

  // Turning focus on or adding sites to the blocklist only makes things stricter,
  // so it is allowed without the password and even while a lock timer runs.
  function isTightening(changes, state) {
    return Object.entries(changes).every(([key, value]) => {
      if (key === "enabled") return value === true;
      if (key === "blocklist") return state.blocklist.every((d) => value.includes(d));
      return false;
    });
  }

  function parseTimerMinutes(minutes) {
    const m = Number(minutes);
    if (!Number.isInteger(m) || m < 1 || m > 24 * 60) fail("errTimerRange");
    return m;
  }

  // Throws unless a pomodoro with this config would block something during work.
  function assertPomodoroBlocksSomething(cfg, state) {
    if (!cfg.useMainRules && !cfg.blocklist.length) fail("errPomodoroEmptyList");
    if (cfg.useMainRules && state.mode === "blocklist" && !state.blocklist.length) fail("errPomodoroMainEmpty");
  }

  const api = {
    fail,
    timerOn,
    mainActive,
    pomodoroStatus,
    blockReason,
    publicState,
    validatePatch,
    cleanList,
    changedOnly,
    isTightening,
    parseTimerMinutes,
    assertPomodoroBlocksSomething,
  };
  if (isNode) module.exports = api;
  else (root.FG = root.FG || {}).policy = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
