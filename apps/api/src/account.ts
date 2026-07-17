import { ApiErrorCode, type AccountResponse } from "@voidmesh/api-contract";
import { PlanKey, type UserId } from "@voidmesh/domain";
import { errorResponse, json } from "./http.ts";

interface AccountRow {
  account_storage_limit_bytes: number;
  can_edit_collaborate: number;
  can_view_share: number;
  hard_asset_limit_bytes: number;
  hosted_workspace_limit: number;
  owned_storage_bytes: number;
  owned_workspace_count: number;
  plan_key: string;
  workspace_storage_limit_bytes: number;
}

interface SubscriptionRow {
  cancel_at_period_end: number;
  current_period_ends_at: number | null;
  status: string;
}

export async function handleAccountRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  if (request.method !== "GET") {
    return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
  }
  const account = await env.DB.prepare(
    `SELECT
      account_entitlements.plan_key,
      account_entitlements.hosted_workspace_limit,
      account_entitlements.account_storage_limit_bytes,
      account_entitlements.workspace_storage_limit_bytes,
      account_entitlements.hard_asset_limit_bytes,
      account_entitlements.can_view_share,
      account_entitlements.can_edit_collaborate,
      COALESCE(SUM(
        CASE WHEN workspaces.lifecycle = 'active' THEN 1 ELSE 0 END
      ), 0) AS owned_workspace_count,
      COALESCE(SUM(workspaces.used_bytes), 0) AS owned_storage_bytes
    FROM account_entitlements
    LEFT JOIN workspaces
      ON workspaces.owner_account_id = account_entitlements.account_id
    WHERE account_entitlements.account_id = ?
    GROUP BY account_entitlements.account_id`,
  )
    .bind(userId)
    .first<AccountRow>();
  if (!account) {
    return errorResponse(ApiErrorCode.notFound, "Account entitlements not found", requestId, 404);
  }
  const subscription = await env.DB.prepare(
    `SELECT status, current_period_ends_at, cancel_at_period_end
     FROM subscriptions WHERE account_id = ?`,
  )
    .bind(userId)
    .first<SubscriptionRow>();
  const body: AccountResponse = {
    account: {
      canEditCollaborate: account.can_edit_collaborate === 1,
      canViewShare: account.can_view_share === 1,
      hardAssetLimitBytes: account.hard_asset_limit_bytes,
      ownedStorageBytes: account.owned_storage_bytes,
      ownedWorkspaceCount: account.owned_workspace_count,
      planKey: toPlanKey(account.plan_key),
      storageLimitBytes: account.account_storage_limit_bytes,
      workspaceLimit: account.hosted_workspace_limit,
      workspaceStorageLimitBytes: account.workspace_storage_limit_bytes,
    },
    subscription: subscription
      ? {
          cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
          currentPeriodEndsAt: subscription.current_period_ends_at,
          status: subscription.status,
        }
      : null,
    billingAvailable: hasBillingConfiguration(env),
  };
  return json(body);
}

function hasBillingConfiguration(env: Env): boolean {
  const bindings = env as unknown as Record<string, unknown>;
  return [
    "STRIPE_SECRET_KEY",
    "STRIPE_PRO_PRICE_ID",
    "PRO_HOSTED_WORKSPACE_LIMIT",
    "PRO_ACCOUNT_STORAGE_LIMIT_BYTES",
    "PRO_WORKSPACE_STORAGE_LIMIT_BYTES",
    "PRO_HARD_ASSET_LIMIT_BYTES",
  ].every((name) => typeof bindings[name] === "string" && bindings[name].length > 0);
}

function toPlanKey(value: string): PlanKey {
  if (value === PlanKey.cloudFree) return PlanKey.cloudFree;
  if (value === PlanKey.pro) return PlanKey.pro;
  throw new Error(`Unknown plan key: ${value}`);
}
