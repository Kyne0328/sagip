-- Additive expansion. Roll back application code without dropping signed evidence.
ALTER TABLE incidents ADD COLUMN receipt_version BIGINT NOT NULL DEFAULT 0 CHECK (receipt_version >= 0);
UPDATE incidents SET receipt_version = accepted.revisions
FROM (SELECT report_id, COUNT(*) AS revisions FROM accepted_messages GROUP BY report_id) AS accepted
WHERE incidents.report_id = accepted.report_id;

CREATE TABLE receipt_sequences (
  issuer_key_id BYTEA NOT NULL CHECK (octet_length(issuer_key_id) = 32),
  grant_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES incidents(report_id),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  PRIMARY KEY (issuer_key_id, grant_id, report_id)
);
CREATE TABLE receipt_actions (
  action_id UUID PRIMARY KEY,
  issuer_provider_id BYTEA NOT NULL CHECK (octet_length(issuer_provider_id) = 32),
  action_digest BYTEA NOT NULL CHECK (octet_length(action_digest) = 32),
  issuer_key_id BYTEA NOT NULL CHECK (octet_length(issuer_key_id) = 32),
  grant_id UUID NOT NULL,
  report_id UUID NOT NULL REFERENCES incidents(report_id),
  responder_id UUID NOT NULL REFERENCES responder_identities(responder_id),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  fields JSONB NOT NULL,
  preparation_state VARCHAR(16) NOT NULL CHECK (preparation_state IN ('PREPARING', 'SIGNED')),
  lease_token UUID,
  lease_until_ms BIGINT,
  UNIQUE (issuer_key_id, grant_id, report_id, sequence)
);
CREATE TABLE receipt_records (
  event_id UUID PRIMARY KEY,
  issuer_provider_id BYTEA NOT NULL CHECK (octet_length(issuer_provider_id) = 32),
  action_digest BYTEA NOT NULL CHECK (octet_length(action_digest) = 32),
  event_digest BYTEA NOT NULL CHECK (octet_length(event_digest) = 32),
  object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) BETWEEN 80 AND 8192),
  forwarding_expires_at_ms BIGINT NOT NULL CHECK (forwarding_expires_at_ms >= 0)
);
CREATE TABLE receipt_projections (
  issuer_provider_id BYTEA NOT NULL CHECK (octet_length(issuer_provider_id) = 32),
  report_id UUID NOT NULL REFERENCES incidents(report_id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  event_id UUID NOT NULL REFERENCES receipt_records(event_id),
  PRIMARY KEY (issuer_provider_id, report_id)
);
CREATE TABLE receipt_authority_grants (
  grant_id UUID PRIMARY KEY,
  provisioning_request_id UUID NOT NULL UNIQUE,
  request_digest BYTEA NOT NULL CHECK (octet_length(request_digest) = 32),
  issuer_provider_id BYTEA NOT NULL CHECK (octet_length(issuer_provider_id) = 32),
  issuer_key_id BYTEA NOT NULL CHECK (octet_length(issuer_key_id) = 32),
  root_key_id BYTEA NOT NULL CHECK (octet_length(root_key_id) = 32),
  object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) BETWEEN 80 AND 8192),
  not_before_ms BIGINT NOT NULL,
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > not_before_ms),
  revoked_at_ms BIGINT
);
CREATE INDEX idx_receipt_records_expiry ON receipt_records(forwarding_expires_at_ms);
