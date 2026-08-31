-- Durable merchant-credential issuance.
--
-- Minting a merchant key is the one control-plane operation whose result
-- cannot be recomputed: the secret is returned once and never stored in
-- recoverable form anywhere in this system. A caller that loses the response
-- to a timeout, a crash, or a redeploy has no way to ask for it again, and
-- retrying blindly mints a second live owner key nobody holds.
--
-- This table makes the operation replayable. The idempotency key identifies the
-- caller's intent; the fingerprint proves the retry is the same request rather
-- than a different one wearing the same key; and the encrypted handoff lets an
-- honest retry receive the identical answer for a bounded window.
--
-- What is deliberately absent: any plaintext credential. The handoff column
-- holds an AES-256-GCM envelope bound to this environment and this operation,
-- and it is erased on expiry while the non-secret operation and audit metadata
-- around it survive.

CREATE TABLE IF NOT EXISTS lip_cloud_credential_operations (
  credential_operation_id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL
    REFERENCES lip_cloud_environments (environment_id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  -- A hash of the request that first claimed this key. A retry that hashes
  -- differently is a different request and is refused rather than served the
  -- first request's credential.
  request_fingerprint TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'rotate')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'issued', 'failed')),
  actor_subject TEXT NOT NULL,
  -- Recorded the moment the key exists, before the response is persisted, so a
  -- crash in that window leaves the orphan identifiable instead of anonymous.
  issued_key_id TEXT,
  replaced_key_expires_at TIMESTAMPTZ,
  handoff_envelope JSONB,
  handoff_expires_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  UNIQUE (environment_id, idempotency_key),
  -- An issued operation must carry the identity of what it issued; a handoff
  -- without an expiry could never be reclaimed by the retention sweep.
  CHECK (state <> 'issued' OR issued_key_id IS NOT NULL),
  CHECK (handoff_envelope IS NULL OR handoff_expires_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS lip_cloud_credential_operations_environment_idx
  ON lip_cloud_credential_operations (environment_id, created_at DESC);

-- Drives the retention sweep that erases expired handoffs while leaving the
-- operation record behind.
CREATE INDEX IF NOT EXISTS lip_cloud_credential_operations_handoff_expiry_idx
  ON lip_cloud_credential_operations (handoff_expires_at)
  WHERE handoff_envelope IS NOT NULL;
