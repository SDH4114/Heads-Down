"""E2E test of the Chrome / Edge (MV3) build in a real Chromium with a throwaway profile.

It checks what differs from Firefox: declarativeNetRequest redirects, the service worker, and
alarms that wake a stopped worker when a lock timer or Pomodoro phase ends. Every host resolves
to 127.0.0.1 (--host-resolver-rules), served by a local http.server, so no real network is used.
Test hosts use the .test TLD: Chrome upgrades HSTS-preloaded hosts such as youtube.com to https.
Takes about 3 minutes, including a 1-minute lock timer and 1-minute Pomodoro phases.

Build first: node scripts/build-chromium.mjs
Usage: uv run --with playwright python tests/e2e/run_chromium_e2e.py dist/chromium <chromium binary>
The binary can be Chrome for Testing or Chromium. Branded Google Chrome 137+ ignores
--load-extension, so it cannot be used here.
"""

import http.server
import sys
import tempfile
import threading
import time
from pathlib import Path

from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import sync_playwright

EXT_DIR = str(Path(sys.argv[1]).resolve())
BROWSER = sys.argv[2]
PORT = 8766

results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(
        ("PASS " if cond else "FAIL ")
        + name
        + (f"  [{detail}]" if detail and not cond else ""),
        flush=True,
    )


