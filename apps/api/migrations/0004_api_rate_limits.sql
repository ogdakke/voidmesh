CREATE TABLE api_rate_limits (
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope, key_hash)
) STRICT;

CREATE INDEX api_rate_limits_expiry_idx ON api_rate_limits (expires_at);
