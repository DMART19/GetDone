import { PostgresAuthAdapter } from "@/lib/auth/postgres-adapter";
import { readWebAuthnServerConfig } from "@/lib/auth/webauthn-config";
import { isAIGatewayConfigured } from "@/lib/ai-gateway/runtime.server";
import { parseAuthoritativeRuntimeEnvironment } from "@/lib/control-plane/runtime-environment";
import { CONTROL_API_SURFACE_VERSION } from "@/lib/control-api/contracts";
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
import type { ObjectiveRecord } from "@/lib/domain/objective-inbox";
import type {
  ResourceEnrollmentRecord,
  ResourceEnrollmentStores
} from "@/lib/resources/enrollment";
import { ResourceEnrollmentService } from "@/lib/resources/enrollment";
import { GithubResourceEnrollmentService } from "@/lib/resources/github-enrollment.server";
import { PostgresEntityStore } from "@/lib/persistence/postgres/authority-stores";
import {
  PostgresOwnerIntentStore,
  PostgresObjectiveIntakeStore,
  PostgresResourceEnrollmentReadinessStore,
  PostgresResourceEvidenceStore
} from "@/lib/persistence/postgres/control-api-stores";
import {
  PostgresDecisionResumeRequestStore,
  PostgresOrchestrationAuthorizationGrantStore,
  PostgresOrchestrationDecisionStore
} from "@/lib/persistence/postgres/orchestration-authorization-stores";
import { PostgresOrchestrationPlanProposalStore } from "@/lib/persistence/postgres/orchestration-planning-stores";
import {
  PostgresOrchestrationPolicyEvaluationStore,
  PostgresOrchestrationValidationArtifactStore
} from "@/lib/persistence/postgres/orchestration-validation-policy-stores";
import { PostgresOrchestrationRunStore } from "@/lib/persistence/postgres/orchestration-store";
import { DecisionResumeDispatcher } from "@/lib/orchestration/authorization-flow";
import { PostgresControlPlaneTransactionManager } from "@/lib/persistence/postgres/transaction-manager";
import { getPostgresRuntimeFromEnv } from "@/lib/persistence/postgres/runtime.server";
import { getAuthPostgresDatabaseFromEnv } from "@/lib/persistence/postgres/auth-runtime.server";
import { runWithPostgresTenantScope } from "@/lib/persistence/postgres/tenant-context.server";

