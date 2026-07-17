import {
  ApiErrorCode,
  type CreateWorkspaceRequest,
  type UpdateWorkspaceRequest,
  type UpdateWorkspaceViewStateRequest,
  type WorkspaceListResponse,
  type WorkspaceResponse,
  type WorkspaceSummary,
  type WorkspaceViewStateResponse,
} from "@voidmesh/api-contract";
import {
  WorkspaceLifecycle,
  WorkspaceRole,
  canEditWorkspace,
  effectiveWorkspaceRole,
  type UserId,
  type WorkspaceId,
} from "@voidmesh/domain";
import { errorResponse, json } from "./http.ts";
import { readIdempotencyKey, requestFingerprint } from "./idempotency.ts";

const MAX_TITLE_LENGTH = 120;
export const WORKSPACE_DELETION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

interface WorkspaceRow {
  can_edit_collaborate: number;
  created_at: number;
  deleted_at: number | null;
  id: string;
  lifecycle: string;
  purge_after: number | null;
  role: string;
  title: string;
  updated_at: number;
  used_bytes: number;
  workspace_storage_limit_bytes: number;
}

interface WorkspaceAccessRow extends WorkspaceRow {
  owner_account_id: string;
}

interface WorkspaceViewStateRow {
  offset_x: number;
  offset_y: number;
  updated_at: number;
  zoom: number;
}

export async function handleWorkspaceRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/v1/workspaces") {
    if (request.method === "GET") {
      return url.searchParams.get("lifecycle") === WorkspaceLifecycle.deleted
        ? listDeletedWorkspaces(env.DB, userId)
        : listWorkspaces(env.DB, userId);
    }
    if (request.method === "POST") return createWorkspace(request, env, userId, requestId);
    return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
  }

  const match = url.pathname.match(
    /^\/v1\/workspaces\/([A-Za-z0-9_-]{1,128})(\/restore|\/view-state)?$/,
  );
  if (!match) return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
  const workspaceId = match[1]!;

  if (match[2] === "/restore") {
    if (request.method !== "POST") {
      return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
    }
    return restoreWorkspace(env, userId, workspaceId, requestId);
  }

  if (match[2] === "/view-state") {
    if (request.method === "GET") {
      return getWorkspaceViewState(env.DB, userId, workspaceId, requestId);
    }
    if (request.method === "PATCH") {
      return updateWorkspaceViewState(request, env.DB, userId, workspaceId, requestId);
    }
    return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
  }

  if (request.method === "GET") return getWorkspace(env.DB, userId, workspaceId, requestId);
  if (request.method === "PATCH") {
    return updateWorkspace(request, env.DB, userId, workspaceId, requestId);
  }
  if (request.method === "DELETE") {
    return deleteWorkspace(env, userId, workspaceId, requestId);
  }

  return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
}

async function getWorkspaceViewState(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readWorkspaceAccess(db, userId, workspaceId);
  if (!access || access.lifecycle !== WorkspaceLifecycle.active) {
    return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  }
  const row = await db
    .prepare(
      `SELECT offset_x, offset_y, zoom, updated_at
       FROM workspace_view_states WHERE workspace_id = ? AND user_id = ?`,
    )
    .bind(workspaceId, userId)
    .first<WorkspaceViewStateRow>();
  const body: WorkspaceViewStateResponse = {
    viewState: row
      ? {
          offset: { x: row.offset_x, y: row.offset_y },
          updatedAt: row.updated_at,
          zoom: row.zoom,
        }
      : null,
  };
  return json(body);
}

