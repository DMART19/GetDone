import pg from "pg";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const connectionString = required("DATABASE_URL");
const portfolioFilter = process.env.GETDONE_AUDIT_VERIFY_PORTFOLIO_ID?.trim();
const companyFilter = process.env.GETDONE_AUDIT_VERIFY_COMPANY_ID?.trim();
if ((portfolioFilter && !companyFilter) || (!portfolioFilter && companyFilter)) {
  throw new Error(
    "GETDONE_AUDIT_VERIFY_PORTFOLIO_ID and GETDONE_AUDIT_VERIFY_COMPANY_ID must be provided together"
  );
}

const pool = new pg.Pool({
  connectionString,
  max: 2,
  application_name: "getdone-audit-integrity-verifier",
  ssl: process.env.GETDONE_DB_SSL === "false"
    ? false
    : { rejectUnauthorized: true }
});

const where = portfolioFilter
  ? "WHERE ae.portfolio_id=$1 AND ae.company_id=$2"
  : "";
const headWhere = portfolioFilter
  ? "WHERE portfolio_id=$1 AND company_id=$2"
  : "";
const values = portfolioFilter ? [portfolioFilter, companyFilter] : [];

try {
  const [headResult, eventResult] = await Promise.all([
    pool.query(
      `SELECT portfolio_id,company_id,head_sequence,head_hash,event_count,updated_at
       FROM audit_chain_heads
       ${headWhere}
       ORDER BY portfolio_id,company_id`,
      values
    ),
    pool.query(
      `SELECT
         ae.sequence AS storage_sequence,
         ae.id,
         ae.portfolio_id,
         ae.company_id,
         ae.chain_sequence,
         ae.previous_event_hash,
         ae.event_hash,
         getdone_audit_event_hash(
           ae.portfolio_id,
           ae.company_id,
           ae.chain_sequence,
           ae.previous_event_hash,
           ae.id,
           ae.occurred_at,
           ae.payload
         ) AS computed_hash
       FROM audit_events ae
       ${where}
       ORDER BY ae.portfolio_id,ae.company_id,ae.chain_sequence`,
      values
    )
  ]);

  const ledgerKey = (portfolioId, companyId) => `${portfolioId}\u001f${companyId}`;
  const heads = new Map(
    headResult.rows.map((row) => [
      ledgerKey(row.portfolio_id, row.company_id),
      row
    ])
  );
  const ledgers = new Map();

  for (const row of eventResult.rows) {
    const key = ledgerKey(row.portfolio_id, row.company_id);
    const list = ledgers.get(key) ?? [];
    list.push(row);
    ledgers.set(key, list);
  }

  const allKeys = new Set([...heads.keys(), ...ledgers.keys()]);
  const failures = [];
  let verifiedEvents = 0;

  for (const key of [...allKeys].sort()) {
    const head = heads.get(key);
    const events = ledgers.get(key) ?? [];
    const [portfolioId, companyId] = key.split("\u001f");

    if (!head) {
      failures.push({
        portfolioId,
        companyId,
        code: "MISSING_CHAIN_HEAD",
        message: "Audit events exist without an authoritative chain head"
      });
      continue;
    }
    if (events.length === 0) {
      failures.push({
        portfolioId,
        companyId,
        code: "ORPHAN_CHAIN_HEAD",
        message: "Audit chain head exists without any audit events"
      });
      continue;
    }

    const expectedCount = Number(head.event_count);
    const headSequence = Number(head.head_sequence);
    if (expectedCount !== events.length) {
      failures.push({
        portfolioId,
        companyId,
        code: "EVENT_COUNT_MISMATCH",
        expected: expectedCount,
        actual: events.length
      });
    }
    if (headSequence !== events.length) {
      failures.push({
        portfolioId,
        companyId,
        code: "HEAD_SEQUENCE_MISMATCH",
        expected: headSequence,
        actual: events.length
      });
    }

    let previousHash = "0".repeat(64);
    let previousStorageSequence = -1;
    for (let index = 0; index < events.length; index += 1) {
      const event = events[index];
      const expectedSequence = index + 1;
      const chainSequence = Number(event.chain_sequence);
      const storageSequence = Number(event.storage_sequence);

      if (chainSequence !== expectedSequence) {
        failures.push({
          portfolioId,
          companyId,
          eventId: event.id,
          code: "CHAIN_SEQUENCE_GAP_OR_REORDER",
          expected: expectedSequence,
          actual: chainSequence
        });
      }
      if (storageSequence <= previousStorageSequence) {
        failures.push({
          portfolioId,
          companyId,
          eventId: event.id,
          code: "STORAGE_SEQUENCE_REORDER",
          previousStorageSequence,
          storageSequence
        });
      }
      if (event.previous_event_hash !== previousHash) {
        failures.push({
          portfolioId,
          companyId,
          eventId: event.id,
          code: "PREVIOUS_HASH_MISMATCH",
          expected: previousHash,
          actual: event.previous_event_hash
        });
      }
      if (event.event_hash !== event.computed_hash) {
        failures.push({
          portfolioId,
          companyId,
          eventId: event.id,
          code: "EVENT_HASH_MISMATCH",
          stored: event.event_hash,
          computed: event.computed_hash
        });
      }

      previousHash = event.event_hash;
      previousStorageSequence = storageSequence;
      verifiedEvents += 1;
    }

    if (head.head_hash !== previousHash) {
      failures.push({
        portfolioId,
        companyId,
        code: "HEAD_HASH_MISMATCH",
        expected: head.head_hash,
        actual: previousHash
      });
    }
  }

  const output = {
    ok: failures.length === 0,
    verifier: "audit-ledger-integrity",
    ledgerCount: allKeys.size,
    verifiedEvents,
    failures
  };

  if (failures.length > 0) {
    console.error(JSON.stringify(output, null, 2));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(output, null, 2));
  }
} finally {
  await pool.end();
}
