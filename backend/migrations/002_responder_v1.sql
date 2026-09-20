CREATE TABLE responder_identities (
  responder_id UUID PRIMARY KEY,
  callsign VARCHAR(64) NOT NULL UNIQUE,
  role VARCHAR(32) NOT NULL,
  api_key_hash VARCHAR(64) NOT NULL UNIQUE,
  registered_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE responder_acknowledgements (
  ack_id UUID PRIMARY KEY,
  report_id UUID NOT NULL REFERENCES incidents(report_id) ON DELETE CASCADE,
  responder_id UUID NOT NULL REFERENCES responder_identities(responder_id) ON DELETE CASCADE,
  status VARCHAR(32) NOT NULL CHECK (status IN ('ACKNOWLEDGED', 'EN_ROUTE', 'ON_SCENE', 'RESOLVED')),
  note TEXT,
  acknowledged_at TIMESTAMPTZ NOT NULL,
  UNIQUE (report_id, responder_id, status)
);

CREATE INDEX idx_responder_acks_report ON responder_acknowledgements(report_id, acknowledged_at DESC);
CREATE INDEX idx_responder_identities_hash ON responder_identities(api_key_hash);
