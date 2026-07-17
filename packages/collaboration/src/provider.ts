import * as Y from "yjs";
import { IndexeddbPersistence } from "y-indexeddb";
import type { WorkspaceId, WorkspaceRole } from "@voidmesh/domain";
import {
  COLLABORATION_PROTOCOL_VERSION,
  base64UrlToBytes,
  decodeServerYjsUpdate,
  encodeClientYjsUpdate,
  type ClientPresenceMessage,
  type ClientClockPingMessage,
  type ServerAckMessage,
  type ServerHelloMessage,
  type ServerPeerLeftMessage,
  type ServerPresenceMessage,
  type ServerRoleChangedMessage,
  type ServerClockPongMessage,
  type ServerSyncCompleteMessage,
} from "./index.ts";

const REMOTE_ORIGIN = Symbol("voidmesh-hosted-remote");
const EMPTY_YJS_UPDATE_BYTES = 2;
const WEB_SOCKET_OPEN = 1;
const CLOCK_SAMPLE_INTERVAL_MS = 15_000;
const CLOCK_SAMPLE_WINDOW = 8;

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
  socketFactory: () => WebSocket;
}

export class HostedCollaborationProvider {
  readonly #document: Y.Doc;
  readonly #beforeSync: () => Promise<void>;
  readonly #onSynchronizationError: (error: unknown) => void;
  readonly #onClockSample: () => void;
  readonly #persistenceReady: Promise<unknown>;
  readonly #socketFactory: () => WebSocket;
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
    if (origin === REMOTE_ORIGIN || this.#status !== "connected") return;
    this.#sendUpdate(update);
  };

  async #open(): Promise<void> {
    await this.#persistenceReady;
    if (this.#stopped) return;
    this.#setStatus("connecting");
    const socket = this.#socketFactory();
    socket.binaryType = "arraybuffer";
    this.#socket = socket;
    socket.addEventListener("open", () => {
      this.#setStatus("synchronizing");
      this.#sendClockPing();
      this.#clockTimer = setInterval(() => this.#sendClockPing(), CLOCK_SAMPLE_INTERVAL_MS);
    });
    socket.addEventListener("message", (event) => this.#handleMessage(event.data));
    socket.addEventListener("close", (event) => this.#handleClose(socket, event.code));
    socket.addEventListener("error", () => socket.close());
  }

  #handleMessage(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const frame = decodeServerYjsUpdate(data);
      if (frame) Y.applyUpdate(this.#document, frame.update, REMOTE_ORIGIN);
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
      this.#pending.delete((parsed as ServerAckMessage).updateId);
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
      const fingerprint = error instanceof Error ? `${error.name}:${error.message}` : String(error);
      if (fingerprint !== this.#lastSynchronizationError) {
        this.#lastSynchronizationError = fingerprint;
        this.#onSynchronizationError(error);
      }
      socket.close(1013, "Offline assets are not ready");
      return;
    }
    if (this.#socket !== socket || socket.readyState !== WEB_SOCKET_OPEN) return;
    for (const frame of this.#pending.values()) socket.send(frame);
    const offlineDiff = Y.encodeStateAsUpdate(this.#document, stateVector);
    this.#setStatus("connected");
    this.#reconnectAttempt = 0;
    if (offlineDiff.byteLength > EMPTY_YJS_UPDATE_BYTES) this.#sendUpdate(offlineDiff);
  }

  #sendUpdate(update: Uint8Array): void {
    const socket = this.#socket;
    if (!socket || socket.readyState !== WEB_SOCKET_OPEN) return;
    const updateId = crypto.randomUUID();
    const frame = encodeClientYjsUpdate(updateId, update);
    this.#pending.set(updateId, frame);
    socket.send(frame);
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
    this.#socket?.close(1012, "Document reconciliation requested");
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
    const delay = Math.min(30_000, 500 * 2 ** this.#reconnectAttempt++);
    this.#reconnectTimer = setTimeout(() => void this.#open(), delay);
  }

  #setStatus(status: CollaborationConnectionStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}

export function createPersistedHostedDocument(workspaceId: WorkspaceId): PersistedHostedDocument {
  const document = new Y.Doc({ guid: workspaceId });
  const persistence = new IndexeddbPersistence(`voidmesh:hosted:${workspaceId}`, document);
  return {
    async destroy() {
      await persistence.destroy();
      document.destroy();
    },
    document,
    whenSynced: persistence.whenSynced,
  };
}

export function createWorkspaceSocket(
  workspaceId: WorkspaceId,
  baseURL = location.href,
): WebSocket {
  const url = new URL(`/v1/workspaces/${encodeURIComponent(workspaceId)}/connect`, baseURL);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(url);
}
