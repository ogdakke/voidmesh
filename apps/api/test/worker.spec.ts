import { env, exports } from "cloudflare:workers";
import {
  COLLABORATION_PROTOCOL_VERSION,
  decodeServerYjsUpdate,
  encodeClientYjsUpdate,
} from "@voidmesh/collaboration";
import * as Y from "yjs";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { processWorkspaceExport } from "../src/exports.ts";
import { safeLogPath } from "../src/index.ts";
import { issueRoomAuthorization, verifyRoomAuthorization } from "../src/room-authorization.ts";
import {
  cleanupExpiredExports,
  cleanupExpiredUploads,
  purgeExpiredWorkspaces,
} from "../src/lifecycle.ts";
import {
  flushSecurityAuditOutbox,
  processSecurityAuditEvent,
  securityAuditObjectKey,
} from "../src/security-audit.ts";

const WEB_ORIGIN = "https://app.voidmesh.test";
let signupAddress = 10;

describe("Voidmesh API", () => {
  it("signs short-lived room authorization without forwarding account sessions", async () => {
    const now = Date.now();
    const authorization = await issueRoomAuthorization(
      env.BETTER_AUTH_SECRET,
      {
        name: "Room User",
        role: "editor",
        sessionId: "session-room",
        userId: "user-room",
        workspaceId: "workspace-room",
      },
      now,
    );
    await expect(
      verifyRoomAuthorization(env.BETTER_AUTH_SECRET, authorization, now + 1_000),
    ).resolves.toMatchObject({
      name: "Room User",
      role: "editor",
      sessionId: "session-room",
      userId: "user-room",
      workspaceId: "workspace-room",
    });
    await expect(
      verifyRoomAuthorization(env.BETTER_AUTH_SECRET, `${authorization}tampered`, now + 1_000),
    ).resolves.toBeNull();
    await expect(
      verifyRoomAuthorization(env.BETTER_AUTH_SECRET, authorization, now + 31_000),
    ).resolves.toBeNull();
  });

  it("templates sensitive and high-cardinality request paths before logging", () => {
    expect(safeLogPath("/v1/invitations/a-secret-token/redeem")).toBe(
      "/v1/invitations/:token/redeem",
    );
    expect(safeLogPath("/v1/object-grants/private-grant")).toBe("/v1/object-grants/:grantId");
    expect(
      safeLogPath("/v1/workspaces/workspace-private/assets/uploads/reservation-private/finalize"),
    ).toBe("/v1/workspaces/:workspaceId/assets/uploads/:reservationId/finalize");
    expect(safeLogPath("/v1/workspaces/workspace-private/assets/asset-private/content")).toBe(
      "/v1/workspaces/:workspaceId/assets/:assetId/content",
    );
    expect(safeLogPath("/v1/workspaces/workspace-private/members/user-private")).toBe(
      "/v1/workspaces/:workspaceId/members/:userId",
    );
  });

  it("reports health from the Workers runtime", async () => {
    const response = await exports.default.fetch("https://voidmesh.test/v1/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      environment: "development",
      ok: true,
      service: "voidmesh-api",
    });
  });

  it("isolates and initializes one Durable Object per workspace", async () => {
    const room = env.WORKSPACE_ROOMS.getByName("workspace_test");

    expect(await room.initialize("workspace_test")).toEqual({
      roomSequence: 0,
      workspaceId: "workspace_test",
    });
    expect(await room.getStatus()).toEqual({
      roomSequence: 0,
      workspaceId: "workspace_test",
    });
  });

  it("requires a session for hosted workspaces", async () => {
    const response = await exports.default.fetch("https://voidmesh.test/v1/workspaces");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: "unauthorized" });
  });

  it("audits successful and denied authentication outcomes without credentials", async () => {
    const email = "auth-audit@example.com";
    await signUp(email, "Auth Audit");
    const denied = await apiFetch("/v1/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "incorrect-password" }),
      headers: {
        "cf-connecting-ip": "192.0.2.241",
        "content-type": "application/json",
        origin: WEB_ORIGIN,
      },
      method: "POST",
    });
    expect(denied.status).toBe(401);

    const signedIn = await apiFetch("/v1/auth/sign-in/email", {
      body: JSON.stringify({ email, password: "correct-horse-battery-staple" }),
      headers: {
        "cf-connecting-ip": "192.0.2.242",
        "content-type": "application/json",
        origin: WEB_ORIGIN,
      },
      method: "POST",
    });
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers.get("set-cookie")!.split(";", 1)[0]!;
    const signedOut = await apiFetch("/v1/auth/sign-out", {
      headers: { cookie, origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(signedOut.status).toBe(200);

    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind(email)
      .first<{ id: string }>();
    const events = await env.DB.prepare(
      `SELECT action, actor_user_id, outcome, metadata_json
       FROM audit_events
       WHERE action IN ('auth.sign-up', 'auth.sign-in', 'auth.sign-out')
         AND (actor_user_id = ? OR (actor_user_id IS NULL AND action = 'auth.sign-in'))`,
    )
      .bind(user!.id)
      .all<{
        action: string;
        actor_user_id: string | null;
        metadata_json: string;
        outcome: string;
      }>();
    expect(
      events.results
        .map((event) => ({
          action: event.action,
          actorUserId: event.actor_user_id,
          metadata: JSON.parse(event.metadata_json),
          outcome: event.outcome,
        }))
        .sort((left, right) =>
          `${left.action}:${left.outcome}`.localeCompare(`${right.action}:${right.outcome}`),
        ),
    ).toEqual([
      {
        action: "auth.sign-in",
        actorUserId: null,
        metadata: { method: "POST", status: 401 },
        outcome: "denied",
      },
      {
        action: "auth.sign-in",
        actorUserId: user!.id,
        metadata: { method: "POST", status: 200 },
        outcome: "success",
      },
      {
        action: "auth.sign-out",
        actorUserId: user!.id,
        metadata: { method: "POST", status: 200 },
        outcome: "success",
      },
      {
        action: "auth.sign-up",
        actorUserId: user!.id,
        metadata: { method: "POST", status: 200 },
        outcome: "success",
      },
    ]);
    expect(events.results.map((event) => event.metadata_json).join(" ")).not.toContain(
      "correct-horse-battery-staple",
    );
  });

  it("delivers exact audit events through the outbox to an immutable R2 sink", async () => {
    const cookie = await signUp("audit-owner@example.com", "Audit Owner");
    const workspace = await createWorkspace(cookie, "Audited workspace");
    const event = await env.DB.prepare(
      `SELECT audit_events.id, audit_events.created_at, security_audit_outbox.payload_json
       FROM audit_events
       INNER JOIN security_audit_outbox ON security_audit_outbox.event_id = audit_events.id
       WHERE audit_events.workspace_id = ? AND audit_events.action = 'workspace.create'`,
    )
      .bind(workspace.id)
      .first<{ created_at: number; id: string; payload_json: string }>();
    expect(event).toBeTruthy();
    expect(JSON.parse(event!.payload_json)).toMatchObject({
      action: "workspace.create",
      actorUserId: expect.any(String),
      createdAt: event!.created_at,
      id: event!.id,
      metadata: {},
      outcome: "success",
      schemaVersion: 1,
      workspaceId: workspace.id,
    });

    await flushSecurityAuditOutbox(env);
    expect(
      await env.DB.prepare("SELECT enqueued_at FROM security_audit_outbox WHERE event_id = ?")
        .bind(event!.id)
        .first<{ enqueued_at: number | null }>(),
    ).toMatchObject({ enqueued_at: expect.any(Number) });

    await processSecurityAuditEvent(env, event!.id);
    await processSecurityAuditEvent(env, event!.id);
    const object = await env.SECURITY_AUDIT.get(
      securityAuditObjectKey(event!.id, event!.created_at),
    );
    expect(object).toBeTruthy();
    expect(await object!.json()).toMatchObject({
      action: "workspace.create",
      id: event!.id,
      workspaceId: workspace.id,
    });
    expect(
      await env.DB.prepare("SELECT delivered_at FROM security_audit_outbox WHERE event_id = ?")
        .bind(event!.id)
        .first<{ delivered_at: number | null }>(),
    ).toMatchObject({ delivered_at: expect.any(Number) });
  });

  it("rate limits repeated signup attempts without retaining raw client addresses", async () => {
    const attempts: Response[] = [];
    const testAddress = `2001:db8:${crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16)}::1`;
    for (let attempt = 0; attempt < 6; attempt++) {
      attempts.push(
        await apiFetch("/v1/auth/sign-up/email", {
          body: JSON.stringify({
            email: `rate-limit-${attempt}@example.com`,
            name: "Rate Limited",
            password: "too-short",
          }),
          headers: {
            "cf-connecting-ip": testAddress,
            "content-type": "application/json",
            origin: WEB_ORIGIN,
          },
          method: "POST",
        }),
      );
    }
    expect(attempts.map((response) => response.status)).toEqual([400, 400, 400, 429, 429, 429]);
    expect(attempts[5]!.status).toBe(429);
    expect(await attempts[5]!.json()).toMatchObject({ code: "rate-limited" });
    expect(attempts[5]!.headers.get("retry-after")).toBeTruthy();

    const row = await env.DB.prepare(
      `SELECT key_hash, request_count FROM api_rate_limits
       WHERE scope = 'auth-sign-up' ORDER BY request_count DESC LIMIT 1`,
    ).first<{ key_hash: string; request_count: number }>();
    expect(row?.request_count).toBe(6);
    expect(row?.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.key_hash).not.toContain(testAddress);
  });

  it("rate limits password reset requests on the Better Auth route", async () => {
    const attempts: Response[] = [];
    const testAddress = `2001:db8:${crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16)}::2`;
    for (let attempt = 0; attempt < 6; attempt++) {
      attempts.push(
        await apiFetch("/v1/auth/request-password-reset", {
          body: JSON.stringify({ email: "invalid" }),
          headers: {
            "cf-connecting-ip": testAddress,
            "content-type": "application/json",
            origin: WEB_ORIGIN,
          },
          method: "POST",
        }),
      );
    }
    expect(attempts.at(-1)!.status).toBe(429);
    expect(await attempts.at(-1)!.json()).toMatchObject({
      code: "rate-limited",
    });
  });

  it("signs up, receives Cloud Free entitlements, and enforces one hosted workspace", async () => {
    const firstWorkspaceKey = "550e8400-e29b-41d4-a716-446655440101";
    const signUp = await exports.default.fetch("https://voidmesh.test/v1/auth/sign-up/email", {
      body: JSON.stringify({
        email: "cloud-free@example.com",
        name: "Cloud Free",
        password: "correct-horse-battery-staple",
      }),
      headers: { "content-type": "application/json", origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(signUp.status).toBe(200);

    const cookie = signUp.headers.get("set-cookie");
    expect(cookie).toBeTruthy();
    const sessionCookie = cookie!.split(";", 1)[0]!;

    const first = await exports.default.fetch("https://voidmesh.test/v1/workspaces", {
      body: JSON.stringify({ title: "First hosted workspace" }),
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        "idempotency-key": firstWorkspaceKey,
        origin: WEB_ORIGIN,
      },
      method: "POST",
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json<{
      workspace: { id: string; role: string; title: string; usedBytes: number };
    }>();
    expect(firstBody).toMatchObject({
      workspace: {
        role: "owner",
        title: "First hosted workspace",
        usedBytes: 0,
      },
    });

    const owner = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("cloud-free@example.com")
      .first<{ id: string }>();
    expect(owner).toBeTruthy();
    await expect(
      env.DB.prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, role, accepted_at
        ) VALUES (?, ?, 'owner', ?)`,
      )
        .bind(firstBody.workspace.id, crypto.randomUUID(), Date.now())
        .run(),
    ).rejects.toThrow(/workspace_owner_identity_mismatch/);
    await expect(
      env.DB.prepare(
        `UPDATE workspace_members SET role = 'editor'
         WHERE workspace_id = ? AND user_id = ?`,
      )
        .bind(firstBody.workspace.id, owner!.id)
        .run(),
    ).rejects.toThrow(/workspace_owner_is_immutable/);
    await expect(
      env.DB.prepare("DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?")
        .bind(firstBody.workspace.id, owner!.id)
        .run(),
    ).rejects.toThrow(/active_workspace_owner_is_required/);
    await expect(
      env.DB.prepare("UPDATE workspaces SET owner_account_id = ? WHERE id = ?")
        .bind(crypto.randomUUID(), firstBody.workspace.id)
        .run(),
    ).rejects.toThrow(/workspace_ownership_transfer_forbidden/);

    const replayed = await exports.default.fetch("https://voidmesh.test/v1/workspaces", {
      body: JSON.stringify({ title: "First hosted workspace" }),
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        "idempotency-key": firstWorkspaceKey,
        origin: WEB_ORIGIN,
      },
      method: "POST",
    });
    expect(replayed.status).toBe(200);
    expect(await replayed.json()).toMatchObject({ workspace: { id: firstBody.workspace.id } });

    const initialSnapshot = await env.DB.prepare(
      `SELECT object_key, room_sequence, byte_length
       FROM workspace_snapshots WHERE workspace_id = ?`,
    )
      .bind(firstBody.workspace.id)
      .first<{ byte_length: number; object_key: string; room_sequence: number }>();
    expect(initialSnapshot).toMatchObject({
      byte_length: expect.any(Number),
      room_sequence: 0,
    });
    expect(initialSnapshot!.byte_length).toBeGreaterThan(0);
    expect(await env.ASSETS.head(initialSnapshot!.object_key)).toBeTruthy();

    const initialViewState = await exports.default.fetch(
      `https://voidmesh.test/v1/workspaces/${firstBody.workspace.id}/view-state`,
      { headers: { cookie: sessionCookie } },
    );
    expect(initialViewState.status).toBe(200);
    expect(await initialViewState.json()).toEqual({ viewState: null });

    const savedViewState = await exports.default.fetch(
      `https://voidmesh.test/v1/workspaces/${firstBody.workspace.id}/view-state`,
      {
        body: JSON.stringify({ offset: { x: 125.5, y: -48 }, zoom: 1.75 }),
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
          origin: WEB_ORIGIN,
        },
        method: "PATCH",
      },
    );
    expect(savedViewState.status).toBe(200);
    expect(await savedViewState.json()).toMatchObject({
      viewState: {
        offset: { x: 125.5, y: -48 },
        updatedAt: expect.any(Number),
        zoom: 1.75,
      },
    });

    const restoredViewState = await exports.default.fetch(
      `https://voidmesh.test/v1/workspaces/${firstBody.workspace.id}/view-state`,
      { headers: { cookie: sessionCookie } },
    );
    expect(await restoredViewState.json()).toMatchObject({
      viewState: { offset: { x: 125.5, y: -48 }, zoom: 1.75 },
    });

    const second = await exports.default.fetch("https://voidmesh.test/v1/workspaces", {
      body: JSON.stringify({ title: "Over the free limit" }),
      headers: {
        "content-type": "application/json",
        cookie: sessionCookie,
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440102",
        origin: WEB_ORIGIN,
      },
      method: "POST",
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ code: "quota-exceeded" });

    const list = await exports.default.fetch("https://voidmesh.test/v1/workspaces", {
      headers: { cookie: sessionCookie },
    });
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      workspaces: [
        {
          overQuota: false,
          role: "owner",
          storageLimitBytes: 1024 ** 3,
          title: "First hosted workspace",
        },
      ],
    });

    const account = await exports.default.fetch("https://voidmesh.test/v1/me", {
      headers: { cookie: sessionCookie },
    });
    expect(account.status).toBe(200);
    expect(await account.json()).toMatchObject({
      account: {
        canEditCollaborate: false,
        ownedStorageBytes: 0,
        ownedWorkspaceCount: 1,
        planKey: "cloud-free",
        storageLimitBytes: 1024 ** 3,
        workspaceLimit: 1,
      },
      billingAvailable: true,
      subscription: null,
    });

    const renamed = await exports.default.fetch(
      `https://voidmesh.test/v1/workspaces/${firstBody.workspace.id}`,
      {
        body: JSON.stringify({ title: "Renamed workspace" }),
        headers: {
          "content-type": "application/json",
          cookie: sessionCookie,
          origin: WEB_ORIGIN,
        },
        method: "PATCH",
      },
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      workspace: { title: "Renamed workspace" },
    });

    const deleted = await exports.default.fetch(
      `https://voidmesh.test/v1/workspaces/${firstBody.workspace.id}`,
      {
        headers: { cookie: sessionCookie, origin: WEB_ORIGIN },
        method: "DELETE",
      },
    );
    expect(deleted.status).toBe(204);

    const unavailable = await exports.default.fetch(
      `https://voidmesh.test/v1/workspaces/${firstBody.workspace.id}`,
      { headers: { cookie: sessionCookie } },
    );
    expect(unavailable.status).toBe(404);

    const recentlyDeleted = await exports.default.fetch(
      "https://voidmesh.test/v1/workspaces?lifecycle=deleted",
      { headers: { cookie: sessionCookie } },
    );
    expect(recentlyDeleted.status).toBe(200);
    expect(await recentlyDeleted.json()).toMatchObject({
      workspaces: [
        {
          deletedAt: expect.any(Number),
          id: firstBody.workspace.id,
          lifecycle: "deleted",
          purgeAfter: expect.any(Number),
          role: "owner",
          title: "Renamed workspace",
        },
      ],
    });

    const restored = await exports.default.fetch(
      `https://voidmesh.test/v1/workspaces/${firstBody.workspace.id}/restore`,
      {
        headers: { cookie: sessionCookie, origin: WEB_ORIGIN },
        method: "POST",
      },
    );
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      workspace: {
        deletedAt: null,
        lifecycle: "active",
        purgeAfter: null,
        title: "Renamed workspace",
      },
    });

    const entitlement = await env.DB.prepare(
      "SELECT plan_key, hosted_workspace_limit FROM account_entitlements",
    ).first<{ hosted_workspace_limit: number; plan_key: string }>();
    expect(entitlement).toEqual({
      hosted_workspace_limit: 1,
      plan_key: "cloud-free",
    });
  });

  it("shares view access through permanent authenticated invitations and revokes membership", async () => {
    const ownerCookie = await signUp("share-owner@example.com", "Share Owner");
    const viewerCookie = await signUp("share-viewer@example.com", "Share Viewer");
    const workspace = await createWorkspace(ownerCookie, "Shared workspace");

    const paidOnly = await apiFetch(`/v1/workspaces/${workspace.id}/invitations`, {
      body: JSON.stringify({ role: "editor" }),
      headers: {
        ...jsonHeaders(ownerCookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440103",
      },
      method: "POST",
    });
    expect(paidOnly.status).toBe(403);

    const created = await apiFetch(`/v1/workspaces/${workspace.id}/invitations`, {
      body: JSON.stringify({ role: "viewer" }),
      headers: {
        ...jsonHeaders(ownerCookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440104",
      },
      method: "POST",
    });
    expect(created.status).toBe(201);
    const invitation = await created.json<{
      invitation: { id: string; role: string; token: string; useCount: number };
    }>();
    expect(invitation.invitation).toMatchObject({
      role: "viewer",
      useCount: 0,
    });
    expect(invitation.invitation.token).toHaveLength(43);

    const invitationReplay = await apiFetch(`/v1/workspaces/${workspace.id}/invitations`, {
      body: JSON.stringify({ role: "viewer" }),
      headers: {
        ...jsonHeaders(ownerCookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440104",
      },
      method: "POST",
    });
    expect(invitationReplay.status).toBe(200);
    expect(await invitationReplay.json()).toEqual(invitation);

    const redeemed = await apiFetch(`/v1/invitations/${invitation.invitation.token}/redeem`, {
      headers: { cookie: viewerCookie, origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(redeemed.status).toBe(200);
    const redemption = await redeemed.json<{
      membership: { role: string; userId: string };
      workspace: { id: string; role: string };
    }>();
    expect(redemption).toMatchObject({
      membership: { role: "viewer" },
      workspace: { id: workspace.id, role: "viewer" },
    });

    const viewerExport = await apiFetch(`/v1/workspaces/${workspace.id}/export`, {
      headers: {
        cookie: viewerCookie,
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440011",
        origin: WEB_ORIGIN,
      },
      method: "POST",
    });
    expect(viewerExport.status).toBe(403);

    const members = await apiFetch(`/v1/workspaces/${workspace.id}/members`, {
      headers: { cookie: viewerCookie },
    });
    expect(members.status).toBe(200);
    expect(await members.json()).toMatchObject({
      members: [
        { email: "share-owner@example.com", role: "owner" },
        { email: "share-viewer@example.com", role: "viewer" },
      ],
    });

    const viewerRename = await apiFetch(`/v1/workspaces/${workspace.id}`, {
      body: JSON.stringify({ title: "Viewer rename" }),
      headers: jsonHeaders(viewerCookie),
      method: "PATCH",
    });
    expect(viewerRename.status).toBe(403);

    const viewerSocketResponse = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie: viewerCookie, upgrade: "websocket" },
    });
    expect(viewerSocketResponse.status).toBe(101);
    const viewerSocket = viewerSocketResponse.webSocket!;
    viewerSocket.accept();
    await bounded(nextWebSocketMessage(viewerSocket), "viewer hello");
    await bounded(nextWebSocketMessage(viewerSocket), "viewer sync");

    await env.DB.prepare(
      `UPDATE account_entitlements SET can_edit_collaborate = 1
       WHERE account_id = (SELECT owner_account_id FROM workspaces WHERE id = ?)`,
    )
      .bind(workspace.id)
      .run();
    const promotedMessage = nextWebSocketMessage(viewerSocket);
    const promoted = await apiFetch(
      `/v1/workspaces/${workspace.id}/members/${redemption.membership.userId}`,
      {
        body: JSON.stringify({ role: "editor" }),
        headers: jsonHeaders(ownerCookie),
        method: "PATCH",
      },
    );
    expect(promoted.status).toBe(204);
    expect(JSON.parse(String(await bounded(promotedMessage, "editor role change")))).toEqual({
      role: "editor",
      type: "role-changed",
    });

    await env.DB.prepare(
      `UPDATE account_entitlements SET can_edit_collaborate = 0
       WHERE account_id = (SELECT owner_account_id FROM workspaces WHERE id = ?)`,
    )
      .bind(workspace.id)
      .run();
    const effectivelyReadOnly = await apiFetch(`/v1/workspaces/${workspace.id}`, {
      headers: { cookie: viewerCookie },
    });
    expect(await effectivelyReadOnly.json()).toMatchObject({
      workspace: { role: "viewer" },
    });
    const downgradedRename = await apiFetch(`/v1/workspaces/${workspace.id}`, {
      body: JSON.stringify({ title: "Downgraded editor rename" }),
      headers: jsonHeaders(viewerCookie),
      method: "PATCH",
    });
    expect(downgradedRename.status).toBe(403);

    const downgradedMessage = nextWebSocketMessage(viewerSocket);
    const downgraded = await apiFetch(
      `/v1/workspaces/${workspace.id}/members/${redemption.membership.userId}`,
      {
        body: JSON.stringify({ role: "viewer" }),
        headers: jsonHeaders(ownerCookie),
        method: "PATCH",
      },
    );
    expect(downgraded.status).toBe(204);
    expect(JSON.parse(String(await bounded(downgradedMessage, "viewer role change")))).toEqual({
      role: "viewer",
      type: "role-changed",
    });
    const forbiddenDocument = new Y.Doc();
    forbiddenDocument.getMap("entities").set("forbidden", true);
    const readOnlyMessage = nextWebSocketMessage(viewerSocket);
    viewerSocket.send(
      encodeClientYjsUpdate(
        "550e8400-e29b-41d4-a716-446655440001",
        Y.encodeStateAsUpdate(forbiddenDocument),
      ),
    );
    expect(JSON.parse(String(await bounded(readOnlyMessage, "read-only rejection")))).toEqual({
      code: "read-only",
      type: "error",
    });

    const revokedLink = await apiFetch(
      `/v1/workspaces/${workspace.id}/invitations/${invitation.invitation.id}`,
      {
        headers: { cookie: ownerCookie, origin: WEB_ORIGIN },
        method: "DELETE",
      },
    );
    expect(revokedLink.status).toBe(204);

    const stillMember = await apiFetch(`/v1/workspaces/${workspace.id}`, {
      headers: { cookie: viewerCookie },
    });
    expect(stillMember.status).toBe(200);

    const closeEvent = nextWebSocketClose(viewerSocket);
    const removed = await apiFetch(
      `/v1/workspaces/${workspace.id}/members/${redemption.membership.userId}`,
      {
        headers: { cookie: ownerCookie, origin: WEB_ORIGIN },
        method: "DELETE",
      },
    );
    expect(removed.status).toBe(204);
    await expect(bounded(closeEvent, "membership close")).resolves.toMatchObject({ code: 4003 });

    const noLongerMember = await apiFetch(`/v1/workspaces/${workspace.id}`, {
      headers: { cookie: viewerCookie },
    });
    expect(noLongerMember.status).toBe(404);

    const revokedRedemption = await apiFetch(
      `/v1/invitations/${invitation.invitation.token}/redeem`,
      { headers: { cookie: viewerCookie, origin: WEB_ORIGIN }, method: "POST" },
    );
    expect(revokedRedemption.status).toBe(404);
  });

  it("charges retained workspace bytes and rechecks storage entitlements on restore", async () => {
    const cookie = await signUp("retained-quota@example.com", "Retained Quota");
    const workspace = await createWorkspace(cookie, "Retained bytes");
    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("retained-quota@example.com")
      .first<{ id: string }>();
    expect(user).toBeTruthy();
    await env.DB.batch([
      env.DB.prepare("UPDATE workspaces SET used_bytes = 6 WHERE id = ?").bind(workspace.id),
      env.DB.prepare(
        `UPDATE account_entitlements
         SET account_storage_limit_bytes = 5, workspace_storage_limit_bytes = 5
         WHERE account_id = ?`,
      ).bind(user!.id),
    ]);

    const deleted = await apiFetch(`/v1/workspaces/${workspace.id}`, {
      headers: { cookie, origin: WEB_ORIGIN },
      method: "DELETE",
    });
    expect(deleted.status).toBe(204);

    const account = await apiFetch("/v1/me", { headers: { cookie } });
    expect(await account.json()).toMatchObject({
      account: { ownedStorageBytes: 6, ownedWorkspaceCount: 0, storageLimitBytes: 5 },
    });

    const restored = await apiFetch(`/v1/workspaces/${workspace.id}/restore`, {
      headers: { cookie, origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(restored.status).toBe(403);
    expect(await restored.json()).toMatchObject({
      code: "quota-exceeded",
      message: "Hosted storage limit reached",
    });
    expect(
      await env.DB.prepare("SELECT lifecycle FROM workspaces WHERE id = ?")
        .bind(workspace.id)
        .first(),
    ).toEqual({ lifecycle: "deleted" });
    const denial = await env.DB.prepare(
      `SELECT metadata_json, outcome FROM audit_events
       WHERE workspace_id = ? AND action = 'workspace.restore'
       ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(workspace.id)
      .first<{ metadata_json: string; outcome: string }>();
    expect(denial).toMatchObject({ outcome: "denied" });
    expect(JSON.parse(denial!.metadata_json)).toEqual({ reason: "workspace-storage-limit" });
  });

  it("reserves one over-quota asset, verifies R2 bytes, and audits transfer grants", async () => {
    const cookie = await signUp("asset-owner@example.com", "Asset Owner");
    const workspace = await createWorkspace(cookie, "Asset workspace");
    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("asset-owner@example.com")
      .first<{ id: string }>();
    expect(user).toBeTruthy();
    await env.DB.prepare(
      `UPDATE account_entitlements
       SET account_storage_limit_bytes = 5, workspace_storage_limit_bytes = 5
       WHERE account_id = ?`,
    )
      .bind(user!.id)
      .run();

    const activeContentRejected = await apiFetch(`/v1/workspaces/${workspace.id}/assets/uploads`, {
      body: JSON.stringify({
        byteLength: 1,
        contentType: "text/html",
        mediaType: "image",
        originalFilename: "not-an-image.html",
      }),
      headers: {
        ...jsonHeaders(cookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440107",
      },
      method: "POST",
    });
    expect(activeContentRejected.status).toBe(400);
    expect(await activeContentRejected.json()).toMatchObject({ code: "invalid-request" });

    const malformedHashRejected = await apiFetch(`/v1/workspaces/${workspace.id}/assets/uploads`, {
      body: JSON.stringify({
        byteLength: 1,
        contentHash: "not-a-sha-256-digest",
        contentType: "image/png",
        mediaType: "image",
        originalFilename: "bad-hash.png",
      }),
      headers: {
        ...jsonHeaders(cookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440108",
      },
      method: "POST",
    });
    expect(malformedHashRejected.status).toBe(400);
    expect(await malformedHashRejected.json()).toMatchObject({ code: "invalid-request" });

    const reserved = await apiFetch(`/v1/workspaces/${workspace.id}/assets/uploads`, {
      body: JSON.stringify({
        byteLength: 6,
        contentHash: "7192385c3c0605de55bb9476ce1d90748190ecb32a8eed7f5207b30cf6a1fe89",
        contentType: "image/png",
        mediaType: "image",
        originalFilename: "six-bytes.png",
      }),
      headers: {
        ...jsonHeaders(cookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440105",
      },
      method: "POST",
    });
    expect(reserved.status).toBe(201);
    const grant = await reserved.json<{
      assetId: string;
      headers: Record<string, string>;
      reservationId: string;
      uploadUrl: string;
    }>();
    const uploadUrl = new URL(grant.uploadUrl);
    expect(uploadUrl.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(uploadUrl.searchParams.get("voidmesh-grant")).toBeTruthy();
    expect(grant.headers).toEqual({
      "content-type": "image/png",
      "x-amz-checksum-sha256": "cZI4XDwGBd5Vu5R2zh2QdIGQ7LMqju1/UgezDPah/ok=",
    });

    const reservationReplay = await apiFetch(`/v1/workspaces/${workspace.id}/assets/uploads`, {
      body: JSON.stringify({
        byteLength: 6,
        contentHash: "7192385c3c0605de55bb9476ce1d90748190ecb32a8eed7f5207b30cf6a1fe89",
        contentType: "image/png",
        mediaType: "image",
        originalFilename: "six-bytes.png",
      }),
      headers: {
        ...jsonHeaders(cookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440105",
      },
      method: "POST",
    });
    expect(reservationReplay.status).toBe(200);
    expect(await reservationReplay.json()).toEqual(grant);

    const grantId = uploadUrl.searchParams.get("voidmesh-grant")!;
    const wrongChecksum = await apiFetch(`/v1/object-grants/${grantId}`, {
      body: new Uint8Array([1, 2, 3, 4, 5, 6]),
      headers: {
        ...grant.headers,
        cookie,
        "x-amz-checksum-sha256": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      },
      method: "PUT",
    });
    expect(wrongChecksum.status).toBe(400);

    const uploaded = await apiFetch(`/v1/object-grants/${grantId}`, {
      body: new Uint8Array([1, 2, 3, 4, 5, 6]),
      headers: { ...grant.headers, cookie },
      method: "PUT",
    });
    expect(uploaded.status).toBe(204);

    const finalized = await apiFetch(
      `/v1/workspaces/${workspace.id}/assets/uploads/${grant.reservationId}/finalize`,
      { headers: { cookie, origin: WEB_ORIGIN }, method: "POST" },
    );
    expect(finalized.status).toBe(200);
    expect(await finalized.json()).toMatchObject({
      asset: {
        byteLength: 6,
        contentHash: "7192385c3c0605de55bb9476ce1d90748190ecb32a8eed7f5207b30cf6a1fe89",
        contentType: "image/png",
        id: grant.assetId,
      },
    });
    const finalizedReplay = await apiFetch(
      `/v1/workspaces/${workspace.id}/assets/uploads/${grant.reservationId}/finalize`,
      { headers: { cookie, origin: WEB_ORIGIN }, method: "POST" },
    );
    expect(finalizedReplay.status).toBe(200);
    expect(await finalizedReplay.json()).toMatchObject({ asset: { id: grant.assetId } });
    expect(
      await env.DB.prepare("SELECT lifecycle FROM assets WHERE id = ?").bind(grant.assetId).first(),
    ).toEqual({ lifecycle: "verified" });

    const blocked = await apiFetch(`/v1/workspaces/${workspace.id}/assets/uploads`, {
      body: JSON.stringify({
        byteLength: 1,
        contentType: "image/png",
        mediaType: "image",
        originalFilename: "blocked.png",
      }),
      headers: {
        ...jsonHeaders(cookie),
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440106",
      },
      method: "POST",
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: "quota-exceeded" });

    const socketResponse = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    expect(socketResponse.status).toBe(101);
    const socket = socketResponse.webSocket!;
    socket.accept();
    await nextWebSocketMessage(socket);
    await nextWebSocketMessage(socket);
    const document = new Y.Doc();
    document
      .getMap<Y.Map<unknown>>("entities")
      .set("uploaded-entity", testWorkspaceEntity(grant.assetId, "Uploaded"));
    const updateId = crypto.randomUUID();
    socket.send(encodeClientYjsUpdate(updateId, Y.encodeStateAsUpdate(document)));
    expect(JSON.parse(String(await nextWebSocketMessage(socket)))).toEqual({
      roomSequence: 1,
      type: "ack",
      updateId,
    });
    expect(
      await env.DB.prepare("SELECT lifecycle FROM assets WHERE id = ?").bind(grant.assetId).first(),
    ).toEqual({ lifecycle: "active" });
    expect(
      await env.DB.prepare(
        "SELECT action FROM audit_events WHERE target_id = ? AND action = 'asset.activated'",
      )
        .bind(grant.assetId)
        .first(),
    ).toEqual({ action: "asset.activated" });

    const content = await apiFetch(
      `/v1/workspaces/${workspace.id}/assets/${grant.assetId}/content`,
      { headers: { cookie, origin: WEB_ORIGIN }, method: "POST" },
    );
    expect(content.status).toBe(201);
    const contentGrant = await content.json<{
      downloadUrl: string;
      grantId: string;
    }>();
    expect(new URL(contentGrant.downloadUrl).pathname).toBe(
      `/v1/object-grants/${contentGrant.grantId}`,
    );
    const rangedContent = await apiFetch(new URL(contentGrant.downloadUrl).pathname, {
      headers: { cookie, range: "bytes=1-3" },
    });
    expect(rangedContent.status).toBe(206);
    expect(rangedContent.headers.get("content-range")).toBe("bytes 1-3/6");
    expect([...new Uint8Array(await rangedContent.arrayBuffer())]).toEqual([2, 3, 4]);

    const download = await apiFetch(
      `/v1/workspaces/${workspace.id}/assets/${grant.assetId}/download`,
      { headers: { cookie, origin: WEB_ORIGIN }, method: "POST" },
    );
    expect(download.status).toBe(201);
    const downloadGrant = await download.json<{
      downloadUrl: string;
      grantId: string;
    }>();
    expect(new URL(downloadGrant.downloadUrl).pathname).toBe(
      `/v1/object-grants/${downloadGrant.grantId}`,
    );
    const downloaded = await apiFetch(new URL(downloadGrant.downloadUrl).pathname, {
      headers: { cookie },
    });
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-disposition")).toContain("six-bytes.png");
    expect([...new Uint8Array(await downloaded.arrayBuffer())]).toEqual([1, 2, 3, 4, 5, 6]);

    const outsiderCookie = await signUp("asset-outsider@example.com", "Asset Outsider");
    const denied = await apiFetch(
      `/v1/workspaces/${workspace.id}/assets/${grant.assetId}/content`,
      {
        headers: { cookie: outsiderCookie, origin: WEB_ORIGIN },
        method: "POST",
      },
    );
    expect(denied.status).toBe(404);

    const transfers = await env.DB.prepare(
      `SELECT operation, purpose, actual_bytes, user_id
       FROM asset_transfer_grants WHERE asset_id = ? ORDER BY created_at`,
    )
      .bind(grant.assetId)
      .all<{
        actual_bytes: number | null;
        operation: string;
        purpose: string;
        user_id: string;
      }>();
    expect(transfers.results).toEqual([
      {
        actual_bytes: 6,
        operation: "upload",
        purpose: "upload",
        user_id: user!.id,
      },
      {
        actual_bytes: 3,
        operation: "download",
        purpose: "render",
        user_id: user!.id,
      },
      {
        actual_bytes: 6,
        operation: "download",
        purpose: "download",
        user_id: user!.id,
      },
    ]);
    const audit = await env.DB.prepare(
      `SELECT action, metadata_json FROM audit_events
       WHERE workspace_id = ? AND target_id = ? AND action IN ('asset.read-authorized', 'asset.bytes-served')
       ORDER BY created_at`,
    )
      .bind(workspace.id, grant.assetId)
      .all<{ action: string; metadata_json: string }>();
    expect(audit.results.map((event) => event.action)).toEqual([
      "asset.read-authorized",
      "asset.bytes-served",
      "asset.read-authorized",
      "asset.bytes-served",
    ]);
    expect(audit.results.map((event) => JSON.parse(event.metadata_json).purpose)).toEqual([
      "render",
      "render",
      "download",
      "download",
    ]);
    expect(
      await env.DB.prepare(
        `SELECT action, outcome, metadata_json FROM audit_events
         WHERE workspace_id = ? AND target_id = ? AND action = 'asset.read-denied'`,
      )
        .bind(workspace.id, grant.assetId)
        .first(),
    ).toMatchObject({
      action: "asset.read-denied",
      metadata_json: expect.stringContaining('"purpose":"render"'),
      outcome: "denied",
    });
    expect(
      await env.DB.prepare(
        `SELECT action FROM audit_events
         WHERE workspace_id = ? AND target_id = ? AND action = 'asset.download-requested'`,
      )
        .bind(workspace.id, grant.assetId)
        .first(),
    ).toEqual({ action: "asset.download-requested" });
    socket.close();
  });

  it("applies signed Stripe subscription events idempotently and ignores stale events", async () => {
    const cookie = await signUp("billing-owner@example.com", "Billing Owner");
    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("billing-owner@example.com")
      .first<{ id: string }>();
    expect(user).toBeTruthy();
    const now = Math.floor(Date.now() / 1000);
    const activeEvent = stripeSubscriptionEvent({
      accountId: user!.id,
      created: now,
      eventId: "evt_subscription_active",
      status: "active",
    });
    const active = await sendStripeEvent(activeEvent);
    expect(active.status).toBe(200);
    expect(await active.json()).toEqual({ received: true });

    const upgraded = await apiFetch("/v1/me", { headers: { cookie } });
    expect(await upgraded.json()).toMatchObject({
      account: {
        canEditCollaborate: true,
        planKey: "pro",
        storageLimitBytes: 10 * 1024 ** 3,
        workspaceLimit: 5,
        workspaceStorageLimitBytes: 4 * 1024 ** 3,
      },
      subscription: { status: "active" },
    });

    const duplicate = await sendStripeEvent(activeEvent);
    expect(duplicate.status).toBe(200);
    const eventCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM billing_events WHERE event_id = ?",
    )
      .bind(activeEvent.id)
      .first<{ count: number }>();
    expect(eventCount?.count).toBe(1);

    const stale = stripeSubscriptionEvent({
      accountId: user!.id,
      created: now - 60,
      eventId: "evt_subscription_stale",
      status: "canceled",
    });
    expect((await sendStripeEvent(stale)).status).toBe(200);
    const stillPro = await apiFetch("/v1/me", { headers: { cookie } });
    expect(await stillPro.json()).toMatchObject({
      account: { planKey: "pro" },
    });

    const canceled = stripeSubscriptionEvent({
      accountId: user!.id,
      created: now + 60,
      eventId: "evt_subscription_canceled",
      status: "canceled",
    });
    expect((await sendStripeEvent(canceled)).status).toBe(200);
    const downgraded = await apiFetch("/v1/me", { headers: { cookie } });
    expect(await downgraded.json()).toMatchObject({
      account: {
        canEditCollaborate: false,
        planKey: "cloud-free",
        storageLimitBytes: 1024 ** 3,
        workspaceLimit: 1,
      },
      subscription: { status: "canceled" },
    });
  });

  it("rejects unsigned billing webhooks and non-idempotent billing session requests", async () => {
    const unsigned = await apiFetch("/v1/billing/webhooks/stripe", {
      body: "{}",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.json()).toMatchObject({ code: "unauthorized" });

    const cookie = await signUp("billing-guard@example.com", "Billing Guard");
    const checkout = await apiFetch("/v1/billing/checkout", {
      headers: { cookie, origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(checkout.status).toBe(400);
    expect(await checkout.json()).toMatchObject({ code: "invalid-request" });

    const portal = await apiFetch("/v1/billing/portal", {
      headers: { cookie, origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(portal.status).toBe(400);
    expect(await portal.json()).toMatchObject({ code: "invalid-request" });
  });

  it("deletes an account, revokes its session, and retains owned workspaces for 30 days", async () => {
    const cookie = await signUp("delete-owner@example.com", "Delete Owner");
    const workspace = await createWorkspace(cookie, "Account deletion workspace");

    const deleted = await apiFetch("/v1/auth/delete-user", {
      body: JSON.stringify({ password: "correct-horse-battery-staple" }),
      headers: jsonHeaders(cookie),
      method: "POST",
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({
      message: "User deleted",
      success: true,
    });

    const sessionRejected = await apiFetch("/v1/me", { headers: { cookie } });
    expect(sessionRejected.status).toBe(401);

    const retained = await env.DB.prepare(
      `SELECT lifecycle, deleted_at, purge_after
       FROM workspaces WHERE id = ?`,
    )
      .bind(workspace.id)
      .first<{
        deleted_at: number | null;
        lifecycle: string;
        purge_after: number | null;
      }>();
    expect(retained).toMatchObject({
      deleted_at: expect.any(Number),
      lifecycle: "deleted",
      purge_after: expect.any(Number),
    });
    expect(retained!.purge_after! - retained!.deleted_at!).toBe(30 * 24 * 60 * 60 * 1000);

    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("delete-owner@example.com")
      .first();
    expect(user).toBeNull();
  });

  it("permanently purges expired workspaces from R2, Durable Objects, and D1", async () => {
    const cookie = await signUp("purge-owner@example.com", "Purge Owner");
    const workspace = await createWorkspace(cookie, "Expired workspace");
    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("purge-owner@example.com")
      .first<{ id: string }>();
    const assetKey = `assets/${workspace.id}/asset/object`;
    const snapshotKey = `snapshots/${workspace.id}/1`;
    const room = env.WORKSPACE_ROOMS.getByName(workspace.id);
    await room.initialize(workspace.id);
    await Promise.all([
      env.ASSETS.put(assetKey, new Uint8Array([1, 2, 3])),
      env.ASSETS.put(snapshotKey, new Uint8Array([4, 5, 6])),
    ]);
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (
          id, workspace_id, uploaded_by_user_id, object_key, media_type, content_type,
          original_filename, byte_length, lifecycle, created_at, updated_at
        ) VALUES ('asset_purge', ?, ?, ?, 'image', 'image/png', 'purge.png', 3, 'active', ?, ?)`,
      ).bind(workspace.id, user!.id, assetKey, now, now),
      env.DB.prepare(
        `INSERT INTO workspace_snapshots (
          workspace_id, room_sequence, object_key, checksum, byte_length, created_at
        ) VALUES (?, 1, ?, 'checksum', 3, ?)`,
      ).bind(workspace.id, snapshotKey, now),
    ]);
    expect(
      (
        await apiFetch(`/v1/workspaces/${workspace.id}`, {
          headers: { cookie, origin: WEB_ORIGIN },
          method: "DELETE",
        })
      ).status,
    ).toBe(204);
    await env.DB.prepare("UPDATE workspaces SET purge_after = ? WHERE id = ?")
      .bind(now - 1, workspace.id)
      .run();

    await expect(purgeExpiredWorkspaces(env, now)).resolves.toEqual({
      deletedObjectCount: 3,
      purgedWorkspaceCount: 1,
    });
    expect(await env.ASSETS.get(assetKey)).toBeNull();
    expect(await env.ASSETS.get(snapshotKey)).toBeNull();
    expect(await room.getStatus()).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM workspaces WHERE id = ?").bind(workspace.id).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT action FROM audit_events WHERE action = 'workspace.purge' AND target_id = ?",
      )
        .bind(workspace.id)
        .first(),
    ).toEqual({ action: "workspace.purge" });
  });

  it("expires abandoned uploads, releases quota, and removes orphaned objects", async () => {
    const cookie = await signUp("upload-expiry@example.com", "Upload Expiry");
    const workspace = await createWorkspace(cookie, "Upload expiry workspace");
    const user = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("upload-expiry@example.com")
      .first<{ id: string }>();
    const assetId = "asset_expired_upload";
    const reservationId = "reservation_expired_upload";
    const objectKey = `assets/${workspace.id}/${assetId}/orphan`;
    const now = Date.now();
    await env.ASSETS.put(objectKey, new Uint8Array([1, 2, 3]));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO assets (
          id, workspace_id, uploaded_by_user_id, object_key, media_type, content_type,
          original_filename, byte_length, lifecycle, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'image', 'image/png', 'orphan.png', 0, 'reserved', ?, ?)`,
      ).bind(assetId, workspace.id, user!.id, objectKey, now - 1_000, now - 1_000),
      env.DB.prepare(
        `INSERT INTO upload_reservations (
          id, workspace_id, asset_id, actor_user_id, expected_bytes, reserved_bytes,
          state, idempotency_key, expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 3, 3, 'pending', ?, ?, ?, ?)`,
      ).bind(
        reservationId,
        workspace.id,
        assetId,
        user!.id,
        reservationId,
        now - 1,
        now - 1_000,
        now - 1_000,
      ),
    ]);
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM workspaces WHERE id = ?")
        .bind(workspace.id)
        .first(),
    ).toEqual({ reserved_bytes: 3 });

    await expect(cleanupExpiredUploads(env, now)).resolves.toEqual({
      cleanedAssetCount: 1,
      expiredReservationCount: 1,
    });
    expect(await env.ASSETS.get(objectKey)).toBeNull();
    expect(
      await env.DB.prepare("SELECT reserved_bytes FROM workspaces WHERE id = ?")
        .bind(workspace.id)
        .first(),
    ).toEqual({ reserved_bytes: 0 });
    expect(
      await env.DB.prepare("SELECT id FROM upload_reservations WHERE id = ?")
        .bind(reservationId)
        .first(),
    ).toBeNull();
    expect(
      await env.DB.prepare("SELECT id FROM assets WHERE id = ?").bind(assetId).first(),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT action, outcome FROM audit_events WHERE target_id = ? AND action = 'asset.upload-expired'",
      )
        .bind(assetId)
        .first(),
    ).toEqual({ action: "asset.upload-expired", outcome: "success" });
  });

  it("disconnects live workspace rooms when an account session is revoked", async () => {
    const cookie = await signUp("session-revoke@example.com", "Session Revoke");
    const workspace = await createWorkspace(cookie, "Session revocation workspace");
    const response = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket!;
    socket.accept();
    await bounded(nextWebSocketMessage(socket), "revocation hello");
    await bounded(nextWebSocketMessage(socket), "revocation sync");

    const close = nextWebSocketClose(socket);
    const revoked = await apiFetch("/v1/auth/revoke-sessions", {
      headers: { cookie, origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(revoked.status).toBe(200);
    await expect(bounded(close, "session revocation close")).resolves.toMatchObject({
      code: 4003,
    });
    expect(
      (
        await apiFetch(`/v1/workspaces/${workspace.id}`, {
          headers: { cookie },
        })
      ).status,
    ).toBe(401);
  });

  it("authenticates WebSockets and deduplicates retried offline Yjs updates", async () => {
    const cookie = await signUp("realtime-owner@example.com", "Realtime Owner");
    const workspace = await createWorkspace(cookie, "Realtime workspace");
    const owner = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("realtime-owner@example.com")
      .first<{ id: string }>();
    const realtimeAssetId = "asset-realtime";
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO assets (
        id, workspace_id, uploaded_by_user_id, object_key, media_type, content_type,
        original_filename, byte_length, lifecycle, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'image', 'image/png', 'realtime.png', 1, 'active', ?, ?)`,
    )
      .bind(
        realtimeAssetId,
        workspace.id,
        owner!.id,
        `assets/${workspace.id}/${realtimeAssetId}/object`,
        now,
        now,
      )
      .run();
    const response = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    expect(socket).toBeTruthy();
    socket!.accept();

    const hello = JSON.parse(String(await nextWebSocketMessage(socket!)));
    expect(hello).toMatchObject({
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      role: "owner",
      roomSequence: 0,
      type: "hello",
    });
    const syncComplete = JSON.parse(String(await nextWebSocketMessage(socket!)));
    expect(syncComplete).toMatchObject({
      roomSequence: 0,
      type: "sync-complete",
    });
    expect(typeof syncComplete.stateVector).toBe("string");

    const clockRequestId = "550e8400-e29b-41d4-a716-446655440008";
    const clientTime = Date.now();
    socket!.send(
      JSON.stringify({
        clientTime,
        requestId: clockRequestId,
        type: "clock-ping",
      }),
    );
    const clockPong = JSON.parse(String(await nextWebSocketMessage(socket!)));
    expect(clockPong).toMatchObject({
      clientTime,
      requestId: clockRequestId,
      type: "clock-pong",
    });
    expect(clockPong.serverTime).toBeGreaterThanOrEqual(clientTime);

    const untrustedDocument = new Y.Doc();
    const untrustedEntity = testWorkspaceEntity("asset-from-another-workspace", "Unknown");
    untrustedDocument.getMap<Y.Map<unknown>>("entities").set("unknown-entity", untrustedEntity);
    socket!.send(
      encodeClientYjsUpdate(
        "550e8400-e29b-41d4-a716-446655440007",
        Y.encodeStateAsUpdate(untrustedDocument),
      ),
    );
    expect(JSON.parse(String(await nextWebSocketMessage(socket!)))).toEqual({
      code: "unknown-asset",
      type: "error",
    });
    expect(await env.WORKSPACE_ROOMS.getByName(workspace.id).getStatus()).toMatchObject({
      roomSequence: 0,
    });

    const updateId = "550e8400-e29b-41d4-a716-446655440000";
    const document = new Y.Doc();
    document
      .getMap<Y.Map<unknown>>("entities")
      .set("entity-1", testWorkspaceEntity(realtimeAssetId, "First"));
    const frame = encodeClientYjsUpdate(updateId, Y.encodeStateAsUpdate(document));
    socket!.send(frame);
    expect(JSON.parse(String(await nextWebSocketMessage(socket!)))).toEqual({
      roomSequence: 1,
      type: "ack",
      updateId,
    });

    const secondDocument = new Y.Doc();
    secondDocument
      .getMap<Y.Map<unknown>>("entities")
      .set("entity-2", testWorkspaceEntity(realtimeAssetId, "Second"));
    const secondUpdateId = "550e8400-e29b-41d4-a716-446655440002";
    const secondFrame = encodeClientYjsUpdate(
      secondUpdateId,
      Y.encodeStateAsUpdate(secondDocument),
    );
    const secondAck = nextWebSocketMessage(socket!);
    socket!.send(secondFrame);
    expect(JSON.parse(String(await bounded(secondAck, "second update ack")))).toEqual({
      roomSequence: 2,
      type: "ack",
      updateId: secondUpdateId,
    });

    const snapshot = await waitForWorkspaceSnapshot(workspace.id, 2);
    expect(snapshot.room_sequence).toBe(2);
    expect(await env.ASSETS.head(snapshot.object_key)).toBeTruthy();

    const reconnect = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    expect(reconnect.status).toBe(101);
    const reconnectSocket = reconnect.webSocket!;
    reconnectSocket.binaryType = "arraybuffer";
    reconnectSocket.accept();
    expect(JSON.parse(String(await nextWebSocketMessage(reconnectSocket)))).toMatchObject({
      roomSequence: 2,
      type: "hello",
    });
    expect(await nextWebSocketMessage(reconnectSocket)).toBeInstanceOf(ArrayBuffer);
    expect(JSON.parse(String(await nextWebSocketMessage(reconnectSocket)))).toMatchObject({
      roomSequence: 2,
      type: "sync-complete",
    });

    socket!.send(frame);
    expect(JSON.parse(String(await nextWebSocketMessage(socket!)))).toEqual({
      roomSequence: 1,
      type: "ack",
      updateId,
    });

    Y.applyUpdate(document, Y.encodeStateAsUpdate(secondDocument));
    const beforeDelete = Y.encodeStateVector(document);
    document.getMap("entities").delete("entity-1");
    document.getMap("entities").delete("entity-2");
    const deleteUpdateId = "550e8400-e29b-41d4-a716-446655440003";
    socket!.send(
      encodeClientYjsUpdate(deleteUpdateId, Y.encodeStateAsUpdate(document, beforeDelete)),
    );
    expect(JSON.parse(String(await nextWebSocketMessage(socket!)))).toEqual({
      roomSequence: 3,
      type: "ack",
      updateId: deleteUpdateId,
    });
    expect(
      await env.DB.prepare("SELECT lifecycle, unreferenced_at FROM assets WHERE id = ?")
        .bind(realtimeAssetId)
        .first(),
    ).toMatchObject({ lifecycle: "unreferenced" });

    const beforeRestore = Y.encodeStateVector(document);
    document
      .getMap<Y.Map<unknown>>("entities")
      .set("entity-1", testWorkspaceEntity(realtimeAssetId, "Restored"));
    const restoreUpdateId = "550e8400-e29b-41d4-a716-446655440004";
    socket!.send(
      encodeClientYjsUpdate(restoreUpdateId, Y.encodeStateAsUpdate(document, beforeRestore)),
    );
    expect(JSON.parse(String(await nextWebSocketMessage(socket!)))).toEqual({
      roomSequence: 4,
      type: "ack",
      updateId: restoreUpdateId,
    });
    expect(
      await env.DB.prepare("SELECT lifecycle, unreferenced_at FROM assets WHERE id = ?")
        .bind(realtimeAssetId)
        .first(),
    ).toEqual({ lifecycle: "active", unreferenced_at: null });
    expect(
      (
        await env.DB.prepare(
          `SELECT action FROM audit_events
           WHERE target_id = ? AND action IN ('asset.unreferenced', 'asset.restored')
           ORDER BY created_at, action`,
        )
          .bind(realtimeAssetId)
          .all<{ action: string }>()
      ).results.map(({ action }) => action),
    ).toEqual(["asset.unreferenced", "asset.restored"]);
    expect(await env.WORKSPACE_ROOMS.getByName(workspace.id).getStatus()).toEqual({
      roomSequence: 4,
      workspaceId: workspace.id,
    });
    socket!.close(1000, "test complete");
    reconnectSocket.close(1000, "test complete");
  });

  it("exchanges an authenticated session for a short-lived direct WebSocket ticket", async () => {
    const cookie = await signUp("ticket-owner@example.com", "Ticket Owner");
    const workspace = await createWorkspace(cookie, "Ticket workspace");
    const ticketResponse = await apiFetch(`/v1/workspaces/${workspace.id}/connect-ticket`, {
      headers: { cookie, origin: WEB_ORIGIN },
      method: "POST",
    });
    expect(ticketResponse.status).toBe(201);
    const ticket = await ticketResponse.json<{ protocol: string; socketUrl: string }>();
    expect(ticket).toMatchObject({
      socketUrl: `/v1/workspaces/${workspace.id}/connect`,
    });
    expect(ticket.protocol).toMatch(/^voidmesh\.ticket\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const rejected = await apiFetch(ticket.socketUrl, {
      headers: {
        origin: "https://attacker.example",
        "sec-websocket-protocol": ticket.protocol,
        upgrade: "websocket",
      },
    });
    expect(rejected.status).toBe(403);

    const connected = await apiFetch(ticket.socketUrl, {
      headers: {
        origin: WEB_ORIGIN,
        "sec-websocket-protocol": ticket.protocol,
        upgrade: "websocket",
      },
    });
    expect(connected.status).toBe(101);
    expect(connected.headers.get("sec-websocket-protocol")).toBe(ticket.protocol);
    const socket = connected.webSocket!;
    socket.accept();
    await expect(bounded(nextWebSocketMessage(socket), "ticket hello")).resolves.toBeTruthy();
    await expect(bounded(nextWebSocketMessage(socket), "ticket sync")).resolves.toBeTruthy();
    socket.close();
  });

  it("routes current cursor and selection presence to new and existing connections", async () => {
    const cookie = await signUp("presence-owner@example.com", "Presence Owner");
    const workspace = await createWorkspace(cookie, "Presence workspace");
    const firstResponse = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    const first = firstResponse.webSocket!;
    first.accept();
    const firstHello = JSON.parse(String(await nextWebSocketMessage(first))) as {
      connectionId: string;
    };
    await nextWebSocketMessage(first);
    first.send(
      JSON.stringify({
        cursor: { x: 40, y: -12 },
        selectedEntityIds: ["entity-current"],
        sequence: 0,
        type: "presence",
      }),
    );

    const secondResponse = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    const second = secondResponse.webSocket!;
    second.accept();
    expect(JSON.parse(String(await nextWebSocketMessage(second)))).toMatchObject({
      peers: [{ connectionId: firstHello.connectionId }],
      type: "hello",
    });
    await nextWebSocketMessage(second);
    expect(JSON.parse(String(await nextWebSocketMessage(second)))).toMatchObject({
      connectionId: firstHello.connectionId,
      cursor: { x: 40, y: -12 },
      selectedEntityIds: ["entity-current"],
      sequence: 0,
      type: "presence",
    });

    first.send(
      JSON.stringify({
        cursor: null,
        selectedEntityIds: [],
        sequence: 1,
        type: "presence",
      }),
    );
    expect(JSON.parse(String(await nextWebSocketMessage(second)))).toMatchObject({
      connectionId: firstHello.connectionId,
      cursor: null,
      selectedEntityIds: [],
      sequence: 1,
      type: "presence",
    });
    const left = nextWebSocketMessage(second);
    first.close();
    expect(JSON.parse(String(await left))).toMatchObject({
      connectionId: firstHello.connectionId,
      type: "peer-left",
    });
    second.close();
  });

  it("stamps playback anchors with the authoritative room time and sequence", async () => {
    const cookie = await signUp("playback-owner@example.com", "Playback Owner");
    const workspace = await createWorkspace(cookie, "Playback workspace");
    const owner = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("playback-owner@example.com")
      .first<{ id: string }>();
    const assetId = "asset-playback";
    const createdAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO assets (
        id, workspace_id, uploaded_by_user_id, object_key, media_type, content_type,
        original_filename, byte_length, lifecycle, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'video', 'video/mp4', 'playback.mp4', 1, 'active', ?, ?)`,
    )
      .bind(
        assetId,
        workspace.id,
        owner!.id,
        `assets/${workspace.id}/${assetId}/object`,
        createdAt,
        createdAt,
      )
      .run();
    const response = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    const socket = response.webSocket!;
    socket.binaryType = "arraybuffer";
    socket.accept();
    await nextWebSocketMessage(socket);
    await nextWebSocketMessage(socket);

    const document = new Y.Doc();
    const entity = testWorkspaceEntity(assetId, "Playback");
    entity.set("playback", {
      commandId: "playback-command-1",
      duration: 30,
      state: {
        currentTime: 4,
        isPlaying: true,
        loop: true,
        muted: false,
        playbackRate: 1,
        volume: 0.5,
      },
      updatedAt: 1,
    });
    document.getMap<Y.Map<unknown>>("entities").set("entity-playback", entity);
    const updateId = "550e8400-e29b-41d4-a716-446655440008";
    const sentAt = Date.now();
    const ack = nextWebSocketMessage(socket);
    socket.send(encodeClientYjsUpdate(updateId, Y.encodeStateAsUpdate(document)));
    expect(JSON.parse(String(await ack))).toEqual({
      roomSequence: 1,
      type: "ack",
      updateId,
    });
    const correction = await nextWebSocketMessage(socket);
    expect(correction).toBeInstanceOf(ArrayBuffer);
    const decoded = decodeServerYjsUpdate(correction as ArrayBuffer);
    expect(decoded).toMatchObject({ roomSequence: 1, updateId });
    Y.applyUpdate(document, decoded!.update);
    const anchor = document
      .getMap<Y.Map<unknown>>("entities")
      .get("entity-playback")!
      .get("playback") as { sequence: number; updatedAt: number };
    expect(anchor.sequence).toBe(1);
    expect(anchor.updatedAt).toBeGreaterThanOrEqual(sentAt);
    expect(anchor.updatedAt).toBeLessThanOrEqual(Date.now());
    socket.close();
  });

  it("builds an authorized portable workspace export with original asset bytes", async () => {
    const cookie = await signUp("export-owner@example.com", "Export Owner");
    const workspace = await createWorkspace(cookie, "Portable canvas");
    const owner = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind("export-owner@example.com")
      .first<{ id: string }>();
    const assetId = "asset-export";
    const objectKey = `assets/${workspace.id}/${assetId}/object`;
    const now = Date.now();
    await env.DB.prepare(
      `INSERT INTO assets (
        id, workspace_id, uploaded_by_user_id, object_key, media_type, content_type,
        original_filename, byte_length, lifecycle, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'image', 'image/png', 'Exported image.png', 1, 'active', ?, ?)`,
    )
      .bind(assetId, workspace.id, owner!.id, objectKey, now, now)
      .run();
    await env.ASSETS.put(objectKey, new Uint8Array([137]), {
      httpMetadata: { contentType: "image/png" },
    });

    const connected = await apiFetch(`/v1/workspaces/${workspace.id}/connect`, {
      headers: { cookie, upgrade: "websocket" },
    });
    const socket = connected.webSocket!;
    socket.accept();
    await nextWebSocketMessage(socket);
    await nextWebSocketMessage(socket);
    const document = new Y.Doc();
    document
      .getMap<Y.Map<unknown>>("entities")
      .set("entity-export", testWorkspaceEntity(assetId, "Exported image"));
    const updateId = "550e8400-e29b-41d4-a716-446655440009";
    socket.send(encodeClientYjsUpdate(updateId, Y.encodeStateAsUpdate(document)));
    expect(JSON.parse(String(await nextWebSocketMessage(socket)))).toMatchObject({
      roomSequence: 1,
      type: "ack",
      updateId,
    });

    const created = await apiFetch(`/v1/workspaces/${workspace.id}/export`, {
      headers: {
        cookie,
        "idempotency-key": "550e8400-e29b-41d4-a716-446655440010",
        origin: WEB_ORIGIN,
      },
      method: "POST",
    });
    expect(created.status).toBe(202);
    const createdBody = await created.json<{
      export: { id: string; roomSequence: number; state: string };
    }>();
    expect(createdBody.export).toMatchObject({ roomSequence: 1 });
    await processWorkspaceExport(env, createdBody.export.id);

    const status = await apiFetch(
      `/v1/workspaces/${workspace.id}/exports/${createdBody.export.id}`,
      { headers: { cookie } },
    );
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      export: {
        byteLength: expect.any(Number),
        filename: "Portable canvas.vdmsh",
        roomSequence: 1,
        state: "completed",
      },
    });

    const downloaded = await apiFetch(
      `/v1/workspaces/${workspace.id}/exports/${createdBody.export.id}/download`,
      { headers: { cookie } },
    );
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get("content-type")).toBe("application/vdmsh");
    const archive = unzipSync(new Uint8Array(await downloaded.arrayBuffer()));
    expect([...archive["media/assets/asset-export.png"]!]).toEqual([137]);
    expect(JSON.parse(new TextDecoder().decode(archive["manifest.json"]))).toMatchObject({
      entities: [
        {
          id: "entity-export",
          mediaFile: "media/assets/asset-export.png",
          mediaType: "image",
        },
      ],
      type: "studio-canvas",
      version: 6,
    });
    const storedExport = await env.DB.prepare(
      `SELECT archive_object_key, snapshot_object_key
       FROM workspace_exports WHERE id = ?`,
    )
      .bind(createdBody.export.id)
      .first<{
        archive_object_key: string;
        snapshot_object_key: string;
      }>();
    await env.DB.prepare("UPDATE workspace_exports SET expires_at = ? WHERE id = ?")
      .bind(Date.now() - 1, createdBody.export.id)
      .run();
    expect(await cleanupExpiredExports(env)).toEqual({
      deletedObjectCount: 2,
      expiredExportCount: 1,
    });
    expect(await env.ASSETS.head(storedExport!.archive_object_key)).toBeNull();
    expect(await env.ASSETS.head(storedExport!.snapshot_object_key)).toBeNull();
    socket.close();
  });
});

async function signUp(email: string, name: string): Promise<string> {
  const response = await apiFetch("/v1/auth/sign-up/email", {
    body: JSON.stringify({
      email,
      name,
      password: "correct-horse-battery-staple",
    }),
    headers: {
      "cf-connecting-ip": `192.0.2.${signupAddress++}`,
      "content-type": "application/json",
      origin: WEB_ORIGIN,
    },
    method: "POST",
  });
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie");
  expect(cookie).toBeTruthy();
  return cookie!.split(";", 1)[0]!;
}

async function createWorkspace(
  cookie: string,
  title: string,
): Promise<{ id: string; title: string }> {
  const response = await apiFetch("/v1/workspaces", {
    body: JSON.stringify({ title }),
    headers: { ...jsonHeaders(cookie), "idempotency-key": crypto.randomUUID() },
    method: "POST",
  });
  expect(response.status).toBe(201);
  const body = await response.json<{
    workspace: { id: string; title: string };
  }>();
  return body.workspace;
}

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(`https://voidmesh.test${path}`, init);
}

function jsonHeaders(cookie: string): Record<string, string> {
  return { "content-type": "application/json", cookie, origin: WEB_ORIGIN };
}

interface TestStripeSubscriptionEvent {
  created: number;
  data: {
    object: {
      cancel_at_period_end: boolean;
      customer: string;
      id: string;
      items: { data: Array<{ current_period_end: number }> };
      metadata: { account_id: string; plan_key: "pro" };
      object: "subscription";
      status: "active" | "canceled";
    };
  };
  id: string;
  object: "event";
  type: "customer.subscription.updated";
}

function stripeSubscriptionEvent(input: {
  accountId: string;
  created: number;
  eventId: string;
  status: "active" | "canceled";
}): TestStripeSubscriptionEvent {
  return {
    created: input.created,
    data: {
      object: {
        cancel_at_period_end: false,
        customer: "cus_voidmesh_test",
        id: "sub_voidmesh_test",
        items: {
          data: [{ current_period_end: input.created + 30 * 24 * 60 * 60 }],
        },
        metadata: { account_id: input.accountId, plan_key: "pro" },
        object: "subscription",
        status: input.status,
      },
    },
    id: input.eventId,
    object: "event",
    type: "customer.subscription.updated",
  };
}

async function sendStripeEvent(event: TestStripeSubscriptionEvent): Promise<Response> {
  const body = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { hash: "SHA-256", name: "HMAC" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${body}`),
  );
  const hex = [...new Uint8Array(signature)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return apiFetch("/v1/billing/webhooks/stripe", {
    body,
    headers: {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${hex}`,
    },
    method: "POST",
  });
}

function nextWebSocketMessage(socket: WebSocket): Promise<string | ArrayBuffer> {
  return new Promise((resolve, reject) => {
    socket.addEventListener("message", (event) => resolve(event.data), {
      once: true,
    });
    socket.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
  });
}

function testWorkspaceEntity(assetId: string, name: string): Y.Map<unknown> {
  const entity = new Y.Map<unknown>();
  entity.set("identity.name", name);
  entity.set("identity.locked", false);
  entity.set("identity.edited", false);
  entity.set("geometry.position.x", 0);
  entity.set("geometry.position.y", 0);
  entity.set("geometry.size.width", 100);
  entity.set("geometry.size.height", 100);
  entity.set("geometry.originalSize.width", 100);
  entity.set("geometry.originalSize.height", 100);
  entity.set("geometry.rotation", 0);
  entity.set("geometry.zIndex", 0);
  entity.set("appearance.shaderType", "none");
  entity.set("appearance.params.size", 1);
  entity.set("appearance.params.shape", "circle");
  entity.set("appearance.params.color", [1, 1, 1, 1]);
  entity.set("appearance.params.background", [0, 0, 0, 1]);
  entity.set("appearance.params.preserveColors", false);
  entity.set("appearance.params.reversePalette", false);
  entity.set("appearance.params.showOriginal", false);
  entity.set("appearance.params.scale", 1);
  entity.set("appearance.params.intensity", 1);
  entity.set("asset", {
    byteLength: 1,
    contentType: "image/png",
    id: assetId,
    mediaType: "image",
    originalFilename: `${name}.png`,
  });
  return entity;
}

function nextWebSocketClose(socket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => {
    socket.addEventListener("close", resolve, { once: true });
  });
}

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 1_000),
    ),
  ]);
}

async function waitForWorkspaceSnapshot(
  workspaceId: string,
  minimumRoomSequence: number,
): Promise<{ object_key: string; room_sequence: number }> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const snapshot = await env.DB.prepare(
      `SELECT object_key, room_sequence FROM workspace_snapshots
       WHERE workspace_id = ? AND room_sequence >= ?
       ORDER BY room_sequence DESC LIMIT 1`,
    )
      .bind(workspaceId, minimumRoomSequence)
      .first<{ object_key: string; room_sequence: number }>();
    if (snapshot) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for workspace snapshot");
}
