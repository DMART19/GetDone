import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { ControlPlaneError } from "@/lib/control-plane/errors";

export type ProviderHostnameResolver = (hostname: string) => Promise<readonly string[]>;

const forbiddenHostnames = new Set([
  "localhost",
  "localhost.",
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal"
]);

function ipv4Parts(address: string) {
  const parts = address.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
}

export function isForbiddenProviderAddress(address: string) {
  const normalized = address.toLowerCase().split("%", 1)[0];
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  if (mapped) return isForbiddenProviderAddress(mapped[1]);

  if (isIP(normalized) === 4) {
    const parts = ipv4Parts(normalized)!;
    const [a, b] = parts;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || a >= 224
    );
  }

  if (isIP(normalized) === 6) {
    return (
      normalized === "::"
      || normalized === "::1"
      || normalized.startsWith("fc")
      || normalized.startsWith("fd")
      || /^fe[89ab]/.test(normalized)
    );
  }

  return true;
}

export function assertSafeConfiguredProviderUrl(
  value: string,
  label: string,
  options: { allowInsecureLoopbackDevelopment?: boolean } = {}
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must be a valid URL`);
  }
  if (url.username || url.password || url.hash) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} cannot contain credentials or fragments`);
  }

  const hostname = url.hostname.toLowerCase();
  const insecureLoopback = options.allowInsecureLoopbackDevelopment === true
    && url.protocol === "http:"
    && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(hostname);
  if (url.protocol !== "https:" && !insecureLoopback) {
    throw new ControlPlaneError("VALIDATION_FAILED", `${label} must use HTTPS`);
  }
  if (!insecureLoopback) {
    if (
      forbiddenHostnames.has(hostname)
      || hostname.endsWith(".localhost")
      || hostname.endsWith(".local")
    ) {
      throw new ControlPlaneError("VALIDATION_FAILED", `${label} targets a forbidden local/metadata host`);
    }
    if (isIP(hostname) && isForbiddenProviderAddress(hostname)) {
      throw new ControlPlaneError("VALIDATION_FAILED", `${label} targets a private or reserved address`);
    }
  }
  return url;
}

export const systemProviderHostnameResolver: ProviderHostnameResolver = async (hostname) => {
  if (isIP(hostname)) return [hostname];
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  return addresses.map((entry) => entry.address);
};

export async function assertPublicProviderResolution(
  url: URL,
  resolver: ProviderHostnameResolver
) {
  let addresses: readonly string[];
  try {
    addresses = await resolver(url.hostname);
  } catch {
    throw new ControlPlaneError("UNAVAILABLE", "Provider hostname resolution failed");
  }
  if (addresses.length === 0) {
    throw new ControlPlaneError("UNAVAILABLE", "Provider hostname resolved to no addresses");
  }
  if (addresses.some(isForbiddenProviderAddress)) {
    throw new ControlPlaneError(
      "POLICY_BLOCKED",
      "Provider hostname resolved to a private, loopback, link-local, or reserved address"
    );
  }
}

export async function guardedProviderFetch(input: {
  url: string | URL;
  expectedOrigin: string;
  fetchImpl: typeof fetch;
  init: RequestInit;
  resolver?: ProviderHostnameResolver;
  allowInsecureLoopbackDevelopment?: boolean;
}) {
  const url = assertSafeConfiguredProviderUrl(String(input.url), "Provider request URL", {
    allowInsecureLoopbackDevelopment: input.allowInsecureLoopbackDevelopment
  });
  if (url.origin !== input.expectedOrigin) {
    throw new ControlPlaneError("POLICY_BLOCKED", "Provider request attempted to change configured origin");
  }
  if (input.resolver && !(input.allowInsecureLoopbackDevelopment && url.protocol === "http:")) {
    await assertPublicProviderResolution(url, input.resolver);
  }

  const response = await input.fetchImpl(url, {
    ...input.init,
    redirect: "manual"
  });
  if (response.status >= 300 && response.status < 400) {
    try { await response.body?.cancel(); } catch {}
    throw new ControlPlaneError("POLICY_BLOCKED", "Provider redirects are forbidden");
  }
  return response;
}
