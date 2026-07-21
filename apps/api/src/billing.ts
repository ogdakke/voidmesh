import { ApiErrorCode, type BillingSessionResponse } from "@voidmesh/api-contract";
import { GIBIBYTE, PlanKey, WorkspaceRole, type UserId, type WorkspaceId } from "@voidmesh/domain";
import Stripe from "stripe";
import { errorResponse, json } from "./http.ts";
import { trustedRequestOrigin } from "./web-origins.ts";

const STRIPE_PROVIDER = "stripe";
const ACTIVE_PAID_STATUSES = new Set<Stripe.Subscription.Status>([
  "active",
  "past_due",
  "trialing",
]);

interface BillingConfiguration {
  pro: {
    accountStorageBytes: number;
    hardAssetBytes: number;
    hostedWorkspaceCount: number;
    workspaceStorageBytes: number;
  };
  proPriceId: string;
  secretKey: string;
  webhookSecret: string | null;
}

interface SubscriptionIdentityRow {
  last_event_created_at: number;
  provider_customer_id: string;
  provider_subscription_id: string | null;
}

interface AccountDeletionSubscriptionRow {
  provider_subscription_id: string | null;
  status: string;
}

export function isBillingPath(pathname: string): boolean {
  return pathname === "/v1/billing/checkout" || pathname === "/v1/billing/portal";
}

export function isBillingWebhookPath(pathname: string): boolean {
  return pathname === "/v1/billing/webhooks/stripe";
}

export async function handleBillingRequest(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
  }
  const pathname = new URL(request.url).pathname;
  if (pathname === "/v1/billing/checkout") {
    return createCheckoutSession(request, env, userId, requestId);
  }
  if (pathname === "/v1/billing/portal") {
    return createPortalSession(request, env, userId, requestId);
  }
  return errorResponse(ApiErrorCode.notFound, "Route not found", requestId, 404);
}

export async function handleBillingWebhook(
  request: Request,
  env: Env,
  requestId: string,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(ApiErrorCode.invalidRequest, "Method not allowed", requestId, 405);
  }
  const configuration = readBillingConfiguration(env, true);
  const signature = request.headers.get("stripe-signature");
  if (!signature || !configuration.webhookSecret) {
    return errorResponse(ApiErrorCode.unauthorized, "Invalid webhook signature", requestId, 401);
  }
  const rawBody = await request.text();
  const stripe = createStripe(configuration.secretKey);
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      configuration.webhookSecret,
      300,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return errorResponse(ApiErrorCode.unauthorized, "Invalid webhook signature", requestId, 401);
  }

  const existing = await env.DB.prepare(
    "SELECT event_id FROM billing_events WHERE provider = ? AND event_id = ?",
  )
    .bind(STRIPE_PROVIDER, event.id)
    .first<{ event_id: string }>();
  if (existing) return json({ received: true });

  if (event.type === "checkout.session.completed") {
    await processCheckoutCompleted(env.DB, event, requestId);
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const result = await processSubscriptionEvent(env.DB, configuration, event, requestId);
    if (result) {
      await synchronizeLiveEditorRoles(env, result.accountId, result.paid);
    }
  } else {
    await recordBillingEvent(env.DB, event, "ignored");
  }
  return json({ received: true });
}

export async function cancelBillingForAccountDeletion(env: Env, userId: UserId): Promise<void> {
  const subscription = await env.DB.prepare(
    `SELECT provider_subscription_id, status
     FROM subscriptions WHERE account_id = ? AND provider = 'stripe'`,
  )
    .bind(userId)
    .first<AccountDeletionSubscriptionRow>();
  if (
    !subscription?.provider_subscription_id ||
    subscription.status === "canceled" ||
    subscription.status === "incomplete_expired"
  ) {
    return;
  }
  const bindings = env as unknown as Record<string, unknown>;
  const secretKey = bindings.STRIPE_SECRET_KEY;
  if (typeof secretKey !== "string" || secretKey.length === 0) {
    throw new Error("Cannot delete a subscribed account while Stripe is not configured");
  }
  await createStripe(secretKey).subscriptions.cancel(
    subscription.provider_subscription_id,
    { invoice_now: false, prorate: false },
    { idempotencyKey: `account-delete-${userId}` },
  );
}

