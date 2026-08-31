-- per-operator control-plane credentials replacing the shared
-- LIP_CLOUD_API_KEY + trusted X-LIP-Cloud-Subject header.

CREATE TABLE IF NOT EXISTS lip_cloud_operators (
  operator_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT NOT NULL CHECK (role IN ('platform-admin', 'org-scoped')),
  -- JSON array of organization ids; present exactly when role = 'org-scoped'.
  organization_ids JSONB,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CHECK ((role = 'org-scoped') = (organization_ids IS NOT NULL)),
  CHECK (char_length(subject) BETWEEN 1 AND 200)
);

CREATE TABLE IF NOT EXISTS lip_cloud_operator_api_keys (
  key_id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES lip_cloud_operators (operator_id)
    ON DELETE CASCADE,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CHECK (active OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS lip_cloud_operator_api_keys_operator_idx
  ON lip_cloud_operator_api_keys (operator_id, created_at);

-- Operator lifecycle events are platform-level, so they cannot live in
-- lip_cloud_audit_log (NOT NULL FK to organizations).
CREATE TABLE IF NOT EXISTS lip_cloud_operator_audit (
  audit_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  metadata JSONB,
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS lip_cloud_operator_audit_time_idx
  ON lip_cloud_operator_audit (occurred_at DESC);
