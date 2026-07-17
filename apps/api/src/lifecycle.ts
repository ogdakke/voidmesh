import type { WorkspaceId } from "@voidmesh/domain";
import { deleteExpiredRateLimits } from "./rate-limit.ts";

const PURGE_BATCH_SIZE = 25;
const UPLOAD_CLEANUP_BATCH_SIZE = 100;
const EXPORT_CLEANUP_BATCH_SIZE = 100;
const R2_DELETE_BATCH_SIZE = 1_000;

interface ExpiredWorkspaceRow {
  id: string;
  owner_account_id: string;
}

interface ObjectKeyRow {
  object_key: string;
}

interface CleanupAssetRow {
  actor_user_id: string;
  asset_id: string;
  object_key: string;
  owner_account_id: string;
  reservation_id: string;
  workspace_id: string;
}

export interface WorkspacePurgeResult {
  deletedObjectCount: number;
  purgedWorkspaceCount: number;
}

export interface UploadCleanupResult {
  cleanedAssetCount: number;
  expiredReservationCount: number;
}

export interface ExportCleanupResult {
  deletedObjectCount: number;
  expiredExportCount: number;
}

export async function cleanupExpiredExports(
  env: Env,
  now = Date.now(),
): Promise<ExportCleanupResult> {
  const expired = await env.DB.prepare(
    `SELECT id, snapshot_object_key, archive_object_key
     FROM workspace_exports
     WHERE expires_at <= ?
     ORDER BY expires_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, EXPORT_CLEANUP_BATCH_SIZE)
    .all<{
      archive_object_key: string | null;
      id: string;
      snapshot_object_key: string;
    }>();
  let deletedObjectCount = 0;
  for (const row of expired.results) {
    const keys = [row.snapshot_object_key, row.archive_object_key].filter(
      (key): key is string => key !== null,
    );
    await env.ASSETS.delete(keys);
    await env.DB.prepare("DELETE FROM workspace_exports WHERE id = ?").bind(row.id).run();
    deletedObjectCount += keys.length;
  }
  return {
    deletedObjectCount,
    expiredExportCount: expired.results.length,
  };
}

/** Releases abandoned reservations, then retries deletion of their orphaned objects. */
export async function cleanupExpiredUploads(
  env: Env,
  now = Date.now(),
): Promise<UploadCleanupResult> {
  const expiring = await env.DB.prepare(
    `SELECT id FROM upload_reservations
     WHERE state = 'pending' AND expires_at <= ?
     ORDER BY expires_at ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, UPLOAD_CLEANUP_BATCH_SIZE)
    .all<{ id: string }>();
  if (expiring.results.length > 0) {
    await env.DB.batch(
      expiring.results.map(({ id }) =>
        env.DB.prepare(
          `UPDATE upload_reservations SET state = 'expired', updated_at = ?
           WHERE id = ? AND state = 'pending'`,
        ).bind(now, id),
      ),
    );
  }

  const deleting = await env.DB.prepare(
    `SELECT
       assets.id AS asset_id,
       assets.workspace_id,
       assets.object_key,
       upload_reservations.id AS reservation_id,
       upload_reservations.actor_user_id,
       workspaces.owner_account_id
     FROM assets
     INNER JOIN upload_reservations ON upload_reservations.asset_id = assets.id
     INNER JOIN workspaces ON workspaces.id = assets.workspace_id
     WHERE assets.lifecycle = 'deleting'
       AND upload_reservations.state IN ('expired', 'failed')
     ORDER BY upload_reservations.updated_at ASC, assets.id ASC
     LIMIT ?`,
  )
    .bind(UPLOAD_CLEANUP_BATCH_SIZE)
    .all<CleanupAssetRow>();

  let cleanedAssetCount = 0;
  for (const asset of deleting.results) {
    await env.ASSETS.delete(asset.object_key);
    const requestId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM asset_transfer_grants WHERE asset_id = ?").bind(asset.asset_id),
      env.DB.prepare("DELETE FROM upload_reservations WHERE id = ?").bind(asset.reservation_id),
      env.DB.prepare("DELETE FROM assets WHERE id = ? AND lifecycle = 'deleting'").bind(
        asset.asset_id,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
          id, actor_user_id, account_id, workspace_id, action, target_type,
          target_id, outcome, request_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, 'asset.upload-expired', 'asset', ?, 'success', ?, '{}', ?)`,
      ).bind(
        crypto.randomUUID(),
        asset.actor_user_id,
        asset.owner_account_id,
        asset.workspace_id,
        asset.asset_id,
        requestId,
        now,
      ),
    ]);
    cleanedAssetCount++;
  }

  return {
    cleanedAssetCount,
    expiredReservationCount: expiring.results.length,
  };
}

export async function purgeExpiredWorkspaces(
  env: Env,
  now = Date.now(),
): Promise<WorkspacePurgeResult> {
  await deleteExpiredRateLimits(env.DB, now);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO workspace_purge_claims (workspace_id, claimed_at)
     SELECT id, ? FROM workspaces
     WHERE lifecycle = 'deleted' AND purge_after <= ?
     ORDER BY purge_after ASC, id ASC
     LIMIT ?`,
  )
    .bind(now, now, PURGE_BATCH_SIZE)
    .run();
  const expired = await env.DB.prepare(
    `SELECT workspaces.id, workspaces.owner_account_id
     FROM workspace_purge_claims
     INNER JOIN workspaces ON workspaces.id = workspace_purge_claims.workspace_id
     WHERE workspaces.lifecycle = 'deleted' AND workspaces.purge_after <= ?
     ORDER BY workspace_purge_claims.claimed_at ASC, workspaces.id ASC
     LIMIT ?`,
  )
    .bind(now, PURGE_BATCH_SIZE)
    .all<ExpiredWorkspaceRow>();

  let deletedObjectCount = 0;
  for (const workspace of expired.results) {
    deletedObjectCount += await purgeWorkspace(env, workspace, now);
  }
  return { deletedObjectCount, purgedWorkspaceCount: expired.results.length };
}

