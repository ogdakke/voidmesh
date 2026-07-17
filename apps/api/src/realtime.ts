import { ApiErrorCode } from "@voidmesh/api-contract";
import { WorkspaceRole, effectiveWorkspaceRole, type UserId } from "@voidmesh/domain";
import { errorResponse } from "./http.ts";
import { issueRoomAuthorization } from "./room-authorization.ts";

const CONNECT_PATH = /^\/v1\/workspaces\/([A-Za-z0-9_-]{1,128})\/connect$/;

interface ConnectionAccessRow {
  can_edit_collaborate: number;
  name: string;
  role: string;
}

export function isRealtimePath(pathname: string): boolean {
  return CONNECT_PATH.test(pathname);
}

export async function handleRealtimeRequest(
  request: Request,
  env: Env,
  userId: UserId,
  sessionId: string,
  requestId: string,
): Promise<Response> {
  const workspaceId = new URL(request.url).pathname.match(CONNECT_PATH)?.[1];
  if (!workspaceId) return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(ApiErrorCode.invalidRequest, "WebSocket upgrade required", requestId, 426);
  }
  const access = await env.DB.prepare(
    `SELECT
       workspace_members.role,
       "user".name,
       account_entitlements.can_edit_collaborate
     FROM workspace_members
     INNER JOIN workspaces ON workspaces.id = workspace_members.workspace_id
     INNER JOIN "user" ON "user".id = workspace_members.user_id
     INNER JOIN account_entitlements
       ON account_entitlements.account_id = workspaces.owner_account_id
     WHERE workspace_members.workspace_id = ?
       AND workspace_members.user_id = ?
       AND workspace_members.removed_at IS NULL
       AND workspaces.lifecycle = 'active'`,
  )
    .bind(workspaceId, userId)
    .first<ConnectionAccessRow>();
  if (!access) return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);

  const headers = new Headers({ upgrade: "websocket" });
  const protocol = request.headers.get("sec-websocket-protocol");
  if (protocol && protocol.length <= 1_024) headers.set("sec-websocket-protocol", protocol);
  headers.set(
    "x-voidmesh-room-authorization",
    await issueRoomAuthorization(env.BETTER_AUTH_SECRET, {
      name: access.name,
      role: effectiveWorkspaceRole(toRole(access.role), access.can_edit_collaborate === 1),
      sessionId,
      userId,
      workspaceId,
    }),
  );
  return env.WORKSPACE_ROOMS.getByName(workspaceId).fetch(
    new Request(request.url, {
      headers,
      method: "GET",
    }),
  );
}

function toRole(value: string): WorkspaceRole {
  if (value === WorkspaceRole.owner) return WorkspaceRole.owner;
  if (value === WorkspaceRole.editor) return WorkspaceRole.editor;
  if (value === WorkspaceRole.viewer) return WorkspaceRole.viewer;
  throw new Error(`Invalid persisted workspace role: ${value}`);
}
