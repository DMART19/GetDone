BEGIN;

CREATE TABLE IF NOT EXISTS node_inventory_snapshots (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES compute_nodes(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  architecture text NOT NULL CHECK (architecture IN ('x86_64','arm64')),
  inventory_hash text NOT NULL,
  discovered_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE(node_id, inventory_hash)
);

CREATE INDEX IF NOT EXISTS node_inventory_latest_idx
  ON node_inventory_snapshots(node_id, discovered_at DESC, received_at DESC);

CREATE INDEX IF NOT EXISTS node_inventory_scope_idx
  ON node_inventory_snapshots(portfolio_id, company_id, discovered_at DESC);

INSERT INTO getdone_schema_migrations(version)
VALUES ('2026-09-21.3')
ON CONFLICT (version) DO NOTHING;

COMMIT;