async function updateWorkspaceViewState(
  request: Request,
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readWorkspaceAccess(db, userId, workspaceId);
  if (!access || access.lifecycle !== WorkspaceLifecycle.active) {
    return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  }
  const input = await readViewStateRequest(request);
  if (!input) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Invalid workspace view state",
      requestId,
      400,
    );
  }
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO workspace_view_states
        (workspace_id, user_id, offset_x, offset_y, zoom, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (workspace_id, user_id) DO UPDATE SET
         offset_x = excluded.offset_x,
         offset_y = excluded.offset_y,
         zoom = excluded.zoom,
         updated_at = excluded.updated_at`,
    )
    .bind(workspaceId, userId, input.offset.x, input.offset.y, input.zoom, now)
    .run();
  const body: WorkspaceViewStateResponse = {
    viewState: { ...input, updatedAt: now },
  };
  return json(body);
}

async function listWorkspaces(db: D1Database, userId: UserId): Promise<Response> {
  const result = await db
    .prepare(
      `SELECT
        workspaces.id,
        workspaces.title,
        workspaces.lifecycle,
        workspaces.deleted_at,
        workspaces.purge_after,
        workspaces.used_bytes,
        workspaces.created_at,
        workspaces.updated_at,
        workspace_members.role,
        account_entitlements.can_edit_collaborate,
        account_entitlements.workspace_storage_limit_bytes
      FROM workspace_members
      INNER JOIN workspaces ON workspaces.id = workspace_members.workspace_id
      INNER JOIN account_entitlements
        ON account_entitlements.account_id = workspaces.owner_account_id
      WHERE workspace_members.user_id = ?
        AND workspace_members.removed_at IS NULL
        AND workspaces.lifecycle = 'active'
      ORDER BY workspaces.updated_at DESC, workspaces.id ASC`,
    )
    .bind(userId)
    .all<WorkspaceRow>();

  const body: WorkspaceListResponse = {
    workspaces: result.results.map(toSummary),
  };
  return json(body);
}

async function listDeletedWorkspaces(db: D1Database, userId: UserId): Promise<Response> {
  const result = await db
    .prepare(
      `SELECT
        workspaces.id,
        workspaces.title,
        workspaces.lifecycle,
        workspaces.deleted_at,
        workspaces.purge_after,
        workspaces.used_bytes,
        workspaces.created_at,
        workspaces.updated_at,
        'owner' AS role,
        account_entitlements.can_edit_collaborate,
        account_entitlements.workspace_storage_limit_bytes
      FROM workspaces
      INNER JOIN account_entitlements
        ON account_entitlements.account_id = workspaces.owner_account_id
      WHERE workspaces.owner_account_id = ?
        AND workspaces.lifecycle = 'deleted'
        AND workspaces.purge_after > ?
      ORDER BY workspaces.deleted_at DESC, workspaces.id ASC`,
    )
    .bind(userId, Date.now())
    .all<WorkspaceRow>();

  const body: WorkspaceListResponse = {
    workspaces: result.results.map(toSummary),
  };
  return json(body);
}

async function createWorkspace(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const input = await readCreateRequest(request);
  if (!input) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      `title must contain 1 to ${MAX_TITLE_LENGTH} characters`,
      requestId,
      400,
    );
  }

  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "A UUID Idempotency-Key header is required",
      requestId,
      400,
    );
  }
  const fingerprint = await requestFingerprint(input);
  const replay = await replayWorkspaceCreation(env, userId, idempotencyKey, fingerprint, requestId);
  if (replay) return replay;

  const workspaceId = crypto.randomUUID();
  const now = Date.now();

  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspaces (
          id, owner_account_id, title, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)`,
      ).bind(workspaceId, userId, input.title, now, now),
      env.DB.prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, role, accepted_at
        ) VALUES (?, ?, 'owner', ?)`,
      ).bind(workspaceId, userId, now),
      env.DB.prepare(
        `INSERT INTO audit_events (
          id, actor_user_id, account_id, workspace_id, action, target_type,
          target_id, outcome, request_id, created_at
        ) VALUES (?, ?, ?, ?, 'workspace.create', 'workspace', ?, 'success', ?, ?)`,
      ).bind(crypto.randomUUID(), userId, userId, workspaceId, workspaceId, requestId, now),
      env.DB.prepare(
        `INSERT INTO mutation_idempotency (
          actor_user_id, operation, idempotency_key, request_fingerprint,
          resource_id, created_at
        ) VALUES (?, 'workspace.create', ?, ?, ?, ?)`,
      ).bind(userId, idempotencyKey, fingerprint, workspaceId, now),
    ]);
  } catch (error) {
    if (isHostedWorkspaceLimitError(error)) {
      await writeDeniedCreationAudit(env.DB, userId, workspaceId, requestId, now);
      return errorResponse(
        ApiErrorCode.quotaExceeded,
        "Hosted workspace limit reached",
        requestId,
        403,
      );
    }
    const concurrentReplay = await replayWorkspaceCreation(
      env,
      userId,
      idempotencyKey,
      fingerprint,
      requestId,
    );
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }

  const room = env.WORKSPACE_ROOMS.getByName(workspaceId);
  try {
    await room.initializeWithSnapshot(workspaceId);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM mutation_idempotency
         WHERE actor_user_id = ? AND operation = 'workspace.create'
           AND idempotency_key = ?`,
      ).bind(userId, idempotencyKey),
      env.DB.prepare("DELETE FROM audit_events WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ?").bind(workspaceId),
      env.DB.prepare("DELETE FROM workspaces WHERE id = ?").bind(workspaceId),
    ]);
    room.purge();
    throw error;
  }

  const created = await readWorkspaceAccess(env.DB, userId, workspaceId);
  if (!created) throw new Error("Created workspace could not be read");
  const body: WorkspaceResponse = { workspace: toSummary(created) };
  return json(body, 201);
}

