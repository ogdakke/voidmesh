import {
  ApiErrorCode,
  type CreateInvitationRequest,
  type CreatedInvitationResponse,
  type InvitationLinkSummary,
  type InvitationListResponse,
  type RedeemInvitationResponse,
  type UpdateMemberRequest,
  type WorkspaceMember,
  type WorkspaceMemberListResponse,
  type WorkspaceSummary,
} from "@voidmesh/api-contract";
import { WorkspaceRole, type InvitationId, type UserId, type WorkspaceId } from "@voidmesh/domain";
import { errorResponse, json } from "./http.ts";
import { readIdempotencyKey } from "./idempotency.ts";

const INVITATION_TOKEN_PATTERN = "[A-Za-z0-9_-]{43}";
const IDENTIFIER_PATTERN = "[A-Za-z0-9_-]{1,128}";

interface AccessRow {
  can_edit_collaborate: number;
  can_view_share: number;
  created_at: number;
  lifecycle: string;
  owner_account_id: string;
  role: string;
  title: string;
  updated_at: number;
  used_bytes: number;
  workspace_id: string;
  workspace_storage_limit_bytes: number;
}

interface InvitationRow {
  created_at: number;
  created_by_user_id?: string;
  id: string;
  idempotency_key?: string | null;
  revoked_at: number | null;
  role: string;
  use_count: number;
  workspace_id: string;
}

interface RedeemableInvitationRow extends InvitationRow {
  can_edit_collaborate: number;
  can_view_share: number;
  created_by_user_id: string;
  owner_account_id: string;
  title: string;
  updated_at: number;
  used_bytes: number;
  workspace_storage_limit_bytes: number;
}

interface MemberRow {
  accepted_at: number;
  email: string;
  name: string;
  role: string;
  user_id: string;
}

export function isSharingPath(pathname: string): boolean {
  return (
    pathname.startsWith("/v1/invitations/") ||
    /^\/v1\/workspaces\/[A-Za-z0-9_-]{1,128}\/(invitations|members)(?:\/|$)/.test(pathname)
  );
}

export async function handleSharingRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const redeemMatch = pathname.match(
    new RegExp(`^/v1/invitations/(${INVITATION_TOKEN_PATTERN})/redeem$`),
  );
  if (redeemMatch) {
    if (request.method !== "POST") return methodNotAllowed(requestId);
    return redeemInvitation(env, userId, redeemMatch[1]!, requestId);
  }

  const invitationMatch = pathname.match(
    new RegExp(`^/v1/workspaces/(${IDENTIFIER_PATTERN})/invitations(?:/(${IDENTIFIER_PATTERN}))?$`),
  );
  if (invitationMatch) {
    const workspaceId = invitationMatch[1]!;
    const invitationId = invitationMatch[2];
    if (invitationId) {
      if (request.method !== "DELETE") return methodNotAllowed(requestId);
      return revokeInvitation(env.DB, userId, workspaceId, invitationId, requestId);
    }
    if (request.method === "GET") {
      return listInvitations(env.DB, userId, workspaceId, requestId);
    }
    if (request.method === "POST") {
      return createInvitation(request, env, userId, workspaceId, requestId);
    }
    return methodNotAllowed(requestId);
  }

  const memberMatch = pathname.match(
    new RegExp(`^/v1/workspaces/(${IDENTIFIER_PATTERN})/members(?:/(${IDENTIFIER_PATTERN}))?$`),
  );
  if (memberMatch) {
    const workspaceId = memberMatch[1]!;
    const memberUserId = memberMatch[2];
    if (!memberUserId) {
      if (request.method !== "GET") return methodNotAllowed(requestId);
      return listMembers(env.DB, userId, workspaceId, requestId);
    }
    if (request.method === "PATCH") {
      return updateMember(request, env, userId, workspaceId, memberUserId, requestId);
    }
    if (request.method === "DELETE") {
      return removeMember(env, userId, workspaceId, memberUserId, requestId);
    }
    return methodNotAllowed(requestId);
  }

  return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
}

