import { DurableObject } from "cloudflare:workers";
import { isIdentifier } from "@voidmesh/api-contract";
import {
  COLLABORATION_PROTOCOL_VERSION,
  MAX_SCENE_ENTITIES,
  type CollaborationPeer,
  type ExpectedEntityRevisions,
  type HostedEntityPatch,
  type HostedEntityRevisionGroup,
  type HostedPlaybackAnchor,
  type HostedPlaybackCommand,
  type HostedSceneChange,
  type HostedSceneCommand,
  type HostedSceneEntity,
  type PresencePoint,
  type ServerAckMessage,
  type ServerClockPongMessage,
  type ServerConflictMessage,
  type ServerHelloMessage,
  type ServerPeerLeftMessage,
  type ServerPlaybackMessage,
  type ServerPresenceMessage,
  type ServerRoleChangedMessage,
  type ServerScenePatchMessage,
  type ServerSceneSnapshotMessage,
  initialEntityRevisions,
  isPlaybackAnchor,
  isSceneEntity,
  isTimeDependentShader,
  parseClientClockPingMessage,
  parseClientDurableMessage,
  parseClientPresenceMessage,
} from "@voidmesh/collaboration";
import type { UserId, WorkspaceId, WorkspaceRole } from "@voidmesh/domain";
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

interface StoredSceneSnapshot {
  entities: HostedSceneEntity[];
  playback: HostedPlaybackAnchor[];
  roomSequence: number;
  schemaVersion: 1;
  workspaceId: WorkspaceId;
}

interface EntityRow {
  [key: string]: SqlStorageValue;
  entity_json: string;
}

interface PlaybackRow {
  [key: string]: SqlStorageValue;
  anchor_json: string;
}

interface AcceptedOperation {
  changes: HostedSceneChange[];
  roomSequence: number;
}

interface RejectedOperation {
  conflict: ServerConflictMessage;
}

const MAX_PRESENCE_BACKPRESSURE_BYTES = 64 * 1024;
const MAX_OPERATION_HISTORY = 2_000;
const CHECKPOINT_DELAY_MS = 5_000;