async function createCheckoutSession(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "A valid Idempotency-Key header is required",
      requestId,
      400,
    );
  }
  const configuration = readBillingConfiguration(env, false);
  const [user, existing] = await Promise.all([
    env.DB.prepare('SELECT email FROM "user" WHERE id = ?').bind(userId).first<{ email: string }>(),
    readSubscriptionIdentity(env.DB, userId),
  ]);
  if (!user) return errorResponse(ApiErrorCode.notFound, "Account not found", requestId, 404);
  if (existing?.provider_subscription_id) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "This account already has billing. Open the billing portal instead.",
      requestId,
      409,
    );
  }
  const stripe = createStripe(configuration.secretKey);
  const webOrigin = trustedRequestOrigin(env, request);
  const session = await stripe.checkout.sessions.create(
    {
      ...(existing?.provider_customer_id
        ? { customer: existing.provider_customer_id }
        : { customer_email: user.email }),
      allow_promotion_codes: true,
      cancel_url: `${webOrigin}/cloud?billing=cancelled`,
      client_reference_id: userId,
      line_items: [{ price: configuration.proPriceId, quantity: 1 }],
      metadata: { account_id: userId, plan_key: PlanKey.pro },
      mode: "subscription",
      success_url: `${webOrigin}/cloud?billing=success`,
      subscription_data: {
        metadata: { account_id: userId, plan_key: PlanKey.pro },
      },
    },
    { idempotencyKey },
  );
  if (!session.url) throw new Error("Stripe did not return a Checkout URL");
  await writeBillingAudit(env.DB, {
    accountId: userId,
    action: "billing.checkout.create",
    outcome: "success",
    requestId,
  });
  const body: BillingSessionResponse = { url: session.url };
  return json(body, 201);
}

async function createPortalSession(
  request: Request,
  env: Env,
  userId: UserId,
  requestId: string,
): Promise<Response> {
  const idempotencyKey = readIdempotencyKey(request);
  if (!idempotencyKey) {
    return errorResponse(
      ApiErrorCode.invalidRequest,
      "A valid Idempotency-Key header is required",
      requestId,
      400,
    );
  }
  const configuration = readBillingConfiguration(env, false);
  const subscription = await readSubscriptionIdentity(env.DB, userId);
  if (!subscription) {
    return errorResponse(ApiErrorCode.notFound, "Billing account not found", requestId, 404);
  }
  const stripe = createStripe(configuration.secretKey);
  const webOrigin = trustedRequestOrigin(env, request);
  const session = await stripe.billingPortal.sessions.create(
    {
      customer: subscription.provider_customer_id,
      return_url: `${webOrigin}/cloud`,
    },
    { idempotencyKey },
  );
  await writeBillingAudit(env.DB, {
    accountId: userId,
    action: "billing.portal.create",
    outcome: "success",
    requestId,
  });
  const body: BillingSessionResponse = { url: session.url };
  return json(body, 201);
}

