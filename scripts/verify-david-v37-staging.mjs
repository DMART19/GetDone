#!/usr/bin/env node
/**
 * Read-only GetDone David Edition staging smoke gate.
 * No credentials, no cookies, no mutations, no production URL.
 * Run: node scripts/verify-david-v37-staging.mjs https://getdone-web-staging.onrender.com
 */
const input = process.argv[2] || process.env.GETDONE_STAGING_URL;
if (!input) {
  console.error("Provide the explicit staging URL as the first argument or GETDONE_STAGING_URL.");
  process.exit(2);
}
let origin;
try {
  const url = new URL(input);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("URL must be an HTTPS origin without credentials, path, query or fragment");
  }
  if (url.hostname !== "getdone-web-staging.onrender.com" && !url.hostname.endsWith(".staging.getdone.example")) {
    throw new Error("Refusing to contact a non-allowlisted staging host");
  }
  origin = url.origin;
} catch (error) {
  console.error("Invalid staging URL:", error.message);
  process.exit(2);
}

const checks = [];
async function check(path, expected, name) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(new URL(path, origin), {
      method: "GET",
      redirect: "manual",
      cache: "no-store",
      headers: { "Accept": path === "/api/health" ? "application/json" : "text/html" },
      signal: controller.signal
    });
    const status = response.status;
    const ok = expected(status, response);
    checks.push({ name, status, ok, location: response.headers.get("location") || undefined });
    if (path === "/api/health" && status === 200) {
      try {
        const body = await response.json();
        // These fields are reported by the endpoint; they are NOT an authenticated runtime proof.
        checks.at(-1).health = body;
      } catch {
        checks.at(-1).ok = false;
        checks.at(-1).error = "Health response is not valid JSON";
      }
    } else {
      await response.body?.cancel();
    }
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  } finally {
    clearTimeout(timeout);
  }
}

// GET only. A 3xx to sign-in or a 401/403 is acceptable for protected pages.
// A 200 for protected pages is suspicious without a session and fails the gate.
await check("/api/health", status => status === 200, "public health endpoint");
for (const path of ["/decisions", "/resources"]) {
  await check(path, (status, response) => {
    if (status === 401 || status === 403) return true;
    if (status >= 300 && status < 400) {
      const location = response.headers.get("location") || "";
      return location.startsWith("/sign-in") || (() => {
        try { return new URL(location, origin).pathname === "/sign-in"; } catch { return false; }
      })();
    }
    return false;
  }, `anonymous access denied: ${path}`);
}
for (const item of checks) {
  console.log(JSON.stringify(item));
}
const failed = checks.filter(item => !item.ok);
console.log(`Read-only staging gate: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) {
  console.error("This is a smoke gate only. Do not promote; investigate the failed checks.");
  process.exitCode = 1;
}
