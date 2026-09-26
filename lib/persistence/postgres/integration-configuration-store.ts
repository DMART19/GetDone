import type { QueryResultRow } from "pg";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  IntegrationConfigurationStore,
  IntegrationVerificationEvidence,
  ManagedIntegrationConfiguration
} from "@/lib/integrations/management";
import type { PostgresTransactionalDatabase } from "@/lib/persistence/postgres/client";

interface IntegrationRow extends QueryResultRow {
  payload: ManagedIntegrationConfiguration;
}

interface CommandRow extends QueryResultRow {
  request_hash: string;
  integration_id: string;
  result_record_hash: string;
}

function values(record: ManagedIntegrationConfiguration) {
  return [
    record.id,
    record.portfolioId,
    record.companyId,
    record.environment,
    record.providerId,
    record.kind,
    record.displayName,
    record.adapterId,
    record.adapterVersion,
    record.credentialBindingId ?? null,
    [...record.capabilityNames],
    [...record.requestedScopes],
    [...record.grantedScopes],
    record.state,
    record.health,
    record.lastVerifiedAt ?? null,
    record.lastVerificationEvidenceHash ?? null,
    record.disabledAt ?? null,
    record.revokedAt ?? null,
    record.createdAt,
    record.updatedAt,
    record.recordHash,
    JSON.stringify(record)
  ];
}

async function commandReplay(
  db: Pick<PostgresTransactionalDatabase, "query">,
  input: {
    portfolioId: string;
    companyId: string;
    idempotencyKey: string;
    requestHash: string;
  }
) {
  const existing = await db.query<CommandRow>(
    `SELECT request_hash,integration_id,result_record_hash
     FROM integration_configuration_commands
     WHERE portfolio_id=$1 AND company_id=$2 AND idempotency_key=$3
     FOR UPDATE`,
    [input.portfolioId, input.companyId, input.idempotencyKey]
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (row.request_hash !== input.requestHash) {
    throw new ControlPlaneError(
      "IDEMPOTENCY_CONFLICT",
      "Integration configuration idempotency key was reused with different input"
    );
  }
  const result = await db.query<IntegrationRow>(
    "SELECT payload FROM integration_configurations WHERE id=$1",
    [row.integration_id]
  );
  const record = result.rows[0]?.payload;
  if (!record || record.recordHash !== row.result_record_hash) {
    throw new ControlPlaneError(
      "UNAVAILABLE",
      "Integration configuration idempotency result is unavailable or drifted"
    );
  }
  return record;
}

export class PostgresIntegrationConfigurationStore implements IntegrationConfigurationStore {
  constructor(private readonly db: PostgresTransactionalDatabase) {}

  async get(id: string) {
    const result = await this.db.query<IntegrationRow>(
      "SELECT payload FROM integration_configurations WHERE id=$1",
      [id]
    );
    return result.rows[0]?.payload ?? null;
  }

  async listByScope(
    portfolioId: string,
    companyId: string,
    environment: ManagedIntegrationConfiguration["environment"]
  ) {
    const result = await this.db.query<IntegrationRow>(
      `SELECT payload
       FROM integration_configurations
       WHERE portfolio_id=$1 AND company_id=$2 AND environment=$3
       ORDER BY updated_at DESC,id`,
      [portfolioId, companyId, environment]
    );
    return result.rows.map((row) => row.payload);
  }

  async create(
    record: ManagedIntegrationConfiguration,
    input: { idempotencyKey: string; requestHash: string }
  ) {
    return this.db.transaction(async (db) => {
      const replay = await commandReplay(db as PostgresTransactionalDatabase, {
        portfolioId: record.portfolioId,
        companyId: record.companyId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash
      });
      if (replay) return replay;

      const existing = await db.query<IntegrationRow>(
        "SELECT payload FROM integration_configurations WHERE id=$1 FOR UPDATE",
        [record.id]
      );
      if (existing.rows[0]) {
        throw new ControlPlaneError("CONFLICT", "Integration configuration already exists");
      }

      await db.query(
        `INSERT INTO integration_configurations
          (id,portfolio_id,company_id,environment,provider_id,kind,display_name,
           adapter_id,adapter_version,credential_binding_id,capability_names,
           requested_scopes,granted_scopes,state,health,last_verified_at,
           last_verification_evidence_hash,disabled_at,revoked_at,created_at,
           updated_at,record_hash,payload)
         VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12::text[],$13::text[],
           $14,$15,$16,$17,$18,$19,$20,$21,$22,$23::jsonb
         )`,
        values(record)
      );
      await db.query(
        `INSERT INTO integration_configuration_commands
          (portfolio_id,company_id,idempotency_key,request_hash,integration_id,
           result_record_hash,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          record.portfolioId,
          record.companyId,
          input.idempotencyKey,
          input.requestHash,
          record.id,
          record.recordHash,
          record.updatedAt
        ]
      );
      return record;
    });
  }

  async save(
    record: ManagedIntegrationConfiguration,
    input: {
      idempotencyKey: string;
      requestHash: string;
      expectedRecordHash: string;
    }
  ) {
    return this.db.transaction(async (db) => {
      const replay = await commandReplay(db as PostgresTransactionalDatabase, {
        portfolioId: record.portfolioId,
        companyId: record.companyId,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash
      });
      if (replay) return replay;

      const current = await db.query<IntegrationRow>(
        "SELECT payload FROM integration_configurations WHERE id=$1 FOR UPDATE",
        [record.id]
      );
      const existing = current.rows[0]?.payload;
      if (!existing) {
        throw new ControlPlaneError("NOT_FOUND", "Integration configuration was not found");
      }
      if (existing.recordHash !== input.expectedRecordHash) {
        throw new ControlPlaneError(
          "CONFLICT",
          "Integration configuration changed before this mutation"
        );
      }

      const params = values(record);
      await db.query(
        `UPDATE integration_configurations SET
           portfolio_id=$2,company_id=$3,environment=$4,provider_id=$5,kind=$6,
           display_name=$7,adapter_id=$8,adapter_version=$9,credential_binding_id=$10,
           capability_names=$11::text[],requested_scopes=$12::text[],
           granted_scopes=$13::text[],state=$14,health=$15,last_verified_at=$16,
           last_verification_evidence_hash=$17,disabled_at=$18,revoked_at=$19,
           created_at=$20,updated_at=$21,record_hash=$22,payload=$23::jsonb
         WHERE id=$1`,
        params
      );
      await db.query(
        `INSERT INTO integration_configuration_commands
          (portfolio_id,company_id,idempotency_key,request_hash,integration_id,
           result_record_hash,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [
          record.portfolioId,
          record.companyId,
          input.idempotencyKey,
          input.requestHash,
          record.id,
          record.recordHash,
          record.updatedAt
        ]
      );
      return record;
    });
  }

  async appendVerification(evidence: IntegrationVerificationEvidence) {
    await this.db.query(
      `INSERT INTO integration_verification_evidence
        (evidence_hash,integration_id,portfolio_id,company_id,environment,
         provider_id,adapter_id,adapter_version,verified,health,granted_scopes,
         observed_at,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[],$12,$13::jsonb)
       ON CONFLICT(evidence_hash) DO NOTHING`,
      [
        evidence.evidenceHash,
        evidence.integrationId,
        evidence.portfolioId,
        evidence.companyId,
        evidence.environment,
        evidence.providerId,
        evidence.adapterId,
        evidence.adapterVersion,
        evidence.verified,
        evidence.health,
        [...evidence.grantedScopes],
        evidence.observedAt,
        JSON.stringify(evidence)
      ]
    );
  }
}