export class WorkspaceRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.#migrate());
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

    const bytes = encodeSnapshot(this.#snapshot(status));
    const checksum = await sha256Hex(bytes);
    const objectKey = `snapshots/${workspaceId}/0/${crypto.randomUUID()}.json`;
    await this.env.ASSETS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/json" },
    });
    try {
      await this.env.DB.prepare(
        `INSERT INTO workspace_snapshots (
          workspace_id, room_sequence, object_key, checksum, byte_length, created_at
        ) VALUES (?, 0, ?, ?, ?, ?)`,
      )
        .bind(workspaceId, objectKey, checksum, bytes.byteLength, Date.now())
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
    const objectKey = `exports/${workspaceId}/${exportId}/source.json`;
    await this.env.ASSETS.put(objectKey, encodeSnapshot(this.#snapshot(status)), {
      customMetadata: {
        roomSequence: String(status.roomSequence),
        workspaceId,
      },
      httpMetadata: { contentType: "application/json" },
    });
    return { objectKey, roomSequence: status.roomSequence };
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.has("authorization") || request.headers.has("cookie")) {
      return new Response("Raw credentials are forbidden in workspace rooms", { status: 400 });
    }
    const token = request.headers.get("x-voidmesh-room-authorization");
    const authorization = token
      ? await verifyRoomAuthorization(this.env.BETTER_AUTH_SECRET, token)
      : null;
    if (!authorization) {
      return new Response("Invalid internal connection identity", { status: 400 });
    }
    return this.#openWebSocket(authorization);
  }

  override async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) {
      socket.close(4002, "Missing connection identity");
      return;
    }
    if (typeof message !== "string") {
      socket.send(JSON.stringify({ code: "binary-message-unsupported", type: "error" }));
      return;
    }

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
    if (presence) {
      this.#applyPresence(socket, attachment, presence);
      return;
    }

    const durable = parseClientDurableMessage(message);
    if (!durable) {
      socket.send(JSON.stringify({ code: "invalid-command", type: "error" }));
      return;
    }
    if (attachment.role === "viewer") {
      socket.send(
        JSON.stringify({
          code: "read-only",
          operationId: operationIdOf(durable),
          type: "error",
        }),
      );
      return;
    }

    if (durable.type === "scene-command") {
      await this.#handleSceneCommand(socket, attachment, durable.command);
    } else {
      this.#handlePlaybackCommand(socket, attachment, durable.command);
    }
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
      ) {
        continue;
      }
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
      this.ctx.storage.sql.exec("DELETE FROM playback_anchors");
      this.ctx.storage.sql.exec("DELETE FROM scene_operations");
      this.ctx.storage.sql.exec("DELETE FROM applied_operations");
      this.ctx.storage.sql.exec("DELETE FROM scene_entities");
      this.ctx.storage.sql.exec("DELETE FROM room_metadata");
    });
  }

  override async alarm(): Promise<void> {
    const status = this.#readStatus();
    if (!status) return;
    await this.#writeRecoveryCheckpoint(status);
  }

  setUserRole(userId: UserId, role: WorkspaceRole): number {
    let updated = 0;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (attachment?.userId !== userId) continue;
      socket.serializeAttachment({ ...attachment, role } satisfies ConnectionAttachment);
      socket.send(
        JSON.stringify({ role, type: "role-changed" } satisfies ServerRoleChangedMessage),
      );
      updated += 1;
    }
    return updated;
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
    server.send(
      JSON.stringify({
        connectionId: attachment.connectionId,
        peers: this.#peers(server),
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        role: input.role,
        roomSequence: status.roomSequence,
        serverTime: Date.now(),
        type: "hello",
        user: { color: attachment.color, name: attachment.name, userId: input.userId },
      } satisfies ServerHelloMessage),
    );
    const snapshot = this.#snapshot(status);
    server.send(
      JSON.stringify({
        entities: snapshot.entities,
        playback: snapshot.playback,
        roomSequence: snapshot.roomSequence,
        type: "scene-snapshot",
      } satisfies ServerSceneSnapshotMessage),
    );
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === server) continue;
      const peer = socket.deserializeAttachment() as ConnectionAttachment | null;
      if (!peer || peer.presenceSequence < 0) continue;
      server.send(JSON.stringify(toPresenceMessage(peer)));
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  #applyPresence(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    presence: ReturnType<typeof parseClientPresenceMessage> & {},
  ): void {
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
    this.#broadcastPresence(
      JSON.stringify({
        ...presence,
        color: attachment.color,
        connectionId: attachment.connectionId,
        name: attachment.name,
        userId: attachment.userId,
      } satisfies ServerPresenceMessage),
      socket,
    );
  }

  async #handleSceneCommand(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    command: HostedSceneCommand,
  ): Promise<void> {
    const duplicate = this.#readAppliedOperation(command.operationId);
    if (duplicate !== null) {
      socket.send(
        JSON.stringify({
          operationId: command.operationId,
          roomSequence: duplicate,
          type: "ack",
        } satisfies ServerAckMessage),
      );
      return;
    }
    if (!(await this.#validateCommandAssets(command))) {
      socket.send(
        JSON.stringify({
          code: "unknown-asset",
          operationId: command.operationId,
          type: "error",
        }),
      );
      return;
    }

    const result = this.ctx.storage.transactionSync<AcceptedOperation | RejectedOperation>(() => {
      const repeated = this.#readAppliedOperation(command.operationId);
      if (repeated !== null) return { changes: [], roomSequence: repeated };
      const status = this.#readStatus();
      if (!status) throw new Error("Workspace room is not initialized");
      const applied = this.#applySceneCommand(command, status.roomSequence);
      if ("conflict" in applied) return applied;
      const roomSequence = status.roomSequence + 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO scene_operations (
          room_sequence, operation_id, actor_id, kind, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        roomSequence,
        command.operationId,
        attachment.userId,
        command.kind,
        JSON.stringify(applied.changes),
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, room_sequence, created_at)
         VALUES (?, ?, ?)`,
        command.operationId,
        roomSequence,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE room_metadata SET room_sequence = ? WHERE singleton = 1",
        roomSequence,
      );
      this.#pruneOperationHistory(roomSequence);
      return { changes: applied.changes, roomSequence };
    });

    if ("conflict" in result) {
      socket.send(JSON.stringify(result.conflict));
      return;
    }
    const patch: ServerScenePatchMessage = {
      changes: result.changes,
      operationId: command.operationId,
      roomSequence: result.roomSequence,
      type: "scene-patch",
    };
    this.#broadcast(JSON.stringify(patch));
    socket.send(
      JSON.stringify({
        operationId: command.operationId,
        roomSequence: result.roomSequence,
        type: "ack",
      } satisfies ServerAckMessage),
    );
    const status = this.#readStatus();
    if (status) {
      const assetIds = this.#currentAssetIds();
      this.ctx.waitUntil(
        Promise.all([
          this.#reconcileAssetReferences(
            status.workspaceId,
            assetIds,
            attachment.userId,
            command.operationId,
          ),
          this.#updateWorkspaceSequence(status.workspaceId, result.roomSequence),
          this.#scheduleCheckpoint(),
        ]).then(() => undefined),
      );
    }
  }

  #applySceneCommand(
    command: HostedSceneCommand,
    roomSequence: number,
  ): { changes: HostedSceneChange[] } | RejectedOperation {
    switch (command.kind) {
      case "entity.create": {
        const current = this.#readEntity(command.entity.id);
        if (current)
          return this.#conflict(command.operationId, "entity-exists", roomSequence, current);
        const entity: HostedSceneEntity = {
          ...structuredClone(command.entity),
          revisions: initialEntityRevisions(),
        };
        this.#writeEntity(entity);
        return { changes: [{ entity, type: "entity.created" }] };
      }
      case "entity.patch": {
        const current = this.#readEntity(command.entityId);
        if (!current) return this.#conflict(command.operationId, "entity-missing", roomSequence);
        if (current.generation !== command.generation) {
          return this.#conflict(command.operationId, "generation", roomSequence, current);
        }
        if (!revisionsMatch(current, command.expected, command.patch)) {
          return this.#conflict(command.operationId, "revision", roomSequence, current);
        }
        const next = applyEntityPatch(current, command.patch);
        this.#writeEntity(next);
        if (command.patch.asset || command.patch.appearance) {
          this.ctx.storage.sql.exec("DELETE FROM playback_anchors WHERE entity_id = ?", next.id);
        }
        return {
          changes: [
            {
              entityId: next.id,
              generation: next.generation,
              patch: structuredClone(command.patch),
              revisions: next.revisions,
              type: "entity.patched",
            },
          ],
        };
      }
      case "entities.remove": {
        const current = command.entities.map(({ id }) => this.#readEntity(id));
        for (let index = 0; index < command.entities.length; index++) {
          const requested = command.entities[index]!;
          const entity = current[index];
          if (!entity) return this.#conflict(command.operationId, "entity-missing", roomSequence);
          if (entity.generation !== requested.generation) {
            return this.#conflict(command.operationId, "generation", roomSequence, entity);
          }
        }
        const changes: HostedSceneChange[] = [];
        for (const entity of current) {
          if (!entity) continue;
          this.ctx.storage.sql.exec("DELETE FROM playback_anchors WHERE entity_id = ?", entity.id);
          this.ctx.storage.sql.exec("DELETE FROM scene_entities WHERE id = ?", entity.id);
          changes.push({
            entityId: entity.id,
            generation: entity.generation,
            type: "entity.removed",
          });
        }
        return { changes };
      }
      case "scene.replace": {
        this.ctx.storage.sql.exec("DELETE FROM playback_anchors");
        this.ctx.storage.sql.exec("DELETE FROM scene_entities");
        const entities = command.entities.map((input) => ({
          ...structuredClone(input),
          revisions: initialEntityRevisions(),
        }));
        for (const entity of entities) this.#writeEntity(entity);
        return { changes: [{ entities, type: "scene.replaced" }] };
      }
    }
  }

  #handlePlaybackCommand(
    socket: WebSocket,
    attachment: ConnectionAttachment,
    command: HostedPlaybackCommand,
  ): void {
    const duplicate = this.#readAppliedOperation(command.commandId);
    if (duplicate !== null) {
      socket.send(
        JSON.stringify({
          operationId: command.commandId,
          roomSequence: duplicate,
          type: "ack",
        } satisfies ServerAckMessage),
      );
      return;
    }
    const entity = this.#readEntity(command.entityId);
    if (!entity || !playbackMatchesEntity(command, entity)) {
      socket.send(
        JSON.stringify({
          code: "stale-playback-command",
          operationId: command.commandId,
          type: "error",
        }),
      );
      return;
    }
    const status = this.#readStatus();
    if (!status) throw new Error("Workspace room is not initialized");
    const roomSequence = status.roomSequence + 1;
    const anchor: HostedPlaybackAnchor = {
      ...structuredClone(command),
      effectiveAtRoomMs: Date.now(),
      sequence: roomSequence,
    };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        `INSERT OR REPLACE INTO playback_anchors (entity_id, kind, anchor_json)
         VALUES (?, ?, ?)`,
        anchor.entityId,
        anchor.type,
        JSON.stringify(anchor),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO scene_operations (
          room_sequence, operation_id, actor_id, kind, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
        roomSequence,
        command.commandId,
        attachment.userId,
        `playback.${anchor.type}`,
        JSON.stringify(anchor),
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO applied_operations (operation_id, room_sequence, created_at)
         VALUES (?, ?, ?)`,
        command.commandId,
        roomSequence,
        Date.now(),
      );
      this.ctx.storage.sql.exec(
        "UPDATE room_metadata SET room_sequence = ? WHERE singleton = 1",
        roomSequence,
      );
      this.#pruneOperationHistory(roomSequence);
    });
    this.#broadcast(
      JSON.stringify({ anchor, roomSequence, type: "playback" } satisfies ServerPlaybackMessage),
    );
    socket.send(
      JSON.stringify({
        operationId: command.commandId,
        roomSequence,
        type: "ack",
      } satisfies ServerAckMessage),
    );
    this.ctx.waitUntil(
      Promise.all([
        this.#updateWorkspaceSequence(status.workspaceId, roomSequence),
        this.#scheduleCheckpoint(),
      ]).then(() => undefined),
    );
  }

  #conflict(
    operationId: string,
    reason: ServerConflictMessage["reason"],
    roomSequence: number,
    current?: HostedSceneEntity,
  ): RejectedOperation {
    return {
      conflict: {
        ...(current && { current }),
        operationId,
        reason,
        roomSequence,
        type: "conflict",
      },
    };
  }

  async #validateCommandAssets(command: HostedSceneCommand): Promise<boolean> {
    const assetIds = new Set<string>();
    if (command.kind === "entity.create") assetIds.add(command.entity.asset.id);
    else if (command.kind === "entity.patch" && command.patch.asset) {
      assetIds.add(command.patch.asset.asset.id);
    } else if (command.kind === "scene.replace") {
      for (const entity of command.entities) assetIds.add(entity.asset.id);
    }
    if (assetIds.size === 0) return true;
    const status = this.#readStatus();
    if (!status) return false;
    const rows = await this.env.DB.prepare(
      `SELECT id FROM assets
       WHERE workspace_id = ? AND lifecycle IN ('verified', 'active', 'unreferenced')
         AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(status.workspaceId, JSON.stringify([...assetIds]))
      .all<{ id: string }>();
    return new Set(rows.results.map((row) => row.id)).size === assetIds.size;
  }

  #readEntity(id: string): HostedSceneEntity | null {
    const row = this.ctx.storage.sql
      .exec<EntityRow>("SELECT entity_json FROM scene_entities WHERE id = ?", id)
      .toArray()[0];
    if (!row) return null;
    const value: unknown = JSON.parse(row.entity_json);
    if (!isSceneEntity(value)) throw new Error(`Stored scene entity is invalid: ${id}`);
    return value;
  }

  #writeEntity(entity: HostedSceneEntity): void {
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO scene_entities (id, generation, asset_id, entity_json)
       VALUES (?, ?, ?, ?)`,
      entity.id,
      entity.generation,
      entity.asset.id,
      JSON.stringify(entity),
    );
  }

  #snapshot(status: WorkspaceRoomStatus): StoredSceneSnapshot {
    const entities = this.ctx.storage.sql
      .exec<EntityRow>("SELECT entity_json FROM scene_entities ORDER BY id")
      .toArray()
      .map((row) => {
        const value: unknown = JSON.parse(row.entity_json);
        if (!isSceneEntity(value)) throw new Error("Stored scene entity is invalid");
        return value;
      })
      .sort((left, right) => left.zIndex - right.zIndex || left.id.localeCompare(right.id));
    const playback = this.ctx.storage.sql
      .exec<PlaybackRow>("SELECT anchor_json FROM playback_anchors ORDER BY entity_id")
      .toArray()
      .map((row) => {
        const value: unknown = JSON.parse(row.anchor_json);
        if (!isPlaybackAnchor(value)) throw new Error("Stored playback anchor is invalid");
        return value;
      });
    return {
      entities,
      playback,
      roomSequence: status.roomSequence,
      schemaVersion: 1,
      workspaceId: status.workspaceId,
    };
  }

  #readStatus(): WorkspaceRoomStatus | null {
    const row = this.ctx.storage.sql
      .exec<{ room_sequence: number; workspace_id: string }>(
        "SELECT workspace_id, room_sequence FROM room_metadata WHERE singleton = 1",
      )
      .toArray()[0];
    return row ? { roomSequence: row.room_sequence, workspaceId: row.workspace_id } : null;
  }

  #readAppliedOperation(operationId: string): number | null {
    return (
      this.ctx.storage.sql
        .exec<{ room_sequence: number }>(
          "SELECT room_sequence FROM applied_operations WHERE operation_id = ?",
          operationId,
        )
        .toArray()[0]?.room_sequence ?? null
    );
  }

  async #scheduleCheckpoint(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.ctx.storage.setAlarm(Date.now() + CHECKPOINT_DELAY_MS);
  }

  async #writeRecoveryCheckpoint(status: WorkspaceRoomStatus): Promise<void> {
    const existing = await this.env.DB.prepare(
      `SELECT object_key FROM workspace_snapshots
       WHERE workspace_id = ? AND room_sequence = ?`,
    )
      .bind(status.workspaceId, status.roomSequence)
      .first<{ object_key: string }>();
    if (existing) return;
    const bytes = encodeSnapshot(this.#snapshot(status));
    const checksum = await sha256Hex(bytes);
    const objectKey = `snapshots/${status.workspaceId}/${status.roomSequence}/${crypto.randomUUID()}.json`;
    await this.env.ASSETS.put(objectKey, bytes, {
      httpMetadata: { contentType: "application/json" },
    });
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO workspace_snapshots (
            workspace_id, room_sequence, object_key, checksum, byte_length, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          status.workspaceId,
          status.roomSequence,
          objectKey,
          checksum,
          bytes.byteLength,
          Date.now(),
        ),
        this.env.DB.prepare(
          `UPDATE workspaces SET snapshot_sequence = ?
           WHERE id = ? AND snapshot_sequence < ?`,
        ).bind(status.roomSequence, status.workspaceId, status.roomSequence),
      ]);
    } catch (error) {
      await this.env.ASSETS.delete(objectKey);
      throw error;
    }
  }

  #pruneOperationHistory(roomSequence: number): void {
    const cutoff = roomSequence - MAX_OPERATION_HISTORY;
    if (cutoff > 0) {
      this.ctx.storage.sql.exec("DELETE FROM scene_operations WHERE room_sequence <= ?", cutoff);
    }
  }

  #currentAssetIds(): Set<string> {
    return new Set(
      this.ctx.storage.sql
        .exec<{ asset_id: string }>("SELECT DISTINCT asset_id FROM scene_entities")
        .toArray()
        .map((row) => row.asset_id),
    );
  }

  async #updateWorkspaceSequence(workspaceId: WorkspaceId, roomSequence: number): Promise<void> {
    await this.env.DB.prepare(
      `UPDATE workspaces SET current_room_sequence = ?, updated_at = ?
       WHERE id = ? AND current_room_sequence < ?`,
    )
      .bind(roomSequence, Date.now(), workspaceId, roomSequence)
      .run();
  }

  async #recoverRemoteSnapshot(workspaceId: WorkspaceId): Promise<WorkspaceRoomStatus | null> {
    const snapshot = await this.env.DB.prepare(
      `SELECT room_sequence, object_key, checksum FROM workspace_snapshots
       WHERE workspace_id = ? ORDER BY room_sequence DESC LIMIT 1`,
    )
      .bind(workspaceId)
      .first<{ checksum: string; object_key: string; room_sequence: number }>();
    if (!snapshot) return null;
    const object = await this.env.ASSETS.get(snapshot.object_key);
    if (!object) throw new Error("Workspace recovery snapshot object is missing");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if ((await sha256Hex(bytes)) !== snapshot.checksum) {
      throw new Error("Workspace recovery snapshot checksum mismatch");
    }
    const stored = decodeSnapshot(bytes);
    if (!stored || stored.workspaceId !== workspaceId) {
      throw new Error("Workspace recovery snapshot is invalid");
    }
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(
        "INSERT INTO room_metadata (singleton, workspace_id, room_sequence) VALUES (1, ?, ?)",
        workspaceId,
        stored.roomSequence,
      );
      for (const entity of stored.entities) this.#writeEntity(entity);
      for (const anchor of stored.playback) {
        this.ctx.storage.sql.exec(
          "INSERT INTO playback_anchors (entity_id, kind, anchor_json) VALUES (?, ?, ?)",
          anchor.entityId,
          anchor.type,
          JSON.stringify(anchor),
        );
      }
    });
    return { roomSequence: stored.roomSequence, workspaceId };
  }

  async #reconcileAssetReferences(
    workspaceId: WorkspaceId,
    referencedAssetIds: ReadonlySet<string>,
    actorUserId: UserId,
    operationId: string,
  ): Promise<void> {
    const referencesJson = JSON.stringify([...referencedAssetIds]);
    const changedAt = Date.now();
    const unreferencedChangeId = crypto.randomUUID();
    const restoredChangeId = crypto.randomUUID();
    const activatedChangeId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE assets SET lifecycle = 'unreferenced', unreferenced_at = ?, updated_at = ?,
             reference_change_id = ?
         WHERE workspace_id = ? AND lifecycle IN ('active', 'verified')
           AND id NOT IN (SELECT value FROM json_each(?))`,
      ).bind(changedAt, changedAt, unreferencedChangeId, workspaceId, referencesJson),
      this.env.DB.prepare(
        `UPDATE assets SET lifecycle = 'active', unreferenced_at = NULL, updated_at = ?,
             reference_change_id = ?
         WHERE workspace_id = ? AND lifecycle = 'unreferenced'
           AND id IN (SELECT value FROM json_each(?))`,
      ).bind(changedAt, restoredChangeId, workspaceId, referencesJson),
      this.env.DB.prepare(
        `UPDATE assets SET lifecycle = 'active', unreferenced_at = NULL, updated_at = ?,
             reference_change_id = ?
         WHERE workspace_id = ? AND lifecycle = 'verified'
           AND id IN (SELECT value FROM json_each(?))`,
      ).bind(changedAt, activatedChangeId, workspaceId, referencesJson),
      assetReferenceAuditStatement(
        this.env.DB,
        workspaceId,
        actorUserId,
        operationId,
        unreferencedChangeId,
        "unreferenced",
        changedAt,
      ),
      assetReferenceAuditStatement(
        this.env.DB,
        workspaceId,
        actorUserId,
        operationId,
        restoredChangeId,
        "active",
        changedAt,
      ),
      assetActivationAuditStatement(
        this.env.DB,
        workspaceId,
        actorUserId,
        operationId,
        activatedChangeId,
        changedAt,
      ),
    ]);
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

  #broadcast(message: string, exclude?: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      try {
        socket.send(message);
      } catch {
        // Hibernated or closing sockets are cleaned up by lifecycle callbacks.
      }
    }
  }

  #broadcastPresence(message: string, exclude: WebSocket): void {
    for (const socket of this.ctx.getWebSockets()) {
      const bufferedAmount =
        (socket as WebSocket & { bufferedAmount?: number }).bufferedAmount ?? 0;
      if (socket === exclude || bufferedAmount > MAX_PRESENCE_BACKPRESSURE_BYTES) continue;
      try {
        socket.send(message);
      } catch {
        // Presence is ephemeral and a later snapshot supersedes a dropped message.
      }
    }
  }

  #announceDeparture(socket: WebSocket): void {
    const attachment = socket.deserializeAttachment() as ConnectionAttachment | null;
    if (!attachment) return;
    this.#broadcast(
      JSON.stringify({
        connectionId: attachment.connectionId,
        type: "peer-left",
        userId: attachment.userId,
      } satisfies ServerPeerLeftMessage),
      socket,
    );
  }

  #migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS room_metadata (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        workspace_id TEXT NOT NULL UNIQUE,
        room_sequence INTEGER NOT NULL DEFAULT 0 CHECK (room_sequence >= 0)
      );
      CREATE TABLE IF NOT EXISTS scene_entities (
        id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL CHECK (generation >= 0),
        asset_id TEXT NOT NULL,
        entity_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS scene_entities_asset_id ON scene_entities(asset_id);
      CREATE TABLE IF NOT EXISTS playback_anchors (
        entity_id TEXT PRIMARY KEY REFERENCES scene_entities(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('media', 'shader')),
        anchor_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scene_operations (
        room_sequence INTEGER PRIMARY KEY CHECK (room_sequence > 0),
        operation_id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS applied_operations (
        operation_id TEXT PRIMARY KEY,
        room_sequence INTEGER NOT NULL CHECK (room_sequence > 0),
        created_at INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (3);
      DROP TABLE IF EXISTS yjs_updates;
      DROP TABLE IF EXISTS applied_update_ids;
      DROP TABLE IF EXISTS room_snapshot;
    `);
  }
}

