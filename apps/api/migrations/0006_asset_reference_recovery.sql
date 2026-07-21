ALTER TABLE assets ADD COLUMN reference_change_id TEXT;

CREATE INDEX assets_unreferenced_at_idx
ON assets (lifecycle, unreferenced_at)
WHERE lifecycle = 'unreferenced';
