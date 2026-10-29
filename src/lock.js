// Password hashing and timer checks. Browser global (FG.lock) and Node module for tests.
(function (root) {
  // Stored next to each hash, so raising this later does not break existing passwords.
  const ITERATIONS = 200000;

  const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
  const fromHex = (hex) => new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));

  async function hashPassword(password, saltHex, iterations = ITERATIONS) {
    const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
      "deriveBits",
    ]);
    const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
    return { hash: toHex(bits), salt: toHex(salt), iterations };
  }

  async function verifyPassword(password, hash, saltHex, iterations = ITERATIONS) {
    if (typeof password !== "string" || !hash || !saltHex) return false;
    const result = await hashPassword(password, saltHex, iterations);
    return result.hash === hash;
  }

  function timerActive(timerEnd, now) {
    return typeof timerEnd === "number" && timerEnd > now;
  }

  const api = { ITERATIONS, hashPassword, verifyPassword, timerActive };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else (root.FG = root.FG || {}).lock = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
