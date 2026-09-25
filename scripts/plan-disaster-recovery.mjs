import pg from "pg";
import { sha256Hex } from "./postgres-backup-integrity.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function iso(name, fallback) {
  const raw = process.env[name]?.trim() || fallback;
  if (!raw || !Number.isFinite(Date.parse(raw))) throw new Error(`${name} must be an ISO timestamp`);
  return new Date(raw).toISOString();
}

function hash64(name) {
  const value = required(name);
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error(`${name} must be 64 lowercase hex characters`);
  return value;
}

function validSpec(record) {
  if (!record || typeof record !== "object") return false;
  const { specHash, ...base } = record;
  return record.jobId === record.spec?.jobId && sha256Hex(base) === specHash;
}

function validBusiness(record, jobId, requestId) {
  if (!record || typeof record !== "object") return false;
  const { recordHash, ...base } = record;
  return record.jobId === jobId
    && record.requestId === requestId
    && sha256Hex(base) === recordHash;
}

function classify(row) {
  const runtime = {
    envelope: row.envelope,
    state: row.runtime_state,
    stateHash: row.state_hash
  };
  const spec = row.spec_payload;
  const business = row.business_payload;
  const base = {
    runtimeHash: runtime.stateHash,
    specHash: spec?.specHash,
    providerRecordHash: business?.recordHash
  };

  if (["released","dead-lettered","cancelled"].includes(runtime.state)) {
    return { ...base, decision:"blocked", reasonCode:"terminal-runtime-state",
      reason:`Runtime state ${runtime.state} is terminal and must never be replayed.` };
  }
  if (!validSpec(spec)) {
    return { ...base, decision:"blocked", reasonCode:"missing-or-invalid-execution-spec",
      reason:"Execution spec is missing, tampered, or bound to a different Job." };
  }
  if (["queued","retry-wait"].includes(runtime.state)) {
    return { ...base, decision:"resume", reasonCode:"not-yet-claimed",
      reason:"Job was not executing at backup time and may resume from the durable queue." };
  }
  if (spec.spec.kind === "business-action") {
    const requestId = spec.spec.request?.id;
    if (business && !validBusiness(business,row.job_id,requestId)) {
      return { ...base, decision:"blocked", reasonCode:"provider-record-invalid",
        reason:"Persisted provider execution record failed identity or integrity validation." };
    }
    if (!business) {
      return { ...base, decision:"reconcile", reasonCode:"provider-boundary-unknown",
        reason:"Job was claimed but no provider execution record survived; external side-effect state is ambiguous." };
    }
    if (business.providerOperationId) {
      return { ...base, decision:"resume", reasonCode:"provider-operation-known",
        reason:"Provider operation identity is durable; resume by status reconciliation without repeating execute()." };
    }
    if (
      ["completed","rejected","cancelled"].includes(business.state)
      || (business.state === "failed" && !business.retryable)
    ) {
      return { ...base, decision:"resume", reasonCode:"provider-terminal-result-persisted",
        reason:"A terminal provider result is durable and can be finalized without replay." };
    }
    return { ...base, decision:"reconcile", reasonCode:"provider-boundary-unknown",
      reason:"Provider state is nonterminal without durable operation identity." };
  }
  if (["software-deploy","software-rollback"].includes(spec.spec.kind)) {
    return { ...base, decision:"blocked", reasonCode:"software-mutation-replay-unsafe",
      reason:"A claimed deployment or rollback may have partially mutated production and is blocked from automatic replay." };
  }
  return { ...base, decision:"reconcile", reasonCode:"software-step-ambiguous",
    reason:"A claimed software execution step requires operator reconciliation." };
}

const connectionString = required("DATABASE_URL");
const incidentId = required("GETDONE_DR_INCIDENT_ID");
const sourceBackupSha256 = hash64("GETDONE_DR_BACKUP_SHA256");
const sourceSnapshotHash = hash64("GETDONE_DR_SNAPSHOT_HASH");
const declaredAt = iso("GETDONE_DR_DECLARED_AT", new Date().toISOString());
const lostPrimaryAt = iso("GETDONE_DR_LOST_PRIMARY_AT");
const decidedAt = iso("GETDONE_DR_DECIDED_AT", declaredAt);

