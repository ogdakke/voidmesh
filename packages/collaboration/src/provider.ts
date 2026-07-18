import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import type { WorkspaceId, WorkspaceRole } from "@voidmesh/domain";
import {
  COLLABORATION_PROTOCOL_VERSION,
  base64UrlToBytes,
  decodeServerYjsRebase,
  decodeServerYjsUpdate,
  encodeClientYjsRebase,
  encodeClientYjsUpdate,
  type ClientPresenceMessage,
  type ClientClockPingMessage,
  type ServerAckMessage,
  type ServerHelloMessage,
  type ServerPeerLeftMessage,
  type ServerPresenceMessage,
  type ServerRoleChangedMessage,
  type ServerClockPongMessage,
  type ServerErrorMessage,
  type ServerSyncCompleteMessage,
} from "./index.ts";

const REMOTE_ORIGIN = Symbol("voidmesh-hosted-remote");
const EMPTY_YJS_UPDATE_BYTES = 2;
const WEB_SOCKET_OPEN = 1;
const CLOCK_SAMPLE_INTERVAL_MS = 15_000;
const CLOCK_SAMPLE_WINDOW = 8;
const CLIENT_CLOSE_ASSET_SYNC_FAILED = 4100;
const CLIENT_CLOSE_RESYNCHRONIZE = 4101;
const CLIENT_CLOSE_RECOVERY_FAILED = 4102;
const HOSTED_DOCUMENT_STORAGE_VERSION = 2;

export type CollaborationConnectionStatus =
  | "offline"
  | "connecting"
  | "synchronizing"
  | "connected"
  | "revoked"
  | "unavailable";

export interface PersistedHostedDocument {
  destroy(): Promise<void>;
  document: Y.Doc;
  whenSynced: Promise<unknown>;
}

export interface HostedCollaborationProviderOptions {
  beforeSync?: () => Promise<void>;
  document: Y.Doc;
  onSynchronizationError?: (error: unknown) => void;
  onClockSample?: () => void;
  persistenceReady?: Promise<unknown>;
  socketFactory: () => Promise<WebSocket> | WebSocket;
}

export class HostedCollaborationProvider {
  readonly #document: Y.Doc;
  readonly #beforeSync: () => Promise<void>;
  readonly #onSynchronizationError: (error: unknown) => void;
  readonly #onClockSample: () => void;
  readonly #persistenceReady: Promise<unknown>;
  readonly #socketFactory: () => Promise<WebSocket> | WebSocket;
  readonly #pending = new Map<string, ArrayBuffer>();
  readonly #presenceListeners = new Set<(presence: ServerPresenceMessage) => void>();
  readonly #roleListeners = new Set<(role: WorkspaceRole) => void>();
  readonly #statusListeners = new Set<(status: CollaborationConnectionStatus) => void>();
  #socket: WebSocket | null = null;
  #status: CollaborationConnectionStatus = "offline";
  #stopped = true;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #presenceSequence = 0;
  #serverClockOffsetMs = 0;
  #lastSynchronizationError = "";
  #recoveryUpdateId: string | null = null;
  #acceptedRecoveryUpdateId: string | null = null;
  #recoveryFollowups: Uint8Array[] = [];
  #receivedAuthoritativeReplacement = false;
  #messageQueue: Promise<void> | null = null;
  #clockTimer: ReturnType<typeof setInterval> | null = null;
  #clockSamples: { offsetMs: number; roundTripMs: number }[] = [];
  readonly #clockRequests = new Map<string, number>();

  constructor(options: HostedCollaborationProviderOptions) {
    this.#document = options.document;
    this.#beforeSync = options.beforeSync ?? (() => Promise.resolve());
    this.#onSynchronizationError = options.onSynchronizationError ?? (() => {});
    this.#onClockSample = options.onClockSample ?? (() => {});
    this.#persistenceReady = options.persistenceReady ?? Promise.resolve();
    this.#socketFactory = options.socketFactory;
    this.#document.on("update", this.#handleDocumentUpdate);
  }

  get status(): CollaborationConnectionStatus {
    return this.#status;
  }

