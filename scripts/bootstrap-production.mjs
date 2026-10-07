import crypto from "node:crypto";
import fs from "node:fs";
import pg from "pg";
import { postgresTlsConnection } from "../lib/persistence/postgres/tls.ts";

const BOOTSTRAP_VERSION = "1.0.0";
const POLICY_REGISTRY_ID = "getdone-core-policy";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeRole(value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(value)) {
    throw new Error("GETDONE_DB_RUNTIME_ROLE must be a safe PostgreSQL role identifier");
  }
  return value;
}

function quoteIdentifier(value) {
  return '"' + value.replaceAll('"', '""') + '"';
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical(value[key])])
    );
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

const runtimeEnvironment = required("GETDONE_RUNTIME_ENV");
if (runtimeEnvironment !== "production") {
  throw new Error("production:bootstrap requires GETDONE_RUNTIME_ENV=production");
}

const registry = JSON.parse(
  fs.readFileSync(new URL("../release/version-registry.json", import.meta.url), "utf8")
);

const requiredMigration = registry.database?.migrationVersion;
const policyVersion = registry.policy?.registryVersion;
const policyEngineVersion = registry.policy?.engineVersion;
if (!requiredMigration || !policyVersion || !policyEngineVersion) {
  throw new Error("Release registry is missing database/policy bootstrap truth");
}

const connectionString = required("DATABASE_URL");
const runtimeRole = safeRole(
  process.env.GETDONE_DB_RUNTIME_ROLE?.trim() || "getdone_tenant_runtime"
);
const userId = required("GETDONE_OWNER_USER_ID");
const organizationId = required("GETDONE_OWNER_ORGANIZATION_ID");
const portfolioId = required("GETDONE_OWNER_PORTFOLIO_ID");
const companyId = required("GETDONE_OWNER_COMPANY_ID");
const credentialId = required("GETDONE_OWNER_PASSKEY_CREDENTIAL_ID");
const organizationName = process.env.GETDONE_OWNER_ORGANIZATION_NAME?.trim() || organizationId;
const companyName = process.env.GETDONE_OWNER_COMPANY_NAME?.trim() || companyId;
const portfolioName = process.env.GETDONE_OWNER_PORTFOLIO_NAME?.trim() || portfolioId;
const userHandle = process.env.GETDONE_OWNER_PASSKEY_USER_HANDLE?.trim() || null;
const passkeyAlgorithm = process.env.GETDONE_OWNER_PASSKEY_ALGORITHM?.trim() || "ES256";
if (passkeyAlgorithm !== "ES256" && passkeyAlgorithm !== "RS256") {
  throw new Error("GETDONE_OWNER_PASSKEY_ALGORITHM must be ES256 or RS256");
}

const publicKeyPem = Buffer.from(
  required("GETDONE_OWNER_PASSKEY_PUBLIC_KEY_PEM_B64"),
  "base64"
).toString("utf8");
let parsedPublicKey;
try {
  parsedPublicKey = crypto.createPublicKey(publicKeyPem);
} catch {
  throw new Error("GETDONE_OWNER_PASSKEY_PUBLIC_KEY_PEM_B64 must decode to a valid public key");
}
if (
  (passkeyAlgorithm === "ES256" && parsedPublicKey.asymmetricKeyType !== "ec")
  || (passkeyAlgorithm === "RS256" && parsedPublicKey.asymmetricKeyType !== "rsa")
) {
  throw new Error("GETDONE_OWNER_PASSKEY_ALGORITHM does not match the supplied public key");
}

const bootstrapSeed = [
  BOOTSTRAP_VERSION,
  runtimeEnvironment,
  userId,
  organizationId,
  companyId,
  portfolioId,
  credentialId,
  POLICY_REGISTRY_ID,
  policyVersion
].join("\n");
const bootstrapId = `production-bootstrap:${hash(bootstrapSeed).slice(0, 32)}`;
const policyConfigurationId =
  `policy-configuration:${portfolioId}:${companyId}:${runtimeEnvironment}`;

const policyPayload = Object.freeze({
  id: policyConfigurationId,
  portfolioId,
  companyId,
  environment: runtimeEnvironment,
  state: "active",
  registryId: POLICY_REGISTRY_ID,
  registryVersion: policyVersion,
  policyEngineVersion,
  enforcement: "enforce",
  bootstrapId,
  bootstrapVersion: BOOTSTRAP_VERSION
});

const bootstrapAuditPayload = Object.freeze({
  bootstrapId,
  bootstrapVersion: BOOTSTRAP_VERSION,
  userId,
  organizationId,
  companyId,
  portfolioId,
  credentialId,
  policyConfigurationId,
  policyRegistryId: POLICY_REGISTRY_ID,
  policyVersion,
  policyEngineVersion
});

const pool = new pg.Pool({
  ...postgresTlsConnection(connectionString, process.env),
  max: 1,
  application_name: "getdone-production-bootstrap"
});

