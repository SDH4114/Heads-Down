# AGENTS.md: Heads Down

## Purpose
A Firefox/Zen WebExtension that blocks distracting sites so the user can stay on one task. The author uses it for IELTS practice, but nothing is hardcoded: every list and lock is user-configured. Planned for publication on addons.mozilla.org.

## What it does
- Two modes: blocklist (block listed domains) and allowlist (allow only listed domains).
- Pomodoro: work/break/long-break cycles (defaults 25/5/20, long break after 4 work sessions). It blocks only during work, with its own list or the main rules, notifies each phase change, and shows a progress ring.
- Optional password lock: turning focus off, stopping a Pomodoro, or loosening the main settings requires it.
- Optional lock timer: blocks with the main rules and freezes the main settings until it ends. It can be extended, never shortened. It does not change `enabled`.
- `ui/blocked.html` replaces blocked pages. It shows the reason and offers **Open site** once the site is allowed again.
- UI and messages in English and Russian (`_locales`).

## Status
Active, v0.3.3. Node tests (98) and `web-ext lint` pass (one Android-only minimum-version warning). E2E in real Zen passes 100 checks; five additional browser checks verified allowing the original site through the popup on a blocked page. Background tests cover notification API calls; OS notification display is not checked. Not published yet. The `gecko.id` is `heads-down@local` (permanent once uploaded to AMO). Name check: ("Heads Down" is taken several times on AMO).

## Stack
Plain JavaScript, no build step, no dependencies. Manifest V2, persistent background. Tests use `node:test` (Node 22). E2E uses Python + Selenium + geckodriver.

## Structure
- `manifest.json`: MV2 manifest. Background scripts are listed in load order: matcher, lock, pomodoro, i18n, policy, storage, background.
- `src/matcher.js`: domain normalization, `isBlocked`, `cleanList` (strict) and `salvageList` (lenient, for stored data).
- `src/lock.js`: PBKDF2 hash/verify (iterations are a parameter and stored with the hash), `timerActive`.
- `src/pomodoro.js`: pure `phaseAt(run, now)`, `validateConfig` (errors carry `field/min/max`), defaults.
- `src/i18n.js`: `t(key, ...subs)` and `applyI18n(document)`. In Node it reads `_locales/en`.
- `src/policy.js`: pure rules with an explicit `now`: `blockReason`, `publicState`, `validatePatch`, `changedOnly`, `isTightening`, `parseTimerMinutes`, `fail(key)`.
- `src/storage.js`: `SCHEMA_VERSION`, frozen `DEFAULTS`, pure `sanitize(stored, now)` (migration and repair), `load` (attempts to write repaired state back; a failed repair write keeps the valid in-memory rules), `save`.
- `src/background.js`: effects only. Listeners (webRequest, tabs.onUpdated, storage.onChanged, runtime.onMessage), `sweepTabs`, pomodoro phase ticks and notifications, `handlers` behind a `serial()` queue.
- `ui/common.js`: `t`, `$`, `send`, `startCountdown(el, state, onDone, end, onTick)`, `phaseLabel`, `phaseProgress`, `onSettingsChanged`. It calls `applyI18n` on load. UI pages load `../src/i18n.js` first.
- `ui/style.css`: the whole design system (tokens, light/dark, buttons, segmented control, pills, ring, cards, page layouts, reduced-motion and forced-colors).
- `ui/popup.*`, `ui/options.*`, `ui/blocked.*`: the three pages. `icons/icon.svg`: toolbar and add-on icon.
- `tests/`:
  - `matcher`, `pomodoro`, `policy` and `common` unit tests.
  - `background.test.js` runs the real background in `node:vm` with a fake `browser`, `i18n`, clock and timers.
  - `ui.test.js` runs options/popup/dialog behavior in `node:vm`, including edits during pending saves.
  - `i18n.test.js` checks that the locales match and that every used key exists.
  - `e2e/run_e2e.py` runs the real Zen scenario.

## Architecture
UI pages never write storage. They call `send(type, payload)` and receive `{ok, state}` or `{ok:false, error}`. The error is already localized by the background. The handlers are:
- `getState` and `check {url}` (returns `reason`);
- `update`, `addSite`, `setPassword`, `removePassword`;
- `startTimer`, `saveTimerMinutes`;
- `savePomodoro`, `startPomodoro`, `stopPomodoro`.

All mutating handlers run through `serial()`, so checks and commits never interleave. That matters because PBKDF2 and the storage write are async.

The background keeps `state` in memory. `storage.onChanged` re-validates through `sanitize`. Commits and external changes share `replaceState`, which synchronizes tab sweeps and Pomodoro timers once per actual change. Password checks re-check locks after async hashing. `policy.blockReason(state, url, now)` returns `focus`, `timer`, `pomodoro` or null. The main rules apply when `enabled || timerActive`; the pomodoro rules apply in a work phase of `pomodoroRun`.

UI pages subscribe to `storage.onChanged` (`onSettingsChanged`) and refresh. Options uses `formSection`: it sends only fields the user edited and refills untouched fields when settings change elsewhere; save acknowledgements preserve edits made while a request was pending. Timer duration has its own immediately saved section.