async function replayWorkspaceCreation(
  env: Env,
  userId: UserId,
  idempotencyKey: string,
  fingerprint: string,
  requestId: string,
): Promise<Response | null> {
  const existing = await env.DB.prepare(
    `SELECT request_fingerprint, resource_id
     FROM mutation_idempotency
     WHERE actor_user_id = ? AND operation = 'workspace.create'
       AND idempotency_key = ?`,
  )
    .bind(userId, idempotencyKey)
    .first<{ request_fingerprint: string; resource_id: string }>();
  if (!existing) return null;
  if (existing.request_fingerprint !== fingerprint) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Idempotency-Key was already used with a different request",
      requestId,
      409,
    );
  }
  await env.WORKSPACE_ROOMS.getByName(existing.resource_id).initializeWithSnapshot(
    existing.resource_id,
  );
  const workspace = await readWorkspaceAccess(env.DB, userId, existing.resource_id);
  if (!workspace) throw new Error("Idempotent workspace could not be read");
  return json({ workspace: toSummary(workspace) } satisfies WorkspaceResponse);
}

async function getWorkspace(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readWorkspaceAccess(db, userId, workspaceId);
  if (!access || access.lifecycle !== WorkspaceLifecycle.active) {
    return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  }
  const body: WorkspaceResponse = { workspace: toSummary(access) };
  return json(body);
}

async function updateWorkspace(
  request: Request,
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readWorkspaceAccess(db, userId, workspaceId);
  if (!access || access.lifecycle !== WorkspaceLifecycle.active) {
    return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  }
  if (
    !canEditWorkspace(
      effectiveWorkspaceRole(toWorkspaceRole(access.role), access.can_edit_collaborate === 1),
    )
  ) {
    return errorResponse(ApiErrorCode.forbidden, "Edit access required", requestId, 403);
  }
  const input = await readUpdateRequest(request);
  if (!input) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      `title must contain 1 to ${MAX_TITLE_LENGTH} characters`,
      requestId,
      400,
    );
  }

  const now = Date.now();
  await db.batch([
    db
      .prepare("UPDATE workspaces SET title = ?, updated_at = ? WHERE id = ?")
      .bind(input.title, now, workspaceId),
    auditStatement(db, {
      action: "workspace.rename",
      actorUserId: userId,
      outcome: "success",
      requestId,
      timestamp: now,
      workspaceId,
    }),
  ]);

  const body: WorkspaceResponse = {
    workspace: { ...toSummary(access), title: input.title, updatedAt: now },
  };
  return json(body);
}

