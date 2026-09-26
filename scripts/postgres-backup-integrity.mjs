import crypto from "node:crypto";

export function canonicalSerialize(value) {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalSerialize).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalSerialize(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(canonicalSerialize(value)).digest("hex");
}

export function fileSha256(fs, path) {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

async function rows(db, sql) {
  const result = await db.query(sql);
  return result.rows;
}

export async function readSnapshotComponents(db) {
  const [
    entities,
    grants,
    consumptions,
    jobRuntime,
    jobTransactions,
    jobOutcomes,
    receipts,
    auditEvents,
    auditHeads
  ] = await Promise.all([
    rows(db, `SELECT entity_type,id,portfolio_id,company_id,version,updated_at,payload
              FROM control_plane_entities ORDER BY entity_type,id`),
    rows(db, `SELECT id,portfolio_id,company_id,status,expires_at,grant_hash,payload
              FROM authorization_grants ORDER BY id`),
    rows(db, `SELECT id,grant_id,consumer_type,consumer_id,consumption_hash,consumed_at,payload
              FROM authorization_consumptions ORDER BY id`),
    rows(db, `SELECT job_id,envelope,envelope_hash,runtime_state,version,state_hash,attempt,
                     scheduled_at,cancelled_reason,updated_at
              FROM job_runtime_state ORDER BY job_id`),
    rows(db, `SELECT id,job_id,operation,idempotency_key,transaction_hash,payload,occurred_at
              FROM job_runtime_transactions ORDER BY job_id,occurred_at,id`),
    rows(db, `SELECT id,job_id,kind,runtime_state,attempt,occurred_at,transaction_hash,record_hash,payload
              FROM job_execution_outcomes ORDER BY job_id,occurred_at,id`),
    rows(db, `SELECT id,portfolio_id,company_id,subject_type,subject_id,expires_at,receipt_hash,payload
              FROM verification_receipts ORDER BY id`),
    rows(db, `SELECT sequence,id,correlation_id,portfolio_id,company_id,entity_type,entity_id,
                     occurred_at,payload,chain_sequence,previous_event_hash,event_hash
              FROM audit_events ORDER BY portfolio_id,company_id,chain_sequence`),
    rows(db, `SELECT portfolio_id,company_id,head_sequence,head_hash,event_count,updated_at
              FROM audit_chain_heads ORDER BY portfolio_id,company_id`)
  ]);

  return {
    entities,
    authorization: { grants, consumptions },
    jobs: { runtime: jobRuntime, transactions: jobTransactions, outcomes: jobOutcomes },
    verificationReceipts: receipts,
    audit: { events: auditEvents, heads: auditHeads }
  };
}

export function snapshotHashes(components) {
  const hashes = {
    controlPlaneEntities: sha256Hex(components.entities),
    authorizationLineage: sha256Hex(components.authorization),
    jobState: sha256Hex(components.jobs),
    verificationReceipts: sha256Hex(components.verificationReceipts),
    auditLedger: sha256Hex(components.audit)
  };
  return {
    ...hashes,
    composite: sha256Hex(hashes)
  };
}

function sameJson(left, right) {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

export async function verifyRestoredInvariants(db) {
  const failures = [];

  const entities = await db.query(
    `SELECT entity_type,id,portfolio_id,company_id,version,updated_at,payload
     FROM control_plane_entities ORDER BY entity_type,id`
  );
  for (const row of entities.rows) {
    const payload = row.payload ?? {};
    if (
      payload.id !== row.id
      || payload.portfolioId !== row.portfolio_id
      || payload.companyId !== row.company_id
      || Number(payload.version) !== Number(row.version)
    ) {
      failures.push({
        code: "ENTITY_COLUMN_HASH_ENVELOPE_MISMATCH",
        entityType: row.entity_type,
        entityId: row.id
      });
    }
  }

  const grants = await db.query(
    `SELECT id,portfolio_id,company_id,status,grant_hash,payload
     FROM authorization_grants ORDER BY id`
  );
  const grantById = new Map();
  for (const row of grants.rows) {
    const payload = row.payload ?? {};
    grantById.set(row.id, payload);
    if (
      payload.id !== row.id
      || payload.grantHash !== row.grant_hash
      || payload.scope?.portfolioId !== row.portfolio_id
      || payload.scope?.companyId !== row.company_id
      || payload.status !== row.status
    ) {
      failures.push({ code: "AUTHORIZATION_GRANT_ENVELOPE_MISMATCH", grantId: row.id });
    }
    if (row.status !== "revoked") {
      const { grantHash, ...base } = payload;
      if (sha256Hex(base) !== row.grant_hash) {
        failures.push({ code: "AUTHORIZATION_GRANT_HASH_MISMATCH", grantId: row.id });
      }
    }
  }

  const consumptions = await db.query(
    `SELECT id,grant_id,consumer_type,consumer_id,consumption_hash,payload
     FROM authorization_consumptions ORDER BY id`
  );
  for (const row of consumptions.rows) {
    const payload = row.payload ?? {};
    const grant = grantById.get(row.grant_id);
    const { consumptionHash, ...base } = payload;
    if (
      !grant
      || payload.id !== row.id
      || payload.grantId !== row.grant_id
      || payload.consumerType !== row.consumer_type
      || payload.consumerId !== row.consumer_id
      || payload.consumptionHash !== row.consumption_hash
      || sha256Hex(base) !== row.consumption_hash
      || payload.grantHash !== grant.grantHash
      || payload.planHash !== grant.planHash
      || payload.stepHash !== grant.stepHash
      || !sameJson(payload.scope, grant.scope)
    ) {
      failures.push({
        code: "AUTHORIZATION_CONSUMPTION_LINEAGE_MISMATCH",
        consumptionId: row.id,
        grantId: row.grant_id
      });
    }
  }

  const jobRuntime = await db.query(
    `SELECT job_id,envelope,envelope_hash,runtime_state,version,state_hash
     FROM job_runtime_state ORDER BY job_id`
  );
  for (const row of jobRuntime.rows) {
    const envelope = row.envelope ?? {};
    const { envelopeHash, ...baseEnvelope } = envelope;
    if (
      envelope.jobId !== row.job_id
      || envelopeHash !== row.envelope_hash
      || sha256Hex(baseEnvelope) !== row.envelope_hash
    ) {
      failures.push({ code: "JOB_ENVELOPE_HASH_MISMATCH", jobId: row.job_id });
    }

    const latest = await db.query(
      `SELECT transaction_hash,payload
       FROM job_runtime_transactions
       WHERE job_id=$1
       ORDER BY occurred_at DESC,id DESC
       LIMIT 1`,
      [row.job_id]
    );
    const transaction = latest.rows[0];
    if (!transaction) {
      failures.push({ code: "JOB_TRANSACTION_LINEAGE_MISSING", jobId: row.job_id });
      continue;
    }
    const payload = transaction.payload ?? {};
    const { transactionHash, ...baseTransaction } = payload;
    if (
      transactionHash !== transaction.transaction_hash
      || sha256Hex(baseTransaction) !== transaction.transaction_hash
      || payload.jobId !== row.job_id
      || Number(payload.nextVersion) !== Number(row.version)
      || payload.nextHash !== row.state_hash
    ) {
      failures.push({ code: "JOB_STATE_HASH_MISMATCH", jobId: row.job_id });
    }
  }

  const receipts = await db.query(
    `SELECT id,portfolio_id,company_id,subject_type,subject_id,receipt_hash,payload
     FROM verification_receipts ORDER BY id`
  );
  for (const row of receipts.rows) {
    const payload = row.payload ?? {};
    const { receiptHash, ...base } = payload;
    if (
      payload.id !== row.id
      || payload.portfolioId !== row.portfolio_id
      || payload.companyId !== row.company_id
      || payload.subject?.type !== row.subject_type
      || payload.subject?.id !== row.subject_id
      || payload.receiptHash !== row.receipt_hash
      || sha256Hex(base) !== row.receipt_hash
    ) {
      failures.push({ code: "VERIFICATION_RECEIPT_HASH_MISMATCH", receiptId: row.id });
    }
  }

  return {
    ok: failures.length === 0,
    entityCount: entities.rows.length,
    authorizationGrantCount: grants.rows.length,
    authorizationConsumptionCount: consumptions.rows.length,
    jobStateCount: jobRuntime.rows.length,
    verificationReceiptCount: receipts.rows.length,
    failures
  };
}
