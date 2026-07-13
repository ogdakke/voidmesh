import { Store } from "#lib/store.ts";

export type CollaborationStatus = "idle" | "connecting" | "connected" | "error";
export type CollaborationTransferDirection = "send" | "receive";

export interface CollaborationTransferMetric {
  assetHash: string;
  direction: CollaborationTransferDirection;
  originalBytes: number;
  transmittedBytes: number;
  compression: "identity" | "gzip";
  durationMs: number;
  throughputBytesPerSecond: number;
  peerId: string;
  completedAt: number;
}

export interface CollaborationMetricsState {
  status: CollaborationStatus;
  roomId: string | null;
  peerCount: number;
  connectedAt: number | null;
  connectionDurationMs: number | null;
  bytesSent: number;
  bytesReceived: number;
  messagesSent: number;
  messagesReceived: number;
  documentUpdatesSent: number;
  documentUpdatesReceived: number;
  assetTransfersSent: number;
  assetTransfersReceived: number;
  assetHashDurationMs: number;
  assetDecodeDurationMs: number;
  lastRoundTripTimeMs: number | null;
  lastError: string | null;
  transfers: readonly CollaborationTransferMetric[];
  version: number;
}

const MAX_TRANSFER_METRICS = 50;

export class CollaborationMetricsStore extends Store<CollaborationMetricsState> {
  readonly getSnapshot: () => CollaborationMetricsState;

  constructor() {
    super(createInitialState());
    this.getSnapshot = this.createSnapshot("version", (state) => ({
      ...state,
      transfers: state.transfers,
    }));
  }

  beginConnection(roomId: string, startedAt = performance.now()): void {
    Object.assign(this.state, createInitialState(), {
      status: "connecting" as const,
      roomId,
      connectedAt: startedAt,
      version: this.state.version + 1,
    });
    this.notify();
  }

  markConnected(now = performance.now()): void {
    this.state.status = "connected";
    this.state.connectionDurationMs = Math.max(0, now - (this.state.connectedAt ?? now));
    this.publish();
  }

  setPeerCount(peerCount: number): void {
    if (this.state.peerCount === peerCount) return;
    this.state.peerCount = peerCount;
    this.publish();
  }

  recordMessage(direction: CollaborationTransferDirection, byteLength: number): void {
    if (direction === "send") {
      this.state.messagesSent++;
      this.state.bytesSent += byteLength;
    } else {
      this.state.messagesReceived++;
      this.state.bytesReceived += byteLength;
    }
    this.publish();
  }

  recordDocumentUpdate(direction: CollaborationTransferDirection, byteLength: number): void {
    this.recordMessage(direction, byteLength);
    if (direction === "send") this.state.documentUpdatesSent++;
    else this.state.documentUpdatesReceived++;
    this.publish();
  }

  recordHashDuration(durationMs: number): void {
    this.state.assetHashDurationMs += durationMs;
    this.publish();
  }

  recordDecodeDuration(durationMs: number): void {
    this.state.assetDecodeDurationMs += durationMs;
    this.publish();
  }

  recordTransfer(metric: CollaborationTransferMetric): void {
    if (metric.direction === "send") this.state.assetTransfersSent++;
    else this.state.assetTransfersReceived++;
    this.state.transfers = [...this.state.transfers.slice(-(MAX_TRANSFER_METRICS - 1)), metric];
    this.publish();
  }

  recordRoundTripTime(durationMs: number): void {
    this.state.lastRoundTripTimeMs = durationMs;
    this.publish();
  }

  fail(error: unknown): void {
    this.state.status = "error";
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.publish();
  }

  reset(): void {
    const version = this.state.version + 1;
    Object.assign(this.state, createInitialState(), { version });
    this.notify();
  }

  private publish(): void {
    this.state.version++;
    this.notify();
  }
}

function createInitialState(): CollaborationMetricsState {
  return {
    status: "idle",
    roomId: null,
    peerCount: 0,
    connectedAt: null,
    connectionDurationMs: null,
    bytesSent: 0,
    bytesReceived: 0,
    messagesSent: 0,
    messagesReceived: 0,
    documentUpdatesSent: 0,
    documentUpdatesReceived: 0,
    assetTransfersSent: 0,
    assetTransfersReceived: 0,
    assetHashDurationMs: 0,
    assetDecodeDurationMs: 0,
    lastRoundTripTimeMs: null,
    lastError: null,
    transfers: [],
    version: 0,
  };
}

export const collaborationMetrics = new CollaborationMetricsStore();
