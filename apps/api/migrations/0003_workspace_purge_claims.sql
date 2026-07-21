CREATE TABLE workspace_purge_claims (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE RESTRICT,
  claimed_at INTEGER NOT NULL
) STRICT;