class Page(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = f"<html><head><title>site</title></head><body>page {self.headers['Host']}{self.path}</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()


def url(domain, path="/"):
    return f"http://{domain}:{PORT}{path}"


def wait_until(fn, timeout=8.0, step=0.2):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn():
                return True
        # e.g. the page is navigating; retry until the timeout
        except PlaywrightError as e:
            print("  (retrying:", str(e).splitlines()[0], ")")
        time.sleep(step)
    return False


with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
    ctx = p.chromium.launch_persistent_context(
        profile,
        executable_path=BROWSER,
        headless=True,
        args=[
            f"--disable-extensions-except={EXT_DIR}",
            f"--load-extension={EXT_DIR}",
            "--host-resolver-rules=MAP * 127.0.0.1",
        ],
    )
    try:
        first = (
            ctx.service_workers[0]
            if ctx.service_workers
            else ctx.wait_for_event("serviceworker", timeout=10000)
        )
        ext_id = first.url.split("/")[2]
        base = f"chrome-extension://{ext_id}/ui/"
        blocked_page = base + "blocked.html"
        check("service worker started", first.url.endswith("/sw.js"), first.url)
        check(
            "manifest v3",
            first.evaluate("browser.runtime.getManifest().manifest_version") == 3,
        )

        page = ctx.pages[0] if ctx.pages else ctx.new_page()
        opts = None

        def worker():
            # Playwright keeps objects of stopped workers; the newest one is the running worker.
            return ctx.service_workers[-1]

        def href(pg):
            # page.url can stay stale after an extension navigates the tab (tabs.update).
            return pg.evaluate("location.href")

        def go(target):
            try:
                page.goto(target, wait_until="domcontentloaded")
            except PlaywrightError as e:  # a redirect can abort the original navigation
                print("  (navigation note:", str(e).splitlines()[0], ")")
            time.sleep(0.4)

        def is_blocked(pg=None):
            return href(pg or page).startswith(blocked_page)

        def send(type_, payload=None):
            """Messages the background from an extension page, like the UI does."""
            return opts.evaluate(
                "([t, p]) => browser.runtime.sendMessage({ type: t, ...p })",
                [type_, payload or {}],
            )

        def dynamic_rules():
            return worker().evaluate("browser.declarativeNetRequest.getDynamicRules()")

        def open_options():
            pg = ctx.new_page()
            pg.goto(base + "options.html")
            return pg

        internals = None

        def worker_status():
            # The page updates live. Reloading it would fire tabs.onUpdated and wake the worker.
            reg = internals.locator(".serviceworker-registration", has_text=ext_id)
            return reg.locator(
                ".serviceworker-running-status .value"
            ).first.inner_text()

        def stop_worker():
            """Stops the worker like Chrome does after 30 s idle; Playwright's debugger keeps it alive otherwise."""
            worker().evaluate("globalThis.__e2eMarker = 1")
            internals.reload()
            reg = internals.locator(".serviceworker-registration", has_text=ext_id)
            reg.locator('cr-button[data-command="stop"]').click()
            return wait_until(lambda: worker_status() == "STOPPED", timeout=5)

        def woken_fresh():
            """The worker runs again, and it is a new instance (the marker is gone)."""
            return (
                worker_status() == "RUNNING"
                and worker().evaluate("typeof globalThis.__e2eMarker") == "undefined"
            )

        # 1. Pages load localized strings (no raw keys) and talk to the worker.
        opts = open_options()
        check(
            "options localized",
            wait_until(
                lambda: opts.locator("#save").inner_text() not in ("", "btnSave")
            ),
            opts.locator("#save").inner_text(),
        )
        check(
            "options reaches the worker",
            wait_until(lambda: opts.locator("#password-state").inner_text() != ""),
        )
        state = send("getState")
        check("getState over sendResponse", state.get("ok") is True, state)
        check(
            "worker localizes errors",
            send("nope").get("error") not in (None, "", "errUnknownRequest"),
        )

        # 2. Fresh install blocks nothing.
        go(url("videos.test"))
        check(
            "fresh install blocks nothing",
            not is_blocked() and "page videos.test" in page.content(),
            href(page),
        )
        check("no rules while off", dynamic_rules() == [])

        # 3. Blocklist through the options UI, then the focus switch.
        opts.fill("#blocklist", "videos.test\n")
        opts.click("#save")
        check(
            "save ok",
            wait_until(lambda: opts.locator("#msg").inner_text() != ""),
            opts.locator("#msg").inner_text(),
        )
        opts.click("#enabled")
        check(
            "focus on", wait_until(lambda: send("getState")["state"]["enabled"] is True)
        )
        check(
            "redirect rule written",
            wait_until(lambda: len(dynamic_rules()) == 1),
            dynamic_rules(),
        )

        target = url("www.videos.test", "/watch?v=1&t=2")
        go(target)
        check("site blocked by the rule", is_blocked(), href(page))
        check(
            "block page shows host",
            wait_until(lambda: page.locator("#host").inner_text() == "www.videos.test"),
            page.locator("#host").inner_text(),
        )
        check(
            "block page reason is focus",
            wait_until(
                lambda: page.locator("#reason-pill").get_attribute("data-state") == "on"
            ),
        )
        go(url("m.videos.test"))
        check("subdomain blocked", is_blocked(), href(page))
        go(url("work.test"))
        check(
            "other site loads",
            not is_blocked() and "page work.test" in page.content(),
            href(page),
        )

        # 4. Turning focus off: the open block page offers the site, and it opens with its full url.
        go(target)
        opts.click("#enabled")
        check(
            "focus off",
            wait_until(lambda: send("getState")["state"]["enabled"] is False),
        )
        check(
            "Open site appears", wait_until(lambda: page.locator("#open").is_visible())
        )
        page.click("#open")
        check(
            "Open site restores the full url (with &)",
            wait_until(lambda: href(page) == target),
            href(page),
        )
        check("rules removed", dynamic_rules() == [])

        # 5. Tabs open before blocking starts are swept (tabs.update, not a rule).
        other = ctx.new_page()
        other.goto(url("videos.test", "/old"))
        send("update", {"patch": {"enabled": True}})
        check(
            "open tab swept on enable",
            wait_until(lambda: is_blocked(other)),
            href(other),
        )
        other.close()
        send("update", {"patch": {"enabled": False}})

        # 6. The popup renders the state.
        popup = ctx.new_page()
        popup.goto(base + "popup.html")
        check(
            "popup shows focus off",
            wait_until(
                lambda: popup.locator("#status").get_attribute("data-state") == "off"
            ),
        )
        popup.close()

        # 7. Lock timer + Pomodoro with the worker stopped: alarms must wake it to update the rules.
        config = {
            "workMin": 1,
            "shortMin": 1,
            "longMin": 1,
            "cycles": 2,
            "useMainRules": False,
            "blocklist": ["shorts.test"],
        }
        res = send("savePomodoro", {"config": config})
        check("pomodoro saved", res.get("ok"), res)
        check("timer started", send("startTimer", {"minutes": 1}).get("ok"))
        check("pomodoro started", send("startPomodoro").get("ok"))
        timer_end = send("getState")["state"]["timerEnd"]
        go(url("videos.test"))
        check(
            "timer blocks",
            is_blocked()
            and wait_until(
                lambda: (
                    page.locator("#reason-pill").get_attribute("data-state") == "locked"
                )
            ),
            href(page),
        )
        go(url("shorts.test"))
        check("pomodoro work blocks", is_blocked(), href(page))
        alarms = worker().evaluate(
            "browser.alarms.getAll().then((a) => a.map((x) => x.name))"
        )
        check("wake alarm set", any(a.startswith("wake:") for a in alarms), alarms)
        check(
            "loosening is refused during the timer",
            send("update", {"patch": {"blocklist": []}}).get("code")
            == "errTimerLocked",
        )
        # Nothing may talk to the worker now: block pages poll it, and so do open settings.
        go(url("work.test"))
        opts.close()
        internals = ctx.new_page()
        internals.goto("chrome://serviceworker-internals/")

        def sleep_until(ms):
            time.sleep(max(0, ms / 1000 - time.time()))

        check("worker stopped", stop_worker(), worker_status())
        sleep_until(timer_end - 2000)
        check(
            "still stopped just before the timer ends",
            worker_status() == "STOPPED",
            worker_status(),
        )
        sleep_until(timer_end + 3000)
        check(
            "an alarm woke a fresh worker at the timer end",
            woken_fresh(),
            worker_status(),
        )
        go(url("videos.test"))
        check(
            "the timer rule was removed before any navigation",
            not is_blocked(),
            href(page),
        )
        go(url("shorts.test"))
        check("pomodoro break opens its sites", not is_blocked(), href(page))

        opts = open_options()
        st = send("getState")["state"]["pomodoroStatus"]
        check("break phase reported", st and st["phase"] == "break", st)
        work_at = st["phaseEnd"]
        opts.close()
        go(url("work.test"))
        check("worker stopped again", stop_worker(), worker_status())
        sleep_until(work_at - 2000)
        check(
            "still stopped just before the phase ends",
            worker_status() == "STOPPED",
            worker_status(),
        )
        sleep_until(work_at + 3000)
        check(
            "an alarm woke a fresh worker at the phase end",
            woken_fresh(),
            worker_status(),
        )
        go(url("shorts.test"))
        check("next work phase blocks again", is_blocked(), href(page))
        internals.close()

        # 8. Password and allowlist.
        opts = open_options()
        check("password set", send("setPassword", {"newPassword": "secret"}).get("ok"))
        check(
            "stop pomodoro needs it",
            send("stopPomodoro").get("code") == "errWrongPassword",
        )
        check(
            "stop pomodoro with it",
            send("stopPomodoro", {"password": "secret"}).get("ok"),
        )
        patch = {"mode": "allowlist", "allowlist": ["work.test"], "enabled": True}
        res = send("update", {"patch": patch, "password": "secret"})
        check("allowlist on", res.get("ok"), res)
        go(url("docs.work.test", "/a"))
        check(
            "allowlisted site loads",
            not is_blocked() and "page docs.work.test" in page.content(),
            href(page),
        )
        go(url("shorts.test"))
        check("everything else blocked", is_blocked(), href(page))
        check(
            "focus off needs the password",
            send("update", {"patch": {"enabled": False}}).get("code")
            == "errWrongPassword",
        )
        check(
            "focus off with password",
            send("update", {"patch": {"enabled": False}, "password": "secret"}).get(
                "ok"
            ),
        )
        check("all rules removed", wait_until(lambda: dynamic_rules() == []))
    finally:
        ctx.close()
        server.shutdown()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
