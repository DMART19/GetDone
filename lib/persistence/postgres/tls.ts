/** pg connection-string SSL options override Pool.ssl. Normalize them before use. */
export function postgresTlsConnection(connectionString: string, env: Readonly<Record<string, string | undefined>>) {
  const production = env.GETDONE_RUNTIME_ENV === "production" || env.NODE_ENV === "production";
  // Preserve pg's normal environment/default connection behavior outside production.
  if (!connectionString && !production) return { connectionString, ssl: env.GETDONE_DB_SSL === "false" ? false as const : { rejectUnauthorized: true as const } };
  const url = new URL(connectionString);
  const disabled = env.GETDONE_DB_SSL === "false" || url.searchParams.get("sslmode") === "disable";
  if (production && (disabled || url.searchParams.get("sslmode") === "no-verify")) {
    throw new Error("Production PostgreSQL requires certificate-verified TLS");
  }
  for (const name of ["ssl", "sslmode", "sslcert", "sslkey", "sslrootcert", "uselibpqcompat"]) url.searchParams.delete(name);
  return { connectionString: url.toString(), ssl: disabled ? false as const : { rejectUnauthorized: true as const } };
}
