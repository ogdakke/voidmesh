CREATE TRIGGER enforce_workspace_owner_identity
BEFORE INSERT ON workspace_members
WHEN NEW.role = 'owner'
BEGIN
  SELECT CASE
    WHEN NEW.removed_at IS NOT NULL THEN RAISE(ABORT, 'workspace_owner_must_be_active')
    WHEN NEW.user_id != (
      SELECT owner_account_id FROM workspaces WHERE id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'workspace_owner_identity_mismatch')
  END;
END;

CREATE TRIGGER prevent_workspace_owner_membership_change
BEFORE UPDATE OF user_id, role, removed_at ON workspace_members
WHEN OLD.role = 'owner' AND OLD.removed_at IS NULL
BEGIN
  SELECT CASE
    WHEN NEW.user_id != OLD.user_id
      OR NEW.role != 'owner'
      OR NEW.removed_at IS NOT NULL
    THEN RAISE(ABORT, 'workspace_owner_is_immutable')
  END;
END;

CREATE TRIGGER prevent_active_workspace_owner_removal
BEFORE DELETE ON workspace_members
WHEN OLD.role = 'owner'
  AND EXISTS (
    SELECT 1 FROM workspaces
    WHERE id = OLD.workspace_id AND lifecycle = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'active_workspace_owner_is_required');
END;

CREATE TRIGGER prevent_workspace_ownership_transfer
BEFORE UPDATE OF owner_account_id ON workspaces
WHEN NEW.owner_account_id != OLD.owner_account_id
BEGIN
  SELECT RAISE(ABORT, 'workspace_ownership_transfer_forbidden');
END;
