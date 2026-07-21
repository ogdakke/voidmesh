DROP TRIGGER validate_upload_reservation;

CREATE TRIGGER validate_upload_reservation
BEFORE INSERT ON upload_reservations
BEGIN
  SELECT CASE
    WHEN NEW.expected_bytes > (
      SELECT hard_asset_limit_bytes
      FROM account_entitlements
      INNER JOIN workspaces ON workspaces.owner_account_id = account_entitlements.account_id
      WHERE workspaces.id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'hard_asset_limit_exceeded')
    WHEN (
      SELECT used_bytes + reserved_bytes FROM workspaces WHERE id = NEW.workspace_id
    ) > (
      SELECT workspace_storage_limit_bytes
      FROM account_entitlements
      INNER JOIN workspaces ON workspaces.owner_account_id = account_entitlements.account_id
      WHERE workspaces.id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'workspace_storage_limit_exceeded')
    WHEN (
      SELECT COALESCE(SUM(used_bytes + reserved_bytes), 0)
      FROM workspaces
      WHERE owner_account_id = (
        SELECT owner_account_id FROM workspaces WHERE id = NEW.workspace_id
      )
    ) > (
      SELECT account_storage_limit_bytes
      FROM account_entitlements
      INNER JOIN workspaces ON workspaces.owner_account_id = account_entitlements.account_id
      WHERE workspaces.id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'account_storage_limit_exceeded')
  END;
END;

CREATE TRIGGER enforce_storage_limits_on_restore
BEFORE UPDATE OF lifecycle ON workspaces
WHEN OLD.lifecycle = 'deleted' AND NEW.lifecycle = 'active'
BEGIN
  SELECT CASE
    WHEN NEW.used_bytes + NEW.reserved_bytes > (
      SELECT workspace_storage_limit_bytes
      FROM account_entitlements
      WHERE account_id = NEW.owner_account_id
    ) THEN RAISE(ABORT, 'workspace_storage_limit_exceeded')
    WHEN (
      SELECT COALESCE(SUM(used_bytes + reserved_bytes), 0)
      FROM workspaces
      WHERE owner_account_id = NEW.owner_account_id
    ) > (
      SELECT account_storage_limit_bytes
      FROM account_entitlements
      WHERE account_id = NEW.owner_account_id
    ) THEN RAISE(ABORT, 'account_storage_limit_exceeded')
  END;
END;
