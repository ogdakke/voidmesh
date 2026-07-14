import { Store } from "#lib/store.ts";

export type CollaborationStatus =
  | "idle"
  | "connecting"
  | "waiting"
  | "connected"
  | "reconnecting"
  | "error";
export type CollaborationErrorCode =
  | "invalid-invite"
  | "relay-unavailable"
  | "signaling-unavailable"
  | "session-failed"
  | "unexpected";
export type CollaborationTransferDirection = "send" | "receive";
export type CollaborationConnectionPath = "unknown" | "direct" | "relay" | "mixed";

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
  assetRequestsPending: number;
  assetReceivesActive: number;
  assetReceiveProgress: number | null;
  assetTransferRetries: number;
  assetHashDurationMs: number;
  assetCompressionDurationMs: number;
  assetDecodeDurationMs: number;
  previewEncodeDurationMs: number;
  previewDecodeDurationMs: number;
  previewPlaceholdersCreated: number;
  previewHydrations: number;
  previewDwellDurationMs: number;
  documentApplyDurationMs: number;
  documentReconcileDurationMs: number;
  lastRoundTripTimeMs: number | null;
  iceCredentialFetchDurationMs: number | null;
  iceCredentialExpiresAt: number | null;
  iceCredentialRefreshes: number;
  iceCredentialRefreshFailures: number;
  connectionPath: CollaborationConnectionPath;
  relayProtocol: string | null;
  lastError: string | null;
  lastErrorCode: CollaborationErrorCode | null;
  transfers: readonly CollaborationTransferMetric[];
  version: number;
}

const MAX_TRANSFER_METRICS = 50;

