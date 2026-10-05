CREATE TABLE origin_authority_time_proofs (
  verifier_id BYTEA NOT NULL REFERENCES origin_keys(origin_key_id),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce)=32),
  verifier_boot_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES incidents(report_id),
  signed_time_ms BIGINT NOT NULL CHECK (signed_time_ms>=0),
  valid_until_ms BIGINT NOT NULL CHECK (valid_until_ms>signed_time_ms),
  object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) BETWEEN 80 AND 8192),
  PRIMARY KEY(verifier_id,nonce)
);
CREATE INDEX idx_origin_time_rate ON origin_authority_time_proofs(verifier_id,signed_time_ms);