async function processCheckoutCompleted(
  db: D1Database,
  event: Stripe.CheckoutSessionCompletedEvent,
  requestId: string,
): Promise<void> {
  const session = event.data.object;
  const accountId = session.client_reference_id ?? session.metadata?.account_id;
  const customerId = stringId(session.customer);
  const subscriptionId = stringId(session.subscription);
  if (!accountId || !customerId) {
    await recordBillingEvent(db, event, "ignored");
    return;
  }
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (
          account_id, provider, provider_customer_id, provider_subscription_id,
          status, created_at, updated_at
        ) VALUES (?, 'stripe', ?, ?, 'pending', ?, ?)
        ON CONFLICT (account_id) DO UPDATE SET
          provider_customer_id = excluded.provider_customer_id,
          provider_subscription_id = COALESCE(excluded.provider_subscription_id, subscriptions.provider_subscription_id),
          updated_at = excluded.updated_at`,
      )
      .bind(accountId, customerId, subscriptionId, now, now),
    billingEventStatement(db, event, "processed", now),
    billingAuditStatement(db, {
      accountId,
      action: "billing.checkout.completed",
      outcome: "success",
      requestId,
      timestamp: now,
    }),
  ]);
}

async function processSubscriptionEvent(
  db: D1Database,
  configuration: BillingConfiguration,
  event:
    | Stripe.CustomerSubscriptionCreatedEvent
    | Stripe.CustomerSubscriptionUpdatedEvent
    | Stripe.CustomerSubscriptionDeletedEvent,
  requestId: string,
): Promise<{ accountId: UserId; paid: boolean } | null> {
  const subscription = event.data.object;
  const customerId = stringId(subscription.customer);
  const bySubscription = await db
    .prepare(
      `SELECT account_id, last_event_created_at
       FROM subscriptions
       WHERE provider = 'stripe' AND (provider_subscription_id = ? OR account_id = ?)
       ORDER BY provider_subscription_id = ? DESC
       LIMIT 1`,
    )
    .bind(subscription.id, subscription.metadata.account_id ?? "", subscription.id)
    .first<{ account_id: string; last_event_created_at: number }>();
  const accountId = subscription.metadata.account_id ?? bySubscription?.account_id;
  if (!accountId || !customerId) {
    await recordBillingEvent(db, event, "ignored");
    return null;
  }
  const eventCreatedAt = event.created * 1000;
  if (bySubscription && eventCreatedAt < bySubscription.last_event_created_at) {
    await recordBillingEvent(db, event, "ignored");
    return null;
  }
  const paid =
    subscription.metadata.plan_key === PlanKey.pro && ACTIVE_PAID_STATUSES.has(subscription.status);
  const limits = paid
    ? configuration.pro
    : {
        accountStorageBytes: GIBIBYTE,
        hardAssetBytes: GIBIBYTE,
        hostedWorkspaceCount: 1,
        workspaceStorageBytes: GIBIBYTE,
      };
  const planKey = paid ? PlanKey.pro : PlanKey.cloudFree;
  const periodEndsAt = currentPeriodEndsAt(subscription);
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (
          account_id, provider, provider_customer_id, provider_subscription_id,
          status, current_period_ends_at, cancel_at_period_end, created_at, updated_at,
          last_event_created_at, last_event_id
        ) VALUES (?, 'stripe', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (account_id) DO UPDATE SET
          provider_customer_id = excluded.provider_customer_id,
          provider_subscription_id = excluded.provider_subscription_id,
          status = excluded.status,
          current_period_ends_at = excluded.current_period_ends_at,
          cancel_at_period_end = excluded.cancel_at_period_end,
          updated_at = excluded.updated_at,
          last_event_created_at = excluded.last_event_created_at,
          last_event_id = excluded.last_event_id
        WHERE excluded.last_event_created_at >= subscriptions.last_event_created_at`,
      )
      .bind(
        accountId,
        customerId,
        subscription.id,
        subscription.status,
        periodEndsAt,
        subscription.cancel_at_period_end ? 1 : 0,
        now,
        now,
        eventCreatedAt,
        event.id,
      ),
    db
      .prepare(
        `UPDATE account_entitlements SET
          plan_key = ?,
          hosted_workspace_limit = ?,
          account_storage_limit_bytes = ?,
          workspace_storage_limit_bytes = ?,
          hard_asset_limit_bytes = ?,
          can_view_share = 1,
          can_edit_collaborate = ?,
          effective_at = ?,
          updated_at = ?
        WHERE account_id = ? AND EXISTS (
          SELECT 1 FROM subscriptions
          WHERE subscriptions.account_id = ? AND subscriptions.last_event_id = ?
        )`,
      )
      .bind(
        planKey,
        limits.hostedWorkspaceCount,
        limits.accountStorageBytes,
        limits.workspaceStorageBytes,
        limits.hardAssetBytes,
        paid ? 1 : 0,
        eventCreatedAt,
        now,
        accountId,
        accountId,
        event.id,
      ),
    billingEventStatement(db, event, "processed", now),
    billingAuditStatement(db, {
      accountId,
      action: paid ? "billing.subscription.pro" : "billing.subscription.cloud-free",
      outcome: "success",
      requestId,
      timestamp: now,
    }),
  ]);
  return { accountId, paid };
}

