-- Issuer-side replay history supplements (never replaces) verifier challenge state.
CREATE TABLE receipt_authority_time_state (
  verifier_id BYTEA PRIMARY KEY CHECK (octet_length(verifier_id) = 32),
  high_water_earliest_ms BIGINT NOT NULL CHECK (high_water_earliest_ms >= 0)
);
CREATE TABLE receipt_authority_time_proofs (
  verifier_id BYTEA NOT NULL CHECK (octet_length(verifier_id) = 32),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 32),
  verifier_boot_id UUID NOT NULL,
  responder_id UUID NOT NULL REFERENCES responder_identities(responder_id),
  signed_time_ms BIGINT NOT NULL CHECK (signed_time_ms >= 0),
  valid_until_ms BIGINT NOT NULL CHECK (valid_until_ms > signed_time_ms),
  object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) BETWEEN 80 AND 8192),
  PRIMARY KEY (verifier_id, nonce)
);
CREATE INDEX idx_receipt_authority_time_verifier ON receipt_authority_time_proofs(verifier_id, signed_time_ms);

CREATE TABLE receipt_authority_audit (
  audit_id UUID PRIMARY KEY,
  grant_id UUID NOT NULL REFERENCES receipt_authority_grants(grant_id),
  event_type VARCHAR(16) NOT NULL CHECK (event_type IN ('ISSUED', 'REVOKED')),
  operator_id UUID NOT NULL REFERENCES responder_identities(responder_id),
  operator_callsign VARCHAR(64) NOT NULL,
  operator_role VARCHAR(32) NOT NULL CHECK (operator_role = 'AUTHORITY_ADMIN'),
  occurred_at_ms BIGINT NOT NULL CHECK (occurred_at_ms >= 0),
  reason TEXT NOT NULL CHECK (octet_length(reason) <= 1024),
  UNIQUE (grant_id, event_type),
  CHECK (event_type = 'ISSUED' OR octet_length(reason) > 0)
);
