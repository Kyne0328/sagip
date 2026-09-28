CREATE TABLE request_rate_limit_windows (
  bucket_key VARCHAR(64) NOT NULL,
  window_start_ms BIGINT NOT NULL CHECK (window_start_ms >= 0),
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (bucket_key, window_start_ms)
);

CREATE INDEX idx_request_rate_limit_window
  ON request_rate_limit_windows(window_start_ms);
