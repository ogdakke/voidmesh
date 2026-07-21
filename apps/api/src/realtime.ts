import { ApiErrorCode, type WorkspaceSocketTicketResponse } from "@voidmesh/api-contract";
import { WorkspaceRole, effectiveWorkspaceRole, type UserId } from "@voidmesh/domain";
import { errorResponse, json } from "./http.ts";
import { issueRoomAuthorization, verifyRoomAuthorization } from "./room-authorization.ts";
import { isTrustedWebOrigin } from "./web-origins.ts";

const IDENTIFIER = "[A-Za-z0-9_-]{1,128}";
const CONNECT_PATH = new RegExp(`^/v1/workspaces/(${IDENTIFIER})/connect$`);
const TICKET_PATH = new RegExp(`^/v1/workspaces/(${IDENTIFIER})/connect-ticket$`);
const TICKET_PROTOCOL_PREFIX = "voidmesh.ticket.";

interface ConnectionAccessRow {
  can_edit_collaborate: number;
  name: string;
  role: string;
}

export function isRealtimePath(pathname: string): boolean {
  return CONNECT_PATH.test(pathname) || TICKET_PATH.test(pathname);
}

export function isTicketRealtimeRequest(request: Request): boolean {
  const url = new URL(request.url);
  return (
    request.method === "GET" &&
    CONNECT_PATH.test(url.pathname) &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket" &&
    request.headers.get("sec-websocket-protocol")?.startsWith(TICKET_PROTOCOL_PREFIX) === true
  );
}

export async function handleAuthenticatedRealtimeRequest(
  request: Request,
  env: Env,
  userId: UserId,
  sessionId: string,
  requestId: string,
): Promise<Response> {
  const url = new URL(request.url);
  const ticketWorkspaceId = url.pathname.match(TICKET_PATH)?.[1];
  if (ticketWorkspaceId) {
    if (request.method !== "POST") {
      return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
    }
    const access = await loadConnectionAccess(env, ticketWorkspaceId, userId);
    if (!access) return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
    const authorization = await issueRoomAuthorization(env.BETTER_AUTH_SECRET, {
      name: access.name,
      role: effectiveWorkspaceRole(toRole(access.role), access.can_edit_collaborate === 1),
      sessionId,
      userId,
      workspaceId: ticketWorkspaceId,
    });
    const origin = realtimeOrigin(env);
    const body: WorkspaceSocketTicketResponse = {
      protocol: `${TICKET_PROTOCOL_PREFIX}${authorization}`,
      socketUrl: `${origin}/v1/workspaces/${encodeURIComponent(ticketWorkspaceId)}/connect`,
    };
    return json(body, 201);
  }

  const workspaceId = url.pathname.match(CONNECT_PATH)?.[1];
  if (!workspaceId) return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
  if (request.method !== "GET" || request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return errorResponse(ApiErrorCode.invalidRequest, "WebSocket upgrade required", requestId, 426);
  }
  const access = await loadConnectionAccess(env, workspaceId, userId);
  if (!access) return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  return openRoom(request, env, workspaceId, userId, sessionId, access);
}

export async function handleTicketRealtimeRequest(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  const workspaceId = new URL(request.url).pathname.match(CONNECT_PATH)?.[1];
  const protocol = request.headers.get("sec-websocket-protocol");
  if (!workspaceId || !protocol?.startsWith(TICKET_PROTOCOL_PREFIX)) {
    return errorResponse(ApiErrorCode.unauthorized, "Authentication required", requestId, 401);
  }
  const origin = request.headers.get("origin");
  if (!origin || !isTrustedWebOrigin(env, origin)) {
    return errorResponse(ApiErrorCode.forbidden, "Untrusted WebSocket origin", requestId, 403);
  }
  const authorization = await verifyRoomAuthorization(
    env.BETTER_AUTH_SECRET,
    protocol.slice(TICKET_PROTOCOL_PREFIX.length),
  );
  if (!authorization || authorization.workspaceId !== workspaceId) {
    return errorResponse(ApiErrorCode.unauthorized, "Invalid WebSocket ticket", requestId, 401);
  }
  const session = await env.DB.prepare(
    `SELECT id FROM "session"
     WHERE id = ? AND "userId" = ? AND "expiresAt" > CURRENT_TIMESTAMP`,
  )
    .bind(authorization.sessionId, authorization.userId)
    .first();
  if (!session) return errorResponse(ApiErrorCode.unauthorized, "Session expired", requestId, 401);
  const access = await loadConnectionAccess(env, workspaceId, authorization.userId);
  if (!access) return errorResponse(ApiErrorCode.notFound, "Workspace not found", requestId, 404);
  return openRoom(
    request,
    env,
    workspaceId,
    authorization.userId,
    authorization.sessionId,
    access,
    protocol,
  );
}

function loadConnectionAccess(
  env: Env,
  workspaceId: string,
  userId: UserId,
): Promise<ConnectionAccessRow | null> {
  return env.DB.prepare(
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
}

async function openRoom(
  request: Request,
  env: Env,
  workspaceId: string,
  userId: UserId,
  sessionId: string,
  access: ConnectionAccessRow,
  protocol?: string,
): Promise<Response> {
  const headers = new Headers({ upgrade: "websocket" });
  if (protocol) headers.set("sec-websocket-protocol", protocol);
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
  const response = await env.WORKSPACE_ROOMS.getByName(workspaceId).fetch(
    new Request(request.url, { headers, method: "GET" }),
  );
  if (!protocol || !response.webSocket) return response;
  return new Response(null, {
    headers: { "sec-websocket-protocol": protocol },
    status: 101,
    webSocket: response.webSocket,
  });
}

function realtimeOrigin(env: Env): string {
  if (env.ENVIRONMENT === "development") return "";
  const origin = new URL(env.REALTIME_ORIGIN);
  if (origin.protocol !== "https:" || origin.pathname !== "/") {
    throw new Error("REALTIME_ORIGIN must be an HTTPS origin");
  }
  return origin.origin;
}

function toRole(value: string): WorkspaceRole {
  if (value === WorkspaceRole.owner) return WorkspaceRole.owner;
  if (value === WorkspaceRole.editor) return WorkspaceRole.editor;
  if (value === WorkspaceRole.viewer) return WorkspaceRole.viewer;
  throw new Error(`Invalid persisted workspace role: ${value}`);
}
