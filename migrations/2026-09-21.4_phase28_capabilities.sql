BEGIN;

CREATE TABLE IF NOT EXISTS node_capability_profiles (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES compute_nodes(id),
  portfolio_id text NOT NULL,
  company_id text NOT NULL,
  profile_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  result_payload jsonb NOT NULL,
  UNIQUE(node_id, profile_hash)
);

CREATE INDEX IF NOT EXISTS node_capability_profiles_latest_idx
  ON node_capability_profiles(node_id, observed_at DESC, received_at DESC);

CREATE TABLE IF NOT EXISTS node_capability_state (
  node_id text NOT NULL REFERENCES compute_nodes(id),
  capability_name text NOT NULL,
  capability_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('detected','validated','disabled','degraded')),
  observed_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY(node_id, capability_name)
);

CREATE INDEX IF NOT EXISTS node_capability_state_status_idx
  ON node_capability_state(node_id, status, capability_name);

CREATE TABLE IF NOT EXISTS node_capability_history (
  id text PRIMARY KEY,
  node_id text NOT NULL REFERENCES compute_nodes(id),
  capability_name text NOT NULL,
  capability_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('detected','validated','disabled','degraded')),
  observed_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE(node_id, capability_name, capability_hash)
);

CREATE INDEX IF NOT EXISTS node_capability_history_node_idx
  ON node_capability_history(node_id, capability_name, observed_at DESC);

COMMIT;