function applyEntityPatch(current: HostedSceneEntity, patch: HostedEntityPatch): HostedSceneEntity {
  const revisions = { ...current.revisions };
  for (const group of revisionGroups(patch)) revisions[group] += 1;
  return {
    ...current,
    ...(patch.identity && {
      edited: patch.identity.edited,
      locked: patch.identity.locked,
      name: patch.identity.name,
      ...(patch.identity.originalPalette
        ? { originalPalette: structuredClone(patch.identity.originalPalette) }
        : { originalPalette: undefined }),
    }),
    ...(patch.geometry && {
      originalSize: { ...patch.geometry.originalSize },
      position: { ...patch.geometry.position },
      rotation: patch.geometry.rotation,
      size: { ...patch.geometry.size },
    }),
    ...(patch.appearance && {
      shaderParams: structuredClone(patch.appearance.shaderParams),
      shaderType: patch.appearance.shaderType,
    }),
    ...(patch.layering && { zIndex: patch.layering.zIndex }),
    ...(patch.asset && {
      asset: structuredClone(patch.asset.asset),
      fps: patch.asset.fps,
      hasAudio: patch.asset.hasAudio,
      playbackDuration: patch.asset.playbackDuration,
    }),
    revisions,
  };
}

function revisionsMatch(
  current: HostedSceneEntity,
  expected: ExpectedEntityRevisions,
  patch: HostedEntityPatch,
): boolean {
  const groups = revisionGroups(patch);
  return (
    groups.length === Object.keys(expected).length &&
    groups.every((group) => expected[group] === current.revisions[group])
  );
}

