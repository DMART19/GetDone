import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const integrationDescribe = enabled ? describe.sequential : describe.skip;
const baseConnectionString = process.env.DATABASE_URL?.trim() ?? "";
const ssl = process.env.GETDONE_DB_SSL === "false"
  ? false
  : { rejectUnauthorized: true };

function quoteIdentifier(value: string) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function databaseUrl(name: string) {
  const url = new URL(baseConnectionString);
  url.pathname = `/${name}`;
  return url.toString();
}

function runMigrations(connectionString: string) {
  const result = spawnSync(process.execPath, ["scripts/migrate-postgres.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false"
    },
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(
      `Migration failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`
    );
  }
}

function runBootstrap(
  connectionString: string,
  publicKeyPemB64: string,
  overrides: Record<string, string> = {}
) {
  return spawnSync(process.execPath, ["scripts/bootstrap-production.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATABASE_URL: connectionString,
      GETDONE_DB_SSL: process.env.GETDONE_DB_SSL ?? "false",
      GETDONE_RUNTIME_ENV: "production",
      GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime",
      GETDONE_OWNER_USER_ID: "owner-prod",
      GETDONE_OWNER_ORGANIZATION_ID: "org-prod",
      GETDONE_OWNER_ORGANIZATION_NAME: "GetDone Production",
      GETDONE_OWNER_COMPANY_ID: "company-prod",
      GETDONE_OWNER_COMPANY_NAME: "GetDone",
      GETDONE_OWNER_PORTFOLIO_ID: "portfolio-prod",
      GETDONE_OWNER_PORTFOLIO_NAME: "Owner Portfolio",
      GETDONE_OWNER_PASSKEY_CREDENTIAL_ID: "credential-prod",
      GETDONE_OWNER_PASSKEY_PUBLIC_KEY_PEM_B64: publicKeyPemB64,
      GETDONE_OWNER_PASSKEY_ALGORITHM: "ES256",
      GETDONE_OWNER_PASSKEY_USER_HANDLE: "owner-prod-handle",
      ...overrides
    },
    encoding: "utf8"
  });
}

