import { canvasStore, type CanvasEntityMutation } from "#engine";
import type { JsonValue } from "trystero";
import {
  CollaborationDocument,
  type CollaborationDocumentChange,
} from "#lib/collaboration/document.ts";
import { AssetHashCache } from "#lib/collaboration/asset-hash-cache.ts";
import { collaborationMetrics, type CollaborationErrorCode } from "#lib/collaboration/metrics.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborativeEntity,
  getEntityAssetBlob,
  getEntityPlaybackDuration,
  hashBlob,
  isReceivedAssetMetadata,
  prepareAssetPayload,
  restoreAssetPayload,
  type CollaborationInvite,
  type CollaborativeAssetDescriptor,
  type CollaborativeEntity,
  type ReceivedAssetMetadata,
} from "#lib/collaboration/protocol.ts";
import { logger } from "#lib/client.logger.ts";
import { getEntityThumbhash } from "#lib/thumbhash.ts";
import type { ColorPalette, MediaPreview, ShaderCanvasEntity } from "#types/canvas.ts";
import type { CollaborationPeerIdentity, CollaborationPeerPresence, Point } from "#types/canvas.ts";
import {
  calculatePeerClockSample,
  isClockSyncMessage,
  monotonicEpochNow,
  type ClockSyncMessage,
} from "#lib/collaboration/clock.ts";
import {
  createPeerIdentity,
  isCollaborationPresenceUpdate,
  type CollaborationPresenceUpdate,
} from "#lib/collaboration/presence.ts";
import {
  HttpIceServerProvider,
  measurePeerConnectionPath,
  type IceServerCredentials,
  type IceServerProvider,
} from "#lib/collaboration/ice-server-provider.ts";
import { AssetRequestPool } from "#lib/collaboration/asset-request-pool.ts";
import { AssetTransferLimiter } from "#lib/collaboration/asset-transfer-limiter.ts";

const APP_ID = "voidmesh-collaboration-v4";
const GEOMETRY_SYNC_INTERVAL_MS = 16;
const SHADER_PLAYBACK_SYNC_INTERVAL_MS = 16;
const PING_INTERVAL_MS = 5_000;
const PLAYBACK_DRIFT_INTERVAL_MS = 1_000;
const PRESENCE_SYNC_INTERVAL_MS = 16;
const ICE_CREDENTIAL_REFRESH_RATIO = 0.75;
const ICE_CREDENTIAL_REFRESH_RETRY_MS = 60_000;
const RECONNECT_RETRY_INITIAL_MS = 1_000;
const RECONNECT_RETRY_MAX_MS = 30_000;
const PEER_RECOVERY_GRACE_MS = 3_000;
const RESUME_PING_TIMEOUT_MS = 3_000;
const MAX_CONCURRENT_ASSET_REQUESTS = 4;
const MAX_CONCURRENT_ASSET_SENDS_PER_PEER = 4;
const MAX_CONCURRENT_ASSET_SEND_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_ASSET_SENDS_GLOBAL = 8;
const MAX_CONCURRENT_ASSET_SEND_BYTES_GLOBAL = 64 * 1024 * 1024;
const MAX_ASSET_SEND_ATTEMPTS = 2;
const ASSET_ACK_TIMEOUT_MS = 120_000;
const ASSET_PROGRESS_TIMEOUT_MS = 20_000;
const ASSET_VERIFY_TIMEOUT_MS = 120_000;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;

interface CollaborationCanvasAdapter {
  adoptRemotePlaceholders(
    entities: readonly CollaborativeEntity[],
    signal: AbortSignal,
  ): Promise<CollaborationProjectionTiming>;
  hydrateRemoteEntities(
    entries: readonly CollaborationHydration[],
    signal: AbortSignal,
  ): Promise<CollaborationProjectionTiming>;
  applyRemotePlayback(entity: CollaborativeEntity): Promise<void>;
  applyRemoteShaderPlayback(entityId: string, time: number, playing: boolean): void;
  updateRemotePresence(presence: CollaborationPeerPresence): void;
  removeRemotePresence(peerId: string): void;
  clearRemotePresence(): void;
  updateRemoteEntity(entity: CollaborativeEntity, applyPlayback: boolean): Promise<void>;
  removeRemoteEntities(entityIds: readonly string[]): void;
  updateRemotePalettes(palettes: readonly ColorPalette[]): void;
}

interface CollaborationProjectionTiming {
  decodeDurationMs: number;
}

interface CollaborationHydration {
  entity: CollaborativeEntity;
  blob: Blob;
}

interface CollaborationRoom {
  leave(): void | Promise<void>;
  getPeers(): Record<string, RTCPeerConnection>;
  ping(peerId: string): Promise<number>;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
}

interface RemotePlaybackAnchor {
  entity: CollaborativeEntity;
  anchoredAt: number;
}

interface RemoteShaderPlaybackAnchor {
  entity: CollaborativeEntity;
  anchoredAt: number;
}

type PendingPresenceUpdate = Omit<CollaborationPresenceUpdate, "sequence">;

interface QueuedAssetSend {
  hash: string;
  attempt: number;
}

interface AssetAckWaiter {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CollaborationService {
  readonly #iceServerProvider: IceServerProvider;
  #adapter: CollaborationCanvasAdapter | null = null;
  #document: CollaborationDocument | null = null;
  #room: CollaborationRoom | null = null;
  #invite: CollaborationInvite | null = null;
  #unsubscribeMutations: (() => void) | null = null;
  #unsubscribeDocumentUpdate: (() => void) | null = null;
  #unsubscribeDocumentChange: (() => void) | null = null;
  #unsubscribeLocalPresence: (() => void) | null = null;
  #sendDocument: ((update: Uint8Array, peerId?: string) => Promise<void>) | null = null;
  #sendInventory: ((hashes: string[], peerId?: string) => Promise<void>) | null = null;
  #sendAssetRequest: ((hash: string, peerId?: string) => Promise<void>) | null = null;
  #sendAsset:
    | ((payload: Uint8Array, metadata: ReceivedAssetMetadata, peerId: string) => Promise<void>)
    | null = null;
  #sendAssetAck: ((hash: string, peerId: string) => Promise<void>) | null = null;
  #sendAssetNack: ((hash: string, peerId: string) => Promise<void>) | null = null;
  #sendClock: ((message: ClockSyncMessage, peerId: string) => Promise<void>) | null = null;
  #sendPresence: ((message: CollaborationPresenceUpdate, peerId?: string) => Promise<void>) | null =
    null;
  #assets = new Map<string, Blob>();
  #assetDescriptors = new Map<string, CollaborativeAssetDescriptor>();
  #assetSources = new Map<string, Set<string>>();
  #pendingAssets = new AssetRequestPool(MAX_CONCURRENT_ASSET_REQUESTS);
  #assetReceiveProgress = new Map<string, number>();
  #assetReceiveStartedAt = new Map<string, number>();
  #assetRequestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #assetSendQueues = new Map<string, QueuedAssetSend[]>();
  #queuedAssetSends = new Map<string, Set<string>>();
  #assetSendWorkers = new Map<string, number>();
  #assetTransferLimiters = new Map<string, AssetTransferLimiter>();
  #globalAssetTransferLimiter = new AssetTransferLimiter(
    MAX_CONCURRENT_ASSET_SENDS_GLOBAL,
    MAX_CONCURRENT_ASSET_SEND_BYTES_GLOBAL,
  );
  #assetAckWaiters = new Map<string, AssetAckWaiter>();
  #pendingMaterializations = new Set<string>();
  #pendingLocalRegistrations = new Set<string>();
  #materializedAssetHashes = new Map<string, string>();
  #appliedPlaybackCommandIds = new Map<string, string>();
  #remotePlaybackAnchors = new Map<string, RemotePlaybackAnchor>();
  #remoteShaderPlaybackAnchors = new Map<string, RemoteShaderPlaybackAnchor>();
  #pendingClockRequests = new Map<string, { peerId: string; sentAt: number }>();
  #bestClockRoundTrips = new Map<string, number>();
  #remotePresences = new Map<string, CollaborationPeerPresence>();
  #remotePresenceSequences = new Map<string, number>();
  #placeholderEntityIds = new Set<string>();
  #placeholderStartedAt = new Map<string, number>();
  #assetTransferIds = new WeakMap<Blob, string>();
  #assetPreviews = new WeakMap<Blob, MediaPreview>();
  #assetHashes = new AssetHashCache();
  #entityRevisions = new Map<string, number>();
  #replaceRevision = 0;
  #geometryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #shaderPlaybackTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingShaderPlaybackEntityIds = new Set<string>();
  #projectionDepth = 0;
  #reconcileQueued = false;
  #reconcileRunning = false;
  #reconcileAgain = false;
  #pendingReconcileEntityIds = new Set<string>();
  #sessionRevision = 0;
  #sessionAbortController: AbortController | null = null;
  #pingTimer: ReturnType<typeof setInterval> | null = null;
  #playbackDriftTimer: ReturnType<typeof setInterval> | null = null;
  #presenceTimer: ReturnType<typeof setTimeout> | null = null;
  #presenceSending = false;
  #presenceSequence = 0;
  #presenceLastSentAt = 0;
  #pendingPresence: PendingPresenceUpdate | null = null;
  #localIdentity: CollaborationPeerIdentity | null = null;
  #localCursor: Point | null = null;
  #localSelectionReference: ReadonlySet<string> | null = null;
  #localSelectedEntityIds: string[] = [];
  #selfId: string | null = null;
  #iceServers: RTCIceServer[] = [];
  #iceCredentialAbortController: AbortController | null = null;
  #iceCredentialRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  #peerConnectionListeners = new Map<string, () => void>();
  #roomLeavePromise: Promise<void> = Promise.resolve();
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #peerRecoveryTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  #connectionAttemptRevision: number | null = null;
  #lifecycleListenersActive = false;

