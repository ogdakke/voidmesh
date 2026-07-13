import { canvasStore, type CanvasEntityMutation } from "#engine";
import { CollaborationDocument } from "#lib/collaboration/document.ts";
import { collaborationMetrics } from "#lib/collaboration/metrics.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  createCollaborativeEntity,
  getEntityAssetBlob,
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
import type { ShaderCanvasEntity } from "#types/canvas.ts";

const APP_ID = "voidmesh-collaboration-v1";
const GEOMETRY_SYNC_INTERVAL_MS = 33;
const PLAYBACK_SYNC_INTERVAL_MS = 250;
const PING_INTERVAL_MS = 5_000;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;

interface CollaborationCanvasAdapter {
  adoptRemoteEntity(entity: CollaborativeEntity, blob: Blob): Promise<void>;
  updateRemoteEntity(entity: CollaborativeEntity): Promise<void>;
  removeRemoteEntities(entityIds: readonly string[]): void;
}

interface CollaborationRoom {
  leave(): void;
  getPeers(): Record<string, RTCPeerConnection>;
  ping(peerId: string): Promise<number>;
  onPeerJoin: ((peerId: string) => void) | null;
  onPeerLeave: ((peerId: string) => void) | null;
}

export class CollaborationService {
  #adapter: CollaborationCanvasAdapter | null = null;
  #document: CollaborationDocument | null = null;
  #room: CollaborationRoom | null = null;
  #invite: CollaborationInvite | null = null;
  #unsubscribeMutations: (() => void) | null = null;
  #unsubscribeDocumentUpdate: (() => void) | null = null;
  #unsubscribeDocumentChange: (() => void) | null = null;
  #sendDocument: ((update: Uint8Array, peerId?: string) => Promise<void>) | null = null;
  #sendInventory: ((hashes: string[], peerId?: string) => Promise<void>) | null = null;
  #sendAssetRequest: ((hash: string, peerId?: string) => Promise<void>) | null = null;
  #sendAsset:
    | ((payload: Uint8Array, metadata: ReceivedAssetMetadata, peerId: string) => Promise<void>)
    | null = null;
  #assets = new Map<string, Blob>();
  #assetDescriptors = new Map<string, CollaborativeAssetDescriptor>();
  #assetSources = new Map<string, Set<string>>();
  #pendingAssets = new Set<string>();
  #pendingMaterializations = new Set<string>();
  #pendingLocalRegistrations = new Set<string>();
  #materializedAssetHashes = new Map<string, string>();
  #entityRevisions = new Map<string, number>();
  #replaceRevision = 0;
  #geometryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #playbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #projectionDepth = 0;
  #reconcileQueued = false;
  #reconcileRunning = false;
  #reconcileAgain = false;
  #lastDocumentEntityIds = new Set<string>();
  #sessionRevision = 0;
  #pingTimer: ReturnType<typeof setInterval> | null = null;

