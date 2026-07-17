CREATE TABLE workspace_exports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  requested_by_user_id TEXT NOT NULL,
  room_sequence INTEGER NOT NULL CHECK (room_sequence >= 0),
  snapshot_object_key TEXT NOT NULL UNIQUE,
  archive_object_key TEXT UNIQUE,
  filename TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  viewport_offset_x REAL NOT NULL,
  viewport_offset_y REAL NOT NULL,
  viewport_zoom REAL NOT NULL CHECK (viewport_zoom > 0),
  state TEXT NOT NULL CHECK (state IN ('queued', 'processing', 'completed', 'failed')),
  byte_length INTEGER CHECK (byte_length IS NULL OR byte_length >= 0),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX workspace_exports_idempotency_idx
ON workspace_exports (workspace_id, requested_by_user_id, idempotency_key);

CREATE INDEX workspace_exports_workspace_created_idx
ON workspace_exports (workspace_id, created_at DESC);
