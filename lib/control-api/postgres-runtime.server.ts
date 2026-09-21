import { PostgresAuthAdapter } from "@/lib/auth/postgres-adapter";
import { parseAuthoritativeRuntimeEnvironment } from "@/lib/control-plane/runtime-environment";
import { ServiceBackedControlApiAdapter } from "@/lib/control-api/service-adapter";
import {
  PostgresControlApiScopeResolver,
  SessionStepUpEvidenceResolver
} from "@/lib/control-api/postgres-auth";
import type { AuthoritativeDecision } from "@/lib/domain/decision-service";
import type { Resource } from "@/lib/domain/resources";
import type {
  ResourceRegistryStores
} from "@/lib/domain/services/resource-registry-service";
import { ResourceRegistryService } from "@/lib/domain/services/resource-registry-service";
import type { JobRecord } from "@/lib/domain/services/job-service";
import type { VerificationRequestRecord } from "@/lib/domain/services/verification-service";
import type {
  ResourceEnrollmentRecord,
  ResourceEnrollmentStores
} from "@/lib/resources/enrollment";
import { ResourceEnrollmentService } from "@/lib/resources/enrollment";
import {
  PostgresAuthorizationGrantStore,
  PostgresEntityStore,
  PostgresJobExecutionBridgeStore,
  PostgresVerificationReceiptStore
} from "@/lib/persistence/postgres/authority-stores";
import {
  PostgresOwnerIntentStore,
  PostgresResourceEnrollmentReadinessStore,
  PostgresResourceEvidenceStore
} from "@/lib/persistence/postgres/control-api-stores";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";

export function createPostgresControlApiAdapter(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const environment = parseAuthoritativeRuntimeEnvironment(env.GETDONE_RUNTIME_ENV);
  if (environment === "development") {
    throw new Error("Postgres production Control API adapter must not be installed in development");
  }

  const runtime = getPostgresRuntimeFromEnv(env);
  const db = runtime.database;

  const decisions = new PostgresEntityStore<AuthoritativeDecision>(db, "decision");
  const resources = new PostgresEntityStore<Resource>(db, "resource");
  const resourceEnrollments = new PostgresEntityStore<ResourceEnrollmentRecord>(
    db,
    "resource-enrollment"
  );
  const jobs = new PostgresEntityStore<JobRecord>(db, "job");
  const verifications = new PostgresEntityStore<VerificationRequestRecord>(
    db,
    "verification"
  );

  const decisionTransactions = new PostgresControlPlaneTransactionManager(
    db,
    (client) => ({
      decisions: new PostgresEntityStore<AuthoritativeDecision>(client, "decision")
    })
  );

  const resourceRegistry = new ResourceRegistryService(
    new PostgresControlPlaneTransactionManager<ResourceRegistryStores>(
      db,
      (client) => ({
        resources: new PostgresEntityStore<Resource>(client, "resource"),
        identities: new PostgresResourceEvidenceStore(client, "identity"),
        trust: new PostgresResourceEvidenceStore(client, "trust"),
        health: new PostgresResourceEvidenceStore(client, "health"),
        capabilities: new PostgresResourceEvidenceStore(client, "capability"),
        locations: new PostgresResourceEvidenceStore(client, "location"),
        costs: new PostgresResourceEvidenceStore(client, "cost"),
        providers: new PostgresResourceEvidenceStore(client, "provider")
      })
    )
  );

  const resourceEnrollmentService = new ResourceEnrollmentService(
    new PostgresControlPlaneTransactionManager<ResourceEnrollmentStores>(
      db,
      (client) => ({
        enrollments: new PostgresEntityStore<ResourceEnrollmentRecord>(
          client,
          "resource-enrollment"
        ),
        resourceReadiness: new PostgresResourceEnrollmentReadinessStore(client)
      })
    )
  );

  return new ServiceBackedControlApiAdapter({
    auth: new PostgresAuthAdapter(db, {
      cookieName: env.GETDONE_AUTH_COOKIE_NAME || "getdone_session"
    }),
    scopes: new PostgresControlApiScopeResolver(db, environment),
    authorizationEvidence: new SessionStepUpEvidenceResolver(),
    intents: new PostgresOwnerIntentStore(db),
    decisions,
    decisionTransactions,
    resources,
    resourceRegistry,
    resourceEnrollments,
    resourceEnrollmentService,
    jobs,
    verifications,
    health: async () => {
      const health = await runtime.health();
      const persistenceReady = health.connected && health.schemaCurrent;
      return {
        service: "getdone-control-api",
        surfaceVersion: "1.0.0",
        status: !persistenceReady
          ? "unavailable"
          : health.backupFresh
            ? "ready"
            : "degraded",
        authConnected: persistenceReady,
        persistenceConnected: persistenceReady,
        aiGatewayAdapterInstalled: false,
        durableJobStoreConnected: persistenceReady,
        details: {
          schemaCurrent: health.schemaCurrent,
          latestMigration: health.latestMigration ?? null,
          backupFresh: health.backupFresh,
          latestVerifiedBackupAt: health.latestVerifiedBackupAt ?? null
        }
      };
    }
  });
}

export function createPostgresAuthorityStores(db: Parameters<typeof PostgresAuthorizationGrantStore>[0]) {
  return {
    authorizationGrants: new PostgresAuthorizationGrantStore(db),
    verificationReceipts: new PostgresVerificationReceiptStore(db),
    executionBridge: new PostgresJobExecutionBridgeStore(db)
  };
}
