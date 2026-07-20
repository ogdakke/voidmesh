import type { WorkspaceId, WorkspaceRole } from "@voidmesh/domain";
import {
  type ClientClockPingMessage,
  type ClientDurableMessage,
  type ClientPresenceMessage,
  COLLABORATION_PROTOCOL_VERSION,
  type HostedPlaybackAnchor,
  type HostedPlaybackCommand,
  type HostedSceneCommand,
  type HostedSceneEntity,
  type ServerClockPongMessage,
  type ServerCollaborationMessage,
  type ServerConflictMessage,
  type ServerPlaybackMessage,
  type ServerPresenceMessage,
  type ServerScenePatchMessage,
  type ServerSceneSnapshotMessage,
  parseServerCollaborationMessage,
} from "./index.ts";

const WEB_SOCKET_OPEN = 1;
const CLOCK_SAMPLE_INTERVAL_MS = 15_000;
const CLOCK_SAMPLE_WINDOW = 8;
const MAX_PENDING_COMMANDS = 10_000;

export type CollaborationConnectionStatus =
  | "offline"
  | "connecting"
  | "synchronizing"
  | "connected"
  | "revoked"
  | "unavailable";

export interface PendingCommandStore {
  load(): Promise<ClientDurableMessage[]>;
  save(commands: readonly ClientDurableMessage[]): Promise<void>;
}

export interface HostedCollaborationProviderOptions {
  beforeFlush?: () => Promise<void>;
  onClockSample?: () => void;
  onConflict?: (conflict: ServerConflictMessage) => void;
  onSynchronizationError?: (error: unknown) => void;
  pendingStore?: PendingCommandStore;
  preparePending?: (
    commands: readonly ClientDurableMessage[],
  ) => Promise<readonly ClientDurableMessage[]>;
  socketFactory: () => Promise<WebSocket> | WebSocket;
}

