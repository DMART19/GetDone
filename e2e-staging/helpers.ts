import { generateKeyPairSync, randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import pg from "pg";

const { Pool } = pg;

export const STAGING_OWNER_ID = "browser-owner";
export const STAGING_PORTFOLIO_ID = "browser-portfolio";
export const STAGING_COMPANY_ID = "browser-company";
export const STAGING_ORG_ID = "browser-org";
export const STAGING_RP_ID = "localhost";
export const STAGING_ORIGIN = "http://localhost:3200";

export interface PasskeyFixture {
  credentialId: string;
  publicKeyPem: string;
  privateKeyPkcs8Base64: string;
}

export function createPasskeyFixture(): PasskeyFixture {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    credentialId: randomBytes(24).toString("base64url"),
    publicKeyPem: keys.publicKey.export({
      type: "spki",
      format: "pem"
    }).toString(),
    privateKeyPkcs8Base64: keys.privateKey.export({
      type: "pkcs8",
      format: "der"
    }).toString("base64")
  };
}

export function stagingPool() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new Error("DATABASE_URL is required for staging browser E2E");
  return new Pool({
    connectionString,
    max: 4,
    ssl: process.env.GETDONE_DB_SSL === "false" ? false : undefined,
    application_name: "getdone-browser-staging-e2e"
  });
}

export async function resetAndSeedStagingDatabase(
  passkey: PasskeyFixture
) {
  const pool = stagingPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS staging_browser_provider_objects (
        provider_operation_id text PRIMARY KEY,
        request_id text NOT NULL,
        job_id text NOT NULL,
        company_id text NOT NULL,
        payload_hash text NOT NULL,
        created_at timestamptz NOT NULL
      )
    `);
    await pool.query(`
      TRUNCATE
        staging_browser_provider_objects,
        business_action_verification_evidence,
        business_action_executions,
        job_execution_outcomes,
        job_runtime_events,
        job_execution_specs,
        job_recovery_records,
        job_dead_letters,
        job_retry_schedule,
        job_leases,
        job_runtime_transactions,
        job_runtime_state,
        authorization_consumptions,
        authorization_grants,
        verification_receipts,
        owner_intents,
        auth_sign_in_challenges,
        auth_step_up_challenges,
        auth_webauthn_credentials,
        auth_step_up_credentials,
        auth_sessions,
        portfolio_memberships,
        company_memberships,
        organization_memberships,
        portfolios,
        companies,
        organizations,
        auth_users,
        control_plane_entities,
        idempotency_records,
        audit_events
      RESTART IDENTITY CASCADE
    `);

    await pool.query(
      "INSERT INTO auth_users(id,status) VALUES($1,'active')",
      [STAGING_OWNER_ID]
    );
    await pool.query(
      "INSERT INTO organizations(id,name) VALUES($1,'Browser E2E Org')",
      [STAGING_ORG_ID]
    );
    await pool.query(
      "INSERT INTO companies(id,organization_id,name) VALUES($1,$2,'Browser E2E Company')",
      [STAGING_COMPANY_ID, STAGING_ORG_ID]
    );
    await pool.query(
      `INSERT INTO portfolios(id,organization_id,company_id,name)
       VALUES($1,$2,$3,'Browser E2E Portfolio')`,
      [STAGING_PORTFOLIO_ID, STAGING_ORG_ID, STAGING_COMPANY_ID]
    );
    await pool.query(
      `INSERT INTO organization_memberships(user_id,organization_id,role,status)
       VALUES($1,$2,'owner','active')`,
      [STAGING_OWNER_ID, STAGING_ORG_ID]
    );
    await pool.query(
      `INSERT INTO company_memberships(user_id,company_id,role,status)
       VALUES($1,$2,'owner','active')`,
      [STAGING_OWNER_ID, STAGING_COMPANY_ID]
    );
    await pool.query(
      `INSERT INTO portfolio_memberships(user_id,portfolio_id,company_id,role,status)
       VALUES($1,$2,$3,'owner','active')`,
      [STAGING_OWNER_ID, STAGING_PORTFOLIO_ID, STAGING_COMPANY_ID]
    );
    await pool.query(
      `INSERT INTO auth_webauthn_credentials
        (credential_id,user_id,public_key_pem,algorithm,sign_count)
       VALUES($1,$2,$3,'ES256',0)`,
      [passkey.credentialId, STAGING_OWNER_ID, passkey.publicKeyPem]
    );
  } finally {
    await pool.end();
  }
}

export async function installVirtualPasskey(
  page: Page,
  passkey: PasskeyFixture,
  input: { userVerified?: boolean } = {}
) {
  const session = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  const created = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: false,
      hasUserVerification: true,
      isUserVerified: input.userVerified ?? true,
      automaticPresenceSimulation: true
    }
  }) as { authenticatorId: string };

  await session.send("WebAuthn.addCredential", {
    authenticatorId: created.authenticatorId,
    credential: {
      credentialId: passkey.credentialId,
      isResidentCredential: false,
      rpId: STAGING_RP_ID,
      privateKey: passkey.privateKeyPkcs8Base64,
      signCount: 0
    }
  });

  return {
    session,
    authenticatorId: created.authenticatorId
  };
}

export async function signInThroughBrowser(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("GetDone user").fill(STAGING_OWNER_ID);
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await page.waitForURL("**/");
}

export async function browserAssertion(
  page: Page,
  challenge: {
    challenge: string;
    rpId: string;
    allowCredentialIds: readonly string[];
    userVerification: "required";
  }
) {
  return page.evaluate(async (value) => {
    function decodeBase64Url(input: string) {
      const binary = atob(
        input.replace(/-/g, "+").replace(/_/g, "/").padEnd(
          Math.ceil(input.length / 4) * 4,
          "="
        )
      );
      return Uint8Array.from(binary, (char) => char.charCodeAt(0)).buffer;
    }
    function encodeBase64Url(input: ArrayBuffer | null) {
      if (!input) return null;
      let binary = "";
      for (const byte of new Uint8Array(input)) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
    }

    const result = await navigator.credentials.get({
      publicKey: {
        challenge: decodeBase64Url(value.challenge),
        rpId: value.rpId,
        allowCredentials: value.allowCredentialIds.map((id) => ({
          id: decodeBase64Url(id),
          type: "public-key" as const
        })),
        userVerification: value.userVerification,
        timeout: 30_000
      }
    });
    if (!(result instanceof PublicKeyCredential)) {
      throw new Error("Virtual authenticator did not return a public-key credential");
    }
    const response = result.response as AuthenticatorAssertionResponse;
    return {
      id: result.id,
      type: "public-key",
      response: {
        clientDataJSON: encodeBase64Url(response.clientDataJSON)!,
        authenticatorData: encodeBase64Url(response.authenticatorData)!,
        signature: encodeBase64Url(response.signature)!,
        userHandle: encodeBase64Url(response.userHandle)
      }
    };
  }, challenge);
}

export function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url");
}

export function encodeBase64Url(value: Uint8Array | Buffer) {
  return Buffer.from(value).toString("base64url");
}

export async function currentSessionId() {
  const pool = stagingPool();
  try {
    const result = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM auth_sessions
       WHERE user_id=$1 ORDER BY issued_at DESC LIMIT 1`,
      [STAGING_OWNER_ID]
    );
    const value = result.rows[0]?.session_id;
    if (!value) throw new Error("Browser E2E session was not persisted");
    return value;
  } finally {
    await pool.end();
  }
}

export async function sql(text: string, values: readonly unknown[] = []) {
  const pool = stagingPool();
  try {
    return await pool.query(text, [...values]);
  } finally {
    await pool.end();
  }
}
