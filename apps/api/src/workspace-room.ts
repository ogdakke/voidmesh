import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import { isIdentifier } from "@voidmesh/api-contract";
import {
  COLLABORATION_PROTOCOL_VERSION,
  MAX_YJS_UPDATE_BYTES,
  bytesToBase64Url,
  decodeClientYjsRebase,
  decodeClientYjsUpdate,
  encodeServerYjsRebase,
  encodeServerYjsUpdate,
  parseClientClockPingMessage,
  parseClientPresenceMessage,
  type CollaborationPeer,
  type PresencePoint,
  type ServerAckMessage,
  type ServerClockPongMessage,
  type ServerHelloMessage,
  type ServerPeerLeftMessage,
  type ServerPresenceMessage,
  type ServerRoleChangedMessage,
  type ServerSyncCompleteMessage,
} from "@voidmesh/collaboration";
import type { WorkspaceId } from "@voidmesh/domain";
import type { UserId, WorkspaceRole } from "@voidmesh/domain";
import { verifyRoomAuthorization } from "./room-authorization.ts";

export interface WorkspaceRoomStatus {
  roomSequence: number;
  workspaceId: WorkspaceId;
}

export interface WorkspaceRoomExportSnapshot {
  objectKey: string;
  roomSequence: number;
}

export interface WorkspaceRoomInitialSnapshot {
  objectKey: string;
  roomSequence: 0;
}

interface ConnectionAttachment {
  color: string;
  connectionId: string;
  cursor?: PresencePoint | null;
  name: string;
  presenceSequence: number;
  role: WorkspaceRole;
  selectedEntityIds?: string[];
  sessionId?: string;
  userId: UserId;
}

interface LocalSnapshotRow {
  [key: string]: ArrayBuffer | number | string;
  room_sequence: number;
  update_bytes: ArrayBuffer;
  update_id: string;
}

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;
const MAX_DOCUMENT_ENTITIES = 10_000;
const MAX_ENTITY_FIELDS = 2_048;
const MAX_SHARED_VALUE_DEPTH = 8;
const MAX_PRESENCE_BACKPRESSURE_BYTES = 64 * 1024;

