// State schema, migration and persistence in browser.storage.local.
// Browser global (FG.storage) and Node module (for testing `sanitize`).
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const { matcher, lock, pomodoro } = isNode
    ? { matcher: require("./matcher.js"), lock: require("./lock.js"), pomodoro: require("./pomodoro.js") }
    : root.FG;

  // 1: v0.2.1. Version 0 is anything older (no schemaVersion key).
  const SCHEMA_VERSION = 1;

  const DEFAULTS = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    enabled: false,
    mode: "blocklist", // "blocklist" | "allowlist"
    blocklist: [],
    allowlist: [],
    passwordHash: null,
    passwordSalt: null,
    passwordIterations: lock.ITERATIONS,
    timerEnd: null, // absolute ms timestamp, survives browser restarts
    timerMinutes: 50, // last used lock timer length
    pomodoro: Object.freeze({ ...pomodoro.DEFAULTS }), // saved pomodoro settings
    pomodoroRun: null, // snapshot of settings + startedAt while a pomodoro runs
  });

  const isHex = (v) => typeof v === "string" && /^[0-9a-f]+$/.test(v) && v.length % 2 === 0;

  function cleanPomodoro(cfg) {
    try {
      const out = pomodoro.validateConfig(cfg);
      out.blocklist = matcher.salvageList(out.blocklist);
      return out;
    } catch {
      return null;
    }
  }

  // Turns whatever is stored (old versions, partial or corrupt data) into a valid state.
  // Pure: returns the state and whether anything had to change, so `load` can write it back.
  function sanitize(stored, now) {
    const s = { ...DEFAULTS, ...stored };
    const out = {
      schemaVersion: SCHEMA_VERSION,
      enabled: s.enabled === true,
      mode: s.mode === "allowlist" ? "allowlist" : "blocklist",
      blocklist: matcher.salvageList(s.blocklist),
      allowlist: matcher.salvageList(s.allowlist),
      passwordHash: null,
      passwordSalt: null,
      passwordIterations: lock.ITERATIONS,
      timerEnd: lock.timerActive(s.timerEnd, now) ? s.timerEnd : null,
      timerMinutes: Number.isInteger(s.timerMinutes) && s.timerMinutes >= 1 && s.timerMinutes <= 1440 ? s.timerMinutes : 50,
      pomodoro: cleanPomodoro(s.pomodoro) || { ...DEFAULTS.pomodoro },
      pomodoroRun: null,
    };
    // A half-stored password would lock the user out; keep it only if complete.
    if (
      isHex(s.passwordHash) && s.passwordHash.length === 64 && isHex(s.passwordSalt) &&
      Number.isInteger(s.passwordIterations) && s.passwordIterations > 0 && s.passwordIterations <= 0xffffffff
    ) {
      out.passwordHash = s.passwordHash;
      out.passwordSalt = s.passwordSalt;
      out.passwordIterations = s.passwordIterations;
    }
    const run = s.pomodoroRun && cleanPomodoro(s.pomodoroRun);
    if (run && Number.isFinite(s.pomodoroRun.startedAt)) out.pomodoroRun = { ...run, startedAt: s.pomodoroRun.startedAt };

    // v0.1.x set enabled=true whenever a lock timer started and never reset it, so focus stayed
    // on after the timer. If an old install still has that leftover timer, undo it once.
    if (!("schemaVersion" in stored) && typeof stored.timerEnd === "number" && stored.enabled === true) {
      out.enabled = false;
    }

    const changed = Object.keys(out).some((k) => JSON.stringify(out[k]) !== JSON.stringify(stored[k]));
    return { state: out, changed };
  }

  async function load() {
    const stored = await browser.storage.local.get(null);
    const { state, changed } = sanitize(stored, Date.now());
    if (changed) {
      try {
        await browser.storage.local.set(state);
      } catch (error) {
        // A failed repair must not discard the rules we already read successfully.
        console.error("Heads Down could not persist repaired settings:", error);
      }
    }
    return state;
  }

  function save(patch) {
    return browser.storage.local.set(patch);
  }

  const api = { SCHEMA_VERSION, DEFAULTS, sanitize, load, save };
  if (isNode) module.exports = api;
  else (root.FG = root.FG || {}).storage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