  /** Approximate room-authority time for durable playback anchors. */
  serverNow(): number {
    return Date.now() + this.#serverClockOffsetMs;
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
    if (this.#clockTimer) clearInterval(this.#clockTimer);
    this.#clockTimer = null;
    this.#clockSamples = [];
    this.#clockRequests.clear();
    this.#socket?.close(1000, "Client disconnected");
    this.#socket = null;
    this.#setStatus("offline");
  }

  destroy(): void {
    this.disconnect();
    this.#document.off("update", this.#handleDocumentUpdate);
    this.#presenceListeners.clear();
    this.#roleListeners.clear();
    this.#statusListeners.clear();
  }

  publishPresence(input: Omit<ClientPresenceMessage, "sequence" | "type">): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN || this.#status !== "connected") return;
    const message: ClientPresenceMessage = {
      ...input,
      sequence: this.#presenceSequence++,
      type: "presence",
    };
    socket.send(JSON.stringify(message));
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

  readonly #handleDocumentUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === REMOTE_ORIGIN) return;
    if (this.#recoveryUpdateId) {
      this.#recoveryFollowups.push(update);
      return;
    }
    if (this.#status === "connected") this.#sendUpdate(update);
  };

  async #open(): Promise<void> {
    await this.#persistenceReady;
    if (this.#stopped) return;
    this.#setStatus("connecting");
    let socket: WebSocket;
    try {
      const created = this.#socketFactory();
      socket = isPromiseLike(created) ? await created : created;
    } catch {
      if (!this.#stopped) this.#scheduleReconnect();
      return;
    }
    if (this.#stopped) {
      socket.close(1000, "Client disconnected");
      return;
    }
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    this.#messageQueue = null;
    socket.addEventListener("open", () => {
      this.#acceptedRecoveryUpdateId = null;
      this.#setStatus("synchronizing");
      this.#sendClockPing();
      this.#clockTimer = setInterval(() => this.#sendClockPing(), CLOCK_SAMPLE_INTERVAL_MS);
    });
    socket.addEventListener("message", (event) => this.#receiveMessage(socket, event.data));
    socket.addEventListener("close", (event) => this.#handleClose(socket, event.code));
    socket.addEventListener("error", () => socket.close());
  }

  #receiveMessage(socket: WebSocket, data: unknown): void {
    if (!this.#messageQueue && !(data instanceof Blob)) {
      if (this.#socket === socket) this.#handleMessage(data);
      return;
    }
    const previous = this.#messageQueue ?? Promise.resolve();
    const next = previous
      .then(async () => {
        if (this.#socket !== socket) return;
        const message = data instanceof Blob ? await data.arrayBuffer() : data;
        if (this.#socket === socket) this.#handleMessage(message);
      })
      .catch((error: unknown) => {
        if (this.#socket !== socket) return;
        this.#reportSynchronizationError(error);
        socket.close(CLIENT_CLOSE_RESYNCHRONIZE, "Binary message decoding failed");
      });
    this.#messageQueue = next;
    void next.finally(() => {
      if (this.#messageQueue === next) this.#messageQueue = null;
    });
  }

  #handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const rebase = decodeServerYjsRebase(data);
      if (rebase) {
        if (
          rebase.updateId === this.#recoveryUpdateId ||
          rebase.updateId === this.#acceptedRecoveryUpdateId
        ) {
          Y.applyUpdate(this.#document, rebase.update, REMOTE_ORIGIN);
          if (rebase.updateId === this.#acceptedRecoveryUpdateId) {
            this.#acceptedRecoveryUpdateId = null;
          }
        } else if (
          !this.#recoveryUpdateId &&
          !this.#acceptedRecoveryUpdateId &&
          this.#pending.size === 0
        ) {
          if (hasSameDocumentGeneration(this.#document, rebase.update)) {
            Y.applyUpdate(this.#document, rebase.update, REMOTE_ORIGIN);
          } else {
            replaceDocumentWithUpdate(this.#document, rebase.update);
            this.#receivedAuthoritativeReplacement = true;
          }
        }
        return;
      }
      const frame = decodeServerYjsUpdate(data);
      if (frame && !this.#recoveryUpdateId && !this.#acceptedRecoveryUpdateId) {
        Y.applyUpdate(this.#document, frame.update, REMOTE_ORIGIN);
      }
      return;
    }
    if (typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object" || !("type" in parsed)) return;
    const type = Reflect.get(parsed, "type");
    if (type === "hello") {
      const hello = parsed as ServerHelloMessage;
      if (hello.protocolVersion !== COLLABORATION_PROTOCOL_VERSION) {
        this.#socket?.close(4005, "Protocol mismatch");
      } else if (Number.isFinite(hello.serverTime)) {
        this.#serverClockOffsetMs = hello.serverTime - Date.now();
      }
      return;
    }
    if (type === "clock-pong") {
      this.#applyClockSample(parsed as Partial<ServerClockPongMessage>);
      return;
    }
    if (type === "sync-complete") {
      void this.#finishSync(parsed as ServerSyncCompleteMessage);
      return;
    }
    if (type === "ack") {
      const updateId = (parsed as ServerAckMessage).updateId;
      if (updateId === this.#recoveryUpdateId) {
        const recoveryFollowups = this.#recoveryFollowups;
        this.#pending.clear();
        this.#recoveryUpdateId = null;
        this.#recoveryFollowups = [];
        this.#acceptedRecoveryUpdateId = updateId;
        if (recoveryFollowups.length > 0) {
          const followup = Y.mergeUpdates(recoveryFollowups);
          if (followup.byteLength > EMPTY_YJS_UPDATE_BYTES) this.#sendUpdate(followup);
        }
      } else {
        this.#pending.delete(updateId);
      }
      return;
    }
    if (type === "error") {
      this.#handleServerError(parsed as Partial<ServerErrorMessage>);
      return;
    }
    if (type === "presence") {
      for (const listener of this.#presenceListeners) listener(parsed as ServerPresenceMessage);
      return;
    }
    if (type === "role-changed") {
      const message = parsed as Partial<ServerRoleChangedMessage>;
      if (message.role !== "owner" && message.role !== "editor" && message.role !== "viewer") {
        return;
      }
      for (const listener of this.#roleListeners) listener(message.role);
      return;
    }
    if (type === "peer-left") {
      const departure = parsed as ServerPeerLeftMessage;
      const cleared: ServerPresenceMessage = {
        color: "",
        connectionId: departure.connectionId,
        cursor: null,
        name: "",
        selectedEntityIds: [],
        sequence: Number.MAX_SAFE_INTEGER,
        type: "presence",
        userId: departure.userId,
      };
      for (const listener of this.#presenceListeners) listener(cleared);
    }
  }

  async #finishSync(message: ServerSyncCompleteMessage): Promise<void> {
    const socket = this.#socket;
    const stateVector = base64UrlToBytes(message.stateVector);
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN || !stateVector) return;
    try {
      await this.#beforeSync();
      this.#lastSynchronizationError = "";
    } catch (error) {
      this.#reportSynchronizationError(error);
      socket.close(CLIENT_CLOSE_ASSET_SYNC_FAILED, "Offline assets are not ready");
      return;
    }
    if (this.#socket !== socket || socket.readyState !== WEB_SOCKET_OPEN) return;
    const recovering = this.#recoveryUpdateId !== null;
    this.#sendPendingFrames();
    this.#setStatus("connected");
    this.#reconnectAttempt = 0;
    if (recovering) return;
    if (this.#receivedAuthoritativeReplacement) {
      this.#receivedAuthoritativeReplacement = false;
      return;
    }
    const offlineDiff = Y.encodeStateAsUpdate(this.#document, stateVector);
    if (offlineDiff.byteLength > EMPTY_YJS_UPDATE_BYTES) this.#sendUpdate(offlineDiff);
  }

  #sendUpdate(update: Uint8Array): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) return;
    const updateId = crypto.randomUUID();
    const frame = encodeClientYjsUpdate(updateId, update);
    this.#pending.set(updateId, frame);
    if (this.#recoveryUpdateId) return;
    socket.send(frame);
  }

  #handleServerError(message: Partial<ServerErrorMessage>): void {
    if (
      typeof message.updateId === "string" &&
      message.updateId === this.#recoveryUpdateId &&
      (message.code === "invalid-document" || message.code === "unknown-asset")
    ) {
      this.#failDocumentRecovery();
      return;
    }
    if (
      message.code !== "missing-yjs-dependencies" ||
      typeof message.updateId !== "string" ||
      !this.#pending.has(message.updateId)
    ) {
      return;
    }
    if (this.#recoveryUpdateId) {
      this.#failDocumentRecovery();
      return;
    }
    this.#pending.clear();
    const update = createDocumentRebase(this.#document);
    const updateId = crypto.randomUUID();
    const frame = encodeClientYjsRebase(updateId, update);
    this.#recoveryUpdateId = updateId;
    this.#acceptedRecoveryUpdateId = null;
    this.#recoveryFollowups = [];
    this.#pending.set(updateId, frame);
    this.#socket?.send(frame);
  }

  #sendPendingFrames(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) return;
    if (this.#recoveryUpdateId) {
      const recovery = this.#pending.get(this.#recoveryUpdateId);
      if (recovery) socket.send(recovery);
      return;
    }
    for (const frame of this.#pending.values()) socket.send(frame);
  }

  #failDocumentRecovery(): void {
    this.#stopped = true;
    this.#pending.clear();
    this.#recoveryUpdateId = null;
    this.#acceptedRecoveryUpdateId = null;
    this.#recoveryFollowups = [];
    this.#reportSynchronizationError(
      new Error("The shared workspace could not recover its document history"),
    );
    this.#socket?.close(CLIENT_CLOSE_RECOVERY_FAILED, "Document history recovery failed");
  }

  #reportSynchronizationError(error: unknown): void {
    const fingerprint = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    if (fingerprint === this.#lastSynchronizationError) return;
    this.#lastSynchronizationError = fingerprint;
    this.#onSynchronizationError(error);
  }

  #sendClockPing(): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) return;
    const message: ClientClockPingMessage = {
      clientTime: Date.now(),
      requestId: crypto.randomUUID(),
      type: "clock-ping",
    };
    this.#clockRequests.set(message.requestId, message.clientTime);
    while (this.#clockRequests.size > CLOCK_SAMPLE_WINDOW) {
      this.#clockRequests.delete(this.#clockRequests.keys().next().value!);
    }
    socket.send(JSON.stringify(message));
  }

  #applyClockSample(message: Partial<ServerClockPongMessage>): void {
    if (
      typeof message.clientTime !== "number" ||
      typeof message.serverTime !== "number" ||
      typeof message.requestId !== "string" ||
      !Number.isFinite(message.clientTime) ||
      !Number.isFinite(message.serverTime)
    ) {
      return;
    }
    const requestedAt = this.#clockRequests.get(message.requestId);
    if (requestedAt !== message.clientTime) return;
    this.#clockRequests.delete(message.requestId);
    const receivedAt = Date.now();
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

  resynchronize(): void {
    if (this.#stopped) return;
    this.#socket?.close(CLIENT_CLOSE_RESYNCHRONIZE, "Document reconciliation requested");
  }

  #handleClose(socket: WebSocket, code: number): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    if (this.#clockTimer) clearInterval(this.#clockTimer);
    this.#clockTimer = null;
    if (code === 4003 || code === 4004) {
      this.#stopped = true;
      this.#setStatus(code === 4003 ? "revoked" : "unavailable");
      return;
    }
    this.#setStatus("offline");
    if (this.#stopped) return;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    this.#setStatus("offline");
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

function createDocumentRebase(document: Y.Doc): Uint8Array {
  const replacement = new Y.Doc();
  const knownClientIds = Y.decodeStateVector(Y.encodeStateVector(document));
  let replacementClientId = 0xffff_ffff;
  while (knownClientIds.has(replacementClientId)) replacementClientId--;
  replacement.clientID = replacementClientId;
  const source = document.getMap<Y.Map<unknown>>("entities");
  const entities = replacement.getMap<Y.Map<unknown>>("entities");
  replacement.transact(() => {
    for (const [entityId, entity] of source) {
      const next = new Y.Map<unknown>();
      for (const [key, value] of entity) next.set(key, structuredClone(value));
      entities.set(entityId, next);
    }
    replacement.getMap<string>("recovery").set("generation", crypto.randomUUID());
  });
  const update = Y.encodeStateAsUpdate(replacement);
  replaceDocumentWithUpdate(document, update);
  replacement.destroy();
  return update;
}

function replaceDocumentWithUpdate(document: Y.Doc, update: Uint8Array): void {
  document.transact(() => {
    document.getMap("entities").clear();
    document.getMap("recovery").clear();
  }, REMOTE_ORIGIN);
  Y.applyUpdate(document, update, REMOTE_ORIGIN);
  const knownClientIds = Y.decodeStateVector(Y.encodeStateVector(document));
  let clientId: number;
  do {
    clientId = crypto.getRandomValues(new Uint32Array(1))[0]!;
  } while (knownClientIds.has(clientId));
  document.clientID = clientId;
}

function isPromiseLike(value: Promise<WebSocket> | WebSocket): value is Promise<WebSocket> {
  return typeof Reflect.get(value, "then") === "function";
}

export function createPersistedHostedDocument(workspaceId: WorkspaceId): PersistedHostedDocument {
  const document = new Y.Doc({ guid: workspaceId });
  const persistence = new IndexeddbPersistence(
    `voidmesh:hosted:v${HOSTED_DOCUMENT_STORAGE_VERSION}:${workspaceId}`,
    document,
  );
  return {
    async destroy() {
      await persistence.destroy();
      document.destroy();
    },
    document,
    whenSynced: persistence.whenSynced,
  };
}

function hasSameDocumentGeneration(document: Y.Doc, update: Uint8Array): boolean {
  const incoming = new Y.Doc();
  try {
    Y.applyUpdate(incoming, update);
    const incomingGeneration = incoming.getMap("recovery").get("generation");
    const localGeneration = document.getMap("recovery").get("generation");
    return (
      typeof incomingGeneration === "string" &&
      incomingGeneration.length > 0 &&
      incomingGeneration === localGeneration
    );
  } finally {
    incoming.destroy();
  }
}

export function createWorkspaceSocket(
  workspaceId: WorkspaceId,
  baseURL = location.href,
): WebSocket {
  const url = new URL(`/v1/workspaces/${encodeURIComponent(workspaceId)}/connect`, baseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}
