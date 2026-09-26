import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createManagedIntegration, createIntegrationVerificationEvidence } from "@/lib/integrations/management";
import { IntegrationConfigurationService } from "@/lib/integrations/management-service";
import { PostgresDatabase, readPostgresConfigFromEnv } from "@/lib/persistence/postgres/client";
import { PostgresIntegrationConfigurationStore } from "@/lib/persistence/postgres/integration-configuration-store";

const enabled = process.env.GETDONE_POSTGRES_INTEGRATION === "true";
const suite = enabled ? describe.sequential : describe.skip;

suite("PostgreSQL integration configuration persistence", () => {
  let database: PostgresDatabase | undefined;
  const scope = {
    userId: "owner",
    portfolioId: "portfolio-integration-config",
    companyId: "company-integration-config",
    environment: "staging" as const
  };

  function db() {
    if (!database) throw new Error("integration configuration database not initialized");
    return database;
  }

  beforeAll(async () => {
    database = new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    await db().query(
      "DELETE FROM integration_verification_evidence WHERE company_id=$1",
      [scope.companyId]
    );
    await db().query(
      "DELETE FROM integration_configuration_commands WHERE company_id=$1",
      [scope.companyId]
    );
    await db().query(
      "DELETE FROM integration_configurations WHERE company_id=$1",
      [scope.companyId]
    );
  });

  afterAll(async () => {
    if (!database) return;
    await database.query(
      "DELETE FROM integration_verification_evidence WHERE company_id=$1",
      [scope.companyId]
    );
    await database.query(
      "DELETE FROM integration_configuration_commands WHERE company_id=$1",
      [scope.companyId]
    );
    await database.query(
      "DELETE FROM integration_configurations WHERE company_id=$1",
      [scope.companyId]
    );
    await database.close();
  });

  it("persists idempotent create/update/control and verification evidence", async () => {
    const store = new PostgresIntegrationConfigurationStore(db());
    const service = new IntegrationConfigurationService(
      store,
      () => new Date("2026-09-25T21:00:00Z")
    );

    const created = await service.create({
      scope,
      idempotencyKey: "integration-create-a",
      config: {
        id: "calendar-integration-a",
        providerId: "calendar",
        displayName: "Ops Calendar",
        credentialBindingId: "binding-calendar-staging",
        capabilityNames: ["calendar.event.read", "calendar.event.create"]
      }
    });
    expect(created).toMatchObject({
      companyId: scope.companyId,
      environment: "staging",
      state: "configured",
      health: "unverified",
      grantedScopes: []
    });

    const replay = await service.create({
      scope,
      idempotencyKey: "integration-create-a",
      config: {
        id: "calendar-integration-a",
        providerId: "calendar",
        displayName: "Ops Calendar",
        credentialBindingId: "binding-calendar-staging",
        capabilityNames: ["calendar.event.read", "calendar.event.create"]
      }
    });
    expect(replay.recordHash).toBe(created.recordHash);

    await expect(service.create({
      scope,
      idempotencyKey: "integration-create-a",
      config: {
        id: "different-id",
        providerId: "calendar",
        displayName: "Different",
        capabilityNames: ["calendar.event.read"]
      }
    })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const evidence = createIntegrationVerificationEvidence({
      source: "integration-verifier",
      integrationId: created.id,
      portfolioId: created.portfolioId,
      companyId: created.companyId,
      environment: created.environment,
      providerId: created.providerId,
      adapterId: created.adapterId,
      adapterVersion: created.adapterVersion,
      verified: true,
      health: "healthy",
      grantedScopes: ["calendar.read", "calendar.write"],
      observedAt: "2026-09-25T21:01:00Z"
    });
    const verified = await service.recordVerification({ scope, evidence });
    expect(verified).toMatchObject({
      state: "connected",
      health: "healthy",
      lastVerificationEvidenceHash: evidence.evidenceHash
    });

    const updated = await service.update({
      scope,
      id: created.id,
      idempotencyKey: "integration-update-a",
      patch: {
        displayName: "Primary Ops Calendar",
        capabilityNames: ["calendar.event.read"]
      }
    });
    expect(updated).toMatchObject({
      displayName: "Primary Ops Calendar",
      state: "configured",
      health: "unverified",
      grantedScopes: []
    });

    const disabled = await service.control({
      scope,
      id: created.id,
      idempotencyKey: "integration-disable-a",
      action: "disable"
    });
    expect(disabled).toMatchObject({ state: "disabled", health: "disabled" });

    const list = await service.list(scope);
    expect(list.map((item) => item.id)).toContain(created.id);

    const evidenceCount = await db().query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM integration_verification_evidence
       WHERE integration_id=$1`,
      [created.id]
    );
    expect(evidenceCount.rows[0]?.count).toBe(1);
  });

  it("fails optimistic writes when record hashes are stale", async () => {
    const store = new PostgresIntegrationConfigurationStore(db());
    const record = createManagedIntegration({
      id: "github-integration-stale",
      scope,
      config: {
        id: "github-integration-stale",
        providerId: "github",
        displayName: "GitHub",
        capabilityNames: ["github.repository.read"]
      },
      createdAt: "2026-09-25T21:10:00Z"
    });
    await store.create(record, {
      idempotencyKey: "stale-create",
      requestHash: "1".repeat(64)
    });

    await expect(store.save(
      { ...record, displayName: "Changed", recordHash: "2".repeat(64) },
      {
        idempotencyKey: "stale-update",
        requestHash: "3".repeat(64),
        expectedRecordHash: "0".repeat(64)
      }
    )).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
