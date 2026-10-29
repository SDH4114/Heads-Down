let state = null;
let countdowns = [];

const toLines = (list) => list.join("\n");
const fromLines = (text) => text.split(/[\s,]+/).filter(Boolean);
const radio = (name) => {
  const checked = document.querySelector(`input[name="${name}"]:checked`);
  return checked ? checked.value : null; // null before the form is first filled
};
const setRadio = (name, value) => (document.querySelector(`input[name="${name}"][value="${value}"]`).checked = true);

// Each form field knows how to read itself, write a state value, and which state value it shows.
// `base` remembers what was last written, so we can tell user edits from stale values:
// - Save sends only fields the user changed (a stale field never undoes a change made elsewhere).
// - When settings change elsewhere, untouched fields are refilled; edited ones are left alone.
function formSection(fields) {
  const base = {};
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  return {
    fill(source, { force = false } = {}) {
      for (const [key, f] of Object.entries(fields)) {
        if (force || same(f.read(), base[key])) {
          f.write(f.from(source));
          base[key] = f.read();
        }
      }
    },
    edited() {
      const out = {};
      for (const [key, f] of Object.entries(fields)) if (!same(f.read(), base[key])) out[key] = f.read();
      return out;
    },
    accept(source, submitted) {
      for (const [key, value] of Object.entries(submitted)) {
        const f = fields[key];
        if (same(f.read(), value)) f.write(f.from(source));
        base[key] = f.from(source);
      }
      this.fill(source);
    },
    isDirty() {
      return Object.keys(this.edited()).length > 0;
    },
    values() {
      return Object.fromEntries(Object.entries(fields).map(([key, f]) => [key, f.read()]));
    },
  };
}

const textList = (id, from) => ({
  read: () => fromLines($(id).value),
  write: (list) => ($(id).value = toLines(list)),
  from,
});
const number = (id, from) => ({ read: () => $(id).value, write: (v) => ($(id).value = v), from });

const mainForm = formSection({
  mode: { read: () => radio("mode"), write: (v) => setRadio("mode", v), from: (s) => s.mode },
  blocklist: textList("blocklist", (s) => s.blocklist),
  allowlist: textList("allowlist", (s) => s.allowlist),
});

const timerForm = formSection({ timerMinutes: number("minutes", (s) => String(s.timerMinutes)) });

const pomoForm = formSection({
  workMin: number("pomo-work", (s) => String(s.pomodoro.workMin)),
  shortMin: number("pomo-short", (s) => String(s.pomodoro.shortMin)),
  longMin: number("pomo-long", (s) => String(s.pomodoro.longMin)),
  cycles: number("pomo-cycles", (s) => String(s.pomodoro.cycles)),
  useMainRules: {
    read: () => radio("pomo-rules") === "main",
    write: (v) => setRadio("pomo-rules", v ? "main" : "custom"),
    from: (s) => s.pomodoro.useMainRules,
  },
  blocklist: textList("pomo-blocklist", (s) => s.pomodoro.blocklist),
});

let formsFilled = false; // nothing can be "unsaved" before the forms show the saved state
const isDirty = () => formsFilled && (mainForm.isDirty() || pomoForm.isDirty());
const updateSavebar = () => $("savebar").classList.toggle("hidden", !isDirty());

function renderStatus() {
  const timerOn = Boolean(state.timerEnd);
  const pomo = state.pomodoroStatus;

  $("enabled").checked = state.enabled;
  $("enabled").disabled = timerOn;
  $("lock-pill").classList.toggle("hidden", !timerOn);
  $("pomo-pill").classList.toggle("hidden", !pomo);
  if (pomo) {
    $("pomo-pill").dataset.state = pomo.phase === "work" ? "work" : "break";
    $("pomo-pill").textContent = phaseLabel(pomo);
  }

  $("password-state").textContent = t(state.hasPassword ? "passwordIsSet" : "passwordNotSet");
  $("set-password").classList.toggle("hidden", state.hasPassword);
  $("change-password").classList.toggle("hidden", !state.hasPassword);
  $("remove-password").classList.toggle("hidden", !state.hasPassword);

  // The lock timer freezes the main settings and the password; Pomodoro settings stay editable.
  for (const el of document.querySelectorAll(".lockable")) el.disabled = timerOn;
  $("pomo-start").classList.toggle("hidden", Boolean(pomo));
  $("pomo-stop").classList.toggle("hidden", !pomo);
  $("pomo-stop").disabled = timerOn;
  timerForm.fill(state, { force: !formsFilled });

  countdowns.forEach(clearInterval);
  countdowns = [];
  $("timer-line").classList.toggle("hidden", !timerOn);
  countdowns.push(startCountdown($("timer"), state, refresh));
  $("pomo-status").classList.toggle("hidden", !pomo);
  if (pomo) {
    const ring = $("pomo-ring");
    ring.dataset.phase = pomo.phase === "work" ? "work" : "break";
    $("pomo-phase").textContent = phaseLabel(pomo);
    countdowns.push(
      startCountdown($("pomo-left"), state, refresh, pomo.phaseEnd, (left) =>
        ring.style.setProperty("--progress", phaseProgress(pomo, left))
      )
    );
  }
  updateSavebar();
}

async function refresh() {
  state = await send("getState");
  renderStatus();
}

let toastTimer = null;
function toast(text, isError = false) {
  clearTimeout(toastTimer);
  showMessage($("msg"), text, isError);
  if (text && !isError) toastTimer = setTimeout(() => showMessage($("msg"), ""), 4000);
}

