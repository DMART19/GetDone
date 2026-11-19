import { readFileSync } from "node:fs";

type TlsEnvironment = Readonly<Record<string, string | undefined>>;
type VerifiedTls = { readonly rejectUnauthorized: true; readonly ca?: string };

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/;

/**
 * Loads the trust anchor named by PGSSLROOTCERT. A configured path that cannot be used is a
 * hard failure: silently falling back to the default trust store would hide a misconfiguration
 * and break the connection later with an opaque certificate-chain error. Messages never include
 * the connection string or certificate contents.
 */
function readRootCertificate(env: TlsEnvironment): string | undefined {
  const certificatePath = env.PGSSLROOTCERT?.trim();
  if (!certificatePath) return undefined;
  let pem: string;
  try {
    pem = readFileSync(certificatePath, "utf8");
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    throw new Error(`PGSSLROOTCERT must reference a readable PEM certificate file (${typeof code === "string" ? code : "unreadable"})`);
  }
  if (!PEM_CERTIFICATE.test(pem)) {
    throw new Error("PGSSLROOTCERT must contain at least one PEM-encoded certificate");
  }
  return pem;
}

/** Certificate-verified TLS options. `ca` replaces Node's default trust store when PGSSLROOTCERT is set. */
function verifiedTls(env: TlsEnvironment): VerifiedTls {
  const ca = readRootCertificate(env);
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

/** pg connection-string SSL options override Pool.ssl. Normalize them before use. */
export function postgresTlsConnection(connectionString: string, env: TlsEnvironment) {
  const verifiedRuntime = env.GETDONE_RUNTIME_ENV === "production"
    || env.GETDONE_RUNTIME_ENV === "staging"
    || env.NODE_ENV === "production";
  // Local development may explicitly opt out of TLS; staging and production may not.
  if (!connectionString && !verifiedRuntime) return { connectionString, ssl: env.GETDONE_DB_SSL === "false" ? false as const : verifiedTls(env) };
  const url = new URL(connectionString);
  const disabled = env.GETDONE_DB_SSL === "false" || url.searchParams.get("sslmode") === "disable";
  if (verifiedRuntime && (disabled || url.searchParams.get("sslmode") === "no-verify")) {
    throw new Error("Staging and production PostgreSQL require certificate-verified TLS");
  }
  // The trust anchor comes only from the operator-controlled environment, never from the URL.
  for (const name of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(name);
  return { connectionString: url.toString(), ssl: disabled ? false as const : verifiedTls(env) };
}
