// Chromium (Manifest V3) has no blocking webRequest, so blocking is done by declarativeNetRequest
// redirect rules. They are computed here from the same state as policy.blockReason, for one moment
// `now`; the background rebuilds them whenever the state changes or a timer or phase ends.
// Browser global (FG.dnr) and Node module for tests.
(function (root) {
  const isNode = typeof module !== "undefined" && module.exports;
  const { policy } = isNode ? { policy: require("./policy.js") } : root.FG;

  const MAIN_RULE = 1;
  const POMODORO_RULE = 2;
  // Only web pages are blocked (as in matcher.isBlocked). The whole URL is the match, so it can be
  // passed to the block page. It goes after "#": in a query string its own "&" would cut it short.
  const WEB_URL = "^https?://.*";

  // Rule condition for one set of lists, or null when it blocks nothing (an empty blocklist).
  // requestDomains and excludedRequestDomains also cover subdomains, like matcher.hostMatches.
  function listCondition({ mode, blocklist, allowlist }) {
    if (mode === "allowlist") return allowlist.length ? { excludedRequestDomains: [...allowlist] } : {};
    return blocklist.length ? { requestDomains: [...blocklist] } : null;
  }

  function redirectRule(id, condition, blockedPage) {
    return {
      id,
      priority: 1,
      action: { type: "redirect", redirect: { regexSubstitution: blockedPage + "#\\0" } },
      condition: { regexFilter: WEB_URL, resourceTypes: ["main_frame"], ...condition },
    };
  }

  // The rules that make policy.blockReason(state, url, now) hold for every main-frame request.
  function redirectRules(state, now, blockedPage) {
    const rules = [];
    const add = (id, lists) => {
      const condition = listCondition(lists);
      if (condition) rules.push(redirectRule(id, condition, blockedPage));
    };
    if (policy.mainActive(state, now)) add(MAIN_RULE, state);
    const phase = policy.pomodoroStatus(state, now);
    if (phase && phase.phase === "work") {
      const run = state.pomodoroRun;
      add(POMODORO_RULE, run.useMainRules ? state : { mode: "blocklist", blocklist: run.blocklist });
    }
    return rules;
  }

  // When the rules next change on their own (lock timer end or Pomodoro phase end), or null.
  function nextChange(state, now) {
    const times = [];
    if (policy.timerOn(state, now)) times.push(state.timerEnd);
    const phase = policy.pomodoroStatus(state, now);
    if (phase) times.push(phase.phaseEnd);
    return times.length ? Math.min(...times) : null;
  }

  const api = { redirectRules, nextChange };
  if (isNode) module.exports = api;
  else (root.FG = root.FG || {}).dnr = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
