CREATE TABLE workspace_view_states (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  offset_x REAL NOT NULL,
  offset_y REAL NOT NULL,
  zoom REAL NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES user(id) ON DELETE CASCADE
);

CREATE INDEX workspace_view_states_user_idx
ON workspace_view_states (user_id, updated_at DESC);
