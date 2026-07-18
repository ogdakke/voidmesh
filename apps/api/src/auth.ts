import { betterAuth } from "better-auth";
import { GIBIBYTE } from "@voidmesh/domain";
import { cancelBillingForAccountDeletion } from "./billing.ts";
import { hasEmailDelivery, sendAccountVerificationEmail, sendPasswordResetEmail } from "./email.ts";
import { readTrustedWebOrigins } from "./web-origins.ts";
import { WORKSPACE_DELETION_RETENTION_MS } from "./workspaces.ts";

const AUTH_PATH = "/v1/auth";

export function createAuth(env: Env) {
  const config = readAuthConfiguration(env);
  const emailDelivery = hasEmailDelivery(env);

  return betterAuth({
    advanced: {
      database: { generateId: "uuid" },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    appName: "Voidmesh",
    basePath: AUTH_PATH,
    baseURL: config.baseURL,
    database: env.DB,
    databaseHooks: {
      session: {
        delete: {
          after: async (session) => {
            await revokeSessionConnections(env, session.userId, session.id);
          },
        },
      },
      user: {
        create: {
          after: async (user) => {
            const now = Date.now();
            await env.DB.prepare(
              `INSERT INTO account_entitlements (
                account_id,
                plan_key,
                hosted_workspace_limit,
                account_storage_limit_bytes,
                workspace_storage_limit_bytes,
                hard_asset_limit_bytes,
                can_view_share,
                can_edit_collaborate,
                effective_at,
                updated_at
              ) VALUES (?, 'cloud-free', 1, ?, ?, ?, 1, 0, ?, ?)`,
            )
              .bind(user.id, GIBIBYTE, GIBIBYTE, GIBIBYTE, now, now)
              .run();
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 12,
      requireEmailVerification: emailDelivery,
      revokeSessionsOnPasswordReset: true,
      ...(emailDelivery && {
        sendResetPassword: async ({ user, url }) => {
          await sendPasswordResetEmail(env, {
            email: user.email,
            name: user.name,
            url,
          });
        },
      }),
    },
    ...(emailDelivery && {
      emailVerification: {
        autoSignInAfterVerification: true,
        expiresIn: 60 * 60,
        sendOnSignIn: true,
        sendOnSignUp: true,
        sendVerificationEmail: async ({ user, url }) => {
          await sendAccountVerificationEmail(env, {
            email: user.email,
            name: user.name,
            url,
          });
        },
      },
    }),
    user: {
      deleteUser: {
        enabled: true,
        beforeDelete: async (user) => {
          await prepareAccountDeletion(env, user.id);
        },
      },
    },
    rateLimit: {
      enabled: true,
      max: 100,
      storage: "database",
      window: 60,
    },
    secret: config.secret,
    telemetry: { enabled: false },
    trustedOrigins: config.trustedOrigins,
  });
}

async function revokeSessionConnections(
  env: Env,
  userId: string,
  sessionId: string,
): Promise<void> {
  const memberships = await env.DB.prepare(
    `SELECT workspace_id FROM workspace_members
     WHERE user_id = ? AND removed_at IS NULL`,
  )
    .bind(userId)
    .all<{ workspace_id: string }>();
  await Promise.all(
    memberships.results.map(({ workspace_id }) =>
      env.WORKSPACE_ROOMS.getByName(workspace_id).revokeSession(userId, sessionId),
    ),
  );
}

export async function handleAuthRequest(
  request: Request,
  env: Env,
  requestId: string,
  guardedResponse: Response | null,
): Promise<Response> {
  const auth = createAuth(env);
  const action = authAuditAction(new URL(request.url).pathname);
  if (!action) return guardedResponse ?? auth.handler(request);

  const session = await auth.api.getSession({ headers: request.headers });
  const response = guardedResponse ?? (await auth.handler(request));
  const actorUserId = session?.user.id ?? (await readResponseUserId(response));
  const outcome = response.status < 400 ? "success" : "denied";
  await env.DB.prepare(
    `INSERT INTO audit_events (
      id, actor_user_id, account_id, action, target_type, target_id,
      outcome, request_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'authentication', ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      actorUserId,
      actorUserId,
      action,
      actorUserId,
      outcome,
      requestId,
      JSON.stringify({ method: request.method, status: response.status }),
      Date.now(),
    )
    .run();
  return response;
}

async function prepareAccountDeletion(env: Env, userId: string): Promise<void> {
  await cancelBillingForAccountDeletion(env, userId);
  const owned = await env.DB.prepare(
    `SELECT id FROM workspaces
     WHERE owner_account_id = ? AND lifecycle = 'active'`,
  )
    .bind(userId)
    .all<{ id: string }>();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE workspaces
       SET lifecycle = 'deleted', deleted_at = ?, purge_after = ?, updated_at = ?
       WHERE owner_account_id = ? AND lifecycle = 'active'`,
    ).bind(now, now + WORKSPACE_DELETION_RETENTION_MS, now, userId),
    env.DB.prepare(
      `UPDATE workspace_members SET removed_at = COALESCE(removed_at, ?)
       WHERE user_id = ? AND role != 'owner'`,
    ).bind(now, userId),
    env.DB.prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, action, target_type, target_id,
        outcome, request_id, created_at
      ) VALUES (?, ?, ?, 'account.delete', 'account', ?, 'success', ?, ?)`,
    ).bind(crypto.randomUUID(), userId, userId, userId, crypto.randomUUID(), now),
  ]);
  await Promise.all(owned.results.map(({ id }) => env.WORKSPACE_ROOMS.getByName(id).revokeAll()));
}

export function isAuthPath(pathname: string): boolean {
  return pathname === AUTH_PATH || pathname.startsWith(`${AUTH_PATH}/`);
}

function authAuditAction(pathname: string): string | null {
  const suffix = pathname.slice(AUTH_PATH.length);
  switch (suffix) {
    case "/sign-up/email":
      return "auth.sign-up";
    case "/sign-in/email":
      return "auth.sign-in";
    case "/sign-out":
      return "auth.sign-out";
    case "/revoke-session":
      return "auth.session-revoke";
    case "/revoke-sessions":
      return "auth.sessions-revoke";
    case "/revoke-other-sessions":
      return "auth.other-sessions-revoke";
    case "/request-password-reset":
      return "auth.password-reset-request";
    case "/reset-password":
      return "auth.password-reset-complete";
    case "/send-verification-email":
      return "auth.email-verification-send";
    case "/verify-email":
      return "auth.email-verification-complete";
    default:
      return null;
  }
}

async function readResponseUserId(response: Response): Promise<string | null> {
  if (response.status >= 400 || !response.headers.get("content-type")?.includes("json")) {
    return null;
  }
  try {
    const value: unknown = await response.clone().json();
    if (!value || typeof value !== "object") return null;
    const user = Reflect.get(value, "user");
    if (!user || typeof user !== "object") return null;
    const id = Reflect.get(user, "id");
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function readAuthConfiguration(env: Env): {
  baseURL: {
    allowedHosts: string[];
    fallback: string;
    protocol: "auto";
  };
  secret: string;
  trustedOrigins: string[];
} {
  const fallback = readBinding(env, "BETTER_AUTH_URL");
  const trustedOrigins = readTrustedWebOrigins(env);
  return {
    baseURL: {
      allowedHosts: trustedOrigins.map((origin) => origin.replace(/^https?:\/\//, "")),
      fallback,
      protocol: "auto",
    },
    secret: readBinding(env, "BETTER_AUTH_SECRET"),
    trustedOrigins,
  };
}

function readBinding(env: Env, name: string): string {
  const bindings = env as unknown as Record<string, unknown>;
  const value = bindings[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Missing required Worker binding: ${name}`);
  }
  return value;
}
