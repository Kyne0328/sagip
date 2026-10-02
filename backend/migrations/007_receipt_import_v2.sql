ALTER TABLE receipt_records ADD COLUMN report_id UUID REFERENCES incidents(report_id);
ALTER TABLE receipt_records ADD COLUMN revision INTEGER CHECK (revision IS NULL OR revision > 0);
ALTER TABLE receipt_records ADD COLUMN object_kind VARCHAR(4) CHECK (object_kind IS NULL OR object_kind IN ('SGA2','SGR2'));
ALTER TABLE receipt_records ADD COLUMN verification VARCHAR(32);
ALTER TABLE receipt_records ADD COLUMN recorded_at_ms BIGINT CHECK (recorded_at_ms IS NULL OR recorded_at_ms >= 0);

UPDATE receipt_records
SET report_id = a.report_id,
    revision = CAST(a.fields->>'revision' AS INTEGER),
    object_kind = 'SGA2',
    verification = 'VERIFIED_CURRENT',
    recorded_at_ms = CAST(a.fields->>'issuedAtMs' AS BIGINT)
FROM receipt_actions AS a
WHERE receipt_records.event_id = a.action_id AND receipt_records.report_id IS NULL;

CREATE INDEX idx_receipt_records_report_time
  ON receipt_records(report_id, recorded_at_ms, event_id)
  WHERE report_id IS NOT NULL;

CREATE TABLE receipt_quarantine (
  quarantine_id UUID PRIMARY KEY,
  event_id UUID,
  report_id UUID NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  object_kind VARCHAR(4) NOT NULL CHECK (object_kind IN ('SGA2','SGR2')),
  issuer_provider_id BYTEA CHECK (issuer_provider_id IS NULL OR octet_length(issuer_provider_id) = 32),
  action_digest BYTEA CHECK (action_digest IS NULL OR octet_length(action_digest) = 32),
  event_digest BYTEA NOT NULL UNIQUE CHECK (octet_length(event_digest) = 32),
  object_bytes BYTEA NOT NULL CHECK (octet_length(object_bytes) BETWEEN 80 AND 8192),
  verification VARCHAR(32) NOT NULL,
  reason VARCHAR(64) NOT NULL CHECK (reason <> ''),
  recorded_at_ms BIGINT NOT NULL CHECK (recorded_at_ms >= 0)
);
CREATE INDEX idx_receipt_quarantine_report_time
  ON receipt_quarantine(report_id, recorded_at_ms, quarantine_id);

CREATE TABLE receipt_access_challenges (
  challenge_id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES incidents(report_id),
  origin_key_id BYTEA NOT NULL REFERENCES origin_keys(origin_key_id) CHECK (octet_length(origin_key_id) = 32),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 32),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
  consumed_at_ms BIGINT CHECK (consumed_at_ms IS NULL OR consumed_at_ms >= created_at_ms)
);
CREATE INDEX idx_receipt_access_challenge_expiry ON receipt_access_challenges(expires_at_ms);

CREATE TABLE receipt_access_sessions (
  session_digest BYTEA PRIMARY KEY CHECK (octet_length(session_digest) = 32),
  report_id UUID NOT NULL REFERENCES incidents(report_id),
  origin_key_id BYTEA NOT NULL REFERENCES origin_keys(origin_key_id) CHECK (octet_length(origin_key_id) = 32),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms)
);
CREATE INDEX idx_receipt_access_session_report ON receipt_access_sessions(report_id, expires_at_ms);
