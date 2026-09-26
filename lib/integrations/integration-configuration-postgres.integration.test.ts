import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createIntegrationConfiguration,
  transitionIntegrationConfiguration,
  attachIntegrationVerification
} from "@/lib/integrations/configuration";
import { PostgresIntegrationConfigurationStore } from "@/lib/persistence/postgres/integration-configuration-store";
import { PostgresDatabase, readPostgresConfigFromEnv } from "@/lib/persistence/postgres/client";

const enabled=process.env.GETDONE_POSTGRES_INTEGRATION==="true";
const suite=enabled?describe.sequential:describe.skip;

suite("PostgreSQL integration configuration persistence",()=>{
  let database:PostgresDatabase|undefined;
  const scope={
    portfolioId:"portfolio-integration-config",
    companyId:"company-integration-config",
    environment:"staging" as const
  };

  function db(){
    if(!database) throw new Error("integration configuration database not initialized");
    return database;
  }

  beforeAll(async()=>{
    database=new PostgresDatabase(readPostgresConfigFromEnv(process.env));
    await db().query("DELETE FROM integration_verification_evidence WHERE company_id=$1",[scope.companyId]);
    await db().query("DELETE FROM integration_configuration_idempotency WHERE company_id=$1",[scope.companyId]);
    await db().query("DELETE FROM integration_configurations WHERE company_id=$1",[scope.companyId]);
  });

  afterAll(async()=>{
    if(!database) return;
    await database.query("DELETE FROM integration_verification_evidence WHERE company_id=$1",[scope.companyId]);
    await database.query("DELETE FROM integration_configuration_idempotency WHERE company_id=$1",[scope.companyId]);
    await database.query("DELETE FROM integration_configurations WHERE company_id=$1",[scope.companyId]);
    await database.close();
  });

  it("creates idempotently, lists by tenant scope, and rejects conflicting replay",async()=>{
    const store=new PostgresIntegrationConfigurationStore(db());
    const record=createIntegrationConfiguration({
      scope,
      value:{
        id:"calendar-integration-it",
        provider:"calendar",
        displayName:"Calendar IT",
        capabilityNames:["calendar.event.read","calendar.event.create"],
        grantedScopes:["calendar.read","calendar.write"],
        credentialBindingId:"binding:calendar:it"
      },
      now:"2026-09-25T20:00:00Z"
    });
    const first=await store.create(record,"idem-calendar-it");
    const replay=await store.create(record,"idem-calendar-it");
    expect(replay.configurationHash).toBe(first.configurationHash);
    expect(await store.list(scope)).toEqual([first]);

    const different=createIntegrationConfiguration({
      scope,
      value:{
        id:"calendar-integration-it",
        provider:"calendar",
        displayName:"Different",
        capabilityNames:["calendar.event.read","calendar.event.create"],
        grantedScopes:["calendar.read","calendar.write"],
        credentialBindingId:"binding:calendar:it"
      },
      now:"2026-09-25T20:00:00Z"
    });
    await expect(store.create(different,"idem-calendar-it"))
      .rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  });

  it("enforces optimistic versions and persists verification evidence append-only",async()=>{
    const store=new PostgresIntegrationConfigurationStore(db());
    const current=await store.get(scope,"calendar-integration-it");
    expect(current).not.toBeNull();
    const active=transitionIntegrationConfiguration(current!,{
      action:"enable",
      at:"2026-09-25T20:01:00Z"
    });
    await store.save(active,current!.version);

    await expect(store.save(
      transitionIntegrationConfiguration(active,{
        action:"disable",
        at:"2026-09-25T20:02:00Z"
      }),
      current!.version
    )).rejects.toMatchObject({code:"CONFLICT"});

    const verification={
      id:"integration-verification-it",
      health:"healthy" as const,
      verifiedAt:"2026-09-25T20:03:00Z",
      evidenceHash:"a".repeat(64),
      capabilityResults:{
        "calendar.event.read":"passed" as const,
        "calendar.event.create":"passed" as const
      }
    };
    await store.appendVerification({
      integrationId:active.id,
      scope,
      verification
    });
    await store.appendVerification({
      integrationId:active.id,
      scope,
      verification
    });
    const count=await db().query<{count:number}>(
      "SELECT COUNT(*)::int AS count FROM integration_verification_evidence WHERE integration_id=$1",
      [active.id]
    );
    expect(count.rows[0]?.count).toBe(1);

    const verified=attachIntegrationVerification(active,verification);
    await store.save(verified,active.version);
    expect(await store.get(scope,active.id)).toMatchObject({
      health:"healthy",
      lastVerification:{id:"integration-verification-it"},
      version:3
    });
  });

  it("does not surface another company through scoped reads",async()=>{
    const store=new PostgresIntegrationConfigurationStore(db());
    expect(await store.get({
      portfolioId:"portfolio-other",
      companyId:"company-other",
      environment:"staging"
    },"calendar-integration-it")).toBeNull();
  });
});
