CREATE TABLE responder_sessions (
  session_hash VARCHAR(64) PRIMARY KEY,
  responder_id UUID NOT NULL REFERENCES responder_identities(responder_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE INDEX idx_responder_sessions_responder
  ON responder_sessions(responder_id, expires_at DESC);

CREATE INDEX idx_responder_sessions_expiry
  ON responder_sessions(expires_at);