async function synchronizeLiveEditorRoles(
  env: Env,
  accountId: UserId,
  paid: boolean,
): Promise<void> {
  const editors = await env.DB.prepare(
    `SELECT workspace_members.workspace_id, workspace_members.user_id
     FROM workspace_members
     INNER JOIN workspaces ON workspaces.id = workspace_members.workspace_id
     WHERE workspaces.owner_account_id = ?
       AND workspaces.lifecycle = 'active'
       AND workspace_members.role = 'editor'
       AND workspace_members.removed_at IS NULL`,
  )
    .bind(accountId)
    .all<{ user_id: UserId; workspace_id: WorkspaceId }>();
  const role = paid ? WorkspaceRole.editor : WorkspaceRole.viewer;
  await Promise.all(
    editors.results.map((editor) =>
      env.WORKSPACE_ROOMS.getByName(editor.workspace_id).setUserRole(editor.user_id, role),
    ),
  );
}

function createStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
    maxNetworkRetries: 2,
    telemetry: false,
  });
}

function currentPeriodEndsAt(subscription: Stripe.Subscription): number | null {
  const periodEnds = subscription.items.data.map((item) => item.current_period_end);
  return periodEnds.length > 0 ? Math.max(...periodEnds) * 1000 : null;
}

function readIdempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key");
  return value && /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : null;
}

function stringId(value: string | { id: string } | null): string | null {
  return typeof value === "string" ? value : (value?.id ?? null);
}

async function readSubscriptionIdentity(
  db: D1Database,
  accountId: UserId,
): Promise<SubscriptionIdentityRow | null> {
  return db
    .prepare(
      `SELECT provider_customer_id, provider_subscription_id, last_event_created_at
       FROM subscriptions WHERE account_id = ? AND provider = 'stripe'`,
    )
    .bind(accountId)
    .first<SubscriptionIdentityRow>();
}

async function recordBillingEvent(
  db: D1Database,
  event: Stripe.Event,
  outcome: "processed" | "ignored",
): Promise<void> {
  await billingEventStatement(db, event, outcome, Date.now()).run();
}

function billingEventStatement(
  db: D1Database,
  event: Stripe.Event,
  outcome: "processed" | "ignored",
  processedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO billing_events (
        provider, event_id, event_type, provider_created_at, outcome, processed_at
      ) VALUES ('stripe', ?, ?, ?, ?, ?)`,
    )
    .bind(event.id, event.type, event.created * 1000, outcome, processedAt);
}

async function writeBillingAudit(
  db: D1Database,
  input: {
    accountId: UserId;
    action: string;
    outcome: "success" | "denied";
    requestId: string;
  },
): Promise<void> {
  await billingAuditStatement(db, { ...input, timestamp: Date.now() }).run();
}

function billingAuditStatement(
  db: D1Database,
  input: {
    accountId: UserId;
    action: string;
    outcome: "success" | "denied";
    requestId: string;
    timestamp: number;
  },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, action, target_type, target_id,
        outcome, request_id, created_at
      ) VALUES (?, ?, ?, ?, 'account', ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.accountId,
      input.accountId,
      input.action,
      input.accountId,
      input.outcome,
      input.requestId,
      input.timestamp,
    );
}

function readBillingConfiguration(env: Env, requireWebhook: boolean): BillingConfiguration {
  const bindings = env as unknown as Record<string, unknown>;
  const read = (name: string): string => {
    const value = bindings[name];
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Missing required Worker binding: ${name}`);
    }
    return value;
  };
  const positiveInteger = (name: string): number => {
    const value = Number(read(name));
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer`);
    }
    return value;
  };
  const webhookSecret = bindings.STRIPE_WEBHOOK_SECRET;
  if (requireWebhook && (typeof webhookSecret !== "string" || webhookSecret.length === 0)) {
    throw new Error("Missing required Worker binding: STRIPE_WEBHOOK_SECRET");
  }
  return {
    pro: {
      accountStorageBytes: positiveInteger("PRO_ACCOUNT_STORAGE_LIMIT_BYTES"),
      hardAssetBytes: positiveInteger("PRO_HARD_ASSET_LIMIT_BYTES"),
      hostedWorkspaceCount: positiveInteger("PRO_HOSTED_WORKSPACE_LIMIT"),
      workspaceStorageBytes: positiveInteger("PRO_WORKSPACE_STORAGE_LIMIT_BYTES"),
    },
    proPriceId: read("STRIPE_PRO_PRICE_ID"),
    secretKey: read("STRIPE_SECRET_KEY"),
    webhookSecret: typeof webhookSecret === "string" ? webhookSecret : null,
  };
}