  constructor(iceServerProvider: IceServerProvider = new HttpIceServerProvider()) {
    this.#iceServerProvider = iceServerProvider;
  }

  configure(adapter: CollaborationCanvasAdapter): () => void {
    this.#adapter = adapter;
    return () => {
      if (this.#adapter === adapter) this.#adapter = null;
    };
  }

  get isActive(): boolean {
    return this.#room !== null;
  }

  get invite(): CollaborationInvite | null {
    return this.#invite;
  }

  createEntityId(fallback: () => string): string {
    return this.isActive ? `entity-${crypto.randomUUID()}` : fallback();
  }

  removePalette(paletteId: string): void {
    this.#document?.removePalette(paletteId);
  }

  restorePalette(palette: ColorPalette): void {
    this.#document?.restorePalette(palette);
  }

  async start(invite: CollaborationInvite): Promise<void> {
    if (!this.#adapter) throw new Error("Collaboration canvas adapter is not configured");
    this.stop();
    this.#invite = invite;
    this.#reconnectAttempt = 0;
    this.#addLifecycleListeners();
    await this.#startSession(invite, false);
  }

  async #startSession(invite: CollaborationInvite, reconnecting: boolean): Promise<void> {
    const sessionRevision = ++this.#sessionRevision;
    this.#invite = invite;
    this.#connectionAttemptRevision = sessionRevision;
    const reusedDocument = this.#document !== null;
    if (reconnecting) collaborationMetrics.beginReconnection(invite.roomId);
    else collaborationMetrics.beginConnection(invite.roomId);
    const sessionAbortController = new AbortController();
    this.#sessionAbortController = sessionAbortController;

    const iceCredentialAbortController = new AbortController();
    this.#iceCredentialAbortController = iceCredentialAbortController;
    const credentialStartedAt = performance.now();
    let iceCredentials: IceServerCredentials;
    try {
      iceCredentials = await this.#iceServerProvider.getCredentials(
        iceCredentialAbortController.signal,
      );
    } catch (error) {
      if (this.#sessionRevision !== sessionRevision) return;
      this.#handleReconnectableError(error, "relay-unavailable");
      throw error;
    }
    if (this.#sessionRevision !== sessionRevision) return;
    this.#replaceIceServers(iceCredentials.iceServers);
    collaborationMetrics.recordIceCredentials(
      performance.now() - credentialStartedAt,
      iceCredentials.expiresAt,
      false,
    );

    try {
      const { joinRoom, selfId } = await import("trystero");
      if (this.#sessionRevision !== sessionRevision) return;
      await this.#roomLeavePromise;
      if (this.#sessionRevision !== sessionRevision) return;
      this.#selfId = selfId;
      let document = this.#document;
      if (!document) {
        document = new CollaborationDocument({ sourceId: selfId });
        this.#document = document;
        this.#unsubscribeDocumentUpdate = document.onUpdate((update, isRemote) => {
          if (isRemote || !this.#sendDocument) return;
          void this.#sendDocument(update).catch((error) => this.#reportIssue(error));
        });
        this.#unsubscribeDocumentChange = document.onChange((change) =>
          this.#handleDocumentChange(change),
        );
        this.#unsubscribeMutations = canvasStore.subscribeEntityMutations((mutation) => {
          if (this.#projectionDepth > 0) return;
          this.#handleCanvasMutation(mutation);
        });
      }

      const room = joinRoom(
        {
          appId: APP_ID,
          password: invite.password,
          rtcConfig: { iceServers: this.#iceServers },
        },
        invite.roomId,
        {
          onJoinError: ({ error }) => {
            if (this.#sessionRevision === sessionRevision) {
              this.#handleReconnectableError(error, "signaling-unavailable");
            }
          },
        },
      );
      if (this.#sessionRevision !== sessionRevision) {
        room.leave();
        return;
      }
      this.#room = room;

      const documentAction = room.makeAction<Uint8Array>("document");
      const inventoryAction = room.makeAction<string[]>("inventory");
      const assetRequestAction = room.makeAction<string>("asset-request");
      const assetAction = room.makeAction<Uint8Array>("asset");
      const assetAckAction = room.makeAction<string>("asset-ack");
      const assetNackAction = room.makeAction<string>("asset-nack");
      const clockAction = room.makeAction<ClockSyncMessage>("clock");
      const presenceAction = room.makeAction<JsonValue>("presence");

      this.#sendDocument = async (update, peerId) => {
        await documentAction.send(update, { target: peerId });
        collaborationMetrics.recordDocumentUpdate(
          "send",
          update.byteLength * (peerId ? 1 : Math.max(1, this.#peerCount)),
        );
      };
      this.#sendInventory = async (hashes, peerId) => {
        await inventoryAction.send(hashes, { target: peerId });
        collaborationMetrics.recordMessage("send", estimateJsonBytes(hashes));
      };
      this.#sendAssetRequest = async (hash, peerId) => {
        await assetRequestAction.send(hash, { target: peerId });
        collaborationMetrics.recordMessage("send", hash.length);
      };
      this.#sendAsset = async (payload, metadata, peerId) => {
        const startedAt = performance.now();
        let completed = false;
        await assetAction.send(payload, {
          target: peerId,
          metadata: { ...metadata },
          onProgress: (progress, context) => {
            if (context.peerId === peerId && progress >= 1) completed = true;
          },
        });
        if (!completed) {
          throw new Error(`Asset transfer ${metadata.hash} stopped before all chunks were queued`);
        }
        const durationMs = performance.now() - startedAt;
        collaborationMetrics.recordMessage("send", payload.byteLength);
        collaborationMetrics.recordTransfer({
          assetHash: metadata.hash,
          direction: "send",
          originalBytes: metadata.originalByteLength,
          transmittedBytes: payload.byteLength,
          compression: metadata.compression,
          durationMs,
          throughputBytesPerSecond: bytesPerSecond(payload.byteLength, durationMs),
          peerId,
          completedAt: Date.now(),
        });
      };
      this.#sendAssetAck = async (hash, peerId) => {
        await assetAckAction.send(hash, { target: peerId });
        collaborationMetrics.recordMessage("send", hash.length);
      };
      this.#sendAssetNack = async (hash, peerId) => {
        await assetNackAction.send(hash, { target: peerId });
        collaborationMetrics.recordMessage("send", hash.length);
      };
      this.#sendClock = async (message, peerId) => {
        await clockAction.send(message, { target: peerId });
        collaborationMetrics.recordMessage("send", estimateJsonBytes(message));
      };
      this.#sendPresence = async (message, peerId) => {
        await presenceAction.send(message as unknown as JsonValue, { target: peerId });
        collaborationMetrics.recordRealtimeMessage("send", estimateJsonBytes(message));
      };

      documentAction.onMessage = (update) => {
        const startedAt = performance.now();
        document.applyUpdate(new Uint8Array(update));
        collaborationMetrics.recordDocumentUpdate("receive", update.byteLength);
        collaborationMetrics.recordDocumentApplyDuration(performance.now() - startedAt);
      };
      inventoryAction.onMessage = (hashes, { peerId }) => {
        collaborationMetrics.recordMessage("receive", estimateJsonBytes(hashes));
        for (const hash of hashes) {
          let sources = this.#assetSources.get(hash);
          if (!sources) this.#assetSources.set(hash, (sources = new Set()));
          sources.add(peerId);
        }
        this.#requestMissingAssets();
      };
      assetRequestAction.onMessage = (hash, { peerId }) => {
        collaborationMetrics.recordMessage("receive", hash.length);
        this.#queueAssetSend(hash, peerId);
      };
      assetAction.onReceiveProgress = (progress, { metadata }) => {
        if (!isReceivedAssetMetadata(metadata)) return;
        if (!this.#pendingAssets.has(metadata.hash)) return;
        if (!this.#assetReceiveStartedAt.has(metadata.hash)) {
          this.#assetReceiveStartedAt.set(metadata.hash, performance.now());
        }
        if (progress < 1) this.#assetReceiveProgress.set(metadata.hash, progress);
        else this.#assetReceiveProgress.delete(metadata.hash);
        this.#scheduleAssetRequestTimeout(
          metadata.hash,
          progress < 1 ? ASSET_PROGRESS_TIMEOUT_MS : ASSET_VERIFY_TIMEOUT_MS,
        );
        this.#updateAssetQueueMetrics();
      };
      assetAction.onMessage = (payload, { peerId, metadata }) => {
        void this.#receiveAsset(payload, peerId, metadata).catch((error) => {
          collaborationMetrics.recordAssetTransferRetry();
          logger.warn("[collaboration] asset receive failed; requesting another copy", error);
        });
      };
      assetAckAction.onMessage = (hash, { peerId }) => {
        collaborationMetrics.recordMessage("receive", hash.length);
        this.#resolveAssetAck(peerId, hash);
      };
      assetNackAction.onMessage = (hash, { peerId }) => {
        collaborationMetrics.recordMessage("receive", hash.length);
        const rejectedSend = this.#rejectAssetAck(
          peerId,
          hash,
          new Error(`Peer ${peerId} could not verify asset ${hash}`),
        );
        if (this.#pendingAssets.has(hash)) {
          collaborationMetrics.recordAssetTransferRetry();
          logger.warn(`[collaboration] peer ${peerId} could not send asset ${hash}; retrying`);
          this.#releasePendingAsset(hash);
          this.#requestMissingAssets();
        } else if (!rejectedSend) {
          logger.warn(`[collaboration] received an unexpected rejection for asset ${hash}`);
        }
      };
      clockAction.onMessage = (message, { peerId }) => {
        collaborationMetrics.recordMessage("receive", estimateJsonBytes(message));
        if (!isClockSyncMessage(message)) return;
        const receivedAt = monotonicEpochNow();
        if (message.type === "request") {
          void this.#sendClock?.(
            {
              type: "response",
              requestId: message.requestId,
              requesterSentAt: message.sentAt,
              receiverReceivedAt: receivedAt,
              receiverSentAt: monotonicEpochNow(),
            },
            peerId,
          ).catch((error) => this.#reportIssue(error));
          return;
        }
        const pending = this.#pendingClockRequests.get(message.requestId);
        if (!pending || pending.peerId !== peerId || pending.sentAt !== message.requesterSentAt)
          return;
        this.#pendingClockRequests.delete(message.requestId);
        const sample = calculatePeerClockSample(
          message.requesterSentAt,
          message.receiverReceivedAt,
          message.receiverSentAt,
          receivedAt,
        );
        const bestRoundTrip = this.#bestClockRoundTrips.get(peerId);
        if (bestRoundTrip === undefined || sample.roundTripMs <= bestRoundTrip) {
          this.#bestClockRoundTrips.set(peerId, sample.roundTripMs);
          document.setPeerClockOffset(peerId, sample.offsetMs);
          void this.#refreshRemotePlaybackClock(peerId).catch((error) => this.#reportIssue(error));
        }
      };
      presenceAction.onMessage = (update, { peerId }) => {
        collaborationMetrics.recordRealtimeMessage("receive", estimateJsonBytes(update));
        if (!isCollaborationPresenceUpdate(update)) return;
        const previousSequence = this.#remotePresenceSequences.get(peerId) ?? -1;
        if (update.sequence <= previousSequence) return;
        this.#remotePresenceSequences.set(peerId, update.sequence);
        const previous = this.#remotePresences.get(peerId);
        const identity = update.identity ?? previous ?? createPeerIdentity(peerId);
        const presence: CollaborationPeerPresence = {
          peerId,
          name: identity.name,
          color: [...identity.color],
          cursor: Object.hasOwn(update, "cursor")
            ? update.cursor
              ? { ...update.cursor }
              : null
            : (previous?.cursor ?? null),
          selectedEntityIds: update.selectedEntityIds
            ? [...update.selectedEntityIds]
            : (previous?.selectedEntityIds ?? []),
        };
        this.#remotePresences.set(peerId, presence);
        this.#adapter?.updateRemotePresence(presence);
      };

      room.onPeerJoin = (peerId) => {
        this.#updatePeerCount();
        this.#observePeerConnection(peerId);
        void this.#measureConnectionPaths();
        const sendDocument = this.#sendDocument;
        if (sendDocument) {
          void sendDocument(document.encodeState(), peerId).catch((error) =>
            this.#reportIssue(error),
          );
        }
        void this.#sendInventory?.([...this.#assets.keys()], peerId).catch((error) =>
          this.#reportIssue(error),
        );
        this.#requestClockSync(peerId);
        void this.#sendPresenceSnapshot(peerId).catch((error) => this.#reportIssue(error));
      };
      room.onPeerLeave = (peerId) => {
        for (const sources of this.#assetSources.values()) sources.delete(peerId);
        for (const hash of this.#assetReceiveProgress.keys()) {
          if (this.#pendingAssets.peerFor(hash) === peerId) this.#assetReceiveProgress.delete(hash);
        }
        for (const hash of this.#assetReceiveStartedAt.keys()) {
          if (this.#pendingAssets.peerFor(hash) === peerId)
            this.#assetReceiveStartedAt.delete(hash);
        }
        for (const hash of this.#assetRequestTimers.keys()) {
          if (this.#pendingAssets.peerFor(hash) === peerId) this.#clearAssetRequestTimeout(hash);
        }
        this.#pendingAssets.deletePeer(peerId);
        this.#assetSendQueues.delete(peerId);
        this.#queuedAssetSends.delete(peerId);
        this.#assetSendWorkers.delete(peerId);
        this.#assetTransferLimiters
          .get(peerId)
          ?.cancel(new Error(`Peer ${peerId} left during asset transfer`));
        this.#assetTransferLimiters.delete(peerId);
        this.#rejectAssetAcksForPeer(
          peerId,
          new Error(`Peer ${peerId} left during asset transfer`),
        );
        this.#updateAssetQueueMetrics();
        this.#requestMissingAssets();
        this.#bestClockRoundTrips.delete(peerId);
        this.#remotePresenceSequences.delete(peerId);
        this.#remotePresences.delete(peerId);
        this.#adapter?.removeRemotePresence(peerId);
        this.#peerConnectionListeners.get(peerId)?.();
        this.#peerConnectionListeners.delete(peerId);
        this.#updatePeerCount();
        this.#schedulePeerRecovery();
      };

      collaborationMetrics.markReady();
      this.#reconnectAttempt = 0;
      this.#clearReconnectTimer();
      this.#updatePeerCount();
      this.#scheduleIceCredentialRefresh(iceCredentials, sessionRevision);
      this.#pingTimer = setInterval(() => void this.#measureRoundTripTime(), PING_INTERVAL_MS);
      this.#playbackDriftTimer = setInterval(
        () => void this.#correctPlaybackDrift().catch((error) => this.#reportIssue(error)),
        PLAYBACK_DRIFT_INTERVAL_MS,
      );
      if (!this.#localIdentity) {
        this.#localIdentity = createPeerIdentity(selfId);
        this.#queuePresence({ identity: this.#localIdentity });
      }
      if (!this.#unsubscribeLocalPresence) {
        this.#unsubscribeLocalPresence = canvasStore.subscribeLocalPresence(
          (cursor, selectedEntityIds) => this.#handleLocalPresence(cursor, selectedEntityIds),
        );
      }
      if (!reusedDocument) {
        for (const entity of canvasStore.getState().entities.values()) {
          this.#queueEntityRegistration(entity);
        }
      }
    } catch (error) {
      if (this.#sessionRevision !== sessionRevision || sessionAbortController.signal.aborted)
        return;
      this.#handleReconnectableError(error, "signaling-unavailable");
      throw error;
    } finally {
      if (this.#connectionAttemptRevision === sessionRevision) {
        this.#connectionAttemptRevision = null;
      }
    }
  }

  stop(): void {
    this.#teardownSession(true, false);
  }

  #teardownSession(resetMetrics: boolean, preserveIntent: boolean, preserveDocument = false): void {
    this.#sessionRevision++;
    this.#connectionAttemptRevision = null;
    this.#sessionAbortController?.abort();
    this.#sessionAbortController = null;
    if (!preserveDocument) {
      this.#unsubscribeMutations?.();
      this.#unsubscribeMutations = null;
      this.#unsubscribeDocumentUpdate?.();
      this.#unsubscribeDocumentUpdate = null;
      this.#unsubscribeDocumentChange?.();
      this.#unsubscribeDocumentChange = null;
      this.#unsubscribeLocalPresence?.();
      this.#unsubscribeLocalPresence = null;
      this.#document?.destroy();
      this.#document = null;
    }
    const room = this.#room;
    if (room) {
      const previousLeave = this.#roomLeavePromise;
      this.#roomLeavePromise = Promise.all([
        previousLeave,
        Promise.resolve(room.leave()).catch((error) => {
          logger.warn("[collaboration] room leave failed", error);
        }),
      ]).then(() => undefined);
    }
    this.#room = null;
    if (!preserveIntent) this.#invite = null;
    this.#sendDocument = null;
    this.#sendInventory = null;
    this.#sendAssetRequest = null;
    this.#sendAsset = null;
    this.#sendAssetAck = null;
    this.#sendAssetNack = null;
    this.#sendClock = null;
    this.#sendPresence = null;
    if (!preserveDocument) this.#selfId = null;
    this.#iceServers = [];
    this.#iceCredentialAbortController?.abort();
    this.#iceCredentialAbortController = null;
    if (this.#iceCredentialRefreshTimer) clearTimeout(this.#iceCredentialRefreshTimer);
    this.#iceCredentialRefreshTimer = null;
    this.#pendingAssets.clear();
    this.#assetReceiveProgress.clear();
    this.#assetReceiveStartedAt.clear();
    for (const timer of this.#assetRequestTimers.values()) clearTimeout(timer);
    this.#assetRequestTimers.clear();
    this.#assetSendQueues.clear();
    this.#queuedAssetSends.clear();
    this.#assetSendWorkers.clear();
    for (const limiter of this.#assetTransferLimiters.values()) {
      limiter.cancel(new Error("Collaboration session stopped"));
    }
    this.#assetTransferLimiters.clear();
    this.#globalAssetTransferLimiter.cancel(new Error("Collaboration session stopped"));
    this.#globalAssetTransferLimiter = new AssetTransferLimiter(
      MAX_CONCURRENT_ASSET_SENDS_GLOBAL,
      MAX_CONCURRENT_ASSET_SEND_BYTES_GLOBAL,
    );
    this.#rejectAllAssetAcks(new Error("Collaboration session stopped"));
    if (!preserveDocument) {
      this.#assets.clear();
      this.#assetDescriptors.clear();
    }
    this.#assetSources.clear();
    this.#pendingMaterializations.clear();
    if (!preserveDocument) {
      this.#pendingLocalRegistrations.clear();
      this.#materializedAssetHashes.clear();
      this.#appliedPlaybackCommandIds.clear();
    }
    this.#remotePlaybackAnchors.clear();
    this.#remoteShaderPlaybackAnchors.clear();
    this.#pendingClockRequests.clear();
    this.#bestClockRoundTrips.clear();
    this.#remotePresences.clear();
    this.#remotePresenceSequences.clear();
    this.#adapter?.clearRemotePresence();
    if (!preserveDocument) {
      this.#placeholderEntityIds.clear();
      this.#placeholderStartedAt.clear();
      this.#assetTransferIds = new WeakMap();
      this.#assetPreviews = new WeakMap();
      this.#assetHashes.clear();
      this.#entityRevisions.clear();
    }
    this.#pendingReconcileEntityIds.clear();
    this.#reconcileQueued = false;
    this.#reconcileAgain = false;
    for (const timer of this.#geometryTimers.values()) clearTimeout(timer);
    this.#geometryTimers.clear();
    if (this.#shaderPlaybackTimer) clearTimeout(this.#shaderPlaybackTimer);
    this.#shaderPlaybackTimer = null;
    this.#pendingShaderPlaybackEntityIds.clear();
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    if (this.#playbackDriftTimer) clearInterval(this.#playbackDriftTimer);
    this.#playbackDriftTimer = null;
    if (this.#presenceTimer) clearTimeout(this.#presenceTimer);
    this.#presenceTimer = null;
    this.#presenceSending = false;
    if (!preserveDocument) {
      this.#presenceSequence = 0;
      this.#presenceLastSentAt = 0;
      this.#pendingPresence = null;
      this.#localIdentity = null;
      this.#localCursor = null;
      this.#localSelectionReference = null;
      this.#localSelectedEntityIds = [];
    }
    for (const removeListener of this.#peerConnectionListeners.values()) removeListener();
    this.#peerConnectionListeners.clear();
    if (this.#peerRecoveryTimer) clearTimeout(this.#peerRecoveryTimer);
    this.#peerRecoveryTimer = null;
    if (!preserveIntent) {
      this.#clearReconnectTimer();
      this.#reconnectAttempt = 0;
      this.#removeLifecycleListeners();
    }
    if (resetMetrics) collaborationMetrics.reset();
  }

  #handleCanvasMutation(mutation: CanvasEntityMutation): void {
    switch (mutation.type) {
      case "add":
        for (const entity of mutation.entities) this.#queueEntityRegistration(entity);
        break;
      case "update":
        for (const { id, updates, syncShaderPlayback } of mutation.batch) {
          const entity = canvasStore.getState().entities.get(id);
          if (!entity) continue;
          if (!this.#document?.hasEntity(id) || updates.mediaSource) {
            this.#queueEntityRegistration(entity);
            continue;
          }
          if (
            updates.position ||
            updates.size ||
            updates.originalSize ||
            updates.rotation !== undefined ||
            updates.zIndex !== undefined
          ) {
            this.#document.setGeometry(entity);
          }
          if (
            updates.name !== undefined ||
            updates.locked !== undefined ||
            updates.edited !== undefined ||
            updates.originalPalette !== undefined
          ) {
            this.#document.setIdentity(entity);
          }
          if (updates.shaderType !== undefined || updates.shaderParams !== undefined) {
            this.#document.setAppearance(entity, false);
            if (syncShaderPlayback === true) this.#scheduleShaderPlaybackSync(id);
          }
          if (updates.playback && entity.playback) this.#publishPlayback(entity);
        }
        break;
      case "shaderPlayback":
        this.#flushShaderPlaybackSync(mutation.entityIds);
        break;
      case "move":
        this.#scheduleGeometrySync(mutation.entityId);
        break;
      case "remove":
        for (const entityId of mutation.entityIds) {
          this.#bumpEntityRevision(entityId);
          this.#pendingLocalRegistrations.delete(entityId);
          this.#materializedAssetHashes.delete(entityId);
          this.#appliedPlaybackCommandIds.delete(entityId);
          this.#remotePlaybackAnchors.delete(entityId);
          this.#remoteShaderPlaybackAnchors.delete(entityId);
        }
        this.#document?.removeEntities(mutation.entityIds);
        this.#pruneUnreferencedAssets();
        break;
      case "replace":
        void this.#replaceDocument(mutation.entities).catch((error) => this.#reportIssue(error));
        break;
      case "playback":
        this.#publishPlayback(
          canvasStore.getState().entities.get(mutation.entityId),
          mutation.playback,
        );
        break;
    }
  }

  async #registerEntity(entity: ShaderCanvasEntity): Promise<void> {
    const document = this.#document;
    if (!document) return;
    const blob = getEntityAssetBlob(entity);
    const mimeType = requireBlobMimeType(blob, entity.name);
    const revision = this.#bumpEntityRevision(entity.id);
    this.#pendingLocalRegistrations.add(entity.id);
    if (blob.size > MAX_ASSET_BYTES) {
      this.#reportIssue(
        new Error(
          `${entity.name} is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the collaboration prototype currently supports assets up to 512 MB`,
        ),
      );
      this.#pendingLocalRegistrations.delete(entity.id);
      return;
    }
    const descriptor = this.#createProvisionalDescriptor(entity, blob, mimeType);
    const collaborative = createCollaborativeEntity(entity, descriptor);
    if (document.hasEntity(entity.id)) {
      document.setGeometry(entity);
      document.setIdentity(entity);
      document.setAppearance(entity);
      if (entity.playback) this.#publishPlayback(entity);
      document.setAsset(entity.id, descriptor);
    } else {
      document.addEntity(collaborative);
    }

    const hash = await this.#assetHashes.get(blob, (durationMs) => {
      if (this.#document === document) collaborationMetrics.recordHashDuration(durationMs);
    });
    if (this.#entityRevisions.get(entity.id) !== revision || this.#document !== document) {
      return;
    }

    const completeDescriptor: CollaborativeAssetDescriptor = { ...descriptor, hash };
    this.#assets.set(hash, blob);
    this.#assetDescriptors.set(hash, completeDescriptor);
    this.#materializedAssetHashes.set(entity.id, hash);
    document.setAsset(entity.id, completeDescriptor);
    this.#pendingLocalRegistrations.delete(entity.id);
    void this.#sendInventory?.([hash]);
  }

  #queueEntityRegistration(entity: ShaderCanvasEntity): void {
    void this.#registerEntity(entity).catch((error) => this.#reportIssue(error));
  }

  async #replaceDocument(entities: readonly ShaderCanvasEntity[]): Promise<void> {
    const document = this.#document;
    if (!document) return;
    const replaceRevision = ++this.#replaceRevision;
    this.#pendingLocalRegistrations = new Set(entities.map(({ id }) => id));
    const registrations = entities.map((entity) => {
      const blob = getEntityAssetBlob(entity);
      if (blob.size > MAX_ASSET_BYTES) {
        throw new Error(`${entity.name} exceeds the 512 MB collaboration asset limit`);
      }
      const descriptor = this.#createProvisionalDescriptor(
        entity,
        blob,
        requireBlobMimeType(blob, entity.name),
      );
      return { entity, blob, descriptor };
    });
    document.replaceEntities(
      registrations.map(({ entity, descriptor }) => createCollaborativeEntity(entity, descriptor)),
    );

    const registrationGroups = new Map<Blob, typeof registrations>();
    for (const registration of registrations) {
      let group = registrationGroups.get(registration.blob);
      if (!group) registrationGroups.set(registration.blob, (group = []));
      group.push(registration);
    }
    const completedGroups = await Promise.all(
      [...registrationGroups].map(async ([blob, group]) => ({
        blob,
        group,
        hash: await this.#assetHashes.get(blob, (durationMs) => {
          if (this.#document === document) collaborationMetrics.recordHashDuration(durationMs);
        }),
      })),
    );
    if (replaceRevision !== this.#replaceRevision || this.#document !== document) return;

    const assetUpdates: Array<{
      entityId: string;
      asset: CollaborativeAssetDescriptor;
    }> = [];
    const inventory = new Set<string>();
    for (const { blob, group, hash } of completedGroups) {
      inventory.add(hash);
      for (const { entity, descriptor } of group) {
        const completeDescriptor: CollaborativeAssetDescriptor = { ...descriptor, hash };
        this.#assets.set(hash, blob);
        this.#assetDescriptors.set(hash, completeDescriptor);
        this.#materializedAssetHashes.set(entity.id, hash);
        this.#pendingLocalRegistrations.delete(entity.id);
        assetUpdates.push({ entityId: entity.id, asset: completeDescriptor });
      }
    }
    document.setAssets(assetUpdates);
    void this.#sendInventory?.([...inventory]);
    this.#pruneUnreferencedAssets();
  }

  #scheduleGeometrySync(entityId: string): void {
    if (this.#geometryTimers.has(entityId)) return;
    const timer = setTimeout(() => {
      this.#geometryTimers.delete(entityId);
      const entity = canvasStore.getState().entities.get(entityId);
      if (entity) this.#document?.setGeometry(entity);
    }, GEOMETRY_SYNC_INTERVAL_MS);
    this.#geometryTimers.set(entityId, timer);
  }

  #scheduleShaderPlaybackSync(entityId: string): void {
    this.#pendingShaderPlaybackEntityIds.add(entityId);
    if (this.#shaderPlaybackTimer) return;
    this.#shaderPlaybackTimer = setTimeout(() => {
      this.#shaderPlaybackTimer = null;
      const entityIds = [...this.#pendingShaderPlaybackEntityIds];
      this.#pendingShaderPlaybackEntityIds.clear();
      this.#publishShaderPlayback(entityIds);
    }, SHADER_PLAYBACK_SYNC_INTERVAL_MS);
  }

  #flushShaderPlaybackSync(entityIds: readonly string[]): void {
    for (const entityId of entityIds) this.#pendingShaderPlaybackEntityIds.delete(entityId);
    if (this.#pendingShaderPlaybackEntityIds.size === 0 && this.#shaderPlaybackTimer) {
      clearTimeout(this.#shaderPlaybackTimer);
      this.#shaderPlaybackTimer = null;
    }
    this.#publishShaderPlayback(entityIds);
  }

  #publishShaderPlayback(entityIds: readonly string[]): void {
    const entities: ShaderCanvasEntity[] = [];
    for (const entityId of entityIds) {
      const entity = canvasStore.getState().entities.get(entityId);
      if (entity) entities.push(entity);
    }
    this.#document?.setShaderPlayback(entities);
  }

  #handleDocumentChange(change: CollaborationDocumentChange): void {
    if (!change.isRemote) return;
    if (change.paletteIds.size > 0) {
      this.#adapter?.updateRemotePalettes(this.#document?.getPalettes() ?? []);
    }
    this.#scheduleReconcile(change.entityIds);
  }

  #scheduleReconcile(entityIds: Iterable<string> = []): void {
    for (const entityId of entityIds) this.#pendingReconcileEntityIds.add(entityId);
    if (this.#reconcileQueued) return;
    this.#reconcileQueued = true;
    queueMicrotask(() => {
      this.#reconcileQueued = false;
      void this.#reconcileDocument().catch((error) => this.#reportIssue(error));
    });
  }

  async #reconcileDocument(): Promise<void> {
    if (this.#reconcileRunning) {
      this.#reconcileAgain = true;
      return;
    }
    this.#reconcileRunning = true;
    try {
      do {
        this.#reconcileAgain = false;
        const entityIds = new Set(this.#pendingReconcileEntityIds);
        this.#pendingReconcileEntityIds.clear();
        if (entityIds.size > 0) await this.#reconcileDocumentOnce(entityIds);
      } while (this.#reconcileAgain);
    } finally {
      this.#reconcileRunning = false;
      if (this.#pendingReconcileEntityIds.size > 0) this.#scheduleReconcile();
    }
  }

  async #reconcileDocumentOnce(changedEntityIds: ReadonlySet<string>): Promise<void> {
    const reconcileStartedAt = performance.now();
    const sessionRevision = this.#sessionRevision;
    const adapter = this.#adapter;
    const document = this.#document;
    const signal = this.#sessionAbortController?.signal;
    if (!adapter || !document || !signal || signal.aborted) return;
    const currentState = canvasStore.getState();
    const removedIds: string[] = [];
    const entities: CollaborativeEntity[] = [];
    for (const entityId of changedEntityIds) {
      if (this.#pendingLocalRegistrations.has(entityId)) continue;
      if (!document.hasEntity(entityId)) {
        if (currentState.entities.has(entityId)) removedIds.push(entityId);
        continue;
      }
      const entity = document.getEntity(entityId);
      if (entity) entities.push(entity);
      else this.#reportIssue(new Error(`Ignored invalid collaborative entity ${entityId}`));
    }

    this.#projectionDepth++;
    try {
      signal.throwIfAborted();
      if (removedIds.length > 0) {
        adapter.removeRemoteEntities(removedIds);
        for (const id of removedIds) {
          this.#materializedAssetHashes.delete(id);
          this.#appliedPlaybackCommandIds.delete(id);
          this.#remotePlaybackAnchors.delete(id);
          this.#remoteShaderPlaybackAnchors.delete(id);
          this.#placeholderEntityIds.delete(id);
          this.#placeholderStartedAt.delete(id);
        }
      }
      this.#pruneUnreferencedAssets();

      const placeholders: CollaborativeEntity[] = [];
      const replacedIds: string[] = [];
      for (const entity of entities) {
        if (this.#pendingLocalRegistrations.has(entity.id)) continue;
        const current = canvasStore.getState().entities.get(entity.id);
        const materializedHash = this.#materializedAssetHashes.get(entity.id);
        if (current && entity.asset.hash && materializedHash === entity.asset.hash) {
          continue;
        }
        const needsPlaceholder =
          !current ||
          (!this.#placeholderEntityIds.has(entity.id) &&
            (!entity.asset.hash || materializedHash !== entity.asset.hash));
        if (needsPlaceholder) {
          if (current) replacedIds.push(entity.id);
          placeholders.push(entity);
        }
      }
      if (replacedIds.length > 0) {
        adapter.removeRemoteEntities(replacedIds);
        for (const id of replacedIds) {
          this.#materializedAssetHashes.delete(id);
          this.#appliedPlaybackCommandIds.delete(id);
          this.#remotePlaybackAnchors.delete(id);
          this.#remoteShaderPlaybackAnchors.delete(id);
          this.#placeholderEntityIds.delete(id);
          this.#placeholderStartedAt.delete(id);
        }
      }
      if (placeholders.length > 0) {
        const timing = await adapter.adoptRemotePlaceholders(placeholders, signal);
        signal.throwIfAborted();
        const visibleAt = performance.now();
        for (const entity of placeholders) {
          this.#placeholderEntityIds.add(entity.id);
          this.#placeholderStartedAt.set(entity.id, visibleAt);
        }
        collaborationMetrics.recordPreviewPlaceholder(timing.decodeDurationMs, placeholders.length);
      }
      const adoptedPlaceholderIds = new Set(placeholders.map(({ id }) => id));

      const hydrations: CollaborationHydration[] = [];
      for (const entity of entities) {
        if (this.#pendingLocalRegistrations.has(entity.id)) continue;
        const current = canvasStore.getState().entities.get(entity.id);
        const materializedHash = this.#materializedAssetHashes.get(entity.id);
        const applyPlayback = this.#shouldApplyPlayback(entity);
        if (current && entity.asset.hash && materializedHash === entity.asset.hash) {
          await adapter.updateRemoteEntity(entity, applyPlayback);
          this.#markPlaybackApplied(entity);
          this.#markShaderPlaybackApplied(entity);
          continue;
        }
        if (
          current &&
          !adoptedPlaceholderIds.has(entity.id) &&
          this.#placeholderEntityIds.has(entity.id)
        ) {
          await adapter.updateRemoteEntity(entity, applyPlayback);
          this.#markPlaybackApplied(entity);
          this.#markShaderPlaybackApplied(entity);
        }

        if (!entity.asset.hash) continue;
        const blob = this.#assets.get(entity.asset.hash);
        if (!blob) {
          this.#requestAsset(entity.asset.hash);
          continue;
        }
        if (this.#pendingMaterializations.has(entity.id)) continue;
        this.#pendingMaterializations.add(entity.id);
        hydrations.push({ entity, blob });
      }

      if (hydrations.length > 0) {
        try {
          const timing = await adapter.hydrateRemoteEntities(hydrations, signal);
          signal.throwIfAborted();
          const hydratedAt = performance.now();
          let totalPreviewDwellMs = 0;
          let hydratedPreviewCount = 0;
          for (const { entity } of hydrations) {
            if (this.#placeholderEntityIds.has(entity.id)) {
              this.#placeholderEntityIds.delete(entity.id);
              totalPreviewDwellMs +=
                hydratedAt - (this.#placeholderStartedAt.get(entity.id) ?? hydratedAt);
              hydratedPreviewCount++;
              this.#placeholderStartedAt.delete(entity.id);
            }
            if (entity.asset.hash) {
              this.#materializedAssetHashes.set(entity.id, entity.asset.hash);
            }
            this.#markPlaybackApplied(entity);
            this.#markShaderPlaybackApplied(entity);
          }
          if (hydratedPreviewCount > 0) {
            collaborationMetrics.recordPreviewHydration(totalPreviewDwellMs, hydratedPreviewCount);
          }
          collaborationMetrics.recordDecodeDuration(timing.decodeDurationMs);
        } finally {
          if (this.#sessionRevision === sessionRevision) {
            for (const { entity } of hydrations) {
              this.#pendingMaterializations.delete(entity.id);
            }
          }
        }
      }
    } finally {
      this.#projectionDepth--;
      if (this.#sessionRevision === sessionRevision) {
        collaborationMetrics.recordDocumentReconcileDuration(
          performance.now() - reconcileStartedAt,
        );
      }
    }
  }

  #requestMissingAssets(): void {
    const document = this.#document;
    if (!document) return;
    for (const hash of document.getAssetHashes()) {
      if (!this.#assets.has(hash)) this.#requestAsset(hash);
    }
  }

  #requestAsset(hash: string): void {
    if (this.#pendingAssets.has(hash) || !this.#sendAssetRequest) return;
    const source = this.#assetSources.get(hash)?.values().next().value;
    if (!source || !this.#pendingAssets.add(hash, source)) return;
    this.#scheduleAssetRequestTimeout(hash, ASSET_PROGRESS_TIMEOUT_MS);
    this.#updateAssetQueueMetrics();
    void this.#sendAssetRequest(hash, source).catch((error) => {
      this.#releasePendingAsset(hash);
      collaborationMetrics.recordAssetTransferRetry();
      logger.warn(`[collaboration] could not request asset ${hash}; retrying`, error);
      this.#requestMissingAssets();
    });
  }

  #queueAssetSend(hash: string, peerId: string): void {
    if (!this.#assets.has(hash) || !this.#assetDescriptors.has(hash)) {
      void this.#sendAssetNack?.(hash, peerId).catch((error) =>
        logger.warn(`[collaboration] could not reject missing asset ${hash}`, error),
      );
      return;
    }
    let queued = this.#queuedAssetSends.get(peerId);
    if (!queued) this.#queuedAssetSends.set(peerId, (queued = new Set()));
    if (queued.has(hash)) return;
    queued.add(hash);
    let queue = this.#assetSendQueues.get(peerId);
    if (!queue) this.#assetSendQueues.set(peerId, (queue = []));
    queue.push({ hash, attempt: 0 });
    this.#startAssetSendWorkers(peerId);
  }

  #startAssetSendWorkers(peerId: string): void {
    const queue = this.#assetSendQueues.get(peerId);
    let workerCount = this.#assetSendWorkers.get(peerId) ?? 0;
    while (queue && queue.length > 0 && workerCount < MAX_CONCURRENT_ASSET_SENDS_PER_PEER) {
      workerCount++;
      this.#assetSendWorkers.set(peerId, workerCount);
      void this.#drainAssetSendWorker(peerId);
    }
  }

  async #drainAssetSendWorker(peerId: string): Promise<void> {
    const sessionRevision = this.#sessionRevision;
    try {
      while (this.#sessionRevision === sessionRevision && this.#room?.getPeers()[peerId]) {
        const queue = this.#assetSendQueues.get(peerId);
        const next = queue?.shift();
        if (!next) break;
        try {
          await this.#sendAssetToPeer(next.hash, peerId);
          if (this.#sessionRevision === sessionRevision) {
            this.#queuedAssetSends.get(peerId)?.delete(next.hash);
          }
        } catch (error) {
          if (this.#sessionRevision === sessionRevision) {
            this.#handleAssetSendFailure(next, peerId, error);
          }
        }
      }
    } finally {
      if (this.#sessionRevision === sessionRevision) {
        const workerCount = Math.max(0, (this.#assetSendWorkers.get(peerId) ?? 1) - 1);
        if (workerCount > 0) this.#assetSendWorkers.set(peerId, workerCount);
        else this.#assetSendWorkers.delete(peerId);
        if ((this.#assetSendQueues.get(peerId)?.length ?? 0) > 0) {
          this.#startAssetSendWorkers(peerId);
        } else if (workerCount === 0) {
          this.#assetSendQueues.delete(peerId);
          this.#queuedAssetSends.delete(peerId);
          this.#assetTransferLimiters.delete(peerId);
        }
      }
    }
  }

  #handleAssetSendFailure(next: QueuedAssetSend, peerId: string, error: unknown): void {
    collaborationMetrics.recordAssetTransferRetry();
    logger.warn(
      `[collaboration] asset ${next.hash} send attempt ${next.attempt + 1} failed`,
      error,
    );
    if (next.attempt + 1 < MAX_ASSET_SEND_ATTEMPTS && this.#room?.getPeers()[peerId]) {
      this.#assetSendQueues.get(peerId)?.unshift({ hash: next.hash, attempt: next.attempt + 1 });
      return;
    }
    this.#queuedAssetSends.get(peerId)?.delete(next.hash);
    void this.#sendAssetNack?.(next.hash, peerId).catch((sendError) =>
      logger.warn(`[collaboration] could not report failed asset ${next.hash}`, sendError),
    );
  }

  async #sendAssetToPeer(hash: string, peerId: string): Promise<void> {
    const sessionRevision = this.#sessionRevision;
    const blob = this.#assets.get(hash);
    const descriptor = this.#assetDescriptors.get(hash);
    const sendAsset = this.#sendAsset;
    if (!blob || !descriptor || !sendAsset) {
      throw new Error(`Cannot send unavailable asset ${hash}`);
    }
    let limiter = this.#assetTransferLimiters.get(peerId);
    if (!limiter) {
      limiter = new AssetTransferLimiter(
        MAX_CONCURRENT_ASSET_SENDS_PER_PEER,
        MAX_CONCURRENT_ASSET_SEND_BYTES,
      );
      this.#assetTransferLimiters.set(peerId, limiter);
    }
    const releaseGlobal = await this.#globalAssetTransferLimiter.acquire(blob.size);
    let releasePeer: (() => void) | null = null;
    let acknowledgement: { promise: Promise<void>; cancel: () => void } | null = null;
    try {
      releasePeer = await limiter.acquire(blob.size);
      throwIfSessionChanged(this.#sessionRevision, sessionRevision);
      if (!this.#room?.getPeers()[peerId]) throw new Error(`Peer ${peerId} left before transfer`);
      const compressionStartedAt = performance.now();
      const prepared = await prepareAssetPayload(blob, descriptor.mimeType);
      throwIfSessionChanged(this.#sessionRevision, sessionRevision);
      collaborationMetrics.recordCompressionDuration(performance.now() - compressionStartedAt);
      acknowledgement = this.#createAssetAckWaiter(peerId, hash);
      await sendAsset(
        prepared.bytes,
        {
          transferId: descriptor.transferId,
          hash,
          mimeType: descriptor.mimeType,
          byteLength: descriptor.byteLength,
          filename: descriptor.filename,
          compression: prepared.compression,
          originalByteLength: prepared.originalByteLength,
          protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        },
        peerId,
      );
    } catch (error) {
      acknowledgement?.cancel();
      throw error;
    } finally {
      releasePeer?.();
      releaseGlobal();
    }
    try {
      await acknowledgement.promise;
    } catch (error) {
      acknowledgement.cancel();
      throw error;
    }
  }

  async #receiveAsset(
    payload: ArrayBuffer | Uint8Array,
    peerId: string,
    metadataValue: unknown,
  ): Promise<void> {
    if (!isReceivedAssetMetadata(metadataValue)) {
      this.#reportIssue(new Error("Received asset with invalid metadata"));
      return;
    }
    const sessionRevision = this.#sessionRevision;
    const metadata = metadataValue;
    try {
      if (metadata.originalByteLength > MAX_ASSET_BYTES) {
        throw new Error(`Rejected oversized collaboration asset ${metadata.hash}`);
      }
      if (!this.#assets.has(metadata.hash)) {
        const startedAt = this.#assetReceiveStartedAt.get(metadata.hash) ?? performance.now();
        const blob = await restoreAssetPayload(payload, metadata);
        if (this.#sessionRevision !== sessionRevision) return;
        const hashStartedAt = performance.now();
        const actualHash = await hashBlob(blob);
        if (this.#sessionRevision !== sessionRevision) return;
        collaborationMetrics.recordHashDuration(performance.now() - hashStartedAt);
        if (actualHash !== metadata.hash)
          throw new Error(`Asset hash mismatch for ${metadata.filename}`);

        this.#assets.set(metadata.hash, blob);
        const descriptor = this.#document?.getAssetDescriptor(metadata.hash);
        if (descriptor) this.#assetDescriptors.set(metadata.hash, descriptor);
        const durationMs = performance.now() - startedAt;
        collaborationMetrics.recordMessage("receive", payload.byteLength);
        collaborationMetrics.recordTransfer({
          assetHash: metadata.hash,
          direction: "receive",
          originalBytes: metadata.originalByteLength,
          transmittedBytes: payload.byteLength,
          compression: metadata.compression,
          durationMs,
          throughputBytesPerSecond: bytesPerSecond(payload.byteLength, durationMs),
          peerId,
          completedAt: Date.now(),
        });
        this.#scheduleReconcile(this.#document?.getEntityIdsForAssetHash(metadata.hash) ?? []);
      }
      await this.#sendAssetAck?.(metadata.hash, peerId);
    } catch (error) {
      if (this.#sessionRevision !== sessionRevision) return;
      await this.#sendAssetNack?.(metadata.hash, peerId).catch((sendError) =>
        logger.warn(`[collaboration] could not reject invalid asset ${metadata.hash}`, sendError),
      );
      throw error;
    } finally {
      if (this.#sessionRevision === sessionRevision) {
        this.#releasePendingAsset(metadata.hash);
        this.#requestMissingAssets();
      }
    }
  }

  #releasePendingAsset(hash: string): void {
    this.#pendingAssets.delete(hash);
    this.#assetReceiveProgress.delete(hash);
    this.#assetReceiveStartedAt.delete(hash);
    this.#clearAssetRequestTimeout(hash);
    this.#updateAssetQueueMetrics();
  }

  #scheduleAssetRequestTimeout(hash: string, timeoutMs: number): void {
    this.#clearAssetRequestTimeout(hash);
    this.#assetRequestTimers.set(
      hash,
      setTimeout(() => {
        this.#assetRequestTimers.delete(hash);
        if (!this.#pendingAssets.has(hash)) return;
        collaborationMetrics.recordAssetTransferRetry();
        logger.warn(`[collaboration] asset ${hash} stopped making progress; retrying`);
        this.#releasePendingAsset(hash);
        this.#requestMissingAssets();
      }, timeoutMs),
    );
  }

  #clearAssetRequestTimeout(hash: string): void {
    const timer = this.#assetRequestTimers.get(hash);
    if (timer) clearTimeout(timer);
    this.#assetRequestTimers.delete(hash);
  }

  #updateAssetQueueMetrics(): void {
    const progressValues = [...this.#assetReceiveProgress.values()];
    collaborationMetrics.setAssetQueue(
      this.#pendingAssets.size,
      progressValues.length,
      progressValues.length > 0
        ? progressValues.reduce((sum, progress) => sum + progress, 0) / progressValues.length
        : null,
    );
  }

  #createAssetAckWaiter(
    peerId: string,
    hash: string,
  ): { promise: Promise<void>; cancel: () => void } {
    const key = assetAckKey(peerId, hash);
    const existing = this.#assetAckWaiters.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.reject(new Error(`Asset ${hash} was requested twice by peer ${peerId}`));
    }
    let resolvePromise = () => {};
    let rejectPromise = (_error: Error) => {};
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const timer = setTimeout(() => {
      const waiter = this.#assetAckWaiters.get(key);
      if (!waiter) return;
      this.#assetAckWaiters.delete(key);
      waiter.reject(new Error(`Timed out waiting for peer ${peerId} to verify asset ${hash}`));
    }, ASSET_ACK_TIMEOUT_MS);
    const waiter: AssetAckWaiter = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
      timer,
    };
    this.#assetAckWaiters.set(key, waiter);
    return {
      promise,
      cancel: () => {
        if (this.#assetAckWaiters.get(key) !== waiter) return;
        clearTimeout(waiter.timer);
        this.#assetAckWaiters.delete(key);
        waiter.resolve();
      },
    };
  }

  #resolveAssetAck(peerId: string, hash: string): void {
    const key = assetAckKey(peerId, hash);
    const waiter = this.#assetAckWaiters.get(key);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.#assetAckWaiters.delete(key);
    waiter.resolve();
  }

  #rejectAssetAck(peerId: string, hash: string, error: Error): boolean {
    const key = assetAckKey(peerId, hash);
    const waiter = this.#assetAckWaiters.get(key);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.#assetAckWaiters.delete(key);
    waiter.reject(error);
    return true;
  }

  #rejectAssetAcksForPeer(peerId: string, error: Error): void {
    const prefix = `${peerId}:`;
    for (const [key, waiter] of this.#assetAckWaiters) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(waiter.timer);
      this.#assetAckWaiters.delete(key);
      waiter.reject(error);
    }
  }

  #rejectAllAssetAcks(error: Error): void {
    for (const [key, waiter] of this.#assetAckWaiters) {
      clearTimeout(waiter.timer);
      this.#assetAckWaiters.delete(key);
      waiter.reject(error);
    }
  }

  async #measureRoundTripTime(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    const peerIds = Object.keys(room.getPeers());
    for (const id of peerIds) this.#requestClockSync(id);
    const peerId = peerIds[0];
    if (!peerId) return;
    try {
      collaborationMetrics.recordRoundTripTime(await room.ping(peerId));
      await this.#measureConnectionPaths();
    } catch (error) {
      logger.warn("[collaboration] ping failed", error);
    }
  }

  #scheduleIceCredentialRefresh(credentials: IceServerCredentials, sessionRevision: number): void {
    if (this.#iceCredentialRefreshTimer) clearTimeout(this.#iceCredentialRefreshTimer);
    const remainingMs = Math.max(0, credentials.expiresAt - Date.now());
    const refreshDelayMs = Math.max(1_000, remainingMs * ICE_CREDENTIAL_REFRESH_RATIO);
    this.#iceCredentialRefreshTimer = setTimeout(
      () => void this.#refreshIceCredentials(sessionRevision),
      refreshDelayMs,
    );
  }

  async #refreshIceCredentials(sessionRevision: number): Promise<void> {
    const abortController = this.#iceCredentialAbortController;
    if (!abortController || this.#sessionRevision !== sessionRevision) return;
    const startedAt = performance.now();
    try {
      const credentials = await this.#iceServerProvider.getCredentials(abortController.signal);
      if (this.#sessionRevision !== sessionRevision) return;
      this.#replaceIceServers(credentials.iceServers);
      for (const peer of Object.values(this.#room?.getPeers() ?? {})) {
        peer.setConfiguration({
          ...peer.getConfiguration(),
          iceServers: this.#iceServers,
        });
        peer.restartIce();
      }
      collaborationMetrics.recordIceCredentials(
        performance.now() - startedAt,
        credentials.expiresAt,
        true,
      );
      this.#scheduleIceCredentialRefresh(credentials, sessionRevision);
    } catch (error) {
      if (this.#sessionRevision !== sessionRevision || abortController.signal.aborted) return;
      collaborationMetrics.recordIceCredentialRefreshFailure();
      logger.warn("[collaboration] TURN credential refresh failed; retrying", error);
      this.#iceCredentialRefreshTimer = setTimeout(
        () => void this.#refreshIceCredentials(sessionRevision),
        ICE_CREDENTIAL_REFRESH_RETRY_MS,
      );
    }
  }

  #replaceIceServers(iceServers: readonly RTCIceServer[]): void {
    this.#iceServers.splice(
      0,
      this.#iceServers.length,
      ...iceServers.map((server) => ({
        ...server,
        urls: Array.isArray(server.urls) ? [...server.urls] : server.urls,
      })),
    );
  }

  async #measureConnectionPaths(): Promise<void> {
    const peers = Object.values(this.#room?.getPeers() ?? {});
    if (peers.length === 0) {
      collaborationMetrics.setConnectionPath("unknown", null);
      return;
    }
    const paths = await Promise.all(peers.map(measurePeerConnectionPath));
    const knownPaths = paths.filter((path) => path.type !== "unknown");
    if (knownPaths.length === 0) {
      collaborationMetrics.setConnectionPath("unknown", null);
      return;
    }
    const relayed = knownPaths.filter((path) => path.type === "relay");
    const connectionPath =
      relayed.length === 0 ? "direct" : relayed.length === knownPaths.length ? "relay" : "mixed";
    const relayProtocols = [...new Set(relayed.map((path) => path.protocol).filter(Boolean))];
    collaborationMetrics.setConnectionPath(
      connectionPath,
      relayProtocols.length > 0 ? relayProtocols.join("+") : null,
    );
  }

  #requestClockSync(peerId: string): void {
    for (const [requestId, pending] of this.#pendingClockRequests) {
      if (pending.peerId === peerId) this.#pendingClockRequests.delete(requestId);
    }
    const sentAt = monotonicEpochNow();
    const requestId = crypto.randomUUID();
    this.#pendingClockRequests.set(requestId, { peerId, sentAt });
    void this.#sendClock?.({ type: "request", requestId, sentAt }, peerId).catch((error) =>
      this.#reportIssue(error),
    );
  }

  async #correctPlaybackDrift(): Promise<void> {
    const adapter = this.#adapter;
    if (
      !adapter ||
      (this.#remotePlaybackAnchors.size === 0 && this.#remoteShaderPlaybackAnchors.size === 0)
    ) {
      return;
    }
    const now = performance.now();
    this.#projectionDepth++;
    try {
      for (const [entityId, anchor] of this.#remotePlaybackAnchors) {
        if (!canvasStore.getState().entities.has(entityId)) {
          this.#remotePlaybackAnchors.delete(entityId);
          continue;
        }
        const playback = advancePlayback(anchor.entity, (now - anchor.anchoredAt) / 1_000);
        await adapter.applyRemotePlayback({ ...anchor.entity, playback });
      }
      for (const [entityId, anchor] of this.#remoteShaderPlaybackAnchors) {
        if (!canvasStore.getState().entities.has(entityId)) {
          this.#remoteShaderPlaybackAnchors.delete(entityId);
          continue;
        }
        adapter.applyRemoteShaderPlayback(
          entityId,
          advanceShaderPlayback(anchor.entity, (now - anchor.anchoredAt) / 1_000),
          anchor.entity.shaderParams.timeAutoPlay !== false,
        );
      }
    } finally {
      this.#projectionDepth--;
    }
  }

  async #refreshRemotePlaybackClock(peerId: string): Promise<void> {
    const adapter = this.#adapter;
    const document = this.#document;
    if (!adapter || !document) return;
    const refreshedPlayback: CollaborativeEntity[] = [];
    for (const [entityId, anchor] of this.#remotePlaybackAnchors) {
      if (anchor.entity.playbackSourceId !== peerId) continue;
      const entity = document.getEntity(entityId);
      if (entity && entity.playbackCommandId === anchor.entity.playbackCommandId) {
        refreshedPlayback.push(entity);
      }
    }
    const refreshedShaderPlayback: CollaborativeEntity[] = [];
    for (const [entityId, anchor] of this.#remoteShaderPlaybackAnchors) {
      if (anchor.entity.shaderPlaybackSourceId !== peerId) continue;
      const entity = document.getEntity(entityId);
      if (entity && entity.shaderPlaybackCommandId === anchor.entity.shaderPlaybackCommandId) {
        refreshedShaderPlayback.push(entity);
      }
    }
    if (refreshedPlayback.length === 0 && refreshedShaderPlayback.length === 0) return;
    this.#projectionDepth++;
    try {
      for (const entity of refreshedPlayback) {
        await adapter.applyRemotePlayback(entity);
        this.#markPlaybackApplied(entity);
      }
      for (const entity of refreshedShaderPlayback) {
        adapter.applyRemoteShaderPlayback(
          entity.id,
          entity.shaderParams.time ?? 0,
          entity.shaderParams.timeAutoPlay !== false,
        );
        this.#markShaderPlaybackApplied(entity);
      }
    } finally {
      this.#projectionDepth--;
    }
  }

  #handleLocalPresence(cursor: Point | null, selectedEntityIds: ReadonlySet<string>): void {
    const update: PendingPresenceUpdate = {};
    if (!samePoint(this.#localCursor, cursor)) {
      this.#localCursor = cursor ? { ...cursor } : null;
      update.cursor = this.#localCursor;
    }
    if (this.#localSelectionReference !== selectedEntityIds) {
      this.#localSelectionReference = selectedEntityIds;
      this.#localSelectedEntityIds = [...selectedEntityIds];
      update.selectedEntityIds = this.#localSelectedEntityIds;
    }
    if (Object.keys(update).length > 0) this.#queuePresence(update);
  }

  #queuePresence(update: PendingPresenceUpdate): void {
    this.#pendingPresence = { ...this.#pendingPresence, ...update };
    this.#schedulePresenceFlush();
  }

  #schedulePresenceFlush(): void {
    if (this.#presenceTimer || this.#presenceSending || !this.#pendingPresence) return;
    const delay = Math.max(
      0,
      PRESENCE_SYNC_INTERVAL_MS - (performance.now() - this.#presenceLastSentAt),
    );
    this.#presenceTimer = setTimeout(() => {
      this.#presenceTimer = null;
      void this.#flushPresence().catch((error) => this.#reportIssue(error));
    }, delay);
  }

  async #flushPresence(): Promise<void> {
    const send = this.#sendPresence;
    const pending = this.#pendingPresence;
    if (!send || !pending || this.#presenceSending) return;
    this.#pendingPresence = null;
    this.#presenceSending = true;
    try {
      await send({ ...pending, sequence: ++this.#presenceSequence });
    } finally {
      this.#presenceSending = false;
      this.#presenceLastSentAt = performance.now();
      this.#schedulePresenceFlush();
    }
  }

  async #sendPresenceSnapshot(peerId: string): Promise<void> {
    if (!this.#sendPresence || !this.#localIdentity) return;
    await this.#sendPresence(
      {
        sequence: ++this.#presenceSequence,
        identity: this.#localIdentity,
        cursor: this.#localCursor,
        selectedEntityIds: this.#localSelectedEntityIds,
      },
      peerId,
    );
  }

  #updatePeerCount(): void {
    collaborationMetrics.setPeerCount(this.#peerCount);
  }

  #observePeerConnection(peerId: string): void {
    this.#peerConnectionListeners.get(peerId)?.();
    const connection = this.#room?.getPeers()[peerId];
    if (!connection) return;
    const handleConnectionState = () => {
      if (
        connection.connectionState === "failed" ||
        connection.connectionState === "disconnected"
      ) {
        collaborationMetrics.markReconnecting();
        connection.restartIce();
        this.#schedulePeerRecovery();
      } else if (connection.connectionState === "connected") {
        if (this.#peerRecoveryTimer) clearTimeout(this.#peerRecoveryTimer);
        this.#peerRecoveryTimer = null;
        collaborationMetrics.markReady();
        this.#updatePeerCount();
        void this.#measureConnectionPaths();
      }
    };
    connection.addEventListener("connectionstatechange", handleConnectionState);
    this.#peerConnectionListeners.set(peerId, () =>
      connection.removeEventListener("connectionstatechange", handleConnectionState),
    );
    handleConnectionState();
  }

  #handleOffline = (): void => {
    if (this.#invite) collaborationMetrics.markReconnecting();
  };

  #handleOnline = (): void => {
    this.#scheduleReconnect(0);
  };

  #handleVisibilityChange = (): void => {
    if (document.visibilityState === "visible") void this.#recoverAfterResume();
  };

  #handlePageShow = (event: PageTransitionEvent): void => {
    if (event.persisted) void this.#recoverAfterResume();
  };

  async #recoverAfterResume(): Promise<void> {
    if (!this.#invite) return;
    if (!navigator.onLine) {
      collaborationMetrics.markReconnecting();
      return;
    }
    const room = this.#room;
    const peerIds = Object.keys(room?.getPeers() ?? {});
    if (!room || peerIds.length === 0) {
      this.#scheduleReconnect(0);
      return;
    }
    const sessionRevision = this.#sessionRevision;
    try {
      await withTimeout(room.ping(peerIds[0]!), RESUME_PING_TIMEOUT_MS);
      if (this.#sessionRevision !== sessionRevision) return;
      collaborationMetrics.markReady();
      this.#updatePeerCount();
    } catch {
      if (this.#sessionRevision === sessionRevision) this.#scheduleReconnect(0);
    }
  }

  #schedulePeerRecovery(): void {
    if (this.#peerRecoveryTimer || !this.#invite) return;
    collaborationMetrics.markReconnecting();
    const sessionRevision = this.#sessionRevision;
    this.#peerRecoveryTimer = setTimeout(() => {
      this.#peerRecoveryTimer = null;
      if (this.#sessionRevision !== sessionRevision) return;
      const peers = Object.values(this.#room?.getPeers() ?? {});
      if (peers.some((peer) => peer.connectionState === "connected")) return;
      this.#scheduleReconnect(0);
    }, PEER_RECOVERY_GRACE_MS);
  }

  #scheduleReconnect(delayMs = this.#nextReconnectDelay()): void {
    if (!this.#invite) return;
    collaborationMetrics.markReconnecting();
    if (!navigator.onLine) return;
    this.#clearReconnectTimer();
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnect();
    }, delayMs);
  }

  async #reconnect(): Promise<void> {
    const invite = this.#invite;
    if (!invite || !navigator.onLine) return;
    if (this.#connectionAttemptRevision !== null) {
      this.#scheduleReconnect(250);
      return;
    }
    this.#reconnectAttempt++;
    this.#teardownSession(false, true, true);
    this.#invite = invite;
    try {
      await this.#startSession(invite, true);
    } catch {
      // The failed attempt records diagnostics and schedules the next retry.
    }
  }

  #nextReconnectDelay(): number {
    return Math.min(
      RECONNECT_RETRY_INITIAL_MS * 2 ** this.#reconnectAttempt,
      RECONNECT_RETRY_MAX_MS,
    );
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
  }

  #addLifecycleListeners(): void {
    if (this.#lifecycleListenersActive) return;
    this.#lifecycleListenersActive = true;
    window.addEventListener("online", this.#handleOnline);
    window.addEventListener("offline", this.#handleOffline);
    window.addEventListener("pageshow", this.#handlePageShow);
    document.addEventListener("visibilitychange", this.#handleVisibilityChange);
  }

  #removeLifecycleListeners(): void {
    if (!this.#lifecycleListenersActive) return;
    this.#lifecycleListenersActive = false;
    window.removeEventListener("online", this.#handleOnline);
    window.removeEventListener("offline", this.#handleOffline);
    window.removeEventListener("pageshow", this.#handlePageShow);
    document.removeEventListener("visibilitychange", this.#handleVisibilityChange);
  }

  #pruneUnreferencedAssets(): void {
    const referencedHashes = this.#document?.getAssetHashes() ?? new Set<string>();
    for (const hash of this.#assets.keys()) {
      if (referencedHashes.has(hash)) continue;
      this.#assets.delete(hash);
      this.#assetDescriptors.delete(hash);
      this.#assetSources.delete(hash);
    }
  }

  get #peerCount(): number {
    return this.#room ? Object.keys(this.#room.getPeers()).length : 0;
  }

  #bumpEntityRevision(entityId: string): number {
    const revision = (this.#entityRevisions.get(entityId) ?? 0) + 1;
    this.#entityRevisions.set(entityId, revision);
    return revision;
  }

  #createProvisionalDescriptor(
    entity: ShaderCanvasEntity,
    blob: Blob,
    mimeType: string,
  ): CollaborativeAssetDescriptor {
    let preview = this.#assetPreviews.get(blob);
    if (!preview) {
      const previewStartedAt = performance.now();
      preview = getEntityThumbhash(entity);
      collaborationMetrics.recordPreviewEncodeDuration(performance.now() - previewStartedAt);
      this.#assetPreviews.set(blob, preview);
    }
    let transferId = this.#assetTransferIds.get(blob);
    if (!transferId) {
      transferId = crypto.randomUUID();
      this.#assetTransferIds.set(blob, transferId);
    }
    return {
      transferId,
      mimeType,
      byteLength: blob.size,
      filename: entity.name,
      preview,
    };
  }

  #publishPlayback(entity: ShaderCanvasEntity | undefined, playback = entity?.playback): void {
    if (!entity || !playback || !this.#document) return;
    const commandId = this.#document.setPlayback(
      entity.id,
      playback,
      getEntityPlaybackDuration(entity),
    );
    if (commandId) {
      this.#appliedPlaybackCommandIds.set(entity.id, commandId);
      this.#remotePlaybackAnchors.delete(entity.id);
    }
  }

  #shouldApplyPlayback(entity: CollaborativeEntity): boolean {
    return (
      !!entity.playbackCommandId &&
      this.#appliedPlaybackCommandIds.get(entity.id) !== entity.playbackCommandId
    );
  }

  #markPlaybackApplied(entity: CollaborativeEntity): void {
    if (entity.playbackCommandId) {
      this.#appliedPlaybackCommandIds.set(entity.id, entity.playbackCommandId);
      if (entity.playback && entity.playbackSourceId !== this.#selfId) {
        this.#remotePlaybackAnchors.set(entity.id, {
          entity: { ...entity, playback: { ...entity.playback } },
          anchoredAt: performance.now(),
        });
      } else {
        this.#remotePlaybackAnchors.delete(entity.id);
      }
    }
  }

  #markShaderPlaybackApplied(entity: CollaborativeEntity): void {
    if (!entity.shaderPlaybackCommandId) return;
    if (
      entity.shaderPlaybackSourceId !== this.#selfId &&
      entity.shaderParams.timeAutoPlay !== false
    ) {
      this.#remoteShaderPlaybackAnchors.set(entity.id, {
        entity: {
          ...entity,
          shaderParams: { ...entity.shaderParams },
        },
        anchoredAt: performance.now(),
      });
    } else {
      this.#remoteShaderPlaybackAnchors.delete(entity.id);
    }
  }

  #handleReconnectableError(error: unknown, code: CollaborationErrorCode): void {
    const failedInvite = this.#invite;
    this.#teardownSession(false, true, true);
    this.#invite = failedInvite;
    this.#reportIssue(error, code);
    this.#scheduleReconnect();
  }

  #reportIssue(error: unknown, code: CollaborationErrorCode = "session-failed"): void {
    if (isAbortError(error)) return;
    collaborationMetrics.recordIssue(error, code);
    logger.warn("[collaboration]", error);
  }
}

