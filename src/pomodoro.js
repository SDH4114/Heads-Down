// Pomodoro schedule math. Browser global (FG.pomodoro) and Node module for tests.
// The current phase is computed from the start time, so it stays correct across
// sleep, restarts and late timers; nothing depends on a timer firing on time.
(function (root) {
  const MIN = 60 * 1000;

  const DEFAULTS = {
    workMin: 25,
    shortMin: 5,
    longMin: 20,
    cycles: 4, // work sessions before a long break
    useMainRules: false, // true: block with the main mode and lists; false: use `blocklist`
    blocklist: [],
  };

  const LIMITS = { workMin: [1, 180], shortMin: [1, 60], longMin: [1, 120], cycles: [1, 12] };

  // Validates numbers and flags; the blocklist is validated by the caller (it needs the matcher).
  function validateConfig(input) {
    const src = { ...DEFAULTS, ...(input || {}) };
    const out = { useMainRules: Boolean(src.useMainRules), blocklist: src.blocklist };
    for (const [key, [min, max]] of Object.entries(LIMITS)) {
      const n = Number(src[key]);
      if (!Number.isInteger(n) || n < min || n > max) {
        // field/min/max let the caller build a localized message.
        throw Object.assign(new Error(`${key} must be a whole number from ${min} to ${max}.`), { field: key, min, max });
      }
      out[key] = n;
    }
    return out;
  }

  // One round: work, break, work, break, ..., work, long break (`cycles` work sessions).
  // Returns { phase: "work" | "break" | "longBreak", cycle, phaseEnd }.
  function phaseAt(run, now) {
    const work = run.workMin * MIN;
    const short = run.shortMin * MIN;
    const long = run.longMin * MIN;
    const round = run.cycles * work + (run.cycles - 1) * short + long;
    let t = Math.max(0, now - run.startedAt) % round;
    for (let cycle = 1; cycle <= run.cycles; cycle++) {
      if (t < work) return { phase: "work", cycle, phaseEnd: now - t + work };
      t -= work;
      const isLong = cycle === run.cycles;
      const pause = isLong ? long : short;
      if (t < pause) return { phase: isLong ? "longBreak" : "break", cycle, phaseEnd: now - t + pause };
      t -= pause;
    }
    throw new Error("unreachable: offset is always inside a round");
  }

  const api = { DEFAULTS, LIMITS, validateConfig, phaseAt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.FG = root.FG || {}).pomodoro = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
