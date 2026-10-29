let state = null;
let countdowns = [];

function render() {
  const timerOn = Boolean(state.timerEnd);
  const list = state.mode === "allowlist" ? state.allowlist : state.blocklist;

  const kind = timerOn ? "locked" : state.enabled ? "on" : "off";
  $("status").dataset.state = kind;
  $("status").textContent = t({ locked: "stLocked", on: "stFocusOn", off: "stFocusOff" }[kind]);
  $("summary").textContent = t(state.mode === "allowlist" ? "summaryAllowlist" : "summaryBlocklist", list.length);

  $("toggle").textContent = t(state.enabled ? "btnFocusOff" : "btnFocusOn");
  $("toggle").classList.toggle("primary", !state.enabled);
  $("toggle").disabled = timerOn;
  $("add-site").textContent = t(state.mode === "allowlist" ? "btnAllowSite" : "btnBlockSite");
  // Blocking one more site is allowed during a timer; allowing one is not.
  $("add-site").disabled = timerOn && state.mode === "allowlist";
  if (document.activeElement !== $("minutes")) $("minutes").value = state.timerMinutes;

  const pomo = state.pomodoroStatus;
  $("pomo-start").classList.toggle("hidden", Boolean(pomo));
  $("pomo-stop").classList.toggle("hidden", !pomo);
  $("pomo-stop").disabled = timerOn;

  countdowns.forEach(clearInterval);
  countdowns = [];
  $("timer-line").classList.toggle("hidden", !timerOn);
  countdowns.push(startCountdown($("timer"), state, refresh));

  const ring = $("pomo-ring");
  ring.dataset.phase = !pomo ? "idle" : pomo.phase === "work" ? "work" : "break";
  if (pomo) {
    $("pomo-line").textContent = phaseLabel(pomo);
    countdowns.push(
      startCountdown($("pomo-time"), state, refresh, pomo.phaseEnd, (left) =>
        ring.style.setProperty("--progress", phaseProgress(pomo, left))
      )
    );
  } else {
    const p = state.pomodoro;
    ring.style.setProperty("--progress", 0);
    $("pomo-time").textContent = formatRemaining(p.workMin * 60 * 1000);
    $("pomo-line").textContent = t("pomoIdleLine", p.workMin, p.shortMin, p.longMin, p.cycles);
  }
}

async function refresh() {
  state = await send("getState");
  render();
}

// A null result means the user cancelled the password dialog: keep everything as is.
async function run(action) {
  try {
    const result = await action();
    if (!result) return;
    state = result;
    showMessage($("msg"), "");
    render();
  } catch (e) {
    showMessage($("msg"), e.message, true);
  }
}

$("toggle").addEventListener("click", () => {
  const enabled = !state.enabled;
  if (enabled && state.mode === "allowlist" && !state.allowlist.length) {
    run(() => formDialog({
      title: t("btnFocusOn"),
      text: t("confirmEmptyAllowlist"),
      submitLabel: t("btnFocusOn"),
      action: () => send("update", { patch: { enabled } }),
    }));
    return;
  }
  run(() => withPassword((password) => send("update", { patch: { enabled }, password })));
});

$("add-site").addEventListener("click", () =>
  run(async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    let url = tab && tab.url;
    const blockedPage = browser.runtime.getURL("ui/blocked.html");
    if (url && url.startsWith(blockedPage)) url = blockedTarget(url);
    return withPassword((password) => send("addSite", { url, password }));
  })
);

// Two-step confirm: confirm() is unreliable in Firefox popups, and a lock cannot be undone.
let armTimeout = null;
function disarm() {
  clearTimeout(armTimeout);
  armTimeout = null;
  $("start-timer").classList.remove("armed");
  $("start-timer").textContent = t("btnStartTimer");
}
$("start-timer").addEventListener("click", () => {
  if (!armTimeout) {
    $("start-timer").classList.add("armed");
    $("start-timer").textContent = t("btnConfirmTimer", $("minutes").value);
    armTimeout = setTimeout(disarm, 4000);
    return;
  }
  disarm();
  run(() => send("startTimer", { minutes: $("minutes").value }));
});

$("minutes").addEventListener("change", () => {
  disarm();
  send("saveTimerMinutes", { minutes: $("minutes").value }).catch((e) => showMessage($("msg"), e.message, true));
});

$("pomo-start").addEventListener("click", () => run(() => send("startPomodoro")));
$("pomo-stop").addEventListener("click", () =>
  run(() => withPassword((password) => send("stopPomodoro", { password })))
);

$("open-options").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});

onSettingsChanged(() => refresh().catch(() => {}));
refresh().catch((e) => showMessage($("msg"), e.message, true));
