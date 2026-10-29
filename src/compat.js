// Chrome and Edge before 148 expose the extension API only as `chrome`. In Manifest V3 it returns
// promises like Firefox's `browser`, so an alias is enough. No-op in Firefox and newer Chromium.
if (typeof globalThis.browser === "undefined" && typeof globalThis.chrome !== "undefined" && globalThis.chrome.runtime) {
  globalThis.browser = globalThis.chrome;
}
