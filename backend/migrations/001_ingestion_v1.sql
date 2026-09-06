CREATE TABLE origin_keys (
  origin_key_id BYTEA PRIMARY KEY,
  public_key_der BYTEA NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  CHECK (octet_length(origin_key_id) = 32),
  CHECK (octet_length(public_key_der) BETWEEN 1 AND 512)
);

CREATE TABLE incidents (
  report_id UUID PRIMARY KEY,
  origin_key_id BYTEA NOT NULL REFERENCES origin_keys(origin_key_id),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  first_received_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE incident_revisions (
  report_id UUID NOT NULL REFERENCES incidents(report_id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  emergency_type SMALLINT NOT NULL CHECK (emergency_type BETWEEN 1 AND 6),
  urgency SMALLINT NOT NULL CHECK (urgency BETWEEN 1 AND 2),
  payload_digest BYTEA NOT NULL CHECK (octet_length(payload_digest) = 32),
  location_latitude_e6 INTEGER,
  location_longitude_e6 INTEGER,
  location_accuracy_cm INTEGER,
  location_captured_at_ms BIGINT,
  location_source SMALLINT,
  location_freshness SMALLINT,
  PRIMARY KEY (report_id, revision),
  CHECK (location_latitude_e6 IS NULL OR location_latitude_e6 BETWEEN -90000000 AND 90000000),
  CHECK (location_longitude_e6 IS NULL OR location_longitude_e6 BETWEEN -180000000 AND 180000000),
  CHECK (location_accuracy_cm IS NULL OR location_accuracy_cm >= 0),
  CHECK (location_captured_at_ms IS NULL OR location_captured_at_ms >= 0),
  CHECK (location_source IS NULL OR location_source IN (1, 2)),
  CHECK (location_freshness IS NULL OR location_freshness IN (1, 2))
);

CREATE TABLE accepted_messages (
  message_id UUID PRIMARY KEY,
  report_id UUID NOT NULL,
  revision INTEGER NOT NULL,
  origin_key_id BYTEA NOT NULL REFERENCES origin_keys(origin_key_id),
  envelope_sha256 BYTEA NOT NULL CHECK (octet_length(envelope_sha256) = 32),
  envelope_bytes BYTEA NOT NULL CHECK (octet_length(envelope_bytes) BETWEEN 1 AND 8192),
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms BIGINT,
  priority INTEGER NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL,
  UNIQUE (report_id, revision),
  FOREIGN KEY (report_id, revision) REFERENCES incident_revisions(report_id, revision) ON DELETE CASCADE,
  CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0)
);

CREATE TABLE server_receipts (
  message_id UUID PRIMARY KEY REFERENCES accepted_messages(message_id) ON DELETE CASCADE,
  receipt_id UUID NOT NULL UNIQUE,
  receipt_version SMALLINT NOT NULL DEFAULT 1 CHECK (receipt_version = 1),
  state TEXT NOT NULL CHECK (state = 'SERVER_ACCEPTED'),
  accepted_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_accepted_messages_report ON accepted_messages(report_id, revision);
CREATE INDEX idx_incidents_origin_key ON incidents(origin_key_id);
