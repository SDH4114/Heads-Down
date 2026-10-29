// Localized strings from _locales/*/messages.json. Browser global (FG.i18n) and Node module.
// Used by the background (error messages, notifications) and every UI page.
(function (root) {
  let englishFallback = null;

  // Node has no browser.i18n: read the English file so tests see real texts.
  function nodeLookup(key, subs) {
    if (!englishFallback) {
      const fs = require("node:fs");
      const path = require("node:path");
      const file = path.join(__dirname, "..", "_locales", "en", "messages.json");
      englishFallback = JSON.parse(fs.readFileSync(file, "utf8"));
    }
    const entry = englishFallback[key];
    return entry ? entry.message.replace(/\$(\d)/g, (_, i) => subs[i - 1] ?? "") : "";
  }

  // t("errNotDomain", "foo") -> "Not a domain: foo". Falls back to the key, so a missing
  // string is visible instead of silently blank.
  function t(key, ...subs) {
    const strSubs = subs.map(String);
    const api = root.browser && root.browser.i18n;
    if (!api) return nodeLookup(key, strSubs) || key;
    return api.getMessage(key, strSubs) || (key.startsWith("@@") ? "" : key);
  }

  // Fills elements marked with data-i18n (text) and data-i18n-<attr> (attributes).
  function applyI18n(doc) {
    for (const el of doc.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
    for (const attr of ["placeholder", "title", "aria-label"]) {
      const data = "i18n" + attr.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase());
      for (const el of doc.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.dataset[data]));
    }
    const lang = t("@@ui_locale");
    if (lang) doc.documentElement.lang = lang.replace("_", "-");
  }

  const api = { t, applyI18n };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.FG = root.FG || {}).i18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
