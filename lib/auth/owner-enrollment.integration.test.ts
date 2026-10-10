import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { PostgresDatabase } from "@/lib/persistence/postgres/client";
import { OwnerEnrollmentService } from "@/lib/auth/owner-enrollment.server";
import { PostgresPasskeySignInService } from "@/lib/auth/postgres-sign-in";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";

const suite = process.env.GETDONE_POSTGRES_INTEGRATION === "true" ? describe : describe.skip;
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest();
const config = readWebAuthnServerConfig({ GETDONE_WEBAUTHN_RP_ID: "getdone.example", GETDONE_WEBAUTHN_ORIGINS: "https://getdone.example" });
const owner = "owner-enrollment-test";
function registration(challenge: string, origin = "https://getdone.example", flags = 0x45) {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const id = randomBytes(32);
  const key = new Map<number, number | Buffer>([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x!, "base64url")], [-3, Buffer.from(jwk.y!, "base64url")]]);
  const length = Buffer.alloc(2); length.writeUInt16BE(id.length);
  const authData = Buffer.concat([sha(config.rpId), Buffer.from([flags]), Buffer.alloc(4), Buffer.alloc(16), length, id, Buffer.from(isoCBOR.encode(key))]);
  const attestation = new Map<string, string | Buffer | Map<string, string>>([["fmt", "none"], ["attStmt", new Map()], ["authData", authData]]);
  const response: RegistrationResponseJSON = {
    id: id.toString("base64url"), rawId: id.toString("base64url"), type: "public-key",
    response: { clientDataJSON: Buffer.from(JSON.stringify({ type: "webauthn.create", challenge, origin, crossOrigin: false })).toString("base64url"), attestationObject: Buffer.from(isoCBOR.encode(attestation)).toString("base64url") },
    clientExtensionResults: {}
  };
  return { response, pair };
}

suite("first owner passkey enrollment with PostgreSQL", () => {
  const name = `getdone_enrollment_${process.pid}_${Date.now()}`;
  const directory = mkdtempSync(join(tmpdir(), "getdone-owner-enrollment-"));
  const ssl = process.env.GETDONE_DB_SSL === "false" ? false : { rejectUnauthorized: true };
  let admin: Pool; let db: PostgresDatabase; let service: OwnerEnrollmentService;
  let connection: string; let token: string; let iteration = 0;
  function bootstrap() {
    const file = join(directory, `invitation-${iteration++}.json`);
    const result = spawnSync(process.execPath, ["scripts/bootstrap-production.mjs", "--enroll-passkey", "--invitation-file", file], {
      encoding: "utf8", env: { ...process.env, DATABASE_URL: connection, GETDONE_RUNTIME_ENV: "production",
        GETDONE_DB_RUNTIME_ROLE: "getdone_tenant_runtime", GETDONE_OWNER_USER_ID: owner,
        GETDONE_OWNER_ORGANIZATION_ID: "enrollment-org", GETDONE_OWNER_COMPANY_ID: "enrollment-company", GETDONE_OWNER_PORTFOLIO_ID: "enrollment-portfolio",
        GETDONE_WEBAUTHN_RP_ID: config.rpId, GETDONE_WEBAUTHN_ORIGINS: config.allowedOrigins.join(",") }
    });
    return { result, file };
  }
  beforeAll(async () => {
    const base = process.env.DATABASE_URL!;
    admin = new Pool({ connectionString: base, ssl });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(base); url.pathname = `/${name}`; connection = url.toString();
    const result = spawnSync(process.execPath, ["scripts/migrate-postgres.mjs"], { encoding: "utf8", env: { ...process.env, DATABASE_URL: connection } });
    if (result.status !== 0) throw new Error(result.stderr);
    db = new PostgresDatabase({ connectionString: connection, ssl: ssl !== false, runtimeRole: "getdone_tenant_runtime" });
    service = new OwnerEnrollmentService(db, config, "production");
  });
  beforeEach(async () => {
    await db.query("DELETE FROM auth_webauthn_credentials WHERE user_id=$1", [owner]);
    // Cleanup through isolated database admin; runtime deliberately has no delete grant.
    const cleanup = new Pool({ connectionString: connection, ssl });
    try { await cleanup.query("DELETE FROM auth_owner_enrollments WHERE user_id=$1", [owner]); } finally { await cleanup.end(); }
    const { result, file } = bootstrap();
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    token = new URL(JSON.parse(readFileSync(file, "utf8")).url).hash.slice(1);
    expect(result.stdout).not.toContain(token);
  });
  afterAll(async () => {
    await db?.close();
    await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin?.end(); rmSync(directory, { recursive: true, force: true });
  });
  it("registers a verified key and signs in through the real assertion verifier", async () => {
    const options = await service.begin(token);
    const key = registration(options.challenge);
    expect(await service.complete(token, key.response)).toEqual({ userId: owner });
    const signin = new PostgresPasskeySignInService(db, config);
    const challenge = await signin.begin(owner);
    const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge: challenge.challenge, origin: config.allowedOrigins[0], crossOrigin: false }));
    const authData = Buffer.concat([sha(config.rpId), Buffer.from([0x05]), Buffer.from([0, 0, 0, 1])]);
    const session = await signin.verify(challenge.challengeId, { id: key.response.id, type: "public-key", response: {
      clientDataJSON: clientData.toString("base64url"), authenticatorData: authData.toString("base64url"),
      signature: sign("sha256", Buffer.concat([authData, sha(clientData)]), key.pair.privateKey).toString("base64url"), userHandle: options.user.id
    }});
    expect(session.session.userId).toBe(owner);
    await expect(service.complete(token, key.response)).rejects.toThrow(/invitation/);
    expect(bootstrap().result.status).not.toBe(0);
  });
  it.each(["https://attacker.example", "http://getdone.example"])("rejects a credential from %s without consuming the invitation", async origin => {
    const options = await service.begin(token);
    await expect(service.complete(token, registration(options.challenge, origin).response)).rejects.toThrow(/verified/);
    expect((await db.query("SELECT consumed_at FROM auth_owner_enrollments WHERE user_id=$1", [owner])).rows[0].consumed_at).toBeNull();
  });
  it("requires user verification and the latest challenge", async () => {
    const first = await service.begin(token); const latest = await service.begin(token);
    await expect(service.complete(token, registration(first.challenge).response)).rejects.toThrow(/verified/);
    await expect(service.complete(token, registration(latest.challenge, undefined, 0x41).response)).rejects.toThrow(/verified/);
  });
  it("rejects absent, expired, and wrong-environment invitations", async () => {
    await expect(service.begin(randomBytes(32).toString("base64url"))).rejects.toThrow(/invitation/);
    await expect(new OwnerEnrollmentService(db, config, "staging").begin(token)).rejects.toThrow(/invitation/);
    await db.query("UPDATE auth_owner_enrollments SET expires_at=now()-interval '1 second' WHERE user_id=$1", [owner]);
    await expect(service.begin(token)).rejects.toThrow(/invitation/);
  });
  it("allows only one concurrent registration and rolls back the losing transaction", async () => {
    const options = await service.begin(token); const response = registration(options.challenge).response;
    const results = await Promise.allSettled([service.complete(token, response), service.complete(token, response)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((await db.query("SELECT credential_id FROM auth_webauthn_credentials WHERE user_id=$1", [owner])).rows).toHaveLength(1);
  });
  it("invalidates an earlier invitation when the operator reissues it", async () => {
    const replacement = bootstrap(); expect(replacement.result.status, replacement.result.stderr).toBe(0);
    await expect(service.begin(token)).rejects.toThrow(/invitation/);
  });
});