integrationDescribe("production bootstrap command", () => {
  const databaseName = `getdone_bootstrap_${process.pid}_${Date.now()}`;
  let adminPool: Pool;
  let pool: Pool;
  let connectionString: string;
  let publicKeyPemB64: string;

  beforeAll(async () => {
    if (!baseConnectionString) throw new Error("DATABASE_URL is required");

    const { publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    publicKeyPemB64 = Buffer.from(publicKey).toString("base64");

    adminPool = new Pool({
      connectionString: baseConnectionString,
      max: 2,
      application_name: "getdone-bootstrap-admin",
      ssl
    });
    await adminPool.query(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
    );
    await adminPool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    connectionString = databaseUrl(databaseName);
    runMigrations(connectionString);
    pool = new Pool({
      connectionString,
      max: 2,
      application_name: "getdone-bootstrap-test",
      ssl
    });
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (adminPool) {
      await adminPool.query(
        `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`
      );
      await adminPool.end();
    }
  });

  it("provisions the production owner, scopes, passkey, policy configuration, and audit evidence atomically", async () => {
    const run = runBootstrap(connectionString, publicKeyPemB64);
    expect(run.status, run.stderr).toBe(0);
    const output = JSON.parse(run.stdout);
    expect(output).toMatchObject({
      status: "ready",
      bootstrapVersion: "1.0.0",
      environment: "production",
      owner: {
        userId: "owner-prod",
        organizationId: "org-prod",
        companyId: "company-prod",
        portfolioId: "portfolio-prod",
        credentialId: "credential-prod"
      },
      policy: {
        registryId: "getdone-core-policy",
        enforcement: "enforce"
      }
    });
    expect(Object.values(output.created).every((value) => value === true)).toBe(true);

    const memberships = await pool.query(
      `SELECT
         (SELECT role FROM organization_memberships
          WHERE user_id='owner-prod' AND organization_id='org-prod') AS organization_role,
         (SELECT role FROM company_memberships
          WHERE user_id='owner-prod' AND company_id='company-prod') AS company_role,
         (SELECT role FROM portfolio_memberships
          WHERE user_id='owner-prod' AND portfolio_id='portfolio-prod'
            AND company_id='company-prod') AS portfolio_role`
    );
    expect(memberships.rows[0]).toEqual({
      organization_role: "owner",
      company_role: "owner",
      portfolio_role: "owner"
    });

    const passkey = await pool.query<{
      user_id: string;
      sign_count: string;
      revoked_at: Date | null;
    }>(
      `SELECT user_id,sign_count,revoked_at
       FROM auth_webauthn_credentials
       WHERE credential_id='credential-prod'`
    );
    expect(passkey.rows[0]).toMatchObject({
      user_id: "owner-prod",
      sign_count: "0",
      revoked_at: null
    });

    const policy = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type='policy-configuration'`
    );
    expect(policy.rows).toHaveLength(1);
    expect(policy.rows[0].payload).toMatchObject({
      portfolioId: "portfolio-prod",
      companyId: "company-prod",
      environment: "production",
      state: "active",
      registryId: "getdone-core-policy",
      enforcement: "enforce"
    });

    const audit = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM audit_events
       WHERE correlation_id LIKE 'production-bootstrap:%'`
    );
    expect(Number(audit.rows[0].count)).toBe(1);

    const sessions = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_sessions"
    );
    expect(Number(sessions.rows[0].count)).toBe(0);
  });

  it("is idempotent and preserves an advanced passkey signature counter on rerun", async () => {
    await pool.query(
      "UPDATE auth_webauthn_credentials SET sign_count=42 WHERE credential_id='credential-prod'"
    );

    const run = runBootstrap(connectionString, publicKeyPemB64);
    expect(run.status, run.stderr).toBe(0);
    const output = JSON.parse(run.stdout);
    expect(Object.values(output.created).every((value) => value === false)).toBe(true);

    const credential = await pool.query<{ sign_count: string }>(
      "SELECT sign_count FROM auth_webauthn_credentials WHERE credential_id='credential-prod'"
    );
    expect(credential.rows[0].sign_count).toBe("42");

    const counts = await pool.query<{
      users: string;
      organizations: string;
      companies: string;
      portfolios: string;
      credentials: string;
      policies: string;
      audits: string;
    }>(
      `SELECT
        (SELECT count(*) FROM auth_users)::text AS users,
        (SELECT count(*) FROM organizations)::text AS organizations,
        (SELECT count(*) FROM companies)::text AS companies,
        (SELECT count(*) FROM portfolios)::text AS portfolios,
        (SELECT count(*) FROM auth_webauthn_credentials)::text AS credentials,
        (SELECT count(*) FROM control_plane_entities
          WHERE entity_type='policy-configuration')::text AS policies,
        (SELECT count(*) FROM audit_events
          WHERE correlation_id LIKE 'production-bootstrap:%')::text AS audits`
    );
    expect(counts.rows[0]).toEqual({
      users: "1",
      organizations: "1",
      companies: "1",
      portfolios: "1",
      credentials: "1",
      policies: "1",
      audits: "1"
    });
  });

  it("fails safely on conflicting existing tenant identity instead of rebinding it", async () => {
    await pool.query(
      "UPDATE companies SET organization_id='other-org' WHERE id='company-prod'"
    );

    const beforePolicy = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type='policy-configuration'`
    );
    const run = runBootstrap(connectionString, publicKeyPemB64);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/Owner company conflicts/);

    const company = await pool.query<{ organization_id: string }>(
      "SELECT organization_id FROM companies WHERE id='company-prod'"
    );
    expect(company.rows[0].organization_id).toBe("other-org");

    const afterPolicy = await pool.query<{ payload: unknown }>(
      `SELECT payload FROM control_plane_entities
       WHERE entity_type='policy-configuration'`
    );
    expect(afterPolicy.rows).toEqual(beforePolicy.rows);

    await pool.query(
      "UPDATE companies SET organization_id='org-prod' WHERE id='company-prod'"
    );
  });

  it("rejects non-production execution before touching persistence", async () => {
    const before = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_users"
    );
    const run = runBootstrap(connectionString, publicKeyPemB64, {
      GETDONE_RUNTIME_ENV: "staging",
      GETDONE_OWNER_USER_ID: "should-not-exist"
    });
    expect(run.status).not.toBe(0);
    expect(run.stderr).toMatch(/requires GETDONE_RUNTIME_ENV=production/);

    const after = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM auth_users"
    );
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });
});
