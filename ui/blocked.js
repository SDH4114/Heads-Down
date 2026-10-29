const target = new URLSearchParams(location.search).get("url") || "";
const isWeb = /^https?:/i.test(target);
let host = target;
try {
  host = new URL(target).hostname;
} catch {}
$("host").textContent = host || t("thisSite");

// reason -> [pill state, pill text, reason text]
const REASONS = {
  focus: ["on", "stFocusOn", "reasonFocus"],
  timer: ["locked", "stLockTimer", "reasonTimer"],
  pomodoro: ["work", "stPomodoroWork", "reasonPomodoro"],
};

async function closeTab() {
  const tab = await browser.tabs.getCurrent();
  if (tab) browser.tabs.remove(tab.id); // undefined when the page is not in a tab (e.g. framed)
}

// The blocked page itself is a history entry; if there is nothing before it, close the tab.
$("back").addEventListener("click", () => (history.length > 1 ? history.back() : closeTab()));
$("close").addEventListener("click", closeTab);
$("options").addEventListener("click", () => browser.runtime.openOptionsPage());
// Only web URLs: the page is web-accessible, so `url` could be anything (e.g. javascript:).
$("open").addEventListener("click", () => {
  if (isWeb) location.replace(target);
});

let countdown = null;
let wasBlocked = null;

// Re-checks the target, so the page notices when a timer ends or a break starts.
async function update() {
  const state = await send("check", { url: target });
  const blocked = Boolean(state.reason);
  const [kind, pillKey, reasonKey] = blocked ? REASONS[state.reason] : ["off", "stNotBlocked", "reasonFree"];

  document.body.dataset.state = blocked ? state.reason : "free";
  $("reason-pill").dataset.state = kind;
  $("reason-pill").textContent = t(pillKey);
  $("title").textContent = t(blocked ? "titleBlocked" : "titleFree");
  $("reason").textContent = t(reasonKey);
  $("open").classList.toggle("hidden", blocked || !isWeb);
  $("back").classList.toggle("primary", blocked);
  if (wasBlocked === true && !blocked) $("announce").textContent = t("announceFree");
  wasBlocked = blocked;

  const end =
    state.reason === "timer" ? state.timerEnd : state.reason === "pomodoro" ? state.pomodoroStatus.phaseEnd : null;
  clearInterval(countdown);
  $("timer-line").classList.toggle("hidden", !end);
  if (end) {
    $("timer-label").textContent = t(state.reason === "timer" ? "unlocksIn" : "breakIn");
    countdown = startCountdown($("timer"), state, update, end);
  }
}

update().catch(() => {});
onSettingsChanged(() => update().catch(() => {}));
// Catches time-based changes without a countdown on screen.
setInterval(() => update().catch(() => {}), 5000);