async function assertOne(client, sql, values, expected, label) {
  const result = await client.query(sql, values);
  const row = result.rows[0];
  if (!row || !equalJson(row, expected)) {
    throw new Error(`${label} conflicts with the deterministic production bootstrap state`);
  }
}

async function insertOrVerify(client, insertSql, insertValues, readSql, readValues, expected, label) {
  const inserted = await client.query(insertSql, insertValues);
  if (inserted.rowCount !== 0 && inserted.rowCount !== 1) {
    throw new Error(`${label} returned an unexpected insert count`);
  }
  await assertOne(client, readSql, readValues, expected, label);
  return inserted.rowCount === 1;
}

const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");

  const migration = await client.query(
    "SELECT version FROM getdone_schema_migrations ORDER BY version DESC LIMIT 1"
  );
  if (migration.rows[0]?.version !== requiredMigration) {
    throw new Error(
      `Production bootstrap requires current migration ${requiredMigration}`
    );
  }

  const role = await client.query(
    `SELECT rolsuper,rolbypassrls,
            pg_has_role(current_user,$1,'MEMBER') AS member
     FROM pg_roles WHERE rolname=$1`,
    [runtimeRole]
  );
  const runtime = role.rows[0];
  if (!runtime || runtime.rolsuper || runtime.rolbypassrls || runtime.member !== true) {
    throw new Error(
      "Production bootstrap requires membership in a NOSUPERUSER/NOBYPASSRLS tenant runtime role"
    );
  }

  await client.query(`SET LOCAL ROLE ${quoteIdentifier(runtimeRole)}`);
  await client.query(
    `SELECT
       set_config('getdone.portfolio_id',$1,true),
       set_config('getdone.company_id',$2,true)`,
    [portfolioId, companyId]
  );

  const created = {};

  created.user = await insertOrVerify(
    client,
    "INSERT INTO auth_users(id,status) VALUES($1,'active') ON CONFLICT (id) DO NOTHING",
    [userId],
    "SELECT id,status FROM auth_users WHERE id=$1",
    [userId],
    { id: userId, status: "active" },
    "Owner user"
  );

  created.organization = await insertOrVerify(
    client,
    "INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT (id) DO NOTHING",
    [organizationId, organizationName],
    "SELECT id,name FROM organizations WHERE id=$1",
    [organizationId],
    { id: organizationId, name: organizationName },
    "Owner organization"
  );

  created.company = await insertOrVerify(
    client,
    `INSERT INTO companies(id,organization_id,name)
     VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
    [companyId, organizationId, companyName],
    "SELECT id,organization_id,name FROM companies WHERE id=$1",
    [companyId],
    {
      id: companyId,
      organization_id: organizationId,
      name: companyName
    },
    "Owner company"
  );

  created.portfolio = await insertOrVerify(
    client,
    `INSERT INTO portfolios(id,organization_id,company_id,name)
     VALUES($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
    [portfolioId, organizationId, companyId, portfolioName],
    "SELECT id,organization_id,company_id,name FROM portfolios WHERE id=$1",
    [portfolioId],
    {
      id: portfolioId,
      organization_id: organizationId,
      company_id: companyId,
      name: portfolioName
    },
    "Owner portfolio"
  );

  created.organizationMembership = await insertOrVerify(
    client,
    `INSERT INTO organization_memberships(user_id,organization_id,role,status)
     VALUES($1,$2,'owner','active')
     ON CONFLICT (user_id,organization_id) DO NOTHING`,
    [userId, organizationId],
    `SELECT user_id,organization_id,role,status
     FROM organization_memberships
     WHERE user_id=$1 AND organization_id=$2`,
    [userId, organizationId],
    {
      user_id: userId,
      organization_id: organizationId,
      role: "owner",
      status: "active"
    },
    "Owner organization membership"
  );

  created.companyMembership = await insertOrVerify(
    client,
    `INSERT INTO company_memberships(user_id,company_id,role,status)
     VALUES($1,$2,'owner','active')
     ON CONFLICT (user_id,company_id) DO NOTHING`,
    [userId, companyId],
    `SELECT user_id,company_id,role,status
     FROM company_memberships
     WHERE user_id=$1 AND company_id=$2`,
    [userId, companyId],
    {
      user_id: userId,
      company_id: companyId,
      role: "owner",
      status: "active"
    },
    "Owner company membership"
  );

  created.portfolioMembership = await insertOrVerify(
    client,
    `INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status)
     VALUES($1,$2,$3,'owner','active')
     ON CONFLICT (user_id,portfolio_id) DO NOTHING`,
    [userId, portfolioId, companyId],
    `SELECT user_id,portfolio_id,company_id,role,status
     FROM portfolio_memberships
     WHERE user_id=$1 AND portfolio_id=$2`,
    [userId, portfolioId],
    {
      user_id: userId,
      portfolio_id: portfolioId,
      company_id: companyId,
      role: "owner",
      status: "active"
    },
    "Owner portfolio membership"
  );

  created.passkey = await insertOrVerify(
    client,
    `INSERT INTO auth_webauthn_credentials
      (credential_id,user_id,user_handle,public_key_pem,algorithm,sign_count)
     VALUES($1,$2,$3,$4,$5,0)
     ON CONFLICT (credential_id) DO NOTHING`,
    [credentialId, userId, userHandle, publicKeyPem, passkeyAlgorithm],
    `SELECT credential_id,user_id,user_handle,public_key_pem,algorithm,
            revoked_at IS NULL AS active
     FROM auth_webauthn_credentials
     WHERE credential_id=$1`,
    [credentialId],
    {
      credential_id: credentialId,
      user_id: userId,
      user_handle: userHandle,
      public_key_pem: publicKeyPem,
      algorithm: passkeyAlgorithm,
      active: true
    },
    "Owner passkey"
  );

  const policyInsert = await client.query(
    `INSERT INTO control_plane_entities
      (entity_type,id,portfolio_id,company_id,version,updated_at,payload)
     VALUES('policy-configuration',$1,$2,$3,1,now(),$4::jsonb)
     ON CONFLICT (entity_type,id) DO NOTHING`,
    [
      policyConfigurationId,
      portfolioId,
      companyId,
      JSON.stringify(policyPayload)
    ]
  );
  await assertOne(
    client,
    `SELECT portfolio_id,company_id,version,payload
     FROM control_plane_entities
     WHERE entity_type='policy-configuration' AND id=$1`,
    [policyConfigurationId],
    {
      portfolio_id: portfolioId,
      company_id: companyId,
      version: 1,
      payload: policyPayload
    },
    "Initial policy configuration"
  );
  created.policyConfiguration = policyInsert.rowCount === 1;

  const auditId = `audit:${bootstrapId}`;
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1 || E'\\x1f' || $2,0))",
    [portfolioId, companyId]
  );
  const existingAudit = await client.query(
    "SELECT id FROM audit_events WHERE id=$1",
    [auditId]
  );
  let auditInsert = { rowCount: 0 };
  if (existingAudit.rowCount === 0) {
    const head = await client.query(
      `SELECT head_sequence,head_hash,event_count
       FROM audit_chain_heads
       WHERE portfolio_id=$1 AND company_id=$2
       FOR UPDATE`,
      [portfolioId, companyId]
    );
    const chainSequence = Number(head.rows[0]?.head_sequence ?? 0) + 1;
    const previousEventHash = head.rows[0]?.head_hash ?? "0".repeat(64);
    const occurredAt = new Date().toISOString();

    auditInsert = await client.query(
      `INSERT INTO audit_events
        (id,correlation_id,portfolio_id,company_id,entity_type,entity_id,occurred_at,payload,
         chain_sequence,previous_event_hash,event_hash)
       VALUES(
         $1,$2,$3,$4,'policy-configuration',$5,$6,$7::jsonb,$8,$9,
         getdone_audit_event_hash($3,$4,$8,$9,$1,$6,$7::jsonb)
       )
       RETURNING chain_sequence,event_hash`,
      [
        auditId,
        bootstrapId,
        portfolioId,
        companyId,
        policyConfigurationId,
        occurredAt,
        JSON.stringify(bootstrapAuditPayload),
        chainSequence,
        previousEventHash
      ]
    );

    const inserted = auditInsert.rows[0];
    await client.query(
      `INSERT INTO audit_chain_heads
        (portfolio_id,company_id,head_sequence,head_hash,event_count,updated_at)
       VALUES($1,$2,$3,$4,$3,$5)
       ON CONFLICT(portfolio_id,company_id) DO UPDATE
       SET head_sequence=excluded.head_sequence,
           head_hash=excluded.head_hash,
           event_count=excluded.event_count,
           updated_at=excluded.updated_at`,
      [
        portfolioId,
        companyId,
        inserted.chain_sequence,
        inserted.event_hash,
        occurredAt
      ]
    );
  }
  await assertOne(
    client,
    `SELECT correlation_id,portfolio_id,company_id,entity_type,entity_id,payload
     FROM audit_events WHERE id=$1`,
    [auditId],
    {
      correlation_id: bootstrapId,
      portfolio_id: portfolioId,
      company_id: companyId,
      entity_type: "policy-configuration",
      entity_id: policyConfigurationId,
      payload: bootstrapAuditPayload
    },
    "Production bootstrap audit evidence"
  );
  created.auditEvidence = auditInsert.rowCount === 1;

  await client.query("COMMIT");

  console.log(JSON.stringify({
    status: "ready",
    bootstrapVersion: BOOTSTRAP_VERSION,
    bootstrapId,
    environment: runtimeEnvironment,
    owner: {
      userId,
      organizationId,
      companyId,
      portfolioId,
      credentialId
    },
    policy: {
      configurationId: policyConfigurationId,
      registryId: POLICY_REGISTRY_ID,
      registryVersion: policyVersion,
      engineVersion: policyEngineVersion,
      enforcement: "enforce"
    },
    created
  }, null, 2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
