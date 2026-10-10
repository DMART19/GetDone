const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function parseOrigins(value: string | undefined) {
  if (!value?.trim()) return [] as string[];
  const raw = value.trim();
  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return [...new Set(parsed.map((item) => item.trim()).filter(Boolean))];
      }
    } catch {}
    return [];
  }
  return [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
}

function cookiePresent(header: string | null, name: string) {
  if (!header) return false;
  return header.split(";").some((part) => part.trim().startsWith(name + "="));
}

export interface BrowserMutationOriginResult {
  allowed: boolean;
  reason?: "cross-site" | "missing-origin" | "untrusted-origin";
}

/**
 * Browser control-plane mutations are protected by exact Origin allowlisting.
 * Bearer-only clients are not CSRF-capable because the credential is not ambient.
 * Sign-in mutations are origin-checked even before a cookie exists to prevent login CSRF.
 */
export function evaluateBrowserMutationOrigin(
  request: Pick<Request, "method" | "url" | "headers">,
  env: Readonly<Record<string, string | undefined>> = process.env
): BrowserMutationOriginResult {
  const method = request.method.toUpperCase();
  if (!UNSAFE_METHODS.has(method)) return { allowed: true };

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/control/")) return { allowed: true };

  const cookieName = env.GETDONE_AUTH_COOKIE_NAME?.trim() || "getdone_session";
  const hasCookie = cookiePresent(request.headers.get("cookie"), cookieName);
  const hasBearer = /^Bearer\s+\S+/i.test(request.headers.get("authorization") ?? "");
  const signInMutation = url.pathname.startsWith("/api/control/auth/sign-in/")
    || url.pathname.startsWith("/api/control/auth/enrollment/");

  if (hasBearer && !hasCookie && !signInMutation) {
    return { allowed: true };
  }

  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") {
    return { allowed: false, reason: "cross-site" };
  }

  const runtime = env.GETDONE_RUNTIME_ENV?.trim();
  const configured = parseOrigins(env.GETDONE_WEBAUTHN_ORIGINS);
  const trustedOrigins = configured.length > 0
    ? configured
    : runtime === "development"
      ? [url.origin]
      : [];

  const origin = request.headers.get("origin");
  if (!origin) return { allowed: false, reason: "missing-origin" };
  if (!trustedOrigins.includes(origin)) {
    return { allowed: false, reason: "untrusted-origin" };
  }
  return { allowed: true };
}
