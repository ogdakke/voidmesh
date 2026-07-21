ALTER TABLE subscriptions ADD COLUMN last_event_created_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN last_event_id TEXT;

CREATE TABLE billing_events (
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  provider_created_at INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('processed', 'ignored')),
  processed_at INTEGER NOT NULL,
  PRIMARY KEY (provider, event_id)
) STRICT;