export function createPostgresControlApiAdapter(
  env: Readonly<Record<string, string | undefined>> = process.env
) {
  const environment = parseAuthoritativeRuntimeEnvironment(env.GETDONE_RUNTIME_ENV);
  if (environment === "development") {
    throw new Error("Postgres production Control API adapter must not be installed in development");
  }

  const runtime = getPostgresRuntimeFromEnv(env);
  const db = runtime.database;
  const authDb = getAuthPostgresDatabaseFromEnv(env);
  const webAuthn = readWebAuthnServerConfig(env);

  const objectives = new PostgresEntityStore<ObjectiveRecord>(db, "objective");
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
      decisions: new PostgresEntityStore<AuthoritativeDecision>(client, "decision"),
      resumeRequests: new PostgresDecisionResumeRequestStore(client)
    })
  );

  const decisionResumeDispatcher = new DecisionResumeDispatcher({
    runStore: new PostgresOrchestrationRunStore(db),
    queue: new PostgresDecisionResumeRequestStore(db),
    plans: new PostgresOrchestrationPlanProposalStore(db),
    validations: new PostgresOrchestrationValidationArtifactStore(db),
    policies: new PostgresOrchestrationPolicyEvaluationStore(db),
    decisions: new PostgresOrchestrationDecisionStore(db),
    grants: new PostgresOrchestrationAuthorizationGrantStore(db)
  });

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

  const githubResourceEnrollment = new GithubResourceEnrollmentService({
    resources,
    registry: resourceRegistry,
    enrollments: resourceEnrollmentService,
    env
  });

  return new ServiceBackedControlApiAdapter({
    auth: new PostgresAuthAdapter(authDb, {
      cookieName: webAuthn.cookieName,
      stepUpTtlSeconds: webAuthn.stepUpTtlSeconds,
      rpId: webAuthn.rpId,
      allowedOrigins: webAuthn.allowedOrigins
    }),
    scopes: new PostgresControlApiScopeResolver(authDb, environment),
    authorizationEvidence: new SessionStepUpEvidenceResolver(),
    intents: new PostgresOwnerIntentStore(db),
    conversationPlans: new PostgresOrchestrationPlanProposalStore(db),
    orchestrations: new PostgresOrchestrationRunStore(db),
    objectives,
    objectiveIntake: new PostgresObjectiveIntakeStore(db),
    // Control API 1.6 preference endpoints fail closed until a durable Postgres
    // PreferenceLearningStore is installed. Do not substitute ephemeral authority.
    preferenceLearning: undefined,
    decisions,
    decisionTransactions,
    decisionResumeDispatcher,
    resources,
    resourceRegistry,
    resourceEnrollments,
    resourceEnrollmentService,
    githubResourceEnrollment,
    jobs,
    verifications,
    tenantScopeRunner: (scope, operation) =>
      runWithPostgresTenantScope(scope, operation),
    health: async () => {
      const health = await runtime.health();
      const schemaReady = health.connected && health.schemaCurrent;

      const requiredRelationsReady = async (relations: readonly string[]) => {
        if (!schemaReady) return false;
        const result = await db.query<{ ready: boolean }>(
          `SELECT COALESCE(bool_and(to_regclass(name) IS NOT NULL), false) AS ready
           FROM unnest($1::text[]) AS required(name)`,
          [relations]
        );
        return result.rows[0]?.ready === true;
      };

      const [coreRelationsReady, authRelationsReady, durableRelationsReady] =
        await Promise.all([
          requiredRelationsReady([
            "control_plane_entities",
            "idempotency_records",
            "audit_events",
            "owner_intents",
            "verification_receipts"
          ]),
          requiredRelationsReady([
            "auth_users",
            "auth_sessions",
            "organizations",
            "companies",
            "portfolios",
            "organization_memberships",
            "company_memberships",
            "portfolio_memberships",
            "auth_webauthn_credentials",
            "auth_step_up_challenges",
            "auth_sign_in_challenges"
          ]),
          requiredRelationsReady([
            "job_runtime_state",
            "job_leases",
            "job_runtime_transactions",
            "job_execution_specs",
            "job_execution_outcomes",
            "job_worker_instances",
            "business_action_verification_evidence"
          ])
        ]);

      const persistenceConnected = schemaReady && coreRelationsReady;
      // Schema presence alone does not establish usable authentication.
      // An RLS-enabled table with no matching auth policy silently returns 0 rows.
      const authBoundaryReady = authRelationsReady && await authDb.query<{
        role: string; owner_count: string; membership_count: string
      }>(
        `SELECT current_user AS role,
           (SELECT count(*) FROM auth_users WHERE status='active') AS owner_count,
           (SELECT count(*) FROM company_memberships WHERE status='active') AS membership_count`
      ).then((result) =>
        result.rows[0]?.role === "getdone_auth_runtime"
        && Number(result.rows[0].owner_count) > 0
        && Number(result.rows[0].membership_count) > 0
      ).catch(() => false);
      const authConnected = persistenceConnected && authRelationsReady && authBoundaryReady;
      const durableJobStoreConnected = persistenceConnected && durableRelationsReady;

      return {
        service: "getdone-control-api",
        surfaceVersion: CONTROL_API_SURFACE_VERSION,
        status: !persistenceConnected || !authConnected
          ? "unavailable"
          : health.backupFresh
            ? "ready"
            : "degraded",
        authConnected,
        persistenceConnected,
        aiGatewayAdapterInstalled: isAIGatewayConfigured(env),
        durableJobStoreConnected,
        details: {
          schemaCurrent: health.schemaCurrent,
          latestMigration: health.latestMigration ?? null,
          backupFresh: health.backupFresh,
          latestVerifiedBackupAt: health.latestVerifiedBackupAt ?? null,
          coreRelationsReady,
          authRelationsReady,
          authBoundaryReady,
          durableRelationsReady
        }
      };
    }
  });
}