async function purgeWorkspace(
  env: Env,
  workspace: ExpiredWorkspaceRow,
  now: number,
): Promise<number> {
  const [assets, snapshots, exports] = await Promise.all([
    env.DB.prepare("SELECT object_key FROM assets WHERE workspace_id = ?")
      .bind(workspace.id)
      .all<ObjectKeyRow>(),
    env.DB.prepare("SELECT object_key FROM workspace_snapshots WHERE workspace_id = ?")
      .bind(workspace.id)
      .all<ObjectKeyRow>(),
    env.DB.prepare(
      `SELECT snapshot_object_key AS object_key FROM workspace_exports WHERE workspace_id = ?
       UNION ALL
       SELECT archive_object_key AS object_key FROM workspace_exports
       WHERE workspace_id = ? AND archive_object_key IS NOT NULL`,
    )
      .bind(workspace.id, workspace.id)
      .all<ObjectKeyRow>(),
  ]);
  const keys = [...assets.results, ...snapshots.results, ...exports.results].map(
    ({ object_key }) => object_key,
  );
  for (let offset = 0; offset < keys.length; offset += R2_DELETE_BATCH_SIZE) {
    await env.ASSETS.delete(keys.slice(offset, offset + R2_DELETE_BATCH_SIZE));
  }

  await env.WORKSPACE_ROOMS.getByName(workspace.id as WorkspaceId).purge();

  const requestId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM invitation_redemptions
       WHERE invitation_id IN (SELECT id FROM invitation_links WHERE workspace_id = ?)`,
    ).bind(workspace.id),
    env.DB.prepare("DELETE FROM asset_transfer_grants WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM upload_reservations WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM assets WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM workspace_snapshots WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM workspace_exports WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM invitation_links WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare(
      `DELETE FROM mutation_idempotency
       WHERE operation = 'workspace.create' AND resource_id = ?`,
    ).bind(workspace.id),
    env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM audit_events WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare("DELETE FROM workspace_purge_claims WHERE workspace_id = ?").bind(workspace.id),
    env.DB.prepare(
      `DELETE FROM workspaces
       WHERE id = ? AND lifecycle = 'deleted' AND purge_after <= ?`,
    ).bind(workspace.id, now),
    env.DB.prepare(
      `INSERT INTO audit_events (
        id, account_id, action, target_type, target_id, outcome, request_id,
        metadata_json, created_at
      ) VALUES (?, ?, 'workspace.purge', 'workspace', ?, 'success', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      workspace.owner_account_id,
      workspace.id,
      requestId,
      JSON.stringify({ deletedObjectCount: keys.length }),
      now,
    ),
    env.DB.prepare(
      `DELETE FROM subscriptions
       WHERE account_id = ?
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_account_id = ?)`,
    ).bind(workspace.owner_account_id, workspace.owner_account_id, workspace.owner_account_id),
    env.DB.prepare(
      `DELETE FROM account_entitlements
       WHERE account_id = ?
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE id = ?)
         AND NOT EXISTS (SELECT 1 FROM workspaces WHERE owner_account_id = ?)`,
    ).bind(workspace.owner_account_id, workspace.owner_account_id, workspace.owner_account_id),
  ]);
  return keys.length;
}