export class CollaborationMetricsStore extends Store<CollaborationMetricsState> {
  readonly getSnapshot: () => CollaborationMetricsState;
  #realtimePublishTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    super(createInitialState());
    this.getSnapshot = this.createSnapshot("version", (state) => ({
      ...state,
      transfers: state.transfers,
    }));
  }

  beginConnection(roomId: string, startedAt = performance.now()): void {
    this.#clearRealtimePublishTimer();
    Object.assign(this.state, createInitialState(), {
      status: "connecting" as const,
      roomId,
      connectedAt: startedAt,
      version: this.state.version + 1,
    });
    this.notify();
  }

  beginReconnection(roomId: string, startedAt = performance.now()): void {
    this.#clearRealtimePublishTimer();
    Object.assign(this.state, {
      status: "reconnecting" as const,
      roomId,
      peerCount: 0,
      connectedAt: startedAt,
      connectionDurationMs: null,
      connectionPath: "unknown" as const,
      relayProtocol: null,
      version: this.state.version + 1,
    });
    this.notify();
  }

  markReady(now = performance.now()): void {
    this.state.status = this.state.peerCount > 0 ? "connected" : "waiting";
    this.state.connectionDurationMs = Math.max(0, now - (this.state.connectedAt ?? now));
    this.publish();
  }

  markReconnecting(): void {
    if (this.state.status === "idle" || this.state.status === "error") return;
    this.state.status = "reconnecting";
    this.publish();
  }

  setPeerCount(peerCount: number): void {
    if (this.state.peerCount === peerCount) return;
    this.state.peerCount = peerCount;
    if (
      this.state.status === "waiting" ||
      this.state.status === "connected" ||
      (this.state.status === "reconnecting" && peerCount === 0)
    ) {
      this.state.status = peerCount > 0 ? "connected" : "waiting";
    }
    this.publish();
  }

  recordMessage(direction: CollaborationTransferDirection, byteLength: number): void {
    this.#accumulateMessage(direction, byteLength);
    this.publish();
  }

  recordRealtimeMessage(direction: CollaborationTransferDirection, byteLength: number): void {
    this.#accumulateMessage(direction, byteLength);
    if (this.#realtimePublishTimer) return;
    this.#realtimePublishTimer = setTimeout(() => {
      this.#realtimePublishTimer = null;
      this.publish();
    }, 250);
  }

  #accumulateMessage(direction: CollaborationTransferDirection, byteLength: number): void {
    if (direction === "send") {
      this.state.messagesSent++;
      this.state.bytesSent += byteLength;
    } else {
      this.state.messagesReceived++;
      this.state.bytesReceived += byteLength;
    }
  }

  recordDocumentUpdate(direction: CollaborationTransferDirection, byteLength: number): void {
    this.#accumulateMessage(direction, byteLength);
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

  recordPreviewEncodeDuration(durationMs: number): void {
    this.state.previewEncodeDurationMs += durationMs;
    this.publish();
  }

  recordPreviewPlaceholder(decodeDurationMs: number, count = 1): void {
    this.state.previewDecodeDurationMs += decodeDurationMs;
    this.state.previewPlaceholdersCreated += count;
    this.publish();
  }

  recordPreviewHydration(dwellDurationMs: number, count = 1): void {
    this.state.previewHydrations += count;
    this.state.previewDwellDurationMs += dwellDurationMs;
    this.publish();
  }

  recordCompressionDuration(durationMs: number): void {
    this.state.assetCompressionDurationMs += durationMs;
    this.publish();
  }

  recordDocumentApplyDuration(durationMs: number): void {
    this.state.documentApplyDurationMs += durationMs;
    this.publish();
  }

  recordDocumentReconcileDuration(durationMs: number): void {
    this.state.documentReconcileDurationMs += durationMs;
    this.publish();
  }

  recordTransfer(metric: CollaborationTransferMetric): void {
    if (metric.direction === "send") this.state.assetTransfersSent++;
    else this.state.assetTransfersReceived++;
    this.state.transfers = [...this.state.transfers.slice(-(MAX_TRANSFER_METRICS - 1)), metric];
    this.publish();
  }

  setAssetQueue(pending: number, active: number, progress: number | null): void {
    if (
      this.state.assetRequestsPending === pending &&
      this.state.assetReceivesActive === active &&
      this.state.assetReceiveProgress === progress
    ) {
      return;
    }
    this.state.assetRequestsPending = pending;
    this.state.assetReceivesActive = active;
    this.state.assetReceiveProgress = progress;
    this.publish();
  }

  recordAssetTransferRetry(): void {
    this.state.assetTransferRetries++;
    this.publish();
  }

  recordRoundTripTime(durationMs: number): void {
    this.state.lastRoundTripTimeMs = durationMs;
    this.publish();
  }

  recordIceCredentials(durationMs: number, expiresAt: number, isRefresh: boolean): void {
    this.state.iceCredentialFetchDurationMs = durationMs;
    this.state.iceCredentialExpiresAt = expiresAt;
    if (isRefresh) this.state.iceCredentialRefreshes++;
    this.publish();
  }

  recordIceCredentialRefreshFailure(): void {
    this.state.iceCredentialRefreshFailures++;
    this.publish();
  }

  setConnectionPath(path: CollaborationConnectionPath, relayProtocol: string | null): void {
    if (this.state.connectionPath === path && this.state.relayProtocol === relayProtocol) return;
    this.state.connectionPath = path;
    this.state.relayProtocol = relayProtocol;
    this.publish();
  }

  fail(error: unknown, code: CollaborationErrorCode = "unexpected"): void {
    this.state.status = "error";
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.state.lastErrorCode = code;
    this.publish();
  }

  recordIssue(error: unknown, code: CollaborationErrorCode = "unexpected"): void {
    this.state.lastError = error instanceof Error ? error.message : String(error);
    this.state.lastErrorCode = code;
    this.publish();
  }

  reset(): void {
    this.#clearRealtimePublishTimer();
    const version = this.state.version + 1;
    Object.assign(this.state, createInitialState(), { version });
    this.notify();
  }

  private publish(): void {
    this.state.version++;
    this.notify();
  }

  #clearRealtimePublishTimer(): void {
    if (this.#realtimePublishTimer) clearTimeout(this.#realtimePublishTimer);
    this.#realtimePublishTimer = null;
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
    assetRequestsPending: 0,
    assetReceivesActive: 0,
    assetReceiveProgress: null,
    assetTransferRetries: 0,
    assetHashDurationMs: 0,
    assetCompressionDurationMs: 0,
    assetDecodeDurationMs: 0,
    previewEncodeDurationMs: 0,
    previewDecodeDurationMs: 0,
    previewPlaceholdersCreated: 0,
    previewHydrations: 0,
    previewDwellDurationMs: 0,
    documentApplyDurationMs: 0,
    documentReconcileDurationMs: 0,
    lastRoundTripTimeMs: null,
    iceCredentialFetchDurationMs: null,
    iceCredentialExpiresAt: null,
    iceCredentialRefreshes: 0,
    iceCredentialRefreshFailures: 0,
    connectionPath: "unknown",
    relayProtocol: null,
    lastError: null,
    lastErrorCode: null,
    transfers: [],
    version: 0,
  };
}

export const collaborationMetrics = new CollaborationMetricsStore();
