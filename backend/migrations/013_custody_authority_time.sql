-- Custody verifier identities are installation keys, not SOS origin keys.
-- Independent bounded ledger; preserve the existing origin proof history and constraints.
CREATE TABLE custody_authority_time_proofs (
  verifier_id BYTEA NOT NULL CHECK (octet_length(verifier_id)=32),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce)=32),
  verifier_boot_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES incidents(report_id),
  signed_time_ms BIGINT NOT NULL CHECK (signed_time_ms>=0),
  valid_until_ms BIGINT NOT NULL CHECK (valid_until_ms>signed_time_ms),
  object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) BETWEEN 80 AND 8192),
  PRIMARY KEY(verifier_id,nonce)
);
CREATE INDEX idx_custody_time_rate ON custody_authority_time_proofs(verifier_id,signed_time_ms);
