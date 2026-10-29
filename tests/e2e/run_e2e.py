"""E2E test of Heads Down in a real Zen browser with a throwaway profile.

Test domains resolve to 127.0.0.1 via network.dns.localDomains, served by a local http.server,
so no real network is used. Takes about 3 minutes, including the 1-minute lock timer and Pomodoro work scenarios.

Usage: uv run --with selenium python tests/e2e/run_e2e.py <extension dir> <geckodriver path> [browser binary]
"""

import http.server
import json
import sys
import threading
import time

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

EXT_DIR = sys.argv[1]
GECKO = sys.argv[2]
ZEN = sys.argv[3] if len(sys.argv) > 3 else "/Applications/Zen.app/Contents/MacOS/zen"
UUID = "0f0c0a11-1111-4111-8111-111111111111"
BASE = f"moz-extension://{UUID}/ui/"
PORT = 8765
DOMAINS = [
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "tiktok.com",
    "example.com",
]

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
        body = f"<html><head><title>{self.headers['Host']}</title></head><body>page {self.headers['Host']}{self.path}</body></html>"
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(body.encode())

    def log_message(self, *args):
        pass


server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Page)
threading.Thread(target=server.serve_forever, daemon=True).start()

opts = Options()
opts.binary_location = ZEN
opts.add_argument("-headless")
opts.set_preference("network.dns.localDomains", ",".join(DOMAINS))
opts.set_preference(
    "extensions.webextensions.uuids", json.dumps({"heads-down@amikolabs.com": UUID})
)
opts.set_preference("browser.sessionstore.resume_from_crash", False)
# Texts are checked in English; pin the UI locale regardless of the machine's language.
opts.set_preference("intl.locale.requested", "en-US")
driver = webdriver.Firefox(
    service=Service(GECKO, service_args=["--allow-system-access"]), options=opts
)
wait = WebDriverWait(driver, 10)


def url(domain, path="/"):
    return f"http://{domain}:{PORT}{path}"


def is_blocked_now():
    return driver.current_url.startswith(BASE + "blocked.html")


def go(target):
    if target.startswith("moz-extension:"):
        # Marionette refuses get() to extension pages; load them from the browser chrome instead.
        with driver.context(driver.CONTEXT_CHROME):
            driver.execute_script(
                "gBrowser.selectedBrowser.fixupAndLoadURIString(arguments[0], {"
                "  triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() })",
                target,
            )
        WebDriverWait(driver, 5).until(lambda d: d.current_url == target)
    else:
        driver.get(target)
    time.sleep(0.4)  # let tabs.onUpdated redirects settle


def wait_blocked(timeout=5):
    try:
        WebDriverWait(driver, timeout).until(lambda d: is_blocked_now())
        return True
    except TimeoutException:
        return False


def el(id_):
    return driver.find_element(By.ID, id_)


def msg():
    return el("msg").text


def status():
    """Popup focus state: "on" | "off" | "locked" (text is localized, data-state is not)."""
    return el("status").get_attribute("data-state")


def options_focus():
    """Options page focus switch state."""
    return el("enabled").is_selected()


def open_options():
    go(BASE + "options.html")
    wait.until(lambda d: el("password-state").text != "")


def set_text(id_, text):
    e = el(id_)
    e.clear()
    e.send_keys(text)


def save():
    el("save").click()
    time.sleep(0.6)


def dialog():
    return WebDriverWait(driver, 3).until(
        lambda d: d.find_element(By.CSS_SELECTOR, "dialog[open]")
    )


def has_dialog():
    return bool(driver.find_elements(By.CSS_SELECTOR, "dialog[open]"))


def dialog_submit(**values):
    """Fills the open dialog's fields by name and submits it."""
    dlg = dialog()
    for name, value in values.items():
        field = dlg.find_element(By.CSS_SELECTOR, f'input[name="{name}"]')
        field.clear()
        field.send_keys(value)
    dlg.find_element(By.CSS_SELECTOR, 'button[type="submit"]').click()
    time.sleep(0.8)


def dialog_error():
    return dialog().find_element(By.CSS_SELECTOR, ".msg.error").text


def dialog_cancel():
    dialog().find_element(By.CSS_SELECTOR, "button.ghost").click()
    time.sleep(0.4)