async function createInvitation(
  request: Request,
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const db = env.DB;
  const access = await readAccess(db, userId, workspaceId);
  if (!isOwnerAccess(access, userId)) return ownerAccessError(access, requestId);

  const input = await readRoleRequest(request);
  if (!input) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "role must be viewer or editor",
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
  if (!roleAllowedByPlan(access, input.role)) {
    return errorResponse(
      ApiErrorCode.forbidden,
      input.role === WorkspaceRole.editor
        ? "Edit collaboration requires a paid plan"
        : "View sharing is not available on this plan",
      requestId,
      403,
    );
  }

  const token = await createInvitationToken(
    env.BETTER_AUTH_SECRET,
    userId,
    workspaceId,
    idempotencyKey,
  );
  const replay = await replayInvitation(
    db,
    userId,
    workspaceId,
    idempotencyKey,
    input.role,
    token,
    requestId,
  );
  if (replay) return replay;

  const invitationId = crypto.randomUUID();
  const tokenHash = await hashToken(token);
  const now = Date.now();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO invitation_links (
            id, workspace_id, token_hash, role, created_by_user_id, created_at,
            idempotency_key
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(invitationId, workspaceId, tokenHash, input.role, userId, now, idempotencyKey),
      auditStatement(db, {
        action: "invitation.create",
        actorUserId: userId,
        metadata: { role: input.role },
        outcome: "success",
        requestId,
        targetId: invitationId,
        targetType: "invitation",
        timestamp: now,
        workspaceId,
      }),
    ]);
  } catch (error) {
    const concurrentReplay = await replayInvitation(
      db,
      userId,
      workspaceId,
      idempotencyKey,
      input.role,
      token,
      requestId,
    );
    if (concurrentReplay) return concurrentReplay;
    throw error;
  }

  const body: CreatedInvitationResponse = {
    invitation: {
      createdAt: now,
      id: invitationId,
      revokedAt: null,
      role: input.role,
      token,
      useCount: 0,
      workspaceId,
    },
  };
  return json(body, 201);
}

async function replayInvitation(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  idempotencyKey: string,
  role: Exclude<WorkspaceRole, "owner">,
  token: string,
  requestId: string,
): Promise<Response | null> {
  const invitation = await db
    .prepare(
      `SELECT id, workspace_id, role, use_count, revoked_at, created_at
       FROM invitation_links
       WHERE created_by_user_id = ? AND workspace_id = ? AND idempotency_key = ?`,
    )
    .bind(userId, workspaceId, idempotencyKey)
    .first<InvitationRow>();
  if (!invitation) return null;
  if (invitation.role !== role) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Idempotency-Key was already used with a different request",
      requestId,
      409,
    );
  }
  return json({
    invitation: { ...toInvitationSummary(invitation), token },
  } satisfies CreatedInvitationResponse);
}

async function listInvitations(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readAccess(db, userId, workspaceId);
  if (!isOwnerAccess(access, userId)) return ownerAccessError(access, requestId);
  const result = await db
    .prepare(
      `SELECT id, workspace_id, role, use_count, revoked_at, created_at
       FROM invitation_links
       WHERE workspace_id = ?
       ORDER BY created_at DESC, id ASC`,
    )
    .bind(workspaceId)
    .all<InvitationRow>();
  const body: InvitationListResponse = {
    invitations: result.results.map(toInvitationSummary),
  };
  return json(body);
}

async function revokeInvitation(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  invitationId: InvitationId,
  requestId: string,
): Promise<Response> {
  const access = await readAccess(db, userId, workspaceId);
  if (!isOwnerAccess(access, userId)) return ownerAccessError(access, requestId);
  const invitation = await db
    .prepare("SELECT id FROM invitation_links WHERE id = ? AND workspace_id = ?")
    .bind(invitationId, workspaceId)
    .first<{ id: string }>();
  if (!invitation) {
    return errorResponse(ApiErrorCode.notFound, "Invitation not found", requestId, 404);
  }

  const now = Date.now();
  await db.batch([
    db
      .prepare("UPDATE invitation_links SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?")
      .bind(now, invitationId),
    auditStatement(db, {
      action: "invitation.revoke",
      actorUserId: userId,
      outcome: "success",
      requestId,
      targetId: invitationId,
      targetType: "invitation",
      timestamp: now,
      workspaceId,
    }),
  ]);
  return new Response(null, { status: 204 });
}

