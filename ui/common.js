// Helpers shared by popup, options and blocked pages. Loaded after ../src/i18n.js.
const t = (key, ...subs) => FG.i18n.t(key, ...subs);
const $ = (id) => document.getElementById(id);

async function send(type, payload = {}) {
  const res = await browser.runtime.sendMessage({ type, ...payload });
  if (!res || !res.ok) {
    throw Object.assign(new Error((res && res.error) || t("errNoResponse")), { code: res && res.code });
  }
  return res.state;
}

// Modal form in a <dialog>. `action(values)` runs on submit; on error the dialog stays open and
// shows the message, so the user can fix a typo. Resolves with action's result, or null on cancel.
// fields: [{ name, label, type = "password", autocomplete }]
function formDialog({ title, text, fields = [], submitLabel, danger = false, action }) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dialog";
    const form = document.createElement("form");
    const h = document.createElement("h2");
    h.textContent = title;
    form.append(h);
    if (text) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = text;
      form.append(p);
    }
    const inputs = fields.map((f) => {
      const label = document.createElement("label");
      label.className = "field";
      const span = document.createElement("span");
      span.className = "field-label";
      span.textContent = f.label;
      const input = document.createElement("input");
      input.type = f.type || "password";
      input.name = f.name;
      input.autocomplete = f.autocomplete || "off";
      input.required = true;
      label.append(span, input);
      form.append(label);
      return input;
    });
    const error = document.createElement("p");
    error.className = "msg error";
    error.setAttribute("role", "alert");
    const buttons = document.createElement("div");
    buttons.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = t("btnCancel");
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = danger ? "danger" : "primary";
    submit.textContent = submitLabel;
    buttons.append(cancel, submit);
    form.append(error, buttons);
    dlg.append(form);

    let result = null;
    const finish = () => dlg.close();
    cancel.addEventListener("click", finish);
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(result);
    });
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const values = Object.fromEntries(inputs.map((i) => [i.name, i.value]));
      submit.disabled = true;
      error.textContent = "";
      try {
        result = await action(values);
        finish();
      } catch (err) {
        error.textContent = err.message;
        if (inputs[0]) inputs[0].select();
      } finally {
        submit.disabled = false;
      }
    });

    document.body.append(dlg);
    dlg.showModal();
    if (inputs[0]) inputs[0].focus();
  });
}

// Runs call(password) without a password first. Only if the background says one is needed,
// asks for it in a dialog and retries there. Resolves to null if the user cancels.
async function withPassword(call) {
  try {
    return await call(undefined);
  } catch (e) {
    if (e.code !== "errWrongPassword") throw e;
    return formDialog({
      title: t("dlgUnlockTitle"),
      text: t("dlgUnlockText"),
      fields: [{ name: "password", label: t("lblPassword"), autocomplete: "current-password" }],
      submitLabel: t("btnUnlock"),
      action: (v) => call(v.password),
    });
  }
}

function formatRemaining(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// Ticks a countdown text node until `end`; calls onDone once it reaches zero.
// Optional onTick(left) runs on every tick (e.g. to move a progress ring).
// state.now comes from the background clock, so the offset handles any skew.
function startCountdown(el, state, onDone, end = state.timerEnd, onTick) {
  if (!end) return null;
  const offset = state.now - Date.now();
  const tick = () => {
    const left = end - (Date.now() + offset);
    el.textContent = formatRemaining(left);
    if (onTick) onTick(left);
    if (left <= 0) {
      clearInterval(id);
      if (onDone) onDone();
    }
  };
  const id = setInterval(tick, 1000);
  tick();
  return id;
}

const PHASE_KEY = { work: "phaseWork", break: "phaseBreak", longBreak: "phaseLongBreak" };

// "Work 2/4" for the current pomodoro phase, or "" when no pomodoro runs.
function phaseLabel(status) {
  return status ? t(PHASE_KEY[status.phase], status.cycle, status.cycles) : "";
}

// Elapsed share of the current pomodoro phase, 0..1.
function phaseProgress(status, left) {
  if (!status) return 0;
  const length = status.phaseEnd - status.phaseStart;
  if (!(length > 0)) return 0;
  return Math.min(1, Math.max(0, 1 - left / length));
}

function showMessage(el, text, isError = false) {
  el.textContent = text;
  el.classList.toggle("error", isError);
}

// Calls fn (debounced) whenever settings change anywhere: another page, the popup, a phase.
function onSettingsChanged(fn) {
  let pending = null;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    clearTimeout(pending);
    pending = setTimeout(fn, 50);
  });
}

if (typeof document !== "undefined" && document.querySelector) FG.i18n.applyI18n(document);
