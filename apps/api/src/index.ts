import { ApiErrorCode, type HealthResponse } from "@voidmesh/api-contract";
import {
  handleAssetRequest,
  handleObjectGrantRequest,
  isAssetPath,
  isObjectGrantPath,
} from "./assets.ts";
import { createAuth, handleAuthRequest, isAuthPath } from "./auth.ts";
import { errorResponse, json } from "./http.ts";
import {
  handleAuthenticatedRealtimeRequest,
  handleTicketRealtimeRequest,
  isRealtimePath,
  isTicketRealtimeRequest,
} from "./realtime.ts";
import { handleSharingRequest, isSharingPath } from "./sharing.ts";
import { handleWorkspaceRequest } from "./workspaces.ts";
import { handleAccountRequest } from "./account.ts";
import {
  handleBillingRequest,
  handleBillingWebhook,
  isBillingPath,
  isBillingWebhookPath,
} from "./billing.ts";
import {
  cleanupExpiredExports,
  cleanupExpiredUploads,
  purgeExpiredWorkspaces,
} from "./lifecycle.ts";
import { guardAuthenticatedRequest, guardPublicAuthRequest } from "./rate-limit.ts";
import {
  handleWorkspaceExportRequest,
  isWorkspaceExportPath,
  processWorkspaceExport,
  type WorkspaceExportQueueMessage,
} from "./exports.ts";
import {
  cleanupDeliveredSecurityAuditOutbox,
  flushSecurityAuditOutbox,
  processSecurityAuditEvent,
  type SecurityAuditQueueMessage,
} from "./security-audit.ts";

export { WorkspaceRoom } from "./workspace-room.ts";

export default {
  async fetch(request, env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    const startedAt = performance.now();
    let status = 500;

    try {
      const response = await routeRequest(request, env, requestId, url);
      status = response.status;
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
          message: "request failed",
          method: request.method,
          path: safeLogPath(url.pathname),
          requestId,
        }),
      );
      const response = errorResponse(
        ApiErrorCode.internal,
        "Internal server error",
        requestId,
        500,
      );
      status = response.status;
      return response;
    } finally {
      console.log(
        JSON.stringify({
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          event: "api-request",
          method: request.method,
          requestId,
          route: safeLogPath(url.pathname),
          status,
        }),
      );
    }
  },
  scheduled(controller, env, ctx): void {
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(
        flushSecurityAuditOutbox(env, controller.scheduledTime).then((auditFlush) => {
          console.log(JSON.stringify({ auditFlush, event: "security-audit-flush" }));
        }),
      );
      return;
    }
    ctx.waitUntil(
      Promise.all([
        purgeExpiredWorkspaces(env, controller.scheduledTime),
        cleanupExpiredUploads(env, controller.scheduledTime),
        cleanupExpiredExports(env, controller.scheduledTime),
        cleanupDeliveredSecurityAuditOutbox(env.DB, controller.scheduledTime),
      ]).then(([workspacePurge, uploadCleanup, exportCleanup, auditOutboxCleanup]) => {
        console.log(
          JSON.stringify({
            auditOutboxCleanup,
            event: "scheduled-maintenance",
            exportCleanup,
            uploadCleanup,
            workspacePurge,
          }),
        );
      }),
    );
  },
  async queue(
    batch: MessageBatch<SecurityAuditQueueMessage | WorkspaceExportQueueMessage>,
    env,
  ): Promise<void> {
    for (const message of batch.messages) {
      if (message.body.kind === "security-audit") {
        try {
          for (const eventId of message.body.eventIds) {
            await processSecurityAuditEvent(env, eventId);
          }
          message.ack();
        } catch (error) {
          console.error(
            JSON.stringify({
              error: error instanceof Error ? error.message : String(error),
              event: "security-audit-delivery-failed",
              eventCount:
                message.body.kind === "security-audit" ? message.body.eventIds.length : undefined,
            }),
          );
          message.retry();
        }
        continue;
      }
      try {
        await processWorkspaceExport(env, message.body.exportId);
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            event: "workspace-export-failed",
            exportId: message.body.kind === "workspace-export" ? message.body.exportId : undefined,
          }),
        );
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, SecurityAuditQueueMessage | WorkspaceExportQueueMessage>;

async function routeRequest(
  request: Request,
  env: Env,
  requestId: string,
  url: URL,
): Promise<Response> {
  if (request.method === "GET" && url.pathname === "/v1/health") {
    const body: HealthResponse = {
      environment: env.ENVIRONMENT,
      ok: true,
      service: "voidmesh-api",
    };
    return json(body);
  }

  if (isAuthPath(url.pathname)) {
    const denied = await guardPublicAuthRequest(request, env, requestId);
    return handleAuthRequest(request, env, requestId, denied);
  }

  if (isBillingWebhookPath(url.pathname)) {
    return handleBillingWebhook(request, env, requestId);
  }

  if (isTicketRealtimeRequest(request)) {
    return handleTicketRealtimeRequest(request, env, requestId);
  }

  if (
    isAssetPath(url.pathname) ||
    isObjectGrantPath(url.pathname) ||
    isRealtimePath(url.pathname) ||
    isSharingPath(url.pathname) ||
    isWorkspaceExportPath(url.pathname) ||
    isBillingPath(url.pathname) ||
    url.pathname === "/v1/me" ||
    url.pathname === "/v1/workspaces" ||
    url.pathname.startsWith("/v1/workspaces/")
  ) {
    const session = await createAuth(env).api.getSession({ headers: request.headers });
    if (!session) {
      return errorResponse(ApiErrorCode.unauthorized, "Authentication required", requestId, 401);
    }
    const rateLimited = await guardAuthenticatedRequest(request, env, session.user.id, requestId);
    if (rateLimited) return rateLimited;
    if (isRealtimePath(url.pathname)) {
      return handleAuthenticatedRealtimeRequest(
        request,
        env,
        session.user.id,
        session.session.id,
        requestId,
      );
    }
    if (isAssetPath(url.pathname)) {
      return handleAssetRequest(request, env, session.user.id, requestId);
    }
    if (isObjectGrantPath(url.pathname)) {
      return handleObjectGrantRequest(request, env, session.user.id, requestId);
    }
    if (isSharingPath(url.pathname)) {
      return handleSharingRequest(request, env, session.user.id, requestId);
    }
    if (isWorkspaceExportPath(url.pathname)) {
      return handleWorkspaceExportRequest(request, env, session.user.id, requestId);
    }
    if (isBillingPath(url.pathname)) {
      return handleBillingRequest(request, env, session.user.id, requestId);
    }
    if (url.pathname === "/v1/me") {
      return handleAccountRequest(request, env, session.user.id, requestId);
    }
    return handleWorkspaceRequest(request, env, session.user.id, requestId);
  }

  return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
}

export function safeLogPath(pathname: string): string {
  return pathname
    .replace(/^\/v1\/invitations\/[^/]+/, "/v1/invitations/:token")
    .replace(/^\/v1\/object-grants\/[^/]+/, "/v1/object-grants/:grantId")
    .replace(/^\/v1\/workspaces\/[^/]+/, "/v1/workspaces/:workspaceId")
    .replace(/\/assets\/uploads\/[^/]+/, "/assets/uploads/:reservationId")
    .replace(/\/assets\/(?!uploads(?:\/|$))[^/]+/, "/assets/:assetId")
    .replace(/\/invitations\/(?!:)[^/]+/, "/invitations/:invitationId")
    .replace(/\/members\/[^/]+/, "/members/:userId")
    .replace(/\/exports\/[^/]+/, "/exports/:exportId");
}