// Runs a background request. A null result means the user cancelled a dialog: nothing to report.
async function run(action, okText) {
  try {
    const result = await action();
    if (!result) return;
    state = result;
    renderStatus();
    if (okText) toast(okText);
  } catch (e) {
    toast(e.message, true);
  }
}

// --- Focus switch: applies at once ---
$("enabled").addEventListener("change", () => {
  const enabled = $("enabled").checked;
  $("enabled").checked = state.enabled; // shows the real state until the background confirms
  if (enabled && state.mode === "allowlist" && !state.allowlist.length && !confirm(t("confirmEmptyAllowlist"))) return;
  run(() => withPassword((password) => send("update", { patch: { enabled }, password })));
});

// --- One save for everything on the page ---
async function saveAll() {
  const main = mainForm.edited();
  const mode = main.mode || state.mode;
  const allowlist = main.allowlist || state.allowlist;
  if (state.enabled && mode === "allowlist" && allowlist.length === 0) {
    if (!confirm(t("confirmEmptyAllowlist"))) return false;
  }
  try {
    // Pomodoro first: it never needs the password, so a cancelled password prompt for the
    // main settings does not lose it.
    if (pomoForm.isDirty()) {
      const config = pomoForm.values();
      state = await send("savePomodoro", { config });
      pomoForm.accept(state, config);
    }
    if (Object.keys(main).length) {
      const result = await withPassword((password) => send("update", { patch: main, password }));
      if (!result) {
        renderStatus();
        return false;
      }
      state = result;
      mainForm.accept(state, main);
    }
    renderStatus();
    toast(t("msgSaved"));
    return true;
  } catch (e) {
    renderStatus();
    toast(e.message, true);
    return false;
  }
}

$("save").addEventListener("click", saveAll);
$("discard").addEventListener("click", () => {
  mainForm.fill(state, { force: true });
  pomoForm.fill(state, { force: true });
  updateSavebar();
});
document.addEventListener("input", updateSavebar);
document.addEventListener("change", updateSavebar);
window.addEventListener("beforeunload", (e) => {
  if (isDirty()) e.preventDefault();
});

// --- Pomodoro ---
// Start saves pending changes first, so what you see is what runs.
$("pomo-start").addEventListener("click", async () => {
  if (isDirty() && !(await saveAll())) return;
  if (isDirty()) return;
  run(() => send("startPomodoro"), t("msgPomodoroStarted"));
});

$("pomo-stop").addEventListener("click", () =>
  run(() => withPassword((password) => send("stopPomodoro", { password })), t("msgPomodoroStopped"))
);

// --- Password: each action is one dialog with exactly the fields it needs ---
const newPasswordFields = [
  { name: "newPassword", label: t("lblNewPassword"), autocomplete: "new-password" },
  { name: "confirm", label: t("lblConfirmPassword"), autocomplete: "new-password" },
];

function checkNew(v) {
  if (v.newPassword !== v.confirm) throw new Error(t("errPasswordMismatch"));
}

$("set-password").addEventListener("click", () =>
  run(
    () =>
      formDialog({
        title: t("dlgSetPasswordTitle"),
        text: t("dlgSetPasswordText"),
        fields: newPasswordFields,
        submitLabel: t("btnSetPassword"),
        action: (v) => (checkNew(v), send("setPassword", { newPassword: v.newPassword })),
      }),
    t("msgPasswordSet")
  )
);

$("change-password").addEventListener("click", () =>
  run(
    () =>
      formDialog({
        title: t("dlgChangePasswordTitle"),
        fields: [{ name: "password", label: t("lblCurrentPassword"), autocomplete: "current-password" }, ...newPasswordFields],
        submitLabel: t("btnChangePassword"),
        action: (v) => (checkNew(v), send("setPassword", { newPassword: v.newPassword, password: v.password })),
      }),
    t("msgPasswordChanged")
  )
);

$("remove-password").addEventListener("click", () =>
  run(
    () =>
      formDialog({
        title: t("dlgRemovePasswordTitle"),
        text: t("dlgRemovePasswordText"),
        fields: [{ name: "password", label: t("lblCurrentPassword"), autocomplete: "current-password" }],
        submitLabel: t("btnRemovePassword"),
        danger: true,
        action: (v) => send("removePassword", { password: v.password }),
      }),
    t("msgPasswordRemoved")
  )
);

// --- Lock timer ---
$("minutes").addEventListener("change", async () => {
  const minutes = $("minutes").value;
  try {
    state = await send("saveTimerMinutes", { minutes });
    timerForm.accept(state, { timerMinutes: minutes });
    renderStatus();
  } catch (e) {
    toast(e.message, true);
  }
});

$("start-timer").addEventListener("click", () => {
  const m = $("minutes").value;
  if (!confirm(t("confirmTimer", m))) return;
  run(() => send("startTimer", { minutes: m }), t("msgTimerStarted"));
});

// Settings changed elsewhere (popup, another tab, a phase change): update status and untouched fields.
onSettingsChanged(() =>
  refresh()
    .then(() => {
      mainForm.fill(state);
      pomoForm.fill(state);
      updateSavebar();
    })
    .catch(() => {})
);

refresh()
  .then(() => {
    mainForm.fill(state, { force: true });
    pomoForm.fill(state, { force: true });
    formsFilled = true;
    updateSavebar();
  })
  .catch((e) => toast(e.message, true));
