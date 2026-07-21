import { ApiErrorCode } from "@voidmesh/api-contract";
import type { UserId } from "@voidmesh/domain";
import { errorResponse } from "./http.ts";

interface RateLimitPolicy {
  maxRequests: number;
  scope: string;
  windowMs: number;
}

interface RateLimitRow {
  expires_at: number;
  request_count: number;
}

const PUBLIC_AUTH_POLICIES = new Map<string, RateLimitPolicy>([
  ["/v1/auth/sign-up/email", { maxRequests: 3, scope: "auth-sign-up", windowMs: 10 * 60_000 }],
  ["/v1/auth/sign-in/email", { maxRequests: 20, scope: "auth-sign-in", windowMs: 5 * 60_000 }],
  [
    "/v1/auth/request-password-reset",
    { maxRequests: 5, scope: "auth-reset", windowMs: 10 * 60_000 },
  ],
  ["/v1/auth/reset-password", { maxRequests: 5, scope: "auth-reset", windowMs: 10 * 60_000 }],
]);

export async function guardPublicAuthRequest(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  if (request.method !== "POST") return null;
  const policy = PUBLIC_AUTH_POLICIES.get(new URL(request.url).pathname);
  if (!policy) return null;
  const limited = await enforceRateLimit(env.DB, policy, clientAddress(request), requestId);
  if (limited) return limited;
  if (policy.scope === "auth-sign-up") return verifyTurnstile(request, env, requestId);
  return null;
}

export async function guardAuthenticatedRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response | null> {
  const policy = authenticatedPolicy(request);
  if (!policy) return null;
  const workspaceId =
    new URL(request.url).pathname.match(/\/workspaces\/([^/]+)/)?.[1] ?? "account";
  return enforceRateLimit(env.DB, policy, `${userId}:${workspaceId}`, requestId);
}

export async function deleteExpiredRateLimits(db: D1Database, now = Date.now()): Promise<void> {
  await db.prepare("DELETE FROM api_rate_limits WHERE expires_at <= ?").bind(now).run();
}

function authenticatedPolicy(request: Request): RateLimitPolicy | null {
  const pathname = new URL(request.url).pathname;
  if (pathname.endsWith("/connect")) {
    return { maxRequests: 60, scope: "workspace-connect", windowMs: 60_000 };
  }
  if (pathname.includes("/assets/uploads") && request.method === "POST") {
    return { maxRequests: 60, scope: "asset-upload", windowMs: 60_000 };
  }
  if (pathname.endsWith("/export") && request.method === "POST") {
    return { maxRequests: 10, scope: "workspace-export", windowMs: 60 * 60_000 };
  }
  if (
    (pathname.endsWith("/download") || pathname.endsWith("/content")) &&
    request.method === "POST"
  ) {
    return { maxRequests: 120, scope: "asset-download", windowMs: 60_000 };
  }
  if (pathname.startsWith("/v1/invitations/") && request.method === "POST") {
    return { maxRequests: 30, scope: "invitation-redeem", windowMs: 5 * 60_000 };
  }
  if (pathname.startsWith("/v1/billing/") && request.method === "POST") {
    return { maxRequests: 10, scope: "billing-session", windowMs: 10 * 60_000 };
  }
  return null;
}

async function enforceRateLimit(
  db: D1Database,
  policy: RateLimitPolicy,
  identity: string,
  requestId: string,
): Promise<Response | null> {
  const now = Date.now();
  const expiresAt = now + policy.windowMs;
  const keyHash = await sha256Hex(`${policy.scope}:${identity}`);
  const row = await db
    .prepare(
      `INSERT INTO api_rate_limits (
        scope, key_hash, window_started_at, request_count, expires_at
      ) VALUES (?, ?, ?, 1, ?)
      ON CONFLICT (scope, key_hash) DO UPDATE SET
        window_started_at = CASE
          WHEN api_rate_limits.expires_at <= ? THEN excluded.window_started_at
          ELSE api_rate_limits.window_started_at
        END,
        request_count = CASE
          WHEN api_rate_limits.expires_at <= ? THEN 1
          ELSE api_rate_limits.request_count + 1
        END,
        expires_at = CASE
          WHEN api_rate_limits.expires_at <= ? THEN excluded.expires_at
          ELSE api_rate_limits.expires_at
        END
      RETURNING request_count, expires_at`,
    )
    .bind(policy.scope, keyHash, now, expiresAt, now, now, now)
    .first<RateLimitRow>();
  if (!row || row.request_count <= policy.maxRequests) return null;
  const response = errorResponse(
    ApiErrorCode.rateLimited,
    "Too many requests. Please try again later.",
    requestId,
    429,
  );
  response.headers.set(
    "retry-after",
    String(Math.max(1, Math.ceil((row.expires_at - now) / 1_000))),
  );
  return response;
}

async function verifyTurnstile(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response | null> {
  const secret = (env as unknown as Record<string, unknown>).TURNSTILE_SECRET_KEY;
  if (typeof secret !== "string" || secret.length === 0) return null;
  const token = request.headers.get("x-turnstile-token");
  if (!token || token.length > 2_048) return turnstileDenied(requestId);
  const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    body: JSON.stringify({
      idempotency_key: crypto.randomUUID(),
      remoteip: clientAddress(request),
      response: token,
      secret,
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) return turnstileDenied(requestId);
  const result: unknown = await response.json();
  return result && typeof result === "object" && Reflect.get(result, "success") === true
    ? null
    : turnstileDenied(requestId);
}

function turnstileDenied(requestId: string): Response {
  return errorResponse(
    ApiErrorCode.forbidden,
    "Human verification is required to create an account.",
    requestId,
    403,
  );
}

function clientAddress(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() ??
    "unknown"
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