Options behavior:
- The focus switch (topbar) applies at once.
- Lists, mode and Pomodoro settings share one Save in a bottom save bar, shown only when something is unsaved. The bar also has Discard and a `beforeunload` guard.
- There is no permanent password field. Errors carry a `code`. `withPassword(call)` in `ui/common.js` tries without a password and opens a `formDialog` only on `errWrongPassword`.
- Set, change and remove password are separate dialogs. A new password is typed twice.

## Commands
- Tests: `node --test`
- E2E: `uv run --with selenium python tests/e2e/run_e2e.py . <geckodriver>` (about 3 min; it pins `intl.locale.requested=en-US`)
- Lint: `npx web-ext lint --source-dir . --ignore-files "tests/**"` (one known warning, the Android-only min version); `uvx ruff check tests/e2e`
- Run: `npx web-ext run --source-dir .`, or load `manifest.json` via `about:debugging` in Zen.
- Package: `npx web-ext build --ignore-files "tests/**"` (verified with `--artifacts-dir /tmp/focus-guard-audit-0.3.2`)

## Conventions
- Modules are IIFEs that attach to `globalThis.FG.*` in the browser and use `module.exports` under Node (requiring their deps), so files are testable without a bundler.
- Every user-visible string goes through `t()` / `data-i18n*`. Add new keys to both `_locales/en` and `_locales/ru`; `i18n.test.js` enforces this. Use `$1…$9` substitutions and avoid plurals (no plural rules in `browser.i18n`): write "sites: 3".
- UI state is shown with `data-state` / `data-phase` attributes plus CSS, not inline styles. The pomodoro ring takes `--progress` 0..1.
- Domains are stored normalized (no scheme, path, `www.` or leading dots; IDN as punycode). An entry matches its subdomains.

## Decisions
- MV2 + blocking `webRequest`: Mozilla says Firefox has no plans to deprecate MV2 (blog, March 2024). MV2 grants host permissions at install, and redirects happen before the page loads.
- Times are absolute timestamps (`timerEnd`, `pomodoroRun.startedAt`). Phases are computed from `startedAt`. `setTimeout` is used only for notifications and sweeps.
- Schema migration lives in `storage.sanitize`. v0 → v1 turns off an `enabled=true` left by the v0.1 timer bug. Corrupt or partial data is repaired, never trusted, because a bad `pomodoroRun` used to break every request.
- Changes that only tighten (enable focus, add to the blocklist, start or extend a lock timer, start a Pomodoro) need no password, and adding to the blocklist works even during a timer.
- The lock timer refuses an empty allowlist (it would block the whole web). It also refuses an empty blocklist unless a Pomodoro is running (locking a Pomodoro is legitimate).
- `focus` wins over `timer` in `blockReason`, so the block page never promises "until the timer ends" while focus keeps the site blocked.
- The popup confirms the lock timer with a second click, because `confirm()` is unreliable in Firefox popups. Options uses `confirm()`.
- `data_collection_permissions: none` requires `strict_min_version` 140.

## Gotchas
- An empty allowlist with focus on blocks every website. Options asks for confirmation; popup uses a dialog because `confirm()` is unreliable there.
- If the initial storage read fails, UI requests return an error and navigation is allowed because no saved rules are available; the background logs the failure. Repair-write failures keep the already-read rules active.
- Back/forward-cache restores do not fire `webRequest`; `tabs.onUpdated` (url change) catches them. Do not remove it.
- `blocked.html` is web-accessible, so its `url` param is untrusted. Only `http(s)` may be opened from it, and text is set via `textContent`.
- The URL parser turns `5` or `1.2` into IPv4 (`0.0.0.5`). `normalizeDomain` accepts an IP only if typed in full.
- E2E:
  - Zen's initial Marionette context is not a real tab, so the script uses a new tab.
  - Extension pages are opened from the chrome context (geckodriver `--allow-system-access`).
  - The status pill is checked via `data-state`, not text.
  - Never use `text-transform` on texts the e2e reads.
  - Segmented radios are opacity-0 overlays; WebDriver clicks them fine.
- Tests:
  - Under `node:vm`, sandbox arrays fail `deepStrictEqual` against host arrays, so compare through `plain()`.
  - Phase-tick tests must advance past the boundary plus 250 ms, in separate steps.
- Dark mode: `--ring-track` equals `--surface-2`, so a ring on a surface-2 block needs `--track` (see `.pomo-now .ring`).
- Only `main_frame` is blocked, so iframes (e.g. YouTube embeds) still load. The locks are not tamper-proof: the add-on can be disabled in `about:addons`, and the system clock affects timers. Private windows need the add-on allowed there.
- "Reload" of a temporary add-on does not pick up folders that did not exist at first load. Requests to them fail with NetworkError, and `getMessage` returns "" for all keys, so the UI shows raw keys. This was reproduced in Zen with `addon.reload()`. Fix: Remove and Load Temporary Add-on again. It does not affect AMO installs. Do not add a code fallback: the files are unreachable too.
- Temporary add-ons disappear on browser restart. A permanent install needs AMO signing.