  configure(adapter: CollaborationCanvasAdapter): () => void {
    this.#adapter = adapter;
    return () => {
      if (this.#adapter === adapter) this.#adapter = null;
    };
  }

  get isActive(): boolean {
    return this.#invite !== null;
  }

  get invite(): CollaborationInvite | null {
    return this.#invite;
  }

  createEntityId(fallback: () => string): string {
    return this.isActive ? `entity-${crypto.randomUUID()}` : fallback();
  }

  async start(invite: CollaborationInvite): Promise<void> {
    if (!this.#adapter) throw new Error("Collaboration canvas adapter is not configured");
    this.stop();
    const sessionRevision = ++this.#sessionRevision;
    this.#invite = invite;
    collaborationMetrics.beginConnection(invite.roomId);

    const document = new CollaborationDocument();
    this.#document = document;
    this.#unsubscribeDocumentUpdate = document.onUpdate((update, isRemote) => {
      if (isRemote || !this.#sendDocument) return;
      void this.#sendDocument(update).catch((error) => this.#fail(error));
    });
    this.#unsubscribeDocumentChange = document.onChange(() => this.#scheduleReconcile());
    this.#unsubscribeMutations = canvasStore.subscribeEntityMutations((mutation) => {
      if (this.#projectionDepth > 0) return;
      this.#handleCanvasMutation(mutation);
    });

    const { joinRoom } = await import("trystero");
    if (this.#sessionRevision !== sessionRevision) return;
    const room = joinRoom({ appId: APP_ID, password: invite.password }, invite.roomId, {
      onJoinError: ({ error }) => this.#fail(error),
    });
    this.#room = room;

    const documentAction = room.makeAction<Uint8Array>("document");
    const inventoryAction = room.makeAction<string[]>("inventory");
    const assetRequestAction = room.makeAction<string>("asset-request");
    const assetAction = room.makeAction<Uint8Array>("asset");

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
      await assetAction.send(payload, {
        target: peerId,
        metadata: { ...metadata },
      });
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
      void this.#sendAssetToPeer(hash, peerId).catch((error) => this.#fail(error));
    };
    assetAction.onMessage = (payload, { peerId, metadata }) => {
      void this.#receiveAsset(payload, peerId, metadata).catch((error) => this.#fail(error));
    };

    room.onPeerJoin = (peerId) => {
      this.#updatePeerCount();
      void this.#sendDocument?.(document.encodeState(), peerId).catch((error) => this.#fail(error));
      void this.#sendInventory?.([...this.#assets.keys()], peerId).catch((error) =>
        this.#fail(error),
      );
    };
    room.onPeerLeave = () => this.#updatePeerCount();

