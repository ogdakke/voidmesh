ALTER TABLE asset_transfer_grants
ADD COLUMN purpose TEXT NOT NULL DEFAULT 'render'
CHECK (purpose IN ('upload', 'render', 'download'));

UPDATE asset_transfer_grants
SET purpose = operation
WHERE operation = 'upload';
