ALTER TABLE assets ADD COLUMN thumbnail_object_key TEXT;
ALTER TABLE assets ADD COLUMN thumbnail_content_hash TEXT;
ALTER TABLE assets ADD COLUMN thumbnail_content_type TEXT;
ALTER TABLE assets ADD COLUMN thumbnail_byte_length INTEGER NOT NULL DEFAULT 0
CHECK (thumbnail_byte_length >= 0);

ALTER TABLE upload_reservations ADD COLUMN thumbnail_expected_bytes INTEGER NOT NULL DEFAULT 0
CHECK (thumbnail_expected_bytes >= 0);

DROP TRIGGER finalize_upload_reservation;

CREATE TRIGGER finalize_upload_reservation
AFTER UPDATE OF state ON upload_reservations
WHEN OLD.state = 'pending' AND NEW.state = 'finalized'
BEGIN
  SELECT CASE
    WHEN NEW.actual_bytes IS NULL OR NEW.actual_bytes > NEW.reserved_bytes
    THEN RAISE(ABORT, 'upload_size_mismatch')
  END;
  UPDATE workspaces
  SET
    reserved_bytes = reserved_bytes - NEW.reserved_bytes,
    used_bytes = used_bytes + NEW.actual_bytes,
    updated_at = NEW.updated_at
  WHERE id = NEW.workspace_id;
  UPDATE assets
  SET
    lifecycle = 'verified',
    byte_length = NEW.expected_bytes,
    thumbnail_byte_length = NEW.thumbnail_expected_bytes,
    updated_at = NEW.updated_at
  WHERE id = NEW.asset_id;
END;

CREATE INDEX assets_workspace_created_idx ON assets (workspace_id, created_at DESC, id DESC);
