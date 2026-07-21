CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL CHECK ("emailVerified" IN (0, 1)),
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE INDEX "account_userId_idx" ON "account" ("userId");

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE "rateLimit" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "key" TEXT NOT NULL UNIQUE,
  "count" INTEGER NOT NULL CHECK ("count" >= 0),
  "lastRequest" INTEGER NOT NULL
);

CREATE TABLE account_entitlements (
  account_id TEXT PRIMARY KEY,
  plan_key TEXT NOT NULL,
  hosted_workspace_limit INTEGER NOT NULL CHECK (hosted_workspace_limit >= 0),
  account_storage_limit_bytes INTEGER NOT NULL CHECK (account_storage_limit_bytes >= 0),
  workspace_storage_limit_bytes INTEGER NOT NULL CHECK (workspace_storage_limit_bytes >= 0),
  hard_asset_limit_bytes INTEGER NOT NULL CHECK (hard_asset_limit_bytes > 0),
  can_view_share INTEGER NOT NULL DEFAULT 1 CHECK (can_view_share IN (0, 1)),
  can_edit_collaborate INTEGER NOT NULL DEFAULT 0 CHECK (can_edit_collaborate IN (0, 1)),
  effective_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE subscriptions (
  account_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_customer_id TEXT NOT NULL UNIQUE,
  provider_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL,
  current_period_ends_at INTEGER,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  owner_account_id TEXT NOT NULL,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'deleted')),
  current_room_sequence INTEGER NOT NULL DEFAULT 0 CHECK (current_room_sequence >= 0),
  snapshot_sequence INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_sequence >= 0),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  deleted_at INTEGER,
  purge_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK ((lifecycle = 'active' AND deleted_at IS NULL AND purge_after IS NULL) OR lifecycle = 'deleted')
) STRICT;

CREATE INDEX workspaces_owner_lifecycle_idx ON workspaces (owner_account_id, lifecycle);

CREATE TRIGGER enforce_hosted_workspace_limit
BEFORE INSERT ON workspaces
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM account_entitlements
      WHERE account_id = NEW.owner_account_id
    ) THEN RAISE(ABORT, 'account_entitlements_missing')
    WHEN (
      SELECT COUNT(*)
      FROM workspaces
      WHERE owner_account_id = NEW.owner_account_id AND lifecycle = 'active'
    ) >= (
      SELECT hosted_workspace_limit
      FROM account_entitlements
      WHERE account_id = NEW.owner_account_id
    ) THEN RAISE(ABORT, 'hosted_workspace_limit_exceeded')
  END;
END;

CREATE TRIGGER enforce_hosted_workspace_limit_on_restore
BEFORE UPDATE OF lifecycle ON workspaces
WHEN OLD.lifecycle = 'deleted' AND NEW.lifecycle = 'active'
BEGIN
  SELECT CASE
    WHEN (
      SELECT COUNT(*)
      FROM workspaces
      WHERE owner_account_id = NEW.owner_account_id AND lifecycle = 'active'
    ) >= (
      SELECT hosted_workspace_limit
      FROM account_entitlements
      WHERE account_id = NEW.owner_account_id
    ) THEN RAISE(ABORT, 'hosted_workspace_limit_exceeded')
  END;
END;

CREATE TABLE workspace_members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  invited_by_user_id TEXT,
  accepted_at INTEGER NOT NULL,
  removed_at INTEGER,
  PRIMARY KEY (workspace_id, user_id)
) STRICT;

CREATE UNIQUE INDEX workspace_single_owner_idx
ON workspace_members (workspace_id)
WHERE role = 'owner' AND removed_at IS NULL;

CREATE TABLE invitation_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  token_hash BLOB NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('editor', 'viewer')),
  created_by_user_id TEXT NOT NULL,
  max_uses INTEGER CHECK (max_uses IS NULL OR max_uses > 0),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE invitation_redemptions (
  invitation_id TEXT NOT NULL REFERENCES invitation_links(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'denied')),
  redeemed_at INTEGER NOT NULL,
  PRIMARY KEY (invitation_id, user_id, redeemed_at)
) STRICT;

CREATE UNIQUE INDEX invitation_single_acceptance_idx
ON invitation_redemptions (invitation_id, user_id)
WHERE outcome = 'accepted';

