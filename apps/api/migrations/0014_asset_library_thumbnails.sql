ALTER TABLE assets ADD COLUMN thumbnail_object_key TEXT;
ALTER TABLE assets ADD COLUMN thumbnail_content_hash TEXT;
ALTER TABLE assets ADD COLUMN thumbnail_content_type TEXT;
ALTER TABLE assets ADD COLUMN thumbnail_byte_length INTEGER NOT NULL DEFAULT 0
CHECK (thumbnail_byte_length >= 0);

ALTER TABLE upload_reservations ADD COLUMN thumbnail_expected_bytes INTEGER NOT NULL DEFAULT 0
CHECK (thumbnail_expected_bytes >= 0);

CREATE INDEX assets_workspace_created_idx ON assets (workspace_id, created_at DESC, id DESC);
