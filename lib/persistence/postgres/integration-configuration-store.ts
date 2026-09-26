import { sha256Hex } from "@/lib/control-plane/canonical-hash";
import { ControlPlaneError } from "@/lib/control-plane/errors";
import type {
  IntegrationConfiguration,
  IntegrationConfigurationStore,
  IntegrationVerificationSummary
} from "@/lib/integrations/configuration";
import { assertIntegrationConfiguration } from "@/lib/integrations/configuration";
import type { TrustedExecutionScope } from "@/lib/control-plane/trusted-execution-scope";
import type { PostgresTransactionalDatabase, QueryResultRow } from "@/lib/persistence/postgres/client";

type Scope=Pick<TrustedExecutionScope,"portfolioId"|"companyId"|"environment">;

interface PayloadRow extends QueryResultRow {
  payload:IntegrationConfiguration;
}

interface IdempotencyRow extends QueryResultRow {
  integration_id:string;
  request_hash:string;
}

export class PostgresIntegrationConfigurationStore implements IntegrationConfigurationStore {
  constructor(private readonly db:PostgresTransactionalDatabase){}

  async list(scope:Scope){
    const result=await this.db.query<PayloadRow>(
      `SELECT payload
       FROM integration_configurations
       WHERE portfolio_id=$1 AND company_id=$2 AND environment=$3
       ORDER BY updated_at DESC,id`,
      [scope.portfolioId,scope.companyId,scope.environment]
    );
    return Object.freeze(result.rows.map((row)=>assertIntegrationConfiguration(row.payload)));
  }

  async get(scope:Scope,id:string){
    const result=await this.db.query<PayloadRow>(
      `SELECT payload
       FROM integration_configurations
       WHERE id=$1 AND portfolio_id=$2 AND company_id=$3 AND environment=$4`,
      [id,scope.portfolioId,scope.companyId,scope.environment]
    );
    const record=result.rows[0]?.payload;
    return record?assertIntegrationConfiguration(record):null;
  }

  async create(record:IntegrationConfiguration,idempotencyKey:string){
    assertIntegrationConfiguration(record);
    const keyHash=sha256Hex({
      scope:{
        portfolioId:record.portfolioId,
        companyId:record.companyId,
        environment:record.environment
      },
      idempotencyKey
    });
    const requestHash=sha256Hex(record);
    return this.db.transaction(async(db)=>{
      const existing=await db.query<IdempotencyRow>(
        `SELECT integration_id,request_hash
         FROM integration_configuration_idempotency
         WHERE idempotency_key_hash=$1
         FOR UPDATE`,
        [keyHash]
      );
      if(existing.rows[0]){
        if(existing.rows[0].request_hash!==requestHash){
          throw new ControlPlaneError(
            "IDEMPOTENCY_CONFLICT",
            "Integration configuration idempotency key was reused with a different request"
          );
        }
        const replay=await db.query<PayloadRow>(
          `SELECT payload
           FROM integration_configurations
           WHERE id=$1 AND portfolio_id=$2 AND company_id=$3 AND environment=$4`,
          [
            existing.rows[0].integration_id,
            record.portfolioId,
            record.companyId,
            record.environment
          ]
        );
        if(!replay.rows[0]){
          throw new ControlPlaneError("UNAVAILABLE","Integration idempotency record lost its configuration");
        }
        return assertIntegrationConfiguration(replay.rows[0].payload);
      }

      try{
        await db.query(
          `INSERT INTO integration_configurations
            (id,portfolio_id,company_id,environment,provider,display_name,status,
             health,credential_binding_id,version,configuration_hash,created_at,updated_at,payload)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
          [
            record.id,
            record.portfolioId,
            record.companyId,
            record.environment,
            record.provider,
            record.displayName,
            record.status,
            record.health,
            record.credentialBindingId??null,
            record.version,
            record.configurationHash,
            record.createdAt,
            record.updatedAt,
            JSON.stringify(record)
          ]
        );
      }catch(error){
        if((error as {code?:string}).code==="23505"){
          throw new ControlPlaneError("CONFLICT","Integration configuration already exists");
        }
        throw error;
      }

      await db.query(
        `INSERT INTO integration_configuration_idempotency
          (idempotency_key_hash,portfolio_id,company_id,integration_id,request_hash,created_at)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [
          keyHash,
          record.portfolioId,
          record.companyId,
          record.id,
          requestHash,
          record.createdAt
        ]
      );
      return record;
    });
  }

  async save(record:IntegrationConfiguration,expectedVersion:number){
    assertIntegrationConfiguration(record);
    const result=await this.db.query(
      `UPDATE integration_configurations
       SET display_name=$1,status=$2,health=$3,credential_binding_id=$4,
           version=$5,configuration_hash=$6,updated_at=$7,payload=$8::jsonb
       WHERE id=$9 AND portfolio_id=$10 AND company_id=$11 AND environment=$12
         AND version=$13`,
      [
        record.displayName,
        record.status,
        record.health,
        record.credentialBindingId??null,
        record.version,
        record.configurationHash,
        record.updatedAt,
        JSON.stringify(record),
        record.id,
        record.portfolioId,
        record.companyId,
        record.environment,
        expectedVersion
      ]
    );
    if(result.rowCount!==1){
      throw new ControlPlaneError("CONFLICT","Integration configuration version changed");
    }
    return record;
  }

  async appendVerification(input:{
    integrationId:string;
    scope:Scope;
    verification:IntegrationVerificationSummary;
  }){
    await this.db.query(
      `INSERT INTO integration_verification_evidence
        (id,integration_id,portfolio_id,company_id,environment,health,
         verified_at,evidence_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT(integration_id,evidence_hash) DO NOTHING`,
      [
        input.verification.id,
        input.integrationId,
        input.scope.portfolioId,
        input.scope.companyId,
        input.scope.environment,
        input.verification.health,
        input.verification.verifiedAt,
        input.verification.evidenceHash,
        JSON.stringify(input.verification)
      ]
    );
  }
}