export class HostedCollaborationProvider {
  readonly #beforeFlush: () => Promise<void>;
  readonly #onClockSample: () => void;
  readonly #onConflict: (conflict: ServerConflictMessage) => void;
  readonly #onSynchronizationError: (error: unknown) => void;
  readonly #pendingStore: PendingCommandStore;
  readonly #preparePending: (
    commands: readonly ClientDurableMessage[],
  ) => Promise<readonly ClientDurableMessage[]>;
  readonly #socketFactory: () => Promise<WebSocket> | WebSocket;
  readonly #presenceListeners = new Set<(presence: ServerPresenceMessage) => void>();
  readonly #roleListeners = new Set<(role: WorkspaceRole) => void>();
  readonly #statusListeners = new Set<(status: CollaborationConnectionStatus) => void>();
  readonly #snapshotListeners = new Set<
    (snapshot: ServerSceneSnapshotMessage) => Promise<void> | void
  >();
  readonly #patchListeners = new Set<(patch: ServerScenePatchMessage) => void>();
  readonly #playbackListeners = new Set<(message: ServerPlaybackMessage) => void>();
  readonly #clockRequests = new Map<string, number>();
  #socket: WebSocket | null = null;
  #status: CollaborationConnectionStatus = "offline";
  #stopped = true;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #presenceSequence = 0;
  #serverClockOffsetMs = 0;
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #clockSamples: { offsetMs: number; roundTripMs: number }[] = [];
  #pending: ClientDurableMessage[] = [];
  #inFlightOperationId: string | null = null;
  #persistenceReady: Promise<void>;
  #flushReady = false;

  constructor(options: HostedCollaborationProviderOptions) {
    this.#beforeFlush = options.beforeFlush ?? (() => Promise.resolve());
    this.#onClockSample = options.onClockSample ?? (() => {});
    this.#onConflict = options.onConflict ?? (() => {});
    this.#onSynchronizationError = options.onSynchronizationError ?? (() => {});
    this.#pendingStore = options.pendingStore ?? new MemoryPendingCommandStore();
    this.#preparePending = options.preparePending ?? ((commands) => Promise.resolve(commands));
    this.#socketFactory = options.socketFactory;
    this.#persistenceReady = this.#loadPending();
  }

  get status(): CollaborationConnectionStatus {
    return this.#status;
  }

  serverNow(): number {
    return monotonicEpochNow() + this.#serverClockOffsetMs;
  }

  connect(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#open();
  }

  disconnect(): void {
    this.#stopped = true;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#clearConnectionTimers();
    this.#socket?.close(1000, "Client disconnected");
    this.#socket = null;
    this.#inFlightOperationId = null;
    this.#flushReady = false;
    this.#setStatus("offline");
  }

  destroy(): void {
    this.disconnect();
    this.#presenceListeners.clear();
    this.#roleListeners.clear();
    this.#statusListeners.clear();
    this.#snapshotListeners.clear();
    this.#patchListeners.clear();
    this.#playbackListeners.clear();
  }

  submitSceneCommand(command: HostedSceneCommand): void {
    this.#enqueue({ command, type: "scene-command" });
  }

  submitPlaybackCommand(command: HostedPlaybackCommand): void {
    this.#enqueuePlayback({ command, type: "playback-command" });
  }

  publishPresence(input: Omit<ClientPresenceMessage, "sequence" | "type">): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN || this.#status !== "connected") return;
    socket.send(
      JSON.stringify({
        ...input,
        sequence: this.#presenceSequence++,
        type: "presence",
      } satisfies ClientPresenceMessage),
    );
  }

  onPresence(listener: (presence: ServerPresenceMessage) => void): () => void {
    this.#presenceListeners.add(listener);
    return () => this.#presenceListeners.delete(listener);
  }

  onStatus(listener: (status: CollaborationConnectionStatus) => void): () => void {
    this.#statusListeners.add(listener);
    listener(this.#status);
    return () => this.#statusListeners.delete(listener);
  }

  onRole(listener: (role: WorkspaceRole) => void): () => void {
    this.#roleListeners.add(listener);
    return () => this.#roleListeners.delete(listener);
  }

  onSnapshot(listener: (snapshot: ServerSceneSnapshotMessage) => Promise<void> | void): () => void {
    this.#snapshotListeners.add(listener);
    return () => this.#snapshotListeners.delete(listener);
  }

  onPatch(listener: (patch: ServerScenePatchMessage) => void): () => void {
    this.#patchListeners.add(listener);
    return () => this.#patchListeners.delete(listener);
  }

  onPlayback(listener: (message: ServerPlaybackMessage) => void): () => void {
    this.#playbackListeners.add(listener);
    return () => this.#playbackListeners.delete(listener);
  }

  resynchronize(): void {
    if (this.#stopped) return;
    this.#socket?.close(4101, "Scene reconciliation requested");
  }

  async #loadPending(): Promise<void> {
    try {
      const commands = await this.#pendingStore.load();
      this.#pending = compactPlaybackCommands(commands.slice(0, MAX_PENDING_COMMANDS));
    } catch (error) {
      this.#onSynchronizationError(error);
    }
  }

  #enqueue(message: ClientDurableMessage): void {
    const operationId = operationIdOf(message);
    if (
      this.#pending.some((entry) => operationIdOf(entry) === operationId) ||
      this.#pending.length >= MAX_PENDING_COMMANDS
    ) {
      return;
    }
    this.#pending.push(message);
    void this.#persistPending();
    this.#flushNext();
  }

  #enqueuePlayback(message: Extract<ClientDurableMessage, { type: "playback-command" }>): void {
    const operationId = message.command.commandId;
    if (this.#pending.some((entry) => operationIdOf(entry) === operationId)) return;

    this.#pending = this.#pending.filter(
      (entry) =>
        entry.type !== "playback-command" ||
        entry.command.entityId !== message.command.entityId ||
        entry.command.commandId === this.#inFlightOperationId,
    );
    if (this.#pending.length >= MAX_PENDING_COMMANDS) return;
    this.#pending.push(message);
    void this.#persistPending();
    this.#flushNext();
  }

  async #open(): Promise<void> {
    await this.#persistenceReady;
    if (this.#stopped) return;
    this.#setStatus("connecting");
    let socket: WebSocket;
    try {
      const created = this.#socketFactory();
      socket = isPromiseLike(created) ? await created : created;
    } catch (error) {
      this.#onSynchronizationError(error);
      if (!this.#stopped) this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) {
      socket.close(1000, "Client disconnected");
      return;
    }
    this.#socket = socket;
    socket.addEventListener("open", () => this.#handleOpen(socket));
    socket.addEventListener("message", (event) => this.#handleMessageEvent(socket, event.data));
    socket.addEventListener("close", (event) => this.#handleClose(socket, event.code));
    socket.addEventListener("error", () => socket.close());
  }

  #handleOpen(socket: WebSocket): void {
    if (this.#socket !== socket) return;
    this.#setStatus("synchronizing");
    this.#sendClockPing();
    this.#clockTimer = setInterval(() => this.#sendClockPing(), CLOCK_SAMPLE_INTERVAL_MS);
  }

  #handleMessageEvent(socket: WebSocket, data: unknown): void {
    if (this.#socket !== socket || typeof data !== "string") return;
    const message = parseServerCollaborationMessage(data);
    if (!message) return;
    this.#handleMessage(message);
  }

  #handleMessage(message: ServerCollaborationMessage): void {
    switch (message.type) {
      case "hello":
        if (message.protocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
          this.#socket?.close(4005, "Protocol mismatch");
        } else if (Number.isFinite(message.serverTime)) {
          this.#serverClockOffsetMs = message.serverTime - monotonicEpochNow();
        }
        return;
      case "scene-snapshot":
        void this.#finishSynchronization(message);
        return;
      case "scene-patch":
        for (const listener of this.#patchListeners) listener(message);
        return;
      case "playback":
        if (
          this.#pending.some(
            (entry) =>
              entry.type === "playback-command" &&
              entry.command.commandId === message.anchor.commandId,
          )
        ) {
          return;
        }
        for (const listener of this.#playbackListeners) listener(message);
        return;
      case "ack":
        this.#acknowledge(message.operationId);
        return;
      case "conflict":
        this.#rejectPending(message);
        return;
      case "clock-pong":
        this.#applyClockSample(message);
        return;
      case "presence":
        for (const listener of this.#presenceListeners) listener(message);
        return;
      case "role-changed":
        for (const listener of this.#roleListeners) listener(message.role);
        return;
      case "peer-left": {
        const cleared: ServerPresenceMessage = {
          color: "",
          connectionId: message.connectionId,
          cursor: null,
          name: "",
          selectedEntityIds: [],
          sequence: Number.MAX_SAFE_INTEGER,
          type: "presence",
          userId: message.userId,
        };
        for (const listener of this.#presenceListeners) listener(cleared);
        return;
      }
      case "error":
        this.#onSynchronizationError(new Error(message.code));
    }
  }

  async #finishSynchronization(snapshot: ServerSceneSnapshotMessage): Promise<void> {
    try {
      await Promise.all([...this.#snapshotListeners].map((listener) => listener(snapshot)));
      await this.#beforeFlush();
      this.#pending = compactPlaybackCommands(await this.#preparePending(this.#pending));
      await this.#persistPending();
    } catch (error) {
      this.#onSynchronizationError(error);
      this.#socket?.close(4100, "Offline assets are not ready");
      return;
    }
    this.#flushReady = true;
    this.#setStatus("connected");
    this.#reconnectAttempt = 0;
    this.#flushNext();
  }

  #acknowledge(operationId: string): void {
    const index = this.#pending.findIndex((entry) => operationIdOf(entry) === operationId);
    if (index >= 0) this.#pending.splice(index, 1);
    if (this.#inFlightOperationId === operationId) this.#inFlightOperationId = null;
    void this.#persistPending();
    this.#flushNext();
  }

  #rejectPending(conflict: ServerConflictMessage): void {
    const index = this.#pending.findIndex((entry) => operationIdOf(entry) === conflict.operationId);
    if (index >= 0) this.#pending.splice(index, 1);
    if (this.#inFlightOperationId === conflict.operationId) this.#inFlightOperationId = null;
    void this.#persistPending();
    this.#onConflict(conflict);
    this.resynchronize();
  }

  #flushNext(): void {
    const socket = this.#socket;
    if (
      !this.#flushReady ||
      this.#status !== "connected" ||
      !socket ||
      socket.readyState !== WEB_SOCKET_OPEN ||
      this.#inFlightOperationId
    ) {
      return;
    }
    const next = this.#pending[0];
    if (!next) return;
    this.#inFlightOperationId = operationIdOf(next);
    socket.send(JSON.stringify(next));
  }

  async #persistPending(): Promise<void> {
    try {
      await this.#pendingStore.save(this.#pending);
    } catch (error) {
      this.#onSynchronizationError(error);
    }
  }

  #sendClockPing(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) return;
    const message: ClientClockPingMessage = {
      clientTime: monotonicEpochNow(),
      requestId: crypto.randomUUID(),
      type: "clock-ping",
    };
    this.#clockRequests.set(message.requestId, message.clientTime);
    while (this.#clockRequests.size > CLOCK_SAMPLE_WINDOW) {
      this.#clockRequests.delete(this.#clockRequests.keys().next().value!);
    }
    socket.send(JSON.stringify(message));
  }

  #applyClockSample(message: ServerClockPongMessage): void {
    const requestedAt = this.#clockRequests.get(message.requestId);
    if (requestedAt !== message.clientTime) return;
    this.#clockRequests.delete(message.requestId);
    const receivedAt = monotonicEpochNow();
    const roundTripMs = receivedAt - message.clientTime;
    if (roundTripMs < 0 || roundTripMs > CLOCK_SAMPLE_INTERVAL_MS) return;
    const sample = {
      offsetMs: message.serverTime - (message.clientTime + roundTripMs / 2),
      roundTripMs,
    };
    this.#clockSamples.push(sample);
    if (this.#clockSamples.length > CLOCK_SAMPLE_WINDOW) this.#clockSamples.shift();
    const best = this.#clockSamples.reduce((left, right) =>
      right.roundTripMs < left.roundTripMs ? right : left,
    );
    if (best !== sample) return;
    this.#serverClockOffsetMs = best.offsetMs;
    this.#onClockSample();
  }

  #handleClose(socket: WebSocket, code: number): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#clearConnectionTimers();
    this.#inFlightOperationId = null;
    this.#flushReady = false;
    if (code === 4003 || code === 4004) {
      this.#stopped = true;
      this.#setStatus(code === 4003 ? "revoked" : "unavailable");
      return;
    }
    this.#setStatus("offline");
    if (!this.#stopped) this.#scheduleReconnect();
  }

  #clearConnectionTimers(): void {
    if (this.#clockTimer) clearInterval(this.#clockTimer);
    this.#clockTimer = null;
    this.#clockSamples = [];
    this.#clockRequests.clear();
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer) return;
    const delay = Math.min(30_000, 500 * 2 ** this.#reconnectAttempt++);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#open();
    }, delay);
  }

  #setStatus(status: CollaborationConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}

export function createIndexedDbPendingCommandStore(workspaceId: WorkspaceId): PendingCommandStore {
  return new IndexedDbPendingCommandStore(`voidmesh:hosted:v3:${workspaceId}`);
}

class MemoryPendingCommandStore implements PendingCommandStore {
  #commands: ClientDurableMessage[] = [];

  async load(): Promise<ClientDurableMessage[]> {
    return structuredClone(this.#commands);
  }

  async save(commands: readonly ClientDurableMessage[]): Promise<void> {
    this.#commands = [...structuredClone(commands)];
  }
}

class IndexedDbPendingCommandStore implements PendingCommandStore {
  readonly #database: Promise<IDBDatabase>;

  constructor(name: string) {
    this.#database = openDatabase(name);
  }

  async load(): Promise<ClientDurableMessage[]> {
    const database = await this.#database;
    return new Promise((resolve, reject) => {
      const request = database.transaction("state", "readonly").objectStore("state").get("pending");
      request.addEventListener("success", () => {
        resolve(Array.isArray(request.result) ? request.result : []);
      });
      request.addEventListener("error", () => reject(request.error));
    });
  }

  async save(commands: readonly ClientDurableMessage[]): Promise<void> {
    const database = await this.#database;
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("state", "readwrite");
      transaction.objectStore("state").put(structuredClone(commands), "pending");
      transaction.addEventListener("complete", () => resolve());
      transaction.addEventListener("error", () => reject(transaction.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  }
}

function openDatabase(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains("state")) {
        request.result.createObjectStore("state");
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });
}

function operationIdOf(message: ClientDurableMessage): string {
  return message.type === "playback-command"
    ? message.command.commandId
    : message.command.operationId;
}

function compactPlaybackCommands(
  commands: readonly ClientDurableMessage[],
): ClientDurableMessage[] {
  const entityIds = new Set<string>();
  const compacted: ClientDurableMessage[] = [];
  for (let index = commands.length - 1; index >= 0; index--) {
    const message = commands[index]!;
    if (message.type === "playback-command") {
      if (entityIds.has(message.command.entityId)) continue;
      entityIds.add(message.command.entityId);
    }
    compacted.push(message);
  }
  compacted.reverse();
  return compacted;
}

function monotonicEpochNow(): number {
  return typeof performance === "undefined"
    ? Date.now()
    : performance.timeOrigin + performance.now();
}

function isPromiseLike(value: Promise<WebSocket> | WebSocket): value is Promise<WebSocket> {
  return typeof Reflect.get(value, "then") === "function";
}

export type { HostedPlaybackAnchor, HostedSceneEntity };
