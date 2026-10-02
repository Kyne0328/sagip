CREATE TABLE incident_snapshots (
  snapshot_id UUID PRIMARY KEY,
  responder_id UUID NOT NULL REFERENCES responder_identities(responder_id) ON DELETE CASCADE,
  created_at_ms BIGINT NOT NULL CHECK (created_at_ms >= 0),
  expires_at_ms BIGINT NOT NULL CHECK (expires_at_ms > created_at_ms),
  total INTEGER NOT NULL CHECK (total >= 0 AND total <= 10000),
  summary_json JSONB NOT NULL,
  byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE incident_snapshot_pages (
  snapshot_id UUID NOT NULL REFERENCES incident_snapshots(snapshot_id) ON DELETE CASCADE,
  page_index INTEGER NOT NULL CHECK (page_index >= 0),
  cursor_digest BYTEA NOT NULL CHECK (octet_length(cursor_digest) = 32),
  page_json JSONB NOT NULL,
  byte_count INTEGER NOT NULL CHECK (byte_count > 0 AND byte_count <= 4194304),
  PRIMARY KEY (snapshot_id, page_index),
  UNIQUE (snapshot_id, cursor_digest)
);

CREATE INDEX idx_incident_snapshots_owner_expiry
  ON incident_snapshots(responder_id, expires_at_ms);