    collaborationMetrics.markConnected();
    this.#updatePeerCount();
    this.#pingTimer = setInterval(() => void this.#measureRoundTripTime(), PING_INTERVAL_MS);
    for (const entity of canvasStore.getState().entities.values())
      void this.#registerEntity(entity);
  }

  stop(): void {
    this.#sessionRevision++;
    this.#unsubscribeMutations?.();
    this.#unsubscribeMutations = null;
    this.#unsubscribeDocumentUpdate?.();
    this.#unsubscribeDocumentUpdate = null;
    this.#unsubscribeDocumentChange?.();
    this.#unsubscribeDocumentChange = null;
    this.#document?.destroy();
    this.#document = null;
    this.#room?.leave();
    this.#room = null;
    this.#invite = null;
    this.#sendDocument = null;
    this.#sendInventory = null;
    this.#sendAssetRequest = null;
    this.#sendAsset = null;
    this.#pendingAssets.clear();
    this.#pendingMaterializations.clear();
    this.#pendingLocalRegistrations.clear();
    this.#materializedAssetHashes.clear();
    this.#entityRevisions.clear();
    this.#lastDocumentEntityIds.clear();
    this.#reconcileQueued = false;
    this.#reconcileAgain = false;
    for (const timer of this.#geometryTimers.values()) clearTimeout(timer);
    for (const timer of this.#playbackTimers.values()) clearTimeout(timer);
    this.#geometryTimers.clear();
    this.#playbackTimers.clear();
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    collaborationMetrics.reset();
  }

  #handleCanvasMutation(mutation: CanvasEntityMutation): void {
    switch (mutation.type) {
      case "add":
        for (const entity of mutation.entities) void this.#registerEntity(entity);
        break;
      case "update":
        for (const { id, updates } of mutation.batch) {
          const entity = canvasStore.getState().entities.get(id);
          if (!entity) continue;
          if (!this.#document?.hasEntity(id) || updates.mediaSource) {
            void this.#registerEntity(entity);
            continue;
          }
          if (
            updates.position ||
            updates.size ||
            updates.originalSize ||
            updates.rotation !== undefined
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
            this.#document.setAppearance(entity);
          }
          if (updates.playback && entity.playback) this.#document.setPlayback(id, entity.playback);
        }
        break;
      case "move":
        this.#scheduleGeometrySync(mutation.entityId);
        break;
      case "remove":
        for (const entityId of mutation.entityIds) {
          this.#bumpEntityRevision(entityId);
          this.#pendingLocalRegistrations.delete(entityId);
          this.#materializedAssetHashes.delete(entityId);
        }
        this.#document?.removeEntities(mutation.entityIds);
        break;
      case "replace":
        void this.#replaceDocument(mutation.entities);
        break;
      case "playback":
        this.#schedulePlaybackSync(mutation.entityId);
        break;
    }
  }

  async #registerEntity(entity: ShaderCanvasEntity): Promise<void> {
    const document = this.#document;
    if (!document) return;
    const revision = this.#bumpEntityRevision(entity.id);
    this.#pendingLocalRegistrations.add(entity.id);
    const blob = getEntityAssetBlob(entity);
    if (blob.size > MAX_ASSET_BYTES) {
      this.#fail(
        new Error(
          `${entity.name} is ${(blob.size / 1024 / 1024).toFixed(1)} MB; the collaboration prototype currently supports assets up to 512 MB`,
        ),
      );
      this.#pendingLocalRegistrations.delete(entity.id);
      return;
    }
    const hashStartedAt = performance.now();
    const hash = await hashBlob(blob);
    collaborationMetrics.recordHashDuration(performance.now() - hashStartedAt);
    if (this.#entityRevisions.get(entity.id) !== revision || this.#document !== document) {
      this.#pendingLocalRegistrations.delete(entity.id);
      return;
    }

    const descriptor: CollaborativeAssetDescriptor = {
      hash,
      mimeType: blob.type || "application/octet-stream",
      byteLength: blob.size,
      filename: entity.name,
    };
    this.#assets.set(hash, blob);
    this.#assetDescriptors.set(hash, descriptor);
    this.#materializedAssetHashes.set(entity.id, hash);
    const collaborative = createCollaborativeEntity(entity, descriptor);
    if (document.hasEntity(entity.id)) {
      document.setGeometry(entity);
      document.setIdentity(entity);
      document.setAppearance(entity);
      if (entity.playback) document.setPlayback(entity.id, entity.playback);
      document.setAsset(entity.id, descriptor);
    } else {
      document.addEntity(collaborative);
    }
    this.#pendingLocalRegistrations.delete(entity.id);
    void this.#sendInventory?.([hash]);
  }

  async #replaceDocument(entities: readonly ShaderCanvasEntity[]): Promise<void> {
    const document = this.#document;
    if (!document) return;
    const replaceRevision = ++this.#replaceRevision;
    this.#pendingLocalRegistrations = new Set(entities.map(({ id }) => id));
    const collaborative: CollaborativeEntity[] = [];
    for (const entity of entities) {
      const blob = getEntityAssetBlob(entity);
      const hashStartedAt = performance.now();
      const hash = await hashBlob(blob);
      collaborationMetrics.recordHashDuration(performance.now() - hashStartedAt);
      if (replaceRevision !== this.#replaceRevision || this.#document !== document) return;
      const descriptor = {
        hash,
        mimeType: blob.type || "application/octet-stream",
        byteLength: blob.size,
        filename: entity.name,
      };
      this.#assets.set(hash, blob);
      this.#assetDescriptors.set(hash, descriptor);
      this.#materializedAssetHashes.set(entity.id, hash);
      collaborative.push(createCollaborativeEntity(entity, descriptor));
    }
    this.#pendingLocalRegistrations.clear();
    document.replaceEntities(collaborative);
    void this.#sendInventory?.([...this.#assets.keys()]);
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

  #schedulePlaybackSync(entityId: string): void {
    if (this.#playbackTimers.has(entityId)) return;
    const timer = setTimeout(() => {
      this.#playbackTimers.delete(entityId);
      const entity = canvasStore.getState().entities.get(entityId);
      if (entity?.playback) this.#document?.setPlayback(entityId, entity.playback);
    }, PLAYBACK_SYNC_INTERVAL_MS);
    this.#playbackTimers.set(entityId, timer);
  }

  #scheduleReconcile(): void {
    if (this.#reconcileQueued) return;
    this.#reconcileQueued = true;
    queueMicrotask(() => {
      this.#reconcileQueued = false;
      void this.#reconcileDocument().catch((error) => this.#fail(error));
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
        await this.#reconcileDocumentOnce();
      } while (this.#reconcileAgain);
    } finally {
      this.#reconcileRunning = false;
    }
  }

  async #reconcileDocumentOnce(): Promise<void> {
    const reconcileStartedAt = performance.now();
    const adapter = this.#adapter;
    const document = this.#document;
    if (!adapter || !document) return;
    const entities = document.getEntities();
    const documentIds = new Set(entities.map(({ id }) => id));
    const currentState = canvasStore.getState();
    const removedIds: string[] = [];
    for (const id of this.#lastDocumentEntityIds) {
      if (
        !documentIds.has(id) &&
        currentState.entities.has(id) &&
        !this.#pendingLocalRegistrations.has(id)
      ) {
        removedIds.push(id);
      }
    }
    this.#lastDocumentEntityIds = documentIds;

    this.#projectionDepth++;
    try {
      if (removedIds.length > 0) {
        adapter.removeRemoteEntities(removedIds);
        for (const id of removedIds) this.#materializedAssetHashes.delete(id);
      }
      for (const entity of entities) {
        const current = canvasStore.getState().entities.get(entity.id);
        const materializedHash = this.#materializedAssetHashes.get(entity.id);
        if (current && materializedHash === entity.asset.hash) {
          if (!sameProjectedEntity(current, entity)) await adapter.updateRemoteEntity(entity);
          continue;
        }
        const blob = this.#assets.get(entity.asset.hash);
        if (!blob) {
          this.#requestAsset(entity.asset.hash);
          continue;
        }
        if (this.#pendingMaterializations.has(entity.id)) continue;
        this.#pendingMaterializations.add(entity.id);
        try {
          if (current) adapter.removeRemoteEntities([entity.id]);
          const startedAt = performance.now();
          await adapter.adoptRemoteEntity(entity, blob);
          this.#materializedAssetHashes.set(entity.id, entity.asset.hash);
          collaborationMetrics.recordDecodeDuration(performance.now() - startedAt);
        } finally {
          this.#pendingMaterializations.delete(entity.id);
        }
      }
    } finally {
      this.#projectionDepth--;
      collaborationMetrics.recordDocumentReconcileDuration(performance.now() - reconcileStartedAt);
    }
  }

  #requestMissingAssets(): void {
    const document = this.#document;
    if (!document) return;
    for (const entity of document.getEntities()) {
      if (!this.#assets.has(entity.asset.hash)) this.#requestAsset(entity.asset.hash);
    }
  }

  #requestAsset(hash: string): void {
    if (this.#pendingAssets.has(hash) || !this.#sendAssetRequest) return;
    this.#pendingAssets.add(hash);
    const source = this.#assetSources.get(hash)?.values().next().value;
    void this.#sendAssetRequest(hash, source).catch((error) => {
      this.#pendingAssets.delete(hash);
      this.#fail(error);
    });
  }

  async #sendAssetToPeer(hash: string, peerId: string): Promise<void> {
    const blob = this.#assets.get(hash);
    const descriptor = this.#assetDescriptors.get(hash);
    if (!blob || !descriptor || !this.#sendAsset) return;
    const compressionStartedAt = performance.now();
    const prepared = await prepareAssetPayload(blob, descriptor.mimeType);
    collaborationMetrics.recordCompressionDuration(performance.now() - compressionStartedAt);
    await this.#sendAsset(
      prepared.bytes,
      {
        ...descriptor,
        compression: prepared.compression,
        originalByteLength: prepared.originalByteLength,
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      },
      peerId,
    );
  }

  async #receiveAsset(
    payload: ArrayBuffer | Uint8Array,
    peerId: string,
    metadataValue: unknown,
  ): Promise<void> {
    if (!isReceivedAssetMetadata(metadataValue)) {
      this.#fail(new Error("Received asset with invalid metadata"));
      return;
    }
    const metadata = metadataValue;
    if (metadata.originalByteLength > MAX_ASSET_BYTES) {
      this.#fail(new Error(`Rejected oversized collaboration asset ${metadata.hash}`));
      return;
    }
    const startedAt = performance.now();
    const blob = await restoreAssetPayload(payload, metadata);
    const hashStartedAt = performance.now();
    const actualHash = await hashBlob(blob);
    collaborationMetrics.recordHashDuration(performance.now() - hashStartedAt);
    if (actualHash !== metadata.hash)
      throw new Error(`Asset hash mismatch for ${metadata.filename}`);

    this.#assets.set(metadata.hash, blob);
    this.#assetDescriptors.set(metadata.hash, metadata);
    this.#pendingAssets.delete(metadata.hash);
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
    this.#scheduleReconcile();
  }

  async #measureRoundTripTime(): Promise<void> {
    const room = this.#room;
    if (!room) return;
    const peerId = Object.keys(room.getPeers())[0];
    if (!peerId) return;
    try {
      collaborationMetrics.recordRoundTripTime(await room.ping(peerId));
    } catch (error) {
      logger.warn("[collaboration] ping failed", error);
    }
  }

  #updatePeerCount(): void {
    collaborationMetrics.setPeerCount(this.#peerCount);
  }

  get #peerCount(): number {
    return this.#room ? Object.keys(this.#room.getPeers()).length : 0;
  }

  #bumpEntityRevision(entityId: string): number {
    const revision = (this.#entityRevisions.get(entityId) ?? 0) + 1;
    this.#entityRevisions.set(entityId, revision);
    return revision;
  }

  #fail(error: unknown): void {
    collaborationMetrics.fail(error);
    logger.error("[collaboration]", error);
  }
}

function estimateJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function bytesPerSecond(byteLength: number, durationMs: number): number {
  return durationMs > 0 ? (byteLength / durationMs) * 1000 : 0;
}

function sameProjectedEntity(
  current: ShaderCanvasEntity,
  collaborative: CollaborativeEntity,
): boolean {
  return (
    current.name === collaborative.name &&
    current.position.x === collaborative.position.x &&
    current.position.y === collaborative.position.y &&
    current.size.width === collaborative.size.width &&
    current.size.height === collaborative.size.height &&
    current.originalSize.width === collaborative.originalSize.width &&
    current.originalSize.height === collaborative.originalSize.height &&
    current.zIndex === collaborative.zIndex &&
    current.rotation === collaborative.rotation &&
    (current.locked ?? false) === collaborative.locked &&
    current.edited === collaborative.edited &&
    current.shaderType === collaborative.shaderType &&
    JSON.stringify(current.shaderParams) === JSON.stringify(collaborative.shaderParams) &&
    JSON.stringify(current.originalPalette) === JSON.stringify(collaborative.originalPalette) &&
    samePlayback(current.playback, collaborative.playback)
  );
}

function samePlayback(
  current: ShaderCanvasEntity["playback"],
  collaborative: CollaborativeEntity["playback"],
): boolean {
  if (!current || !collaborative) return current === collaborative;
  return (
    current.isPlaying === collaborative.isPlaying &&
    current.loop === collaborative.loop &&
    current.playbackRate === collaborative.playbackRate &&
    current.muted === collaborative.muted &&
    current.volume === collaborative.volume &&
    Math.abs(current.currentTime - collaborative.currentTime) < 0.15
  );
}

export const collaborationService = new CollaborationService();
