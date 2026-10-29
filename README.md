# Heads Down

A Firefox / Zen extension that blocks distracting websites, with a Pomodoro timer and optional password and timer locks.

- **Blocklist mode**: block only the domains you list.
- **Allowlist mode**: allow only the domains you list, block every other website.
- **Pomodoro**: work and break sessions with sites blocked only during work. You set the work, break and long-break lengths, how many work sessions come before a long break (default 4, long break 20 min), and which sites to block (its own list, or the main mode and lists). A notification marks each phase change.
- **Password lock**: turning focus off, stopping a Pomodoro, changing the password, or loosening the main rules needs the password. Tightening the rules and saving settings for the next Pomodoro run do not.
- **Lock timer**: blocks with the main rules and prevents loosening them, stopping a Pomodoro, or changing the password until the time is up. It can be extended, not stopped. Changes that tighten the rules remain after it ends.
- Lists start empty; you decide what goes in them. A domain entry also covers its subdomains.
- Interface in English and Russian (follows the browser language), light and dark themes.

## Requirements
- Firefox 140+ or Zen (Firefox-based).
- Node.js 18+ only for tests and `web-ext` (tested with Node 22).

## Install (temporary, for development)
1. Open `about:debugging#/runtime/this-firefox` in Firefox or Zen.
2. Click **Load Temporary Add-on…** and pick `manifest.json` from this folder.

After an update that adds new folders (for example `_locales/` or `icons/`), **Reload** is not enough: Firefox/Zen keeps the old file list, and the UI shows raw keys like `btnFocusOn`. Click **Remove**, then **Load Temporary Add-on…** again (or restart the browser and load it).

A temporary add-on is removed when the browser restarts. For a permanent install the extension has to be signed through addons.mozilla.org (not done yet).

Or run it in a fresh Firefox profile:

```sh
npx web-ext run --source-dir .
```

## Usage
- Toolbar button: turn focus on/off, block or allow the current site, start a lock timer (click twice to confirm), start or stop a Pomodoro.
- **Settings**: choose the mode, edit both lists (one domain per line), configure the Pomodoro, set a password, start a lock timer.
- When a site is no longer blocked (timer over, break started), its block page shows **Open site**.

## Tests

Unit and integration tests (Node, no dependencies):

```sh
node --test
npx web-ext lint --source-dir . --ignore-files "tests/**"
```

End-to-end test in a real Zen browser (headless, throwaway profile, no real network, about 3 min). It needs [geckodriver](https://github.com/mozilla/geckodriver/releases) and `uv`:

```sh
uv run --with selenium python tests/e2e/run_e2e.py . /path/to/geckodriver
# optional third argument: another Firefox-based binary instead of /Applications/Zen.app/Contents/MacOS/zen
```

## Project structure

```
manifest.json     MV2 manifest
_locales/         en and ru strings
icons/            extension icon (SVG)
src/              background logic: matcher, lock, pomodoro, i18n, policy, storage, background
ui/               popup, settings page, block page, shared CSS and helpers
tests/            node:test suites; tests/e2e/ Selenium scenario for Zen
```

## Limits
The password and timer protect the extension's own settings. The extension can still be disabled or removed in `about:addons`.

Private windows are not covered until you allow the extension there: `about:addons` → Heads Down → **Run in Private Windows** → Allow.