function revisionGroups(patch: HostedEntityPatch): HostedEntityRevisionGroup[] {
  const groups: HostedEntityRevisionGroup[] = [];
  if (patch.identity) groups.push("identity");
  if (patch.geometry) groups.push("geometry");
  if (patch.appearance) groups.push("appearance");
  if (patch.layering) groups.push("layering");
  if (patch.asset) groups.push("asset");
  return groups;
}

function playbackMatchesEntity(command: HostedPlaybackCommand, entity: HostedSceneEntity): boolean {
  if (command.type === "media") {
    return (
      (entity.asset.mediaType === "gif" || entity.asset.mediaType === "video") &&
      command.mediaRevision === entity.revisions.asset
    );
  }
  return (
    command.appearanceRevision === entity.revisions.appearance && isTimeDependentShader(entity)
  );
}

function toPresenceMessage(attachment: ConnectionAttachment): ServerPresenceMessage {
  return {
    color: attachment.color,
    connectionId: attachment.connectionId,
    cursor: attachment.cursor ?? null,
    name: attachment.name,
    selectedEntityIds: attachment.selectedEntityIds ?? [],
    sequence: attachment.presenceSequence,
    type: "presence",
    userId: attachment.userId,
  };
}

function operationIdOf(message: ReturnType<typeof parseClientDurableMessage> & {}): string {
  if (!message) return "";
  return message.type === "scene-command" ? message.command.operationId : message.command.commandId;
}

