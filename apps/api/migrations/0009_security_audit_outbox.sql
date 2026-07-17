CREATE TABLE security_audit_outbox (
  event_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at INTEGER NOT NULL,
  enqueued_at INTEGER,
  delivered_at INTEGER
) STRICT;

CREATE INDEX security_audit_outbox_pending_idx
ON security_audit_outbox (delivered_at, enqueued_at, created_at);

CREATE TRIGGER audit_events_security_outbox
AFTER INSERT ON audit_events
BEGIN
  INSERT INTO security_audit_outbox (event_id, payload_json, created_at)
  VALUES (
    NEW.id,
    json_object(
      'schemaVersion', 1,
      'id', NEW.id,
      'actorUserId', NEW.actor_user_id,
      'accountId', NEW.account_id,
      'workspaceId', NEW.workspace_id,
      'action', NEW.action,
      'targetType', NEW.target_type,
      'targetId', NEW.target_id,
      'outcome', NEW.outcome,
      'requestId', NEW.request_id,
      'metadata', json(NEW.metadata_json),
      'createdAt', NEW.created_at
    ),
    NEW.created_at
  );
END;
