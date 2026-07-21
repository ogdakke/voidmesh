DROP TRIGGER finalize_upload_reservation;

CREATE TRIGGER finalize_upload_reservation
AFTER UPDATE OF state ON upload_reservations
WHEN OLD.state = 'pending' AND NEW.state = 'finalized'
BEGIN
  SELECT CASE
    WHEN NEW.actual_bytes IS NULL OR NEW.actual_bytes > NEW.expected_bytes
    THEN RAISE(ABORT, 'upload_size_mismatch')
  END;
  UPDATE workspaces
  SET
    reserved_bytes = reserved_bytes - NEW.reserved_bytes,
    used_bytes = used_bytes + NEW.actual_bytes,
    updated_at = NEW.updated_at
  WHERE id = NEW.workspace_id;
  UPDATE assets
  SET lifecycle = 'verified', byte_length = NEW.actual_bytes, updated_at = NEW.updated_at
  WHERE id = NEW.asset_id;
END;

CREATE INDEX assets_verified_updated_idx
ON assets (lifecycle, updated_at)
WHERE lifecycle = 'verified';