async function deleteWorkspace(
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readWorkspaceAccess(env.DB, userId, workspaceId);
  if (!access || access.lifecycle !== WorkspaceLifecycle.active) {
    return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  }
  if (access.owner_account_id !== userId || access.role !== WorkspaceRole.owner) {
    return errorResponse(ApiErrorCode.forbidden, "Owner access required", requestId, 403);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspaces
       SET lifecycle = 'deleted', deleted_at = ?, purge_after = ?, updated_at = ?
       WHERE id = ? AND lifecycle = 'active'`,
    ).bind(now, now + WORKSPACE_DELETION_RETENTION_MS, now, workspaceId),
    auditStatement(env.DB, {
      action: "workspace.delete",
      actorUserId: userId,
      outcome: "success",
      requestId,
      timestamp: now,
      workspaceId,
    }),
  ]);
  await env.WORKSPACE_ROOMS.getByName(workspaceId).revokeAll();
  return new Response(null, { status: 204 });
}

async function restoreWorkspace(
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readWorkspaceAccess(env.DB, userId, workspaceId);
  if (!access || access.lifecycle !== WorkspaceLifecycle.deleted) {
    return errorResponse(ApiErrorCode.notFound, "Deleted workspace not found", requestId, 404);
  }
  if (access.owner_account_id !== userId || access.role !== WorkspaceRole.owner) {
    return errorResponse(ApiErrorCode.forbidden, "Owner access required", requestId, 403);
  }
  const now = Date.now();
  if (access.purge_after === null || access.purge_after <= now) {
    return errorResponse(
      ApiErrorCode.notFound,
      "Workspace recovery window expired",
      requestId,
      404,
    );
  }

  try {
    const restored = await env.DB.prepare(
      `UPDATE workspaces
       SET lifecycle = 'active', deleted_at = NULL, purge_after = NULL, updated_at = ?
       WHERE id = ? AND lifecycle = 'deleted'
         AND NOT EXISTS (
           SELECT 1 FROM workspace_purge_claims
           WHERE workspace_purge_claims.workspace_id = workspaces.id
         )`,
    )
      .bind(now, workspaceId)
      .run();
    if (restored.meta.changes !== 1) {
      return errorResponse(
        ApiErrorCode.invalidRequest,
        "Workspace permanent deletion is already in progress",
        requestId,
        409,
      );
    }
    await auditStatement(env.DB, {
      action: "workspace.restore",
      actorUserId: userId,
      outcome: "success",
      requestId,
      timestamp: now,
      workspaceId,
    }).run();
  } catch (error) {
    const reason = entitlementLimitReason(error);
    if (reason) {
      await auditStatement(env.DB, {
        action: "workspace.restore",
        actorUserId: userId,
        metadata: { reason },
        outcome: "denied",
        requestId,
        timestamp: now,
        workspaceId,
      }).run();
      return errorResponse(
        ApiErrorCode.quotaExceeded,
        reason === "hosted-workspace-limit"
          ? "Hosted workspace limit reached"
          : "Hosted storage limit reached",
        requestId,
        403,
      );
    }
    throw error;
  }

  const body: WorkspaceResponse = {
    workspace: {
      ...toSummary(access),
      deletedAt: null,
      lifecycle: WorkspaceLifecycle.active,
      purgeAfter: null,
      updatedAt: now,
    },
  };
  return json(body);
}

async function readCreateRequest(request: Request): Promise<CreateWorkspaceRequest | null> {
  return readTitleRequest(request);
}

async function readUpdateRequest(request: Request): Promise<UpdateWorkspaceRequest | null> {
  return readTitleRequest(request);
}

async function readViewStateRequest(
  request: Request,
): Promise<UpdateWorkspaceViewStateRequest | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object") return null;
    const offset = Reflect.get(body, "offset");
    const zoom = Reflect.get(body, "zoom");
    if (!offset || typeof offset !== "object") return null;
    const x = Reflect.get(offset, "x");
    const y = Reflect.get(offset, "y");
    if (
      typeof x !== "number" ||
      !Number.isFinite(x) ||
      Math.abs(x) > 100_000_000 ||
      typeof y !== "number" ||
      !Number.isFinite(y) ||
      Math.abs(y) > 100_000_000 ||
      typeof zoom !== "number" ||
      !Number.isFinite(zoom) ||
      zoom < 0.01 ||
      zoom > 10
    )
      return null;
    return { offset: { x, y }, zoom };
  } catch {
    return null;
  }
}

async function readTitleRequest(request: Request): Promise<{ title: string } | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("title" in body)) return null;
    const title = Reflect.get(body, "title");
    if (typeof title !== "string") return null;
    const normalized = title.trim();
    if (normalized.length === 0 || normalized.length > MAX_TITLE_LENGTH) return null;
    return { title: normalized };
  } catch {
    return null;
  }
}

async function readWorkspaceAccess(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<WorkspaceAccessRow | null> {
  return db
    .prepare(
      `SELECT
        workspaces.id,
        workspaces.owner_account_id,
        workspaces.title,
        workspaces.lifecycle,
        workspaces.deleted_at,
        workspaces.used_bytes,
        workspaces.created_at,
        workspaces.updated_at,
        workspaces.purge_after,
        workspace_members.role,
        account_entitlements.can_edit_collaborate,
        account_entitlements.workspace_storage_limit_bytes
      FROM workspace_members
      INNER JOIN workspaces ON workspaces.id = workspace_members.workspace_id
      INNER JOIN account_entitlements
        ON account_entitlements.account_id = workspaces.owner_account_id
      WHERE workspace_members.user_id = ?
        AND workspace_members.workspace_id = ?
        AND workspace_members.removed_at IS NULL`,
    )
    .bind(userId, workspaceId)
    .first<WorkspaceAccessRow>();
}

function toSummary(row: WorkspaceRow): WorkspaceSummary {
  return {
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    id: row.id,
    lifecycle: toWorkspaceLifecycle(row.lifecycle),
    purgeAfter: row.purge_after,
    role: effectiveWorkspaceRole(toWorkspaceRole(row.role), row.can_edit_collaborate === 1),
    title: row.title,
    updatedAt: row.updated_at,
    usedBytes: row.used_bytes,
    storageLimitBytes: row.workspace_storage_limit_bytes,
    overQuota: row.used_bytes > row.workspace_storage_limit_bytes,
  };
}

function toWorkspaceLifecycle(lifecycle: string): WorkspaceLifecycle {
  if (lifecycle === WorkspaceLifecycle.active) return WorkspaceLifecycle.active;
  if (lifecycle === WorkspaceLifecycle.deleted) return WorkspaceLifecycle.deleted;
  throw new Error(`Invalid persisted workspace lifecycle: ${lifecycle}`);
}

function toWorkspaceRole(role: string): WorkspaceRole {
  if (role === WorkspaceRole.owner) return WorkspaceRole.owner;
  if (role === WorkspaceRole.editor) return WorkspaceRole.editor;
  if (role === WorkspaceRole.viewer) return WorkspaceRole.viewer;
  throw new Error(`Invalid persisted workspace role: ${role}`);
}

function isHostedWorkspaceLimitError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("hosted_workspace_limit_exceeded");
}

function entitlementLimitReason(
  error: unknown,
): "account-storage-limit" | "hosted-workspace-limit" | "workspace-storage-limit" | null {
  if (!(error instanceof Error)) return null;
  if (error.message.includes("hosted_workspace_limit_exceeded")) {
    return "hosted-workspace-limit";
  }
  if (error.message.includes("workspace_storage_limit_exceeded")) {
    return "workspace-storage-limit";
  }
  if (error.message.includes("account_storage_limit_exceeded")) {
    return "account-storage-limit";
  }
  return null;
}

async function writeDeniedCreationAudit(
  db: D1Database,
  userId: UserId,
  workspaceId: string,
  requestId: string,
  createdAt: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, action, target_type, target_id,
        outcome, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, 'workspace.create', 'workspace', ?, 'denied', ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      userId,
      workspaceId,
      requestId,
      JSON.stringify({ reason: "hosted-workspace-limit" }),
      createdAt,
    )
    .run();
}

function auditStatement(
  db: D1Database,
  input: {
    action: string;
    actorUserId: UserId;
    outcome: "success" | "denied";
    metadata?: Record<string, unknown>;
    requestId: string;
    timestamp: number;
    workspaceId: WorkspaceId;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, workspace_id, action, target_type,
        target_id, outcome, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, 'workspace', ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorUserId,
      input.actorUserId,
      input.workspaceId,
      input.action,
      input.workspaceId,
      input.outcome,
      input.requestId,
      JSON.stringify(input.metadata ?? {}),
      input.timestamp,
    );
}