async function redeemInvitation(
  env: Env,
  userId: UserId,
  token: string,
  requestId: string,
): Promise<Response> {
  const tokenHash = await hashToken(token);
  const invitation = await env.DB.prepare(
    `SELECT
      invitation_links.id,
      invitation_links.workspace_id,
      invitation_links.role,
      invitation_links.created_by_user_id,
      invitation_links.use_count,
      invitation_links.revoked_at,
      invitation_links.created_at,
      workspaces.owner_account_id,
      workspaces.title,
      workspaces.used_bytes,
      workspaces.created_at AS workspace_created_at,
      workspaces.updated_at,
      account_entitlements.can_view_share,
      account_entitlements.can_edit_collaborate,
      account_entitlements.workspace_storage_limit_bytes
    FROM invitation_links
    INNER JOIN workspaces ON workspaces.id = invitation_links.workspace_id
    INNER JOIN account_entitlements
      ON account_entitlements.account_id = workspaces.owner_account_id
    WHERE invitation_links.token_hash = ?
      AND invitation_links.revoked_at IS NULL
      AND workspaces.lifecycle = 'active'
      AND (
        invitation_links.max_uses IS NULL
        OR invitation_links.use_count < invitation_links.max_uses
      )`,
  )
    .bind(tokenHash)
    .first<RedeemableInvitationRow & { workspace_created_at: number }>();
  if (!invitation) {
    await writeRedemptionAudit(env.DB, userId, requestId, "denied", null, {
      reason: "unavailable",
    });
    return errorResponse(ApiErrorCode.notFound, "Invitation is unavailable", requestId, 404);
  }

  const role = toInvitableRole(invitation.role);
  if (!roleAllowedByPlan(invitation, role)) {
    await writeRedemptionAudit(env.DB, userId, requestId, "denied", invitation.workspace_id, {
      reason: "entitlement",
      role,
    });
    return errorResponse(
      ApiErrorCode.forbidden,
      role === WorkspaceRole.editor
        ? "Edit collaboration requires a paid plan"
        : "View sharing is not available on this plan",
      requestId,
      403,
    );
  }

  const existing = await readActiveMember(env.DB, invitation.workspace_id, userId);
  if (existing) return redemptionResponse(invitation, existing, invitation.workspace_created_at);

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, role, invited_by_user_id, accepted_at, removed_at
        ) VALUES (?, ?, ?, ?, ?, NULL)
        ON CONFLICT (workspace_id, user_id) DO UPDATE SET
          role = CASE
            WHEN workspace_members.role = 'owner' THEN 'owner'
            WHEN workspace_members.role = 'editor' OR excluded.role = 'editor' THEN 'editor'
            ELSE 'viewer'
          END,
          invited_by_user_id = excluded.invited_by_user_id,
          accepted_at = excluded.accepted_at,
          removed_at = NULL`,
      ).bind(invitation.workspace_id, userId, role, invitation.created_by_user_id, now),
      env.DB.prepare(
        `INSERT INTO invitation_redemptions (
          invitation_id, user_id, outcome, redeemed_at
        ) VALUES (?, ?, 'accepted', ?)`,
      ).bind(invitation.id, userId, now),
      auditStatement(env.DB, {
        action: "invitation.redeem",
        actorUserId: userId,
        metadata: { role },
        outcome: "success",
        requestId,
        targetId: invitation.id,
        targetType: "invitation",
        timestamp: now,
        workspaceId: invitation.workspace_id,
      }),
    ]);
  } catch (error) {
    if (isInvitationUnavailableError(error)) {
      return errorResponse(ApiErrorCode.notFound, "Invitation is unavailable", requestId, 404);
    }
    if (isEditEntitlementError(error)) {
      return errorResponse(
        ApiErrorCode.forbidden,
        "Edit collaboration requires a paid plan",
        requestId,
        403,
      );
    }
    throw error;
  }

  const member = await readActiveMember(env.DB, invitation.workspace_id, userId);
  if (!member) throw new Error("Redeemed membership was not persisted");
  return redemptionResponse(invitation, member, invitation.workspace_created_at);
}

async function listMembers(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
  requestId: string,
): Promise<Response> {
  const access = await readAccess(db, userId, workspaceId);
  if (!access || access.lifecycle !== "active") {
    return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  }
  const result = await db
    .prepare(
      `SELECT
        workspace_members.user_id,
        workspace_members.role,
        workspace_members.accepted_at,
        "user".name,
        "user".email
      FROM workspace_members
      INNER JOIN "user" ON "user".id = workspace_members.user_id
      WHERE workspace_members.workspace_id = ?
        AND workspace_members.removed_at IS NULL
      ORDER BY
        CASE workspace_members.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END,
        workspace_members.accepted_at ASC,
        workspace_members.user_id ASC`,
    )
    .bind(workspaceId)
    .all<MemberRow>();
  const body: WorkspaceMemberListResponse = { members: result.results.map(toMember) };
  return json(body);
}

async function updateMember(
  request: Request,
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  memberUserId: UserId,
  requestId: string,
): Promise<Response> {
  const access = await readAccess(env.DB, userId, workspaceId);
  if (!isOwnerAccess(access, userId)) return ownerAccessError(access, requestId);
  if (memberUserId === userId) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Workspace owner role is immutable",
      requestId,
      400,
    );
  }
  const input = await readRoleRequest(request);
  if (!input) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "role must be viewer or editor",
      requestId,
      400,
    );
  }
  if (!roleAllowedByPlan(access, input.role)) {
    return errorResponse(
      ApiErrorCode.forbidden,
      "Edit collaboration requires a paid plan",
      requestId,
      403,
    );
  }
  const member = await readActiveMember(env.DB, workspaceId, memberUserId);
  if (!member || member.role === WorkspaceRole.owner) {
    return errorResponse(ApiErrorCode.notFound, "Member not found", requestId, 404);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspace_members
       SET role = ?
       WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL AND role != 'owner'`,
    ).bind(input.role, workspaceId, memberUserId),
    auditStatement(env.DB, {
      action: "membership.role-change",
      actorUserId: userId,
      metadata: { from: member.role, to: input.role, userId: memberUserId },
      outcome: "success",
      requestId,
      targetId: memberUserId,
      targetType: "user",
      timestamp: now,
      workspaceId,
    }),
  ]);
  await env.WORKSPACE_ROOMS.getByName(workspaceId).setUserRole(memberUserId, input.role);
  return new Response(null, { status: 204 });
}