function encodeSnapshot(snapshot: StoredSceneSnapshot): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(snapshot));
}

function decodeSnapshot(bytes: Uint8Array): StoredSceneSnapshot | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.workspaceId !== "string" ||
      !isIdentifier(value.workspaceId)
    ) {
      return null;
    }
    if (
      !Number.isSafeInteger(value.roomSequence) ||
      Number(value.roomSequence) < 0 ||
      !Array.isArray(value.entities) ||
      value.entities.length > MAX_SCENE_ENTITIES ||
      !value.entities.every(isSceneEntity) ||
      !Array.isArray(value.playback) ||
      !value.playback.every(isPlaybackAnchor)
    ) {
      return null;
    }
    return {
      entities: value.entities,
      playback: value.playback,
      roomSequence: Number(value.roomSequence),
      schemaVersion: 1,
      workspaceId: value.workspaceId,
    };
  } catch {
    return null;
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assetReferenceAuditStatement(
  db: D1Database,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  operationId: string,
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
    .bind(actorUserId, action, operationId, changedAt, workspaceId, changeId, lifecycle);
}

function assetActivationAuditStatement(
  db: D1Database,
  workspaceId: WorkspaceId,
  actorUserId: UserId,
  operationId: string,
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
    .bind(actorUserId, operationId, changedAt, workspaceId, changeId);
}

function colorForUser(userId: UserId): string {
  let hash = 0x811c9dc5;
  for (const character of userId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return `hsl(${(hash >>> 0) % 360} 72% 58%)`;
}