const pool = new pg.Pool({
  connectionString,
  max: 2,
  application_name:"getdone-dr-plan",
  ssl: process.env.GETDONE_DB_SSL === "false" ? false : { rejectUnauthorized:true }
});
const client = await pool.connect();

try {
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  const incidentPayload = {
    id:incidentId,declaredAt,lostPrimaryAt,sourceBackupSha256,sourceSnapshotHash,status:"active"
  };
  const incidentHash = sha256Hex(incidentPayload);
  await client.query(
    `INSERT INTO disaster_recovery_incidents
      (id,declared_at,lost_primary_at,source_backup_sha256,source_snapshot_hash,status,incident_hash,payload)
     VALUES($1,$2,$3,$4,$5,'active',$6,$7::jsonb)
     ON CONFLICT(id) DO NOTHING`,
    [incidentId,declaredAt,lostPrimaryAt,sourceBackupSha256,sourceSnapshotHash,incidentHash,JSON.stringify(incidentPayload)]
  );
  const incident = await client.query(
    "SELECT incident_hash,status FROM disaster_recovery_incidents WHERE id=$1 FOR UPDATE",
    [incidentId]
  );
  if (incident.rows[0]?.incident_hash !== incidentHash || incident.rows[0]?.status !== "active") {
    throw new Error("Disaster recovery incident evidence conflicts with persisted incident");
  }

  const rows = await client.query(
    `SELECT r.*,s.payload AS spec_payload,b.payload AS business_payload
     FROM job_runtime_state r
     LEFT JOIN job_execution_specs s ON s.job_id=r.job_id
     LEFT JOIN LATERAL (
       SELECT payload FROM business_action_executions
       WHERE job_id=r.job_id
       ORDER BY updated_at DESC,request_id DESC
       LIMIT 1
     ) b ON true
     ORDER BY r.job_id
     FOR UPDATE OF r`
  );

  const decisions = [];
  for (const row of rows.rows) {
    const classification = classify(row);
    const payload = {
      incidentId,
      jobId:row.job_id,
      portfolioId:row.envelope.scope.portfolioId,
      companyId:row.envelope.scope.companyId,
      runtimeState:row.runtime_state,
      decidedAt,
      ...classification
    };
    const decisionHash = sha256Hex(payload);
    await client.query(
      `INSERT INTO job_disaster_recovery_decisions
        (incident_id,job_id,portfolio_id,company_id,decision,reason_code,runtime_state,
         runtime_hash,spec_hash,provider_record_hash,decided_at,decision_hash,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)
       ON CONFLICT(incident_id,job_id) DO NOTHING`,
      [
        incidentId,row.job_id,row.envelope.scope.portfolioId,row.envelope.scope.companyId,
        classification.decision,classification.reasonCode,row.runtime_state,
        classification.runtimeHash,classification.specHash ?? null,
        classification.providerRecordHash ?? null,decidedAt,decisionHash,JSON.stringify(payload)
      ]
    );
    const persisted = await client.query(
      "SELECT decision_hash FROM job_disaster_recovery_decisions WHERE incident_id=$1 AND job_id=$2",
      [incidentId,row.job_id]
    );
    if (persisted.rows[0]?.decision_hash !== decisionHash) {
      throw new Error(`Disaster recovery decision drifted for ${row.job_id}`);
    }
    decisions.push({ ...payload, decisionHash });
  }
  await client.query("COMMIT");

  const counts = {
    resume: decisions.filter((item) => item.decision === "resume").length,
    reconcile: decisions.filter((item) => item.decision === "reconcile").length,
    blocked: decisions.filter((item) => item.decision === "blocked").length
  };
  console.log(JSON.stringify({ok:true,incidentId,counts,decisions},null,2));
} catch (error) {
  try { await client.query("ROLLBACK"); } catch {}
  throw error;
} finally {
  client.release();
  await pool.end();
}
