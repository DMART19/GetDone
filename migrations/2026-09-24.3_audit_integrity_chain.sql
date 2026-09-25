BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION getdone_audit_event_hash(
  p_portfolio_id text,
  p_company_id text,
  p_chain_sequence bigint,
  p_previous_event_hash text,
  p_event_id text,
  p_occurred_at timestamptz,
  p_payload jsonb
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT encode(
    digest(
      concat_ws(
        E'\x1f',
        'getdone-audit-chain-v1',
        p_portfolio_id,
        p_company_id,
        p_chain_sequence::text,
        p_previous_event_hash,
        p_event_id,
        to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
        p_payload::text
      ),
      'sha256'
    ),
    'hex'
  )
$$;

ALTER TABLE audit_events
  ADD COLUMN IF NOT EXISTS chain_sequence bigint,
  ADD COLUMN IF NOT EXISTS previous_event_hash text,
  ADD COLUMN IF NOT EXISTS event_hash text;

CREATE TABLE IF NOT EXISTS audit_chain_heads (
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  head_sequence bigint NOT NULL CHECK (head_sequence >= 1),
  head_hash text NOT NULL CHECK (head_hash ~ '^[a-f0-9]{64}$'),
  event_count bigint NOT NULL CHECK (event_count >= 1),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY(portfolio_id, company_id),
  CHECK (head_sequence = event_count)
);

DO $$
DECLARE
  tenant record;
  event_row record;
  previous_hash text;
  next_hash text;
  next_sequence bigint;
BEGIN
  FOR tenant IN
    SELECT DISTINCT portfolio_id, company_id
    FROM audit_events
    ORDER BY portfolio_id, company_id
  LOOP
    previous_hash := repeat('0', 64);
    next_sequence := 0;

    FOR event_row IN
      SELECT sequence, id, occurred_at, payload
      FROM audit_events
      WHERE portfolio_id = tenant.portfolio_id
        AND company_id = tenant.company_id
      ORDER BY sequence
    LOOP
      next_sequence := next_sequence + 1;
      next_hash := getdone_audit_event_hash(
        tenant.portfolio_id,
        tenant.company_id,
        next_sequence,
        previous_hash,
        event_row.id,
        event_row.occurred_at,
        event_row.payload
      );

      UPDATE audit_events
      SET chain_sequence = next_sequence,
          previous_event_hash = previous_hash,
          event_hash = next_hash
      WHERE sequence = event_row.sequence;

      previous_hash := next_hash;
    END LOOP;

    IF next_sequence > 0 THEN
      INSERT INTO audit_chain_heads(
        portfolio_id, company_id, head_sequence, head_hash, event_count, updated_at
      ) VALUES(
        tenant.portfolio_id, tenant.company_id, next_sequence, previous_hash,
        next_sequence, now()
      )
      ON CONFLICT(portfolio_id, company_id) DO UPDATE
      SET head_sequence = excluded.head_sequence,
          head_hash = excluded.head_hash,
          event_count = excluded.event_count,
          updated_at = excluded.updated_at;
    END IF;
  END LOOP;
END
$$;

ALTER TABLE audit_events
  ALTER COLUMN chain_sequence SET NOT NULL,
  ALTER COLUMN previous_event_hash SET NOT NULL,
  ALTER COLUMN event_hash SET NOT NULL;

ALTER TABLE audit_events
  DROP CONSTRAINT IF EXISTS audit_events_previous_event_hash_check,
  ADD CONSTRAINT audit_events_previous_event_hash_check
    CHECK (previous_event_hash ~ '^[a-f0-9]{64}$'),
  DROP CONSTRAINT IF EXISTS audit_events_event_hash_check,
  ADD CONSTRAINT audit_events_event_hash_check
    CHECK (event_hash ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX IF NOT EXISTS audit_events_chain_sequence_idx
  ON audit_events(portfolio_id, company_id, chain_sequence);
CREATE INDEX IF NOT EXISTS audit_events_chain_hash_idx
  ON audit_events(portfolio_id, company_id, event_hash);

GRANT SELECT,INSERT ON audit_events TO getdone_tenant_runtime;
REVOKE UPDATE,DELETE ON audit_events FROM getdone_tenant_runtime;
GRANT SELECT,INSERT,UPDATE ON audit_chain_heads TO getdone_tenant_runtime;
REVOKE DELETE ON audit_chain_heads FROM getdone_tenant_runtime;

ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS getdone_tenant_isolation ON audit_chain_heads;
CREATE POLICY getdone_tenant_isolation ON audit_chain_heads
  USING (getdone_tenant_scope_matches(portfolio_id,company_id))
  WITH CHECK (getdone_tenant_scope_matches(portfolio_id,company_id));

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-24.3')
ON CONFLICT (version) DO NOTHING;

COMMIT;