def set_focus(on, password=None):
    """Options switch; answers the password dialog if one appears."""
    if options_focus() != on:
        el("enabled").click()
        time.sleep(0.6)
        if has_dialog():
            dialog_submit(password=password)


try:
    driver.install_addon(EXT_DIR, temporary=True)
    time.sleep(1)
    # Zen's initial Marionette context is not a real tab (tabs.query skips it, tabId -1), so use a new one.
    driver.switch_to.new_window("tab")
    main = driver.current_window_handle

    # 1. Fresh install: focus off, nothing blocked.
    go(url("youtube.com"))
    check("fresh install blocks nothing", not is_blocked_now(), driver.current_url)

    # 2. Options: one save bar, shown only with unsaved changes; invalid entries are rejected.
    open_options()
    check("options shows focus off", not options_focus())
    check("no save bar without changes", not el("savebar").is_displayed())
    set_text("blocklist", "youtube.com\nnot a domain")
    check("save bar appears on edit", el("savebar").is_displayed())
    save()
    check("invalid domain rejected", "Not a domain" in msg(), msg())
    check(
        "edits kept after an error",
        "not a domain" in el("blocklist").get_attribute("value"),
    )
    el("discard").click()
    check("discard restores saved values", el("blocklist").get_attribute("value") == "")
    check("save bar hidden after discard", not el("savebar").is_displayed())

    # 3. One Save stores the lists and the Pomodoro settings together; the focus switch is instant.
    set_text("blocklist", "https://www.YouTube.com/watch\ntiktok.com")
    set_text("pomo-work", "30")
    save()
    check("save ok", msg() == "Saved.", msg())
    check("save bar hidden after save", not el("savebar").is_displayed())
    check(
        "domains normalized in UI",
        el("blocklist").get_attribute("value") == "youtube.com\ntiktok.com",
        el("blocklist").get_attribute("value"),
    )
    open_options()
    check(
        "pomodoro setting saved by the same Save",
        el("pomo-work").get_attribute("value") == "30",
    )
    set_text("pomo-work", "25")
    save()

    el("enabled").click()
    time.sleep(0.6)
    check("focus switch applies at once", options_focus())
    open_options()
    check("focus switch persisted", options_focus())

    go(url("youtube.com", "/watch?v=1"))
    check("youtube blocked", is_blocked_now(), driver.current_url)
    check("blocked page shows host", el("host").text == "youtube.com", el("host").text)
    check(
        "blocked page keeps original url",
        "watch%3Fv%3D1" in driver.current_url,
        driver.current_url,
    )
    go(url("m.youtube.com"))
    check("subdomain blocked", is_blocked_now())
    go(url("www.youtube.com"))
    check("www blocked", is_blocked_now())
    go(url("example.com"))
    check("other site allowed", not is_blocked_now(), driver.current_url)
    check("other site actually loaded", "page example.com" in driver.page_source)

    # 4. Sweep: a tab opened while focus is off gets blocked when focus turns on.
    open_options()
    set_focus(False)
    check("focus off applied", not options_focus())
    driver.switch_to.new_window("tab")
    other = driver.current_window_handle
    go(url("tiktok.com"))
    check("tiktok allowed while off", not is_blocked_now())
    driver.switch_to.window(main)
    open_options()
    set_focus(True)
    driver.switch_to.window(other)
    check("open tab swept on enable", wait_blocked(), driver.current_url)
    driver.close()
    driver.switch_to.window(main)

    # 5. bfcache: going Back to a page visited while focus was off.
    open_options()
    set_focus(False)
    go(url("youtube.com", "/bf"))
    check("youtube allowed while off", not is_blocked_now())
    go(url("example.com", "/after"))
    driver.switch_to.new_window("tab")
    open_options()
    set_focus(True)
    driver.close()
    driver.switch_to.window(main)
    driver.back()
    check("Back to youtube is blocked (bfcache)", wait_blocked(), driver.current_url)

    # 6. Blocked page "Close tab".
    driver.switch_to.new_window("tab")
    go(url("youtube.com"))
    handles_before = len(driver.window_handles)
    el("close").click()
    time.sleep(0.8)
    check(
        "close tab button closes tab", len(driver.window_handles) == handles_before - 1
    )
    driver.switch_to.window(main)

    # 7. Password: set (twice-typed), then prompted only when loosening.
    open_options()
    check(
        "no change/remove buttons without a password",
        not el("change-password").is_displayed(),
    )
    el("set-password").click()
    dialog_submit(newPassword="secret1", confirm="secret2")
    check(
        "mismatched passwords rejected",
        "do not match" in dialog_error(),
        dialog_error(),
    )
    dialog_submit(newPassword="abc", confirm="abc")
    check("short password rejected", "at least 4" in dialog_error(), dialog_error())
    dialog_submit(newPassword="secret1", confirm="secret1")
    check("password set", msg() == "Password set." and not has_dialog(), msg())
    check(
        "change and remove buttons shown",
        el("change-password").is_displayed() and el("remove-password").is_displayed(),
    )
    check("set button hidden", not el("set-password").is_displayed())

    el("enabled").click()  # turn focus off: asks for the password
    time.sleep(0.6)
    check("turning focus off asks for the password", has_dialog())
    dialog_cancel()
    check("cancel keeps focus on", options_focus())
    el("enabled").click()
    time.sleep(0.6)
    dialog_submit(password="wrong")
    check(
        "wrong password shown in the dialog",
        dialog_error() == "Wrong password.",
        dialog_error(),
    )
    dialog_cancel()
    check("still on after a wrong password", options_focus())

    open_options()
    set_text("blocklist", "youtube.com\ntiktok.com\nexample.com")
    save()
    check(
        "blocking more needs no password", msg() == "Saved." and not has_dialog(), msg()
    )
    go(url("example.com"))
    check("newly added site blocked", is_blocked_now())

    open_options()
    set_text("blocklist", "tiktok.com")
    el("save").click()
    time.sleep(0.6)
    check("unblocking asks for the password", has_dialog())
    dialog_submit(password="secret1")
    check(
        "unblock with right password ok", msg() == "Saved." and not has_dialog(), msg()
    )
    go(url("youtube.com"))
    check("removed site now allowed", not is_blocked_now())

    # Change password: current + new twice.
    open_options()
    el("change-password").click()
    dialog_submit(password="wrong", newPassword="secret9", confirm="secret9")
    check(
        "change with wrong current refused",
        dialog_error() == "Wrong password.",
        dialog_error(),
    )
    dialog_submit(password="secret1", newPassword="secret9", confirm="secret9")
    check("password changed", msg() == "Password changed.", msg())

    # 8. Allowlist mode (needs password).
    open_options()
    driver.find_element(
        By.CSS_SELECTOR, 'input[name="mode"][value="allowlist"]'
    ).click()
    set_text("allowlist", "example.com")
    el("save").click()
    time.sleep(0.6)
    dialog_submit(password="secret9")
    check("switched to allowlist", msg() == "Saved.", msg())
    go(url("example.com"))
    check("allowlist: listed site allowed", not is_blocked_now())
    go(url("youtube.com"))
    check("allowlist: other site blocked", is_blocked_now())
    go("about:blank")
    check("allowlist: about: pages untouched", driver.current_url == "about:blank")

    # Empty allowlist triggers a confirmation.
    open_options()
    set_text("allowlist", "")
    el("save").click()
    alert = WebDriverWait(driver, 3).until(lambda d: d.switch_to.alert)
    check(
        "empty allowlist asks confirmation", "every website" in alert.text, alert.text
    )
    alert.dismiss()

    # Back to blocklist, remove password.
    open_options()
    driver.find_element(
        By.CSS_SELECTOR, 'input[name="mode"][value="blocklist"]'
    ).click()
    set_text("blocklist", "youtube.com")
    el("save").click()
    time.sleep(0.6)
    dialog_submit(password="secret9")
    el("remove-password").click()
    dialog_submit(password="secret1")
    check(
        "remove with old password refused",
        dialog_error() == "Wrong password.",
        dialog_error(),
    )
    dialog_submit(password="secret9")
    check("password removed", msg() == "Password removed.", msg())
    check("set button back", el("set-password").is_displayed())

    # 9. Popup: password dialog appears only when needed.
    go(BASE + "popup.html")
    wait.until(lambda d: el("status").text != "")
    check("popup has no password field", not driver.find_elements(By.ID, "password"))
    wait.until(lambda d: el("status").text != "")
    check("popup shows ON", status() == "on", status())
    el("toggle").click()
    time.sleep(0.5)
    check("popup toggled off", status() == "off", status())
    el("toggle").click()
    time.sleep(0.5)
    check("popup toggled on", status() == "on", status())
    el("add-site").click()
    time.sleep(0.5)
    check("add-site on extension page refused", "no domain" in msg(), msg())

    # 9a. Popup password dialog: only when turning focus off with a password set.
    open_options()
    el("set-password").click()
    dialog_submit(newPassword="pw1234", confirm="pw1234")
    go(BASE + "popup.html")
    wait.until(lambda d: el("status").text != "")
    el("toggle").click()
    time.sleep(0.6)
    check("popup asks for the password to turn off", has_dialog() and status() == "on")
    dialog_submit(password="pw1234")
    check(
        "popup turned off with the password",
        status() == "off" and not has_dialog(),
        status(),
    )
    el("toggle").click()
    time.sleep(0.6)
    check(
        "popup turns on without a password",
        status() == "on" and not has_dialog(),
        status(),
    )
    open_options()
    el("remove-password").click()
    dialog_submit(password="pw1234")
    go(BASE + "popup.html")
    wait.until(lambda d: el("status").text != "")

    # 9b. An open options page follows changes made elsewhere, and its Save never undoes them.
    popup_tab = driver.current_window_handle
    driver.switch_to.new_window("tab")
    opt_tab = driver.current_window_handle
    open_options()
    check("options shows focus on", el("enabled").is_selected())
    driver.switch_to.window(popup_tab)
    el("toggle").click()  # focus off from the popup
    time.sleep(0.5)
    driver.switch_to.window(opt_tab)
    time.sleep(0.5)
    check("options refills an untouched field", not el("enabled").is_selected())
    set_text("allowlist", "example.org")
    save()
    check("save after an outside change keeps it", not options_focus())
    driver.close()
    driver.switch_to.window(popup_tab)
    go(BASE + "popup.html")
    wait.until(lambda d: el("status").text != "")
    el("toggle").click()
    time.sleep(0.5)
    check("popup toggled on again", status() == "on", status())

    # 10. Lock timer started while focus is OFF (the reported bug: sites stayed blocked after it).
    el("toggle").click()
    time.sleep(0.5)
    check("focus off before timer", status() == "off", status())
    set_text("minutes", "1")
    el("start-timer").click()
    time.sleep(0.3)
    check(
        "popup timer asks for a second click",
        "Click again" in el("start-timer").text,
        el("start-timer").text,
    )
    check("first click starts nothing", not el("timer-line").is_displayed())
    el("start-timer").click()
    time.sleep(0.8)
    check("popup shows locked state", status() == "locked", status())
    check("timer line shown in popup", el("timer-line").is_displayed())
    check("toggle disabled during timer", not el("toggle").is_enabled())
    check("add-site still enabled in blocklist mode", el("add-site").is_enabled())

    open_options()
    check(
        "options locked during timer",
        not el("enabled").is_enabled() and not el("blocklist").is_enabled(),
    )
    check("timer extend still possible", el("start-timer").is_enabled())
    check("pomodoro settings stay editable during timer", el("pomo-work").is_enabled())
    res = driver.execute_async_script(
        "const done = arguments[0];"
        "browser.runtime.sendMessage({type:'update', patch:{blocklist:[]}}).then(done);"
    )
    check(
        "background refuses unblocking during timer (bypassing UI)",
        res["ok"] is False and "Timer" in res["error"],
        res,
    )
    res = driver.execute_async_script(
        "const done = arguments[0];"
        "browser.runtime.sendMessage({type:'startTimer', minutes: 0.5}).then(done);"
    )
    check("timer cannot be shortened", res["ok"] is False, res)

    # Keep a blocked tab open to see it offer the site again when the timer ends.
    driver.switch_to.new_window("tab")
    timer_tab = driver.current_window_handle
    go(url("youtube.com", "/later"))
    check("blocked during timer", is_blocked_now())
    check(
        "blocked page names the timer",
        "lock timer" in el("reason").text,
        el("reason").text,
    )
    check(
        "blocked page shows countdown",
        el("timer-line").is_displayed() and ":" in el("timer").text,
        el("timer").text,
    )
    check("no open button while blocked", not el("open").is_displayed())

    print("waiting for the 1-minute timer to end...", flush=True)
    driver.switch_to.window(main)
    open_options()
    WebDriverWait(driver, 75).until(lambda d: el("blocklist").is_enabled())
    check("options unlock after timer", el("blocklist").is_enabled())
    check("focus back to off after timer", not options_focus())
    go(url("youtube.com"))
    check(
        "sites open again after timer (bug fix)",
        not is_blocked_now(),
        driver.current_url,
    )

    driver.switch_to.window(timer_tab)
    try:
        WebDriverWait(driver, 8).until(lambda d: el("open").is_displayed())
    except TimeoutException:
        pass
    check(
        "blocked tab offers the site after timer",
        el("open").is_displayed(),
        el("title").text,
    )
    el("open").click()
    time.sleep(0.8)
    check(
        "open site loads the original url",
        driver.current_url == url("youtube.com", "/later"),
        driver.current_url,
    )
    driver.close()
    driver.switch_to.window(main)

    # 11. Timer length is remembered (the reported bug: it reset to 50).
    open_options()
    check(
        "options shows last timer length",
        el("minutes").get_attribute("value") == "1",
        el("minutes").get_attribute("value"),
    )
    set_text("minutes", "7")
    el("pomo-work").click()  # blur fires the change event
    time.sleep(0.5)
    open_options()
    check(
        "typed timer length survives reload",
        el("minutes").get_attribute("value") == "7",
        el("minutes").get_attribute("value"),
    )
    go(BASE + "popup.html")
    wait.until(lambda d: el("status").text != "")
    check(
        "popup shows saved timer length",
        el("minutes").get_attribute("value") == "7",
        el("minutes").get_attribute("value"),
    )

    # 12. Pomodoro with 1-minute phases and its own list.
    open_options()
    set_text("pomo-work", "1")
    set_text("pomo-short", "1")
    set_text("pomo-long", "1")
    set_text("pomo-cycles", "2")
    driver.find_element(
        By.CSS_SELECTOR, 'input[name="pomo-rules"][value="custom"]'
    ).click()
    set_text("pomo-blocklist", "")
    el("pomo-start").click()
    time.sleep(0.5)
    check("pomodoro refuses empty list", "Add sites" in msg(), msg())
    set_text("pomo-blocklist", "tiktok.com")
    el("pomo-start").click()
    time.sleep(0.8)
    check("pomodoro started", msg() == "Pomodoro started.", msg())
    check(
        "pomodoro status shows work",
        "Work 1/2" in el("pomo-phase").text,
        el("pomo-phase").text,
    )
    check(
        "stop button shown",
        el("pomo-stop").is_displayed() and not el("pomo-start").is_displayed(),
    )

    driver.switch_to.new_window("tab")
    pomo_tab = driver.current_window_handle
    go(url("tiktok.com", "/pomo"))
    check("pomodoro blocks its list during work", is_blocked_now())
    check(
        "blocked page names pomodoro",
        "Pomodoro" in el("reason").text,
        el("reason").text,
    )
    check(
        "blocked page counts down to the break",
        "Break in" in el("timer-label").text,
        el("timer-label").text,
    )
    go(url("youtube.com"))
    check("sites outside the pomodoro list stay open", not is_blocked_now())
    go(url("tiktok.com", "/pomo"))

    print("waiting for the 1-minute work phase to end...", flush=True)
    try:
        WebDriverWait(driver, 75).until(lambda d: el("open").is_displayed())
    except TimeoutException:
        pass
    check(
        "break: blocked tab offers the site",
        el("open").is_displayed(),
        el("title").text,
    )
    go(url("tiktok.com", "/break"))
    check("break: pomodoro list is open", not is_blocked_now(), driver.current_url)
    driver.close()
    driver.switch_to.window(main)

    go(BASE + "popup.html")
    wait.until(lambda d: el("status").text != "")
    check(
        "popup shows break phase",
        "Break 1/2" in el("pomo-line").text,
        el("pomo-line").text,
    )
    el("pomo-stop").click()
    time.sleep(0.5)
    check("popup stops pomodoro", el("pomo-start").is_displayed(), el("pomo-line").text)
finally:
    driver.quit()
    server.shutdown()

failed = [n for n, ok in results if not ok]
print(f"\n{len(results) - len(failed)}/{len(results)} passed")
sys.exit(1 if failed else 0)