async function removeMember(
  env: Env,
  userId: UserId,
  workspaceId: WorkspaceId,
  memberUserId: UserId,
  requestId: string,
): Promise<Response> {
  const access = await readAccess(env.DB, userId, workspaceId);
  if (!isOwnerAccess(access, userId)) return ownerAccessError(access, requestId);
  if (memberUserId === userId) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "Workspace owner cannot be removed",
      requestId,
      400,
    );
  }
  const member = await readActiveMember(env.DB, workspaceId, memberUserId);
  if (!member || member.role === WorkspaceRole.owner) {
    return errorResponse(ApiErrorCode.notFound, "Member not found", requestId, 404);
  }

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspace_members
       SET removed_at = ?
       WHERE workspace_id = ? AND user_id = ? AND removed_at IS NULL AND role != 'owner'`,
    ).bind(now, workspaceId, memberUserId),
    auditStatement(env.DB, {
      action: "membership.remove",
      actorUserId: userId,
      metadata: { role: member.role, userId: memberUserId },
      outcome: "success",
      requestId,
      targetId: memberUserId,
      targetType: "user",
      timestamp: now,
      workspaceId,
    }),
  ]);
  await env.WORKSPACE_ROOMS.getByName(workspaceId).revokeUser(memberUserId);
  return new Response(null, { status: 204 });
}

async function readAccess(
  db: D1Database,
  userId: UserId,
  workspaceId: WorkspaceId,
): Promise<AccessRow | null> {
  return db
    .prepare(
      `SELECT
        workspaces.id AS workspace_id,
        workspaces.owner_account_id,
        workspaces.title,
        workspaces.lifecycle,
        workspaces.used_bytes,
        workspaces.created_at,
        workspaces.updated_at,
        workspace_members.role,
        account_entitlements.can_view_share,
        account_entitlements.can_edit_collaborate,
        account_entitlements.workspace_storage_limit_bytes
      FROM workspaces
      INNER JOIN workspace_members ON workspace_members.workspace_id = workspaces.id
      INNER JOIN account_entitlements
        ON account_entitlements.account_id = workspaces.owner_account_id
      WHERE workspaces.id = ?
        AND workspace_members.user_id = ?
        AND workspace_members.removed_at IS NULL`,
    )
    .bind(workspaceId, userId)
    .first<AccessRow>();
}

async function readActiveMember(
  db: D1Database,
  workspaceId: WorkspaceId,
  userId: UserId,
): Promise<MemberRow | null> {
  return db
    .prepare(
      `SELECT
        workspace_members.user_id,
        workspace_members.role,
        workspace_members.accepted_at,
        "user".name,
        "user".email
      FROM workspace_members
      INNER JOIN "user" ON "user".id = workspace_members.user_id
      WHERE workspace_members.workspace_id = ?
        AND workspace_members.user_id = ?
        AND workspace_members.removed_at IS NULL`,
    )
    .bind(workspaceId, userId)
    .first<MemberRow>();
}

function redemptionResponse(
  invitation: RedeemableInvitationRow,
  member: MemberRow,
  workspaceCreatedAt: number,
): Response {
  const membership = toMember(member);
  const workspace: WorkspaceSummary = {
    createdAt: workspaceCreatedAt,
    deletedAt: null,
    id: invitation.workspace_id,
    lifecycle: "active",
    purgeAfter: null,
    role: membership.role,
    title: invitation.title,
    updatedAt: invitation.updated_at,
    usedBytes: invitation.used_bytes,
    storageLimitBytes: invitation.workspace_storage_limit_bytes,
    overQuota: invitation.used_bytes > invitation.workspace_storage_limit_bytes,
  };
  const body: RedeemInvitationResponse = { membership, workspace };
  return json(body);
}

function isOwnerAccess(access: AccessRow | null, userId: UserId): access is AccessRow {
  return (
    access !== null &&
    access.lifecycle === "active" &&
    access.owner_account_id === userId &&
    access.role === WorkspaceRole.owner
  );
}

function ownerAccessError(access: AccessRow | null, requestId: string): Response {
  return access && access.lifecycle === "active"
    ? errorResponse(ApiErrorCode.forbidden, "Owner access required", requestId, 403)
    : errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
}

function roleAllowedByPlan(
  entitlements: { can_edit_collaborate: number; can_view_share: number },
  role: Exclude<WorkspaceRole, "owner">,
): boolean {
  return role === WorkspaceRole.editor
    ? entitlements.can_edit_collaborate === 1
    : entitlements.can_view_share === 1;
}

async function readRoleRequest(
  request: Request,
): Promise<CreateInvitationRequest | UpdateMemberRequest | null> {
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || !("role" in body)) return null;
    const role = Reflect.get(body, "role");
    if (role === WorkspaceRole.editor) return { role: WorkspaceRole.editor };
    if (role === WorkspaceRole.viewer) return { role: WorkspaceRole.viewer };
    return null;
  } catch {
    return null;
  }
}

async function createInvitationToken(
  secret: string,
  userId: UserId,
  workspaceId: WorkspaceId,
  idempotencyKey: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`invitation:${userId}:${workspaceId}:${idempotencyKey}`),
  );
  const bytes = new Uint8Array(signature);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

async function hashToken(token: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
}

function toInvitationSummary(row: InvitationRow): InvitationLinkSummary {
  return {
    createdAt: row.created_at,
    id: row.id,
    revokedAt: row.revoked_at,
    role: toInvitableRole(row.role),
    useCount: row.use_count,
    workspaceId: row.workspace_id,
  };
}

function toMember(row: MemberRow): WorkspaceMember {
  return {
    acceptedAt: row.accepted_at,
    email: row.email,
    name: row.name,
    role: toRole(row.role),
    userId: row.user_id,
  };
}

function toInvitableRole(role: string): Exclude<WorkspaceRole, "owner"> {
  if (role === WorkspaceRole.editor) return WorkspaceRole.editor;
  if (role === WorkspaceRole.viewer) return WorkspaceRole.viewer;
  throw new Error(`Invalid persisted invitation role: ${role}`);
}

function toRole(role: string): WorkspaceRole {
  if (role === WorkspaceRole.owner) return WorkspaceRole.owner;
  return toInvitableRole(role);
}

function methodNotAllowed(requestId: string): Response {
  return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
}

function isInvitationUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("invitation_unavailable");
}

function isEditEntitlementError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("edit_collaboration_required");
}

async function writeRedemptionAudit(
  db: D1Database,
  userId: UserId,
  requestId: string,
  outcome: "success" | "denied",
  workspaceId: WorkspaceId | null,
  metadata: Record<string, unknown>,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, workspace_id, action, target_type, outcome,
        request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, 'invitation.redeem', 'invitation', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      userId,
      workspaceId,
      outcome,
      requestId,
      JSON.stringify(metadata),
      Date.now(),
    )
    .run();
}

function auditStatement(
  db: D1Database,
  input: {
    action: string;
    actorUserId: UserId;
    metadata?: Record<string, unknown>;
    outcome: "success" | "denied";
    requestId: string;
    targetId: string;
    targetType: string;
    timestamp: number;
    workspaceId: WorkspaceId;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, workspace_id, action, target_type,
        target_id, outcome, request_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.actorUserId,
      input.actorUserId,
      input.workspaceId,
      input.action,
      input.targetType,
      input.targetId,
      input.outcome,
      input.requestId,
      JSON.stringify(input.metadata ?? {}),
      input.timestamp,
    );
}
