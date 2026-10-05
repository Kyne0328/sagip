-- Additive, default-empty registry. Source installation does not enroll authority.
CREATE TABLE offline_root_domains (
  authority_domain_id VARCHAR(64) PRIMARY KEY,
  policy_digest CHAR(64) NOT NULL,
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  authority_state_digest CHAR(64) NOT NULL,
  checked_at_earliest_ms BIGINT NOT NULL DEFAULT 0 CHECK (checked_at_earliest_ms >= 0)
);
CREATE TABLE offline_root_subjects (
  authority_domain_id VARCHAR(64) NOT NULL REFERENCES offline_root_domains(authority_domain_id),
  subject_kind VARCHAR(8) NOT NULL CHECK (subject_kind IN ('KEY','PROVIDER')),
  subject_id CHAR(64) NOT NULL,
  revoked_at_ms BIGINT,
  PRIMARY KEY(authority_domain_id,subject_kind,subject_id)
);
CREATE TABLE offline_root_snapshots (
  event_id UUID NOT NULL REFERENCES receipt_records(event_id),
  authority_domain_id VARCHAR(64) NOT NULL REFERENCES offline_root_domains(authority_domain_id),
  proof_id UUID PRIMARY KEY,
  receipt_digest CHAR(64) NOT NULL,
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  authority_state_digest CHAR(64) NOT NULL,
  proof_bytes BYTEA NOT NULL CHECK (octet_length(proof_bytes) BETWEEN 74 AND 4096),
  bundle_bytes BYTEA NOT NULL CHECK (octet_length(bundle_bytes) BETWEEN 154 AND 8192),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > 0)
);
CREATE INDEX idx_offline_root_snapshot_event ON offline_root_snapshots(event_id,expires_at_ms);
CREATE TABLE offline_root_revocations (
  revocation_id UUID PRIMARY KEY,
  authority_domain_id VARCHAR(64) NOT NULL REFERENCES offline_root_domains(authority_domain_id),
  target_kind VARCHAR(8) NOT NULL CHECK (target_kind IN ('KEY','PROVIDER')),
  target_id CHAR(64) NOT NULL,
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  authority_state_digest CHAR(64) NOT NULL,
  object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) BETWEEN 74 AND 4096),
  operator_id UUID NOT NULL REFERENCES responder_identities(responder_id),
  revoked_at_ms BIGINT NOT NULL CHECK (revoked_at_ms >= 0),
  UNIQUE(authority_domain_id,target_kind,target_id)
);
CREATE TABLE offline_root_registry_audit (
  audit_id UUID PRIMARY KEY,
  authority_domain_id VARCHAR(64) NOT NULL REFERENCES offline_root_domains(authority_domain_id),
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('ENROLLED','SNAPSHOT','REVOKED')),
  object_id UUID NOT NULL,
  revocation_epoch BIGINT NOT NULL CHECK (revocation_epoch > 0),
  authority_state_digest CHAR(64) NOT NULL,
  occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0)
);