CREATE TRIGGER validate_invitation_redemption
BEFORE INSERT ON invitation_redemptions
WHEN NEW.outcome = 'accepted'
BEGIN
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1
      FROM invitation_links
      INNER JOIN workspaces ON workspaces.id = invitation_links.workspace_id
      WHERE invitation_links.id = NEW.invitation_id
        AND invitation_links.revoked_at IS NULL
        AND workspaces.lifecycle = 'active'
        AND (
          invitation_links.max_uses IS NULL
          OR invitation_links.use_count < invitation_links.max_uses
        )
    ) THEN RAISE(ABORT, 'invitation_unavailable')
    WHEN EXISTS (
      SELECT 1
      FROM invitation_links
      INNER JOIN workspaces ON workspaces.id = invitation_links.workspace_id
      LEFT JOIN account_entitlements
        ON account_entitlements.account_id = workspaces.owner_account_id
      WHERE invitation_links.id = NEW.invitation_id
        AND invitation_links.role = 'editor'
        AND COALESCE(account_entitlements.can_edit_collaborate, 0) = 0
    ) THEN RAISE(ABORT, 'edit_collaboration_required')
  END;
END;

CREATE TRIGGER count_invitation_redemption
AFTER INSERT ON invitation_redemptions
WHEN NEW.outcome = 'accepted'
BEGIN
  UPDATE invitation_links
  SET use_count = use_count + 1
  WHERE id = NEW.invitation_id;
END;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  uploaded_by_user_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  content_hash TEXT,
  media_type TEXT NOT NULL,
  content_type TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('reserved', 'uploaded', 'verified', 'active', 'unreferenced', 'deleting')),
  unreferenced_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX assets_workspace_lifecycle_idx ON assets (workspace_id, lifecycle);

CREATE TABLE upload_reservations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL UNIQUE REFERENCES assets(id) ON DELETE RESTRICT,
  actor_user_id TEXT NOT NULL,
  expected_bytes INTEGER NOT NULL CHECK (expected_bytes > 0),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
  actual_bytes INTEGER CHECK (actual_bytes IS NULL OR actual_bytes >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'finalized', 'expired', 'failed')),
  idempotency_key TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (actor_user_id, idempotency_key)
) STRICT;

CREATE INDEX upload_reservations_expiry_idx ON upload_reservations (state, expires_at);

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
      ) AND lifecycle = 'active'
    ) > (
      SELECT account_storage_limit_bytes
      FROM account_entitlements
      INNER JOIN workspaces ON workspaces.owner_account_id = account_entitlements.account_id
      WHERE workspaces.id = NEW.workspace_id
    ) THEN RAISE(ABORT, 'account_storage_limit_exceeded')
  END;
END;

CREATE TRIGGER reserve_workspace_bytes
AFTER INSERT ON upload_reservations
BEGIN
  UPDATE workspaces
  SET reserved_bytes = reserved_bytes + NEW.reserved_bytes
  WHERE id = NEW.workspace_id;
END;

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
  SET lifecycle = 'active', byte_length = NEW.actual_bytes, updated_at = NEW.updated_at
  WHERE id = NEW.asset_id;
END;

CREATE TRIGGER reject_repeated_upload_finalization
BEFORE UPDATE OF state ON upload_reservations
WHEN NEW.state = 'finalized' AND OLD.state != 'pending'
BEGIN
  SELECT RAISE(ABORT, 'upload_already_finalized');
END;

CREATE TRIGGER release_upload_reservation
AFTER UPDATE OF state ON upload_reservations
WHEN OLD.state = 'pending' AND NEW.state IN ('expired', 'failed')
BEGIN
  UPDATE workspaces
  SET reserved_bytes = reserved_bytes - NEW.reserved_bytes, updated_at = NEW.updated_at
  WHERE id = NEW.workspace_id;
  UPDATE assets
  SET lifecycle = 'deleting', updated_at = NEW.updated_at
  WHERE id = NEW.asset_id;
END;

CREATE TABLE asset_transfer_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upload', 'download')),
  object_key TEXT NOT NULL,
  expected_bytes INTEGER,
  actual_bytes INTEGER,
  expires_at INTEGER NOT NULL,
  completed_at INTEGER,
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX asset_transfer_grants_user_created_idx
ON asset_transfer_grants (user_id, created_at);

CREATE TABLE workspace_snapshots (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  room_sequence INTEGER NOT NULL CHECK (room_sequence >= 0),
  object_key TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, room_sequence)
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  actor_user_id TEXT,
  account_id TEXT,
  workspace_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  outcome TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX audit_events_workspace_created_idx ON audit_events (workspace_id, created_at);
CREATE INDEX audit_events_actor_created_idx ON audit_events (actor_user_id, created_at);