function advancePlayback(entity: CollaborativeEntity, elapsedSeconds: number) {
  const state = { ...entity.playback! };
  if (!state.isPlaying) return state;
  state.currentTime += Math.max(0, elapsedSeconds) * state.playbackRate;
  const duration = entity.playbackDuration ?? 0;
  if (duration > 0) {
    if (state.loop) state.currentTime %= duration;
    else if (state.currentTime >= duration) {
      state.currentTime = duration;
      state.isPlaying = false;
    }
  }
  return state;
}

function advanceShaderPlayback(entity: CollaborativeEntity, elapsedSeconds: number): number {
  const time = entity.shaderParams.time ?? 0;
  return entity.shaderParams.timeAutoPlay === false ? time : time + Math.max(0, elapsedSeconds);
}

function samePoint(left: Point | null, right: Point | null): boolean {
  if (!left || !right) return left === right;
  return left.x === right.x && left.y === right.y;
}

function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function bytesPerSecond(byteLength: number, durationMs: number): number {
  return durationMs > 0 ? (byteLength / durationMs) * 1000 : 0;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Collaboration connection check timed out")),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function assetAckKey(peerId: string, hash: string): string {
  return `${peerId}:${hash}`;
}

function requireBlobMimeType(blob: Blob, entityName: string): string {
  if (blob.type) return blob.type;
  throw new Error(`Cannot share ${entityName}: its media Blob has no MIME type`);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function throwIfSessionChanged(currentRevision: number, expectedRevision: number): void {
  if (currentRevision !== expectedRevision) {
    throw new DOMException("Collaboration session changed", "AbortError");
  }
}

export const collaborationService = new CollaborationService();