export class WorkspaceRoom extends DurableObject<Env> {
  #document = new Y.Doc();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.#migrate();
      await this.#restoreDocument();
    });
  }

  async initialize(workspaceId: WorkspaceId): Promise<WorkspaceRoomStatus> {
    if (!isIdentifier(workspaceId)) throw new Error("Invalid workspace ID");

    const existing = this.#readStatus();
    if (existing && existing.workspaceId !== workspaceId) {
      throw new Error("Workspace room is already initialized for another workspace");
    }
    if (existing) return existing;

    const recovered = await this.#recoverRemoteSnapshot(workspaceId);
    if (recovered) return recovered;

    this.ctx.storage.sql.exec(
      "INSERT INTO room_metadata (singleton, workspace_id, room_sequence) VALUES (1, ?, 0)",
      workspaceId,
    );
    return { roomSequence: 0, workspaceId };
  }

  async initializeWithSnapshot(workspaceId: WorkspaceId): Promise<WorkspaceRoomInitialSnapshot> {
    const status = await this.initialize(workspaceId);
    if (status.roomSequence !== 0) {
      throw new Error("Cannot create an initial snapshot for a non-empty workspace");
    }

    const existing = await this.env.DB.prepare(
      `SELECT object_key FROM workspace_snapshots
       WHERE workspace_id = ? AND room_sequence = 0`,
    )
      .bind(workspaceId)
      .first<{ object_key: string }>();
    if (existing) return { objectKey: existing.object_key, roomSequence: 0 };

    const update = Y.encodeStateAsUpdate(this.#document);
    const checksum = await sha256Hex(update);
    const objectKey = `snapshots/${workspaceId}/0/${crypto.randomUUID()}`;
    await this.env.ASSETS.put(objectKey, update, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    try {
      await this.env.DB.prepare(
        `INSERT INTO workspace_snapshots (
          workspace_id, room_sequence, object_key, checksum, byte_length, created_at
        ) VALUES (?, 0, ?, ?, ?, ?)`,
      )
        .bind(workspaceId, objectKey, checksum, update.byteLength, Date.now())
        .run();
    } catch (error) {
      await this.env.ASSETS.delete(objectKey);
      throw error;
    }
    return { objectKey, roomSequence: 0 };
  }

  getStatus(): WorkspaceRoomStatus | null {
    return this.#readStatus();
  }

  async createExportSnapshot(
    workspaceId: WorkspaceId,
    exportId: string,
  ): Promise<WorkspaceRoomExportSnapshot> {
    if (!isIdentifier(exportId)) throw new Error("Invalid export ID");
    const status = await this.initialize(workspaceId);
    const update = Y.encodeStateAsUpdate(this.#document);
    const objectKey = `exports/${workspaceId}/${exportId}/source.yjs`;
    await this.env.ASSETS.put(objectKey, update, {
      customMetadata: {
        roomSequence: String(status.roomSequence),
        workspaceId,
      },
      httpMetadata: { contentType: "application/octet-stream" },
    });
    return { objectKey, roomSequence: status.roomSequence };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.has("authorization") || request.headers.has("cookie")) {
      return new Response("Raw credentials are forbidden in workspace rooms", {
        status: 400,
      });
    }
    const token = request.headers.get("x-voidmesh-room-authorization");
    const authorization = token
      ? await verifyRoomAuthorization(this.env.BETTER_AUTH_SECRET, token)
      : null;
    if (!authorization) {
      return new Response("Invalid internal connection identity", {
        status: 400,
      });
    }
    return this.#openWebSocket(authorization);
  }

  async #openWebSocket(input: {
    name: string;
    role: WorkspaceRole;
    sessionId: string;
    userId: UserId;
    workspaceId: WorkspaceId;
  }): Promise<Response> {
    const status = await this.initialize(input.workspaceId);
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const attachment: ConnectionAttachment = {
      color: colorForUser(input.userId),
      connectionId: crypto.randomUUID(),
      name: input.name.slice(0, 64),
      presenceSequence: -1,
      role: input.role,
      sessionId: input.sessionId,
      userId: input.userId,
    };
    this.ctx.acceptWebSocket(server, [`user:${input.userId}`]);
    server.serializeAttachment(attachment);

    const hello: ServerHelloMessage = {
      connectionId: attachment.connectionId,
      peers: this.#peers(server),
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      role: input.role,
      roomSequence: status.roomSequence,
      serverTime: Date.now(),
      type: "hello",
      user: {
        color: attachment.color,
        name: attachment.name,
        userId: input.userId,
      },
    };
    server.send(JSON.stringify(hello));
    const snapshot = this.#readLocalSnapshot();
    if (snapshot) {
      server.send(
        encodeServerYjsUpdate(
          snapshot.room_sequence,
          snapshot.update_id,
          new Uint8Array(snapshot.update_bytes),
        ),
      );
    }
    for (const row of this.ctx.storage.sql.exec<{
      room_sequence: number;
      update_bytes: ArrayBuffer;
      update_id: string;
    }>("SELECT room_sequence, update_id, update_bytes FROM yjs_updates ORDER BY room_sequence")) {
      server.send(
        encodeServerYjsUpdate(row.room_sequence, row.update_id, new Uint8Array(row.update_bytes)),
      );
    }
    const syncComplete: ServerSyncCompleteMessage = {
      roomSequence: status.roomSequence,
      stateVector: bytesToBase64Url(Y.encodeStateVector(this.#document)),
      type: "sync-complete",
    };
    server.send(JSON.stringify(syncComplete));
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === server) continue;
      const peer = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (!peer || peer.presenceSequence < 0) continue;
      server.send(
        JSON.stringify({
          color: peer.color,
          connectionId: peer.connectionId,
          cursor: peer.cursor ?? null,
          name: peer.name,
          selectedEntityIds: peer.selectedEntityIds ?? [],
          sequence: peer.presenceSequence,
          type: "presence",
          userId: peer.userId,
        } satisfies ServerPresenceMessage),
      );
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) {
      socket.close(4002, "Missing connection identity");
      return;
    }
    if (typeof message === "string") {
      const clockPing = parseClientClockPingMessage(message);
      if (clockPing) {
        socket.send(
          JSON.stringify({
            ...clockPing,
            serverTime: Date.now(),
            type: "clock-pong",
          } satisfies ServerClockPongMessage),
        );
        return;
      }
      const presence = parseClientPresenceMessage(message);
      if (!presence || presence.sequence <= attachment.presenceSequence) return;
      const nextAttachment = {
        ...attachment,
        ...(presence.cursor !== undefined && { cursor: presence.cursor }),
        presenceSequence: presence.sequence,
        ...(presence.selectedEntityIds !== undefined && {
          selectedEntityIds: presence.selectedEntityIds,
        }),
      } satisfies ConnectionAttachment;
      socket.serializeAttachment(nextAttachment);
      const outgoing: ServerPresenceMessage = {
        ...presence,
        color: attachment.color,
        connectionId: attachment.connectionId,
        name: attachment.name,
        userId: attachment.userId,
      };
      this.#broadcastPresence(JSON.stringify(outgoing), socket);
      return;
    }

    if (attachment.role === "viewer") {
      socket.send(JSON.stringify({ type: "error", code: "read-only" }));
      return;
    }
    const rebase = decodeClientYjsRebase(message);
    const decoded = rebase ?? decodeClientYjsUpdate(message);
    if (!decoded) {
      socket.send(JSON.stringify({ type: "error", code: "invalid-update" }));
      return;
    }
    try {
      Y.decodeUpdate(decoded.update);
    } catch {
      socket.send(JSON.stringify({ type: "error", code: "invalid-yjs-update" }));
      return;
    }
    const current = this.ctx.storage.sql
      .exec<{
        room_sequence: number;
      }>("SELECT room_sequence FROM applied_update_ids WHERE update_id = ?", decoded.updateId)
      .toArray()[0];
    if (current) {
      const status = this.#readStatus()!;
      const referencedAssetIds = validateDocument(this.#document);
      if (referencedAssetIds) {
        await this.#reconcileAssetReferences(
          status.workspaceId,
          referencedAssetIds,
          attachment.userId,
          decoded.updateId,
        );
      }
      socket.send(
        JSON.stringify({
          roomSequence: current.room_sequence,
          type: "ack",
          updateId: decoded.updateId,
        } satisfies ServerAckMessage),
      );
      if (rebase) {
        socket.send(
          encodeServerYjsRebase(
            status.roomSequence,
            decoded.updateId,
            Y.encodeStateAsUpdate(this.#document),
          ),
        );
      }
      return;
    }
    if (rebase) {
      await this.#applyDocumentRebase(socket, attachment, rebase.updateId, rebase.update);
      return;
    }
    const candidate = new Y.Doc();
    let referencedAssetIds: Set<string> | null = null;
    try {
      Y.applyUpdate(candidate, Y.encodeStateAsUpdate(this.#document));
      Y.applyUpdate(candidate, decoded.update);
      if (hasPendingYjsData(candidate)) {
        candidate.destroy();
        socket.send(
          JSON.stringify({
            code: "missing-yjs-dependencies",
            type: "error",
            updateId: decoded.updateId,
          }),
        );
        return;
      }
      referencedAssetIds = validateDocument(candidate);
    } catch {
      referencedAssetIds = null;
    }
    if (!referencedAssetIds) {
      candidate.destroy();
      socket.send(JSON.stringify({ type: "error", code: "invalid-document" }));
      return;
    }
    const status = this.#readStatus()!;
    const workspaceId = status.workspaceId;
    const recoverableAssets = await this.env.DB.prepare(
      `SELECT id FROM assets
       WHERE workspace_id = ? AND lifecycle IN ('verified', 'active', 'unreferenced')`,
    )
      .bind(workspaceId)
      .all<{ id: string }>();
    const recoverableAssetIds = new Set(recoverableAssets.results.map(({ id }) => id));
    if ([...referencedAssetIds].some((assetId) => !recoverableAssetIds.has(assetId))) {
      candidate.destroy();
      socket.send(JSON.stringify({ type: "error", code: "unknown-asset" }));
      return;
    }
    const nextRoomSequence = status.roomSequence + 1;
    const playbackStamped = stampPlaybackAnchors(
      this.#document,
      candidate,
      nextRoomSequence,
      Date.now(),
    );
    const acceptedUpdate = playbackStamped
      ? Y.encodeStateAsUpdate(candidate, Y.encodeStateVector(this.#document))
      : decoded.update;
    candidate.destroy();
    if (acceptedUpdate.byteLength > MAX_YJS_UPDATE_BYTES) {
      socket.send(JSON.stringify({ type: "error", code: "invalid-document" }));
      return;
    }
    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{
          room_sequence: number;
        }>("SELECT room_sequence FROM applied_update_ids WHERE update_id = ?", decoded.updateId)
        .toArray()[0];
      if (existing) return { isNew: false, roomSequence: existing.room_sequence };
      const roomSequence = this.#readStatus()!.roomSequence + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO yjs_updates (
          room_sequence, update_id, actor_id, update_bytes, created_at
        ) VALUES (?, ?, ?, ?, ?)`,
        roomSequence,
        decoded.updateId,
        attachment.userId,
        acceptedUpdate.buffer as ArrayBuffer,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_update_ids (update_id, room_sequence, created_at)
         VALUES (?, ?, ?)`,
        decoded.updateId,
        roomSequence,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE room_metadata SET room_sequence = ? WHERE singleton = 1",
        roomSequence,
      );
      return { isNew: true, roomSequence };
    });
    let serverFrame: ArrayBuffer | null = null;
    if (result.isNew) {
      Y.applyUpdate(this.#document, acceptedUpdate);
      await this.#reconcileAssetReferences(
        workspaceId,
        referencedAssetIds,
        attachment.userId,
        decoded.updateId,
      );
      await this.env.DB.prepare(
        `UPDATE workspaces
         SET current_room_sequence = ?, updated_at = ?
         WHERE id = ? AND current_room_sequence < ?`,
      )
        .bind(result.roomSequence, Date.now(), workspaceId, result.roomSequence)
        .run();
      serverFrame = encodeServerYjsUpdate(result.roomSequence, decoded.updateId, acceptedUpdate);
    }
    const ack: ServerAckMessage = {
      roomSequence: result.roomSequence,
      type: "ack",
      updateId: decoded.updateId,
    };
    socket.send(JSON.stringify(ack));
    if (serverFrame) {
      this.#broadcast(serverFrame, socket);
      // A transformed playback anchor contains the room's authoritative time
      // and sequence, so the originating client must receive that correction too.
      if (playbackStamped) socket.send(serverFrame);
      if (result.roomSequence % this.#snapshotInterval() === 0) {
        await this.#checkpoint(result.roomSequence);
      }
    }
  }

  async #applyDocumentRebase(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    updateId: string,
    update: Uint8Array,
  ): Promise<void> {
    const status = this.#readStatus()!;
    const candidate = new Y.Doc();
    let referencedAssetIds: Set<string> | null = null;
    let rejectionReason = "schema-validation";
    try {
      Y.applyUpdate(candidate, update);
      if (hasPendingYjsData(candidate)) rejectionReason = "missing-yjs-dependencies";
      else {
        referencedAssetIds = validateDocument(candidate);
        if (!referencedAssetIds) {
          rejectionReason = documentValidationIssue(candidate) ?? rejectionReason;
        }
      }
    } catch {
      rejectionReason = "invalid-yjs-update";
      referencedAssetIds = null;
    }
    if (!referencedAssetIds) {
      const entityCount = candidate.getMap("entities").size;
      candidate.destroy();
      this.#logRejectedDocumentRebase(
        status,
        "invalid-document",
        rejectionReason,
        entityCount,
        update.byteLength,
      );
      socket.send(JSON.stringify({ type: "error", code: "invalid-document", updateId }));
      return;
    }

    const recoverableAssets = await this.env.DB.prepare(
      `SELECT id FROM assets
       WHERE workspace_id = ? AND lifecycle IN ('verified', 'active', 'unreferenced')`,
    )
      .bind(status.workspaceId)
      .all<{ id: string }>();
    const recoverableAssetIds = new Set(recoverableAssets.results.map(({ id }) => id));
    if ([...referencedAssetIds].some((assetId) => !recoverableAssetIds.has(assetId))) {
      const entityCount = candidate.getMap("entities").size;
      candidate.destroy();
      this.#logRejectedDocumentRebase(
        status,
        "unknown-asset",
        "unknown-asset-reference",
        entityCount,
        update.byteLength,
      );
      socket.send(JSON.stringify({ type: "error", code: "unknown-asset", updateId }));
      return;
    }

    const nextRoomSequence = status.roomSequence + 1;
    const empty = new Y.Doc();
    stampPlaybackAnchors(empty, candidate, nextRoomSequence, Date.now());
    empty.destroy();
    const acceptedUpdate = Y.encodeStateAsUpdate(candidate);
    if (acceptedUpdate.byteLength > MAX_YJS_UPDATE_BYTES) {
      const entityCount = candidate.getMap("entities").size;
      candidate.destroy();
      this.#logRejectedDocumentRebase(
        status,
        "invalid-document",
        "update-too-large",
        entityCount,
        acceptedUpdate.byteLength,
      );
      socket.send(JSON.stringify({ type: "error", code: "invalid-document", updateId }));
      return;
    }

    const result = this.ctx.storage.transactionSync(() => {
      const existing = this.ctx.storage.sql
        .exec<{ room_sequence: number }>(
          "SELECT room_sequence FROM applied_update_ids WHERE update_id = ?",
          updateId,
        )
        .toArray()[0];
      if (existing) return { isNew: false, roomSequence: existing.room_sequence };
      const roomSequence = this.#readStatus()!.roomSequence + 1;
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_update_ids (update_id, room_sequence, created_at)
         VALUES (?, ?, ?)`,
        updateId,
        roomSequence,
        now,
      );
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO room_snapshot (
          singleton, room_sequence, update_id, update_bytes, created_at
        ) VALUES (1, ?, ?, ?, ?)`,
        roomSequence,
        updateId,
        acceptedUpdate.buffer as ArrayBuffer,
        now,
      );
      this.ctx.storage.sql.exec("DELETE FROM yjs_updates");
      this.ctx.storage.sql.exec(
        "UPDATE room_metadata SET room_sequence = ? WHERE singleton = 1",
        roomSequence,
      );
      return { isNew: true, roomSequence };
    });

    let serverFrame: ArrayBuffer;
    if (result.isNew) {
      this.#document.destroy();
      this.#document = candidate;
      await this.#reconcileAssetReferences(
        status.workspaceId,
        referencedAssetIds,
        attachment.userId,
        updateId,
      );
      await this.env.DB.prepare(
        `UPDATE workspaces
         SET current_room_sequence = ?, updated_at = ?
         WHERE id = ? AND current_room_sequence < ?`,
      )
        .bind(result.roomSequence, Date.now(), status.workspaceId, result.roomSequence)
        .run();
      await this.#checkpoint(result.roomSequence);
      serverFrame = encodeServerYjsRebase(result.roomSequence, updateId, acceptedUpdate);
    } else {
      candidate.destroy();
      const currentStatus = this.#readStatus()!;
      serverFrame = encodeServerYjsRebase(
        currentStatus.roomSequence,
        updateId,
        Y.encodeStateAsUpdate(this.#document),
      );
    }

    socket.send(
      JSON.stringify({
        roomSequence: result.roomSequence,
        type: "ack",
        updateId,
      } satisfies ServerAckMessage),
    );
    socket.send(serverFrame);
    if (result.isNew) this.#broadcast(serverFrame, socket);
  }

  #logRejectedDocumentRebase(
    status: WorkspaceRoomStatus,
    code: "invalid-document" | "unknown-asset",
    reason: string,
    entityCount: number,
    updateBytes: number,
  ): void {
    console.warn(
      JSON.stringify({
        code,
        entityCount,
        event: "workspace-room-document-rebase-rejected",
        reason,
        roomSequence: status.roomSequence,
        updateBytes,
        workspaceId: status.workspaceId,
      }),
    );
  }

  override webSocketClose(socket: WebSocket): void {
    this.#announceDeparture(socket);
  }

  override webSocketError(socket: WebSocket): void {
    this.#announceDeparture(socket);
  }

  revokeUser(userId: UserId): number {
    let revoked = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.userId !== userId) continue;
      socket.close(4003, "Workspace access revoked");
      revoked += 1;
    }
    return revoked;
  }

  revokeSession(userId: UserId, sessionId: string): number {
    let revoked = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (
        attachment?.userId !== userId ||
        (attachment.sessionId !== undefined && attachment.sessionId !== sessionId)
      )
        continue;
      socket.close(4003, "Account session revoked");
      revoked += 1;
    }
    return revoked;
  }

  revokeAll(): number {
    const sockets = this.ctx.getWebSockets();
    for (const socket of sockets) socket.close(4004, "Workspace unavailable");
    return sockets.length;
  }

  purge(): void {
    this.revokeAll();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM yjs_updates");
      this.ctx.storage.sql.exec("DELETE FROM applied_update_ids");
      this.ctx.storage.sql.exec("DELETE FROM room_snapshot");
      this.ctx.storage.sql.exec("DELETE FROM room_metadata");
    });
    this.#document.destroy();
  }

  setUserRole(userId: UserId, role: WorkspaceRole): number {
    let updated = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.userId !== userId) continue;
      socket.serializeAttachment({
        ...attachment,
        role,
      } satisfies ConnectionAttachment);
      const message: ServerRoleChangedMessage = { role, type: "role-changed" };
      socket.send(JSON.stringify(message));
      updated += 1;
    }
    return updated;
  }

  async #reconcileAssetReferences(
    workspaceId: WorkspaceId,
    referencedAssetIds: ReadonlySet<string>,
    actorUserId: UserId,
    updateId: string,
  ): Promise<void> {
    const referencesJson = JSON.stringify([...referencedAssetIds]);
    const changedAt = Date.now();
    const unreferencedChangeId = crypto.randomUUID();
    const restoredChangeId = crypto.randomUUID();
    const activatedChangeId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE assets
         SET lifecycle = 'unreferenced', unreferenced_at = ?, updated_at = ?,
             reference_change_id = ?
         WHERE workspace_id = ? AND lifecycle IN ('active', 'verified')
           AND id NOT IN (SELECT value FROM json_each(?))`,
      ).bind(changedAt, changedAt, unreferencedChangeId, workspaceId, referencesJson),
      this.env.DB.prepare(
        `UPDATE assets
         SET lifecycle = 'active', unreferenced_at = NULL, updated_at = ?,
             reference_change_id = ?
         WHERE workspace_id = ? AND lifecycle = 'unreferenced'
           AND id IN (SELECT value FROM json_each(?))`,
      ).bind(changedAt, restoredChangeId, workspaceId, referencesJson),
      this.env.DB.prepare(
        `UPDATE assets
         SET lifecycle = 'active', unreferenced_at = NULL, updated_at = ?,
             reference_change_id = ?
         WHERE workspace_id = ? AND lifecycle = 'verified'
           AND id IN (SELECT value FROM json_each(?))`,
      ).bind(changedAt, activatedChangeId, workspaceId, referencesJson),
      assetReferenceAuditStatement(
        this.env.DB,
        workspaceId,
        actorUserId,
        updateId,
        unreferencedChangeId,
        "unreferenced",
        changedAt,
      ),
      assetReferenceAuditStatement(
        this.env.DB,
        workspaceId,
        actorUserId,
        updateId,
        restoredChangeId,
        "active",
        changedAt,
      ),
      assetActivationAuditStatement(
        this.env.DB,
        workspaceId,
        actorUserId,
        updateId,
        activatedChangeId,
        changedAt,
      ),
    ]);
  }

  #readStatus(): WorkspaceRoomStatus | null {
    const row = this.ctx.storage.sql
      .exec<{
        room_sequence: number;
        workspace_id: string;
      }>("SELECT workspace_id, room_sequence FROM room_metadata WHERE singleton = 1")
      .toArray()[0];
    return row ? { roomSequence: row.room_sequence, workspaceId: row.workspace_id } : null;
  }

  #peers(exclude: WebSocket): CollaborationPeer[] {
    const peers: CollaborationPeer[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (!attachment) continue;
      peers.push({
        color: attachment.color,
        connectionId: attachment.connectionId,
        name: attachment.name,
        role: attachment.role,
        userId: attachment.userId,
      });
    }
    return peers;
  }

  #broadcast(message: string | ArrayBuffer, exclude?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      try {
        socket.send(message);
      } catch {
        // Hibernated/closing sockets are cleaned up by the runtime lifecycle callbacks.
      }
    }
  }

  #broadcastPresence(message: string, exclude: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const bufferedAmount = (socket as unknown as { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (bufferedAmount > MAX_PRESENCE_BACKPRESSURE_BYTES) continue;
      try {
        socket.send(message);
      } catch {
        // Presence is ephemeral; a later snapshot supersedes a dropped message.
      }
    }
  }

  #announceDeparture(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) return;
    const message: ServerPeerLeftMessage = {
      connectionId: attachment.connectionId,
      type: "peer-left",
      userId: attachment.userId,
    };
    this.#broadcast(JSON.stringify(message), socket);
  }

  #migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    const version = this.ctx.storage.sql
      .exec<{
        version: number;
      }>("SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations")
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_metadata (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          workspace_id TEXT NOT NULL UNIQUE,
          room_sequence INTEGER NOT NULL DEFAULT 0 CHECK (room_sequence >= 0)
        );
        CREATE TABLE yjs_updates (
          room_sequence INTEGER PRIMARY KEY CHECK (room_sequence > 0),
          update_id TEXT NOT NULL UNIQUE,
          actor_id TEXT NOT NULL,
          update_bytes BLOB NOT NULL,
          created_at INTEGER NOT NULL
        );
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }
    if (version < 2) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE room_snapshot (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          room_sequence INTEGER NOT NULL CHECK (room_sequence > 0),
          update_id TEXT NOT NULL UNIQUE,
          update_bytes BLOB NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE applied_update_ids (
          update_id TEXT PRIMARY KEY,
          room_sequence INTEGER NOT NULL CHECK (room_sequence > 0),
          created_at INTEGER NOT NULL
        );
        INSERT INTO applied_update_ids (update_id, room_sequence, created_at)
        SELECT update_id, room_sequence, created_at FROM yjs_updates;
        INSERT INTO _sql_schema_migrations (id) VALUES (2);
      `);
    }
  }

  async #restoreDocument(): Promise<void> {
    const snapshot = this.#readLocalSnapshot();
    if (snapshot) Y.applyUpdate(this.#document, new Uint8Array(snapshot.update_bytes));
    for (const row of this.ctx.storage.sql.exec<{ update_bytes: ArrayBuffer }>(
      "SELECT update_bytes FROM yjs_updates ORDER BY room_sequence",
    )) {
      Y.applyUpdate(this.#document, new Uint8Array(row.update_bytes));
    }
    const repaired = hasPendingYjsData(this.#document);
    if (repaired) {
      const corrupted = this.#document;
      this.#document = createRebasedDocument(corrupted);
      corrupted.destroy();
    }
    if (!validateDocument(this.#document)) {
      throw new Error("Workspace room document is invalid");
    }
    if (!repaired) return;

    const status = this.#readStatus();
    if (!status || status.roomSequence === 0) return;
    console.warn(
      JSON.stringify({
        entityCount: this.#document.getMap("entities").size,
        event: "workspace-room-history-repaired",
        recoverySource: "durable-object-storage",
        roomSequence: status.roomSequence,
        workspaceId: status.workspaceId,
      }),
    );
    await this.#checkpoint(status.roomSequence, true);
  }

  #readLocalSnapshot(): LocalSnapshotRow | null {
    return (
      this.ctx.storage.sql
        .exec<LocalSnapshotRow>(
          "SELECT room_sequence, update_id, update_bytes FROM room_snapshot WHERE singleton = 1",
        )
        .toArray()[0] ?? null
    );
  }

  async #checkpoint(roomSequence: number, replaceExisting = false): Promise<void> {
    const workspaceId = this.#readStatus()!.workspaceId;
    const update = Y.encodeStateAsUpdate(this.#document);
    const updateId = crypto.randomUUID();
    const checksum = await sha256Hex(update);
    const objectKey = `snapshots/${workspaceId}/${roomSequence}/${updateId}`;
    const now = Date.now();
    await this.env.ASSETS.put(objectKey, update, {
      httpMetadata: { contentType: "application/octet-stream" },
    });
    const replacedObject = replaceExisting
      ? await this.env.DB.prepare(
          `SELECT object_key FROM workspace_snapshots
           WHERE workspace_id = ? AND room_sequence = ?`,
        )
          .bind(workspaceId, roomSequence)
          .first<{ object_key: string }>()
      : null;
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO workspace_snapshots (
            workspace_id, room_sequence, object_key, checksum, byte_length, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ${
            replaceExisting
              ? `ON CONFLICT (workspace_id, room_sequence) DO UPDATE SET
                   object_key = excluded.object_key,
                   checksum = excluded.checksum,
                   byte_length = excluded.byte_length,
                   created_at = excluded.created_at`
              : ""
          }`,
        ).bind(workspaceId, roomSequence, objectKey, checksum, update.byteLength, now),
        this.env.DB.prepare(
          `UPDATE workspaces SET snapshot_sequence = ?
           WHERE id = ? AND snapshot_sequence < ?`,
        ).bind(roomSequence, workspaceId, roomSequence),
      ]);
    } catch (error) {
      await this.env.ASSETS.delete(objectKey);
      throw error;
    }
    if (replacedObject && replacedObject.object_key !== objectKey) {
      await this.env.ASSETS.delete(replacedObject.object_key);
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO room_snapshot (
          singleton, room_sequence, update_id, update_bytes, created_at
        ) VALUES (1, ?, ?, ?, ?)`,
        roomSequence,
        updateId,
        update.buffer as ArrayBuffer,
        now,
      );
      this.ctx.storage.sql.exec("DELETE FROM yjs_updates WHERE room_sequence <= ?", roomSequence);
    });
  }

  async #recoverRemoteSnapshot(workspaceId: WorkspaceId): Promise<WorkspaceRoomStatus | null> {
    const snapshot = await this.env.DB.prepare(
      `SELECT room_sequence, object_key, checksum
       FROM workspace_snapshots
       WHERE workspace_id = ?
       ORDER BY room_sequence DESC
       LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ checksum: string; object_key: string; room_sequence: number }>();
    if (!snapshot) return null;
    const object = await this.env.ASSETS.get(snapshot.object_key);
    if (!object) throw new Error("Workspace recovery snapshot object is missing");
    const update = new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(update)) !== snapshot.checksum) {
      throw new Error("Workspace recovery snapshot checksum mismatch");
    }
    const updateId = crypto.randomUUID();
    const now = Date.now();
    Y.applyUpdate(this.#document, update);
    let recoveredUpdate: Uint8Array<ArrayBufferLike> = update;
    const repaired = hasPendingYjsData(this.#document);
    if (repaired) {
      const corrupted = this.#document;
      this.#document = createRebasedDocument(corrupted);
      corrupted.destroy();
      recoveredUpdate = Y.encodeStateAsUpdate(this.#document);
    }
    if (!validateDocument(this.#document)) {
      throw new Error("Workspace recovery snapshot document is invalid");
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO room_metadata (singleton, workspace_id, room_sequence) VALUES (1, ?, ?)",
        workspaceId,
        snapshot.room_sequence,
      );
      if (snapshot.room_sequence > 0) {
        this.ctx.storage.sql.exec(
          `INSERT INTO room_snapshot (
            singleton, room_sequence, update_id, update_bytes, created_at
          ) VALUES (1, ?, ?, ?, ?)`,
          snapshot.room_sequence,
          updateId,
          recoveredUpdate.buffer as ArrayBuffer,
          now,
        );
      }
    });
    if (repaired) {
      console.warn(
        JSON.stringify({
          entityCount: this.#document.getMap("entities").size,
          event: "workspace-room-history-repaired",
          recoverySource: "remote-snapshot",
          roomSequence: snapshot.room_sequence,
          workspaceId,
        }),
      );
      await this.#checkpoint(snapshot.room_sequence, true);
    }
    return { roomSequence: snapshot.room_sequence, workspaceId };
  }

  #snapshotInterval(): number {
    const value = Number((this.env as unknown as Record<string, unknown>).ROOM_SNAPSHOT_INTERVAL);
    return Number.isSafeInteger(value) && value > 0 ? value : 100;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hasPendingYjsData(document: Y.Doc): boolean {
  return document.store.pendingStructs !== null || document.store.pendingDs !== null;
}

function createRebasedDocument(source: Y.Doc): Y.Doc {
  const replacement = new Y.Doc();
  const knownClientIds = Y.decodeStateVector(Y.encodeStateVector(source));
  let replacementClientId = 0xffff_ffff;
  while (knownClientIds.has(replacementClientId)) replacementClientId--;
  replacement.clientID = replacementClientId;
  const sourceEntities = source.getMap<Y.Map<unknown>>("entities");
  const entities = replacement.getMap<Y.Map<unknown>>("entities");
  replacement.transact(() => {
    for (const [entityId, entity] of sourceEntities) {
      const next = new Y.Map<unknown>();
      for (const [key, value] of entity) next.set(key, structuredClone(value));
      entities.set(entityId, next);
    }
    replacement.getMap<string>("recovery").set("generation", crypto.randomUUID());
  });
  return replacement;
}

function validateDocument(document: Y.Doc): Set<string> | null {
  if (documentValidationIssue(document)) return null;
  const assetIds = new Set<string>();
  for (const entity of document.getMap<Y.Map<unknown>>("entities").values()) {
    const asset = entity.get("asset") as Record<string, unknown>;
    assetIds.add(asset.id as string);
  }
  return assetIds;
}

function documentValidationIssue(document: Y.Doc): string | null {
  if (Y.encodeStateAsUpdate(document).byteLength > MAX_DOCUMENT_BYTES) return "document-too-large";
  const entities = document.getMap<Y.Map<unknown>>("entities");
  if (entities.size > MAX_DOCUMENT_ENTITIES) return "too-many-entities";
  for (const [entityId, entity] of entities) {
    if (!isIdentifier(entityId)) return "entity-id";
    if (!(entity instanceof Y.Map)) return "entity-map";
    if (entity.size > MAX_ENTITY_FIELDS) return "too-many-entity-fields";
    const asset = entity.get("asset");
    const invalidField = invalidEntityField(entity);
    if (invalidField) return invalidField;
    if (!isRecord(asset)) return "asset";
    if (!isIdentifierValue(asset.id)) return "asset.id";
    for (const [key, value] of entity) {
      if (key.length === 0 || key.length > 256) return "entity-field-key";
      if (!isBoundedSharedValue(value)) return `shared-value:${key}`;
    }
  }
  return null;
}

function stampPlaybackAnchors(
  current: Y.Doc,
  candidate: Y.Doc,
  roomSequence: number,
  serverTime: number,
): boolean {
  const currentEntities = current.getMap<Y.Map<unknown>>("entities");
  const candidateEntities = candidate.getMap<Y.Map<unknown>>("entities");
  let stamped = false;
  candidate.transact(() => {
    for (const [entityId, entity] of candidateEntities) {
      if (!(entity instanceof Y.Map)) continue;
      const currentEntity = currentEntities.get(entityId);
      for (const key of ["playback", "appearance.shaderPlayback"] as const) {
        const anchor = entity.get(key);
        if (!isRecord(anchor) || sameSharedValue(anchor, currentEntity?.get(key))) continue;
        entity.set(key, {
          ...anchor,
          sequence: roomSequence,
          updatedAt: serverTime,
        });
        stamped = true;
      }
    }
  });
  return stamped;
}

function invalidEntityField(entity: Y.Map<unknown>): string | null {
  const playback = entity.get("playback");
  const shaderPlayback = entity.get("appearance.shaderPlayback");
  const checks: readonly [string, boolean][] = [
    ["identity.name", isBoundedString(entity.get("identity.name"), 1_024)],
    ["identity.locked", typeof entity.get("identity.locked") === "boolean"],
    ["identity.edited", typeof entity.get("identity.edited") === "boolean"],
    ["geometry.position.x", isCoordinate(entity.get("geometry.position.x"))],
    ["geometry.position.y", isCoordinate(entity.get("geometry.position.y"))],
    ["geometry.size.width", isDimension(entity.get("geometry.size.width"))],
    ["geometry.size.height", isDimension(entity.get("geometry.size.height"))],
    ["geometry.originalSize.width", isDimension(entity.get("geometry.originalSize.width"))],
    ["geometry.originalSize.height", isDimension(entity.get("geometry.originalSize.height"))],
    ["geometry.rotation", isCoordinate(entity.get("geometry.rotation"))],
    ["geometry.zIndex", isCoordinate(entity.get("geometry.zIndex"))],
    ["appearance.shaderType", isBoundedString(entity.get("appearance.shaderType"), 128)],
    ["appearance.params.size", isDimension(entity.get("appearance.params.size"))],
    ["appearance.params.shape", isBoundedString(entity.get("appearance.params.shape"), 128)],
    ["appearance.params.color", isColor(entity.get("appearance.params.color"))],
    ["appearance.params.background", isColor(entity.get("appearance.params.background"))],
    [
      "appearance.params.preserveColors",
      typeof entity.get("appearance.params.preserveColors") === "boolean",
    ],
    [
      "appearance.params.reversePalette",
      typeof entity.get("appearance.params.reversePalette") === "boolean",
    ],
    [
      "appearance.params.showOriginal",
      typeof entity.get("appearance.params.showOriginal") === "boolean",
    ],
    ["appearance.params.scale", isDimension(entity.get("appearance.params.scale"))],
    ["appearance.params.intensity", isCoordinate(entity.get("appearance.params.intensity"))],
    ["asset", isValidAssetReference(entity.get("asset"))],
    ["playback", playback === undefined || isValidPlaybackAnchor(playback)],
    [
      "appearance.shaderPlayback",
      shaderPlayback === undefined || isValidShaderPlaybackAnchor(shaderPlayback),
    ],
  ];
  return checks.find(([, valid]) => !valid)?.[0] ?? null;
}

function isValidPlaybackAnchor(value: unknown): boolean {
  if (!isRecord(value) || !isIdentifierValue(value.commandId)) return false;
  if (!isCoordinate(value.duration) || Number(value.duration) < 0) return false;
  if (!isTimestamp(value.updatedAt)) return false;
  if (value.sequence !== undefined && !isNonnegativeSafeInteger(value.sequence)) return false;
  const state = value.state;
  return (
    isRecord(state) &&
    typeof state.isPlaying === "boolean" &&
    isCoordinate(state.currentTime) &&
    Number(state.currentTime) >= 0 &&
    typeof state.loop === "boolean" &&
    isDimension(state.playbackRate) &&
    typeof state.muted === "boolean" &&
    isCoordinate(state.volume) &&
    Number(state.volume) >= 0 &&
    Number(state.volume) <= 1
  );
}

function isValidShaderPlaybackAnchor(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifierValue(value.commandId) &&
    typeof value.isPlaying === "boolean" &&
    isCoordinate(value.time) &&
    isTimestamp(value.updatedAt) &&
    (value.sequence === undefined || isNonnegativeSafeInteger(value.sequence))
  );
}

function isValidAssetReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    isIdentifierValue(value.id) &&
    Number.isSafeInteger(value.byteLength) &&
    Number(value.byteLength) >= 0 &&
    isBoundedString(value.contentType, 200) &&
    isBoundedString(value.mediaType, 32) &&
    isBoundedString(value.originalFilename, 1_024)
  );
}

function isCoordinate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e8;
}

function isDimension(value: unknown): value is number {
  return isCoordinate(value) && value > 0;
}

function isColor(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    (value.length === 3 || value.length === 4) &&
    value.every((channel) => typeof channel === "number" && Number.isFinite(channel))
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isIdentifierValue(value: unknown): value is string {
  return typeof value === "string" && isIdentifier(value);
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e15;
}

function sameSharedValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => sameSharedValue(entry, right[index]))
    );
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => sameSharedValue(left[key], right[key]))
  );
}

function isBoundedSharedValue(value: unknown, depth = 0): boolean {
  if (depth > MAX_SHARED_VALUE_DEPTH) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value) && Math.abs(value) <= 1e15;
  if (typeof value === "string") return value.length <= 4_096;
  if (Array.isArray(value)) {
    return value.length <= 128 && value.every((entry) => isBoundedSharedValue(entry, depth + 1));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= 256 &&
    entries.every(
      ([key, entry]) =>
        key.length > 0 && key.length <= 256 && isBoundedSharedValue(entry, depth + 1),
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function assetReferenceAuditStatement(
  db: D1Database,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  updateId: string,
  changeId: string,
  lifecycle: "active" | "unreferenced",
  changedAt: number,
): D1PreparedStatement {
  const action = lifecycle === "active" ? "asset.restored" : "asset.unreferenced";
  return db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, workspace_id, action, target_type,
        target_id, outcome, request_id, metadata_json, created_at
      )
      SELECT lower(hex(randomblob(16))), ?, workspaces.owner_account_id,
        assets.workspace_id, ?, 'asset', assets.id, 'success', ?, '{}', ?
      FROM assets
      INNER JOIN workspaces ON workspaces.id = assets.workspace_id
      WHERE assets.workspace_id = ? AND assets.reference_change_id = ?
        AND assets.lifecycle = ?`,
    )
    .bind(actorUserId, action, updateId, changedAt, workspaceId, changeId, lifecycle);
}

function assetActivationAuditStatement(
  db: D1Database,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  updateId: string,
  changeId: string,
  changedAt: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO audit_events (
        id, actor_user_id, account_id, workspace_id, action, target_type,
        target_id, outcome, request_id, metadata_json, created_at
      )
      SELECT lower(hex(randomblob(16))), ?, workspaces.owner_account_id,
        assets.workspace_id, 'asset.activated', 'asset', assets.id,
        'success', ?, '{}', ?
      FROM assets
      INNER JOIN workspaces ON workspaces.id = assets.workspace_id
      WHERE assets.workspace_id = ? AND assets.reference_change_id = ?
        AND assets.lifecycle = 'active'`,
    )
    .bind(actorUserId, updateId, changedAt, workspaceId, changeId);
}

function colorForUser(userId: UserId): string {
  let hash = 0x811c9dc5;
  for (const character of userId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `hsl(${(hash >>> 0) % 360} 72% 58%)`;
}
