CREATE TABLE mutation_idempotency (
  actor_user_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_user_id, operation, idempotency_key)
) STRICT;

ALTER TABLE invitation_links ADD COLUMN idempotency_key TEXT;

CREATE UNIQUE INDEX invitation_links_creator_idempotency_idx
ON invitation_links (created_by_user_id, workspace_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;
