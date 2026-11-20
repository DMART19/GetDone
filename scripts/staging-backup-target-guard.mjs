// Read-only, deterministic identity checks before ANY dump or restore tool is started.
// Never log URLs or passwords; they stay in the private staging environment.
export const STAGING_PROJECT_ID = "ddxjiszbsmmbqxuoecmg";
const POOLER_HOST = "aws-1-ca-central-1.pooler.supabase.com";

function parseUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(label + " must be a PostgreSQL URL"); }
  if (!["postgres:","postgresql:"].includes(url.protocol)
    || !url.username || !url.password || !url.pathname.slice(1)) {
    throw new Error(label + " must contain authenticated PostgreSQL connection details");
  }
  return url;
}

export function assertStagingBackupSource(value, env = process.env) {
  if (env.GETDONE_RUNTIME_ENV !== "staging") {
    throw new Error("Backup commands require GETDONE_RUNTIME_ENV=staging");
  }
  const url = parseUrl(value, "DATABASE_URL");
  const fixture = env.GETDONE_ALLOW_ISOLATED_RESTORE_TEST === "true"
    && ["localhost","127.0.0.1"].includes(url.hostname)
    && /^getdone_backup_source_[A-Za-z0-9_]+$/.test(decodeURIComponent(url.pathname.slice(1)));
  const direct = url.hostname === "db." + STAGING_PROJECT_ID + ".supabase.co"
    && decodeURIComponent(url.username) === "postgres";
  const pooler = url.hostname === POOLER_HOST
    && decodeURIComponent(url.username) === "postgres." + STAGING_PROJECT_ID
    && (!url.port || url.port === "5432");
  if (!fixture && !direct && !pooler) {
    throw new Error("DATABASE_URL is not the approved GetDone staging project");
  }
  if (!fixture &&
    (env.GETDONE_DB_SSL !== "true" || env.PGSSLMODE !== "verify-full"
      || !env.PGSSLROOTCERT?.trim())) {
    throw new Error("Staging backup requires CA-verified PostgreSQL TLS");
  }
  if (url.searchParams.get("sslmode") === "disable"
      || url.searchParams.get("sslmode") === "no-verify") {
    throw new Error("Staging backup cannot disable TLS verification");
  }
  return Object.freeze({ fixture });
}

export function assertIsolatedRestoreAdmin(value, sourceValue) {
  const admin = parseUrl(value, "GETDONE_RESTORE_ADMIN_DATABASE_URL");
  if (!["localhost","127.0.0.1"].includes(admin.hostname)) {
    throw new Error("Restore admin must use a separate local disposable PostgreSQL cluster");
  }
  if (sourceValue) {
    const source = parseUrl(sourceValue, "DATABASE_URL");
    if (source.hostname === admin.hostname && source.port === admin.port
      && source.pathname === admin.pathname) {
      throw new Error("Restore admin database must differ from backup source");
    }
  }
  return Object.freeze({ isolated: true });
}
