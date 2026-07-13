import { canvasStore, type CanvasEntityMutation } from "#engine";
import { CollaborationDocument } from "#lib/collaboration/document.ts";
import { AssetHashCache } from "#lib/collaboration/asset-hash-cache.ts";
import { collaborationMetrics } from "#lib/collaboration/metrics.ts";
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
import type { MediaPreview, ShaderCanvasEntity } from "#types/canvas.ts";

const APP_ID = "voidmesh-collaboration-v3";
const GEOMETRY_SYNC_INTERVAL_MS = 33;
const PING_INTERVAL_MS = 5_000;
const MAX_ASSET_BYTES = 512 * 1024 * 1024;

interface CollaborationCanvasAdapter {
  adoptRemotePlaceholders(
    entities: readonly CollaborativeEntity[],
  ): Promise<CollaborationProjectionTiming>;
  hydrateRemoteEntities(
    entries: readonly CollaborationHydration[],
  ): Promise<CollaborationProjectionTiming>;
  updateRemoteEntity(entity: CollaborativeEntity, applyPlayback: boolean): Promise<void>;
  removeRemoteEntities(entityIds: readonly string[]): void;
}

interface CollaborationProjectionTiming {
  decodeDurationMs: number;
}

interface CollaborationHydration {
  entity: CollaborativeEntity;
  blob: Blob;
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
  #appliedPlaybackCommandIds = new Map<string, string>();
  #placeholderEntityIds = new Set<string>();
  #placeholderStartedAt = new Map<string, number>();
  #assetTransferIds = new WeakMap<Blob, string>();
  #assetPreviews = new WeakMap<Blob, MediaPreview>();
  #assetHashes = new AssetHashCache();
  #entityRevisions = new Map<string, number>();
  #replaceRevision = 0;
  #geometryTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
    for (const entity of canvasStore.getState().entities.values()) {
      this.#queueEntityRegistration(entity);
    }
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
    this.#appliedPlaybackCommandIds.clear();
    this.#placeholderEntityIds.clear();
    this.#placeholderStartedAt.clear();
    this.#assetTransferIds = new WeakMap();
    this.#assetPreviews = new WeakMap();
    this.#assetHashes.clear();
    this.#entityRevisions.clear();
    this.#lastDocumentEntityIds.clear();
    this.#reconcileQueued = false;
    this.#reconcileAgain = false;
    for (const timer of this.#geometryTimers.values()) clearTimeout(timer);
    this.#geometryTimers.clear();
    if (this.#pingTimer) clearInterval(this.#pingTimer);
    this.#pingTimer = null;
    collaborationMetrics.reset();
  }

  #handleCanvasMutation(mutation: CanvasEntityMutation): void {
    switch (mutation.type) {
      case "add":
        for (const entity of mutation.entities) this.#queueEntityRegistration(entity);
        break;
      case "update":
        for (const { id, updates } of mutation.batch) {
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
          if (updates.playback && entity.playback) this.#publishPlayback(entity);
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
          this.#appliedPlaybackCommandIds.delete(entityId);
        }
        this.#document?.removeEntities(mutation.entityIds);
        break;
      case "replace":
        void this.#replaceDocument(mutation.entities).catch((error) => this.#fail(error));
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
      this.#fail(
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

    const hash = await this.#assetHashes.get(blob, (durationMs) =>
      collaborationMetrics.recordHashDuration(durationMs),
    );
    if (this.#entityRevisions.get(entity.id) !== revision || this.#document !== document) {
      this.#pendingLocalRegistrations.delete(entity.id);
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
    void this.#registerEntity(entity).catch((error) => this.#fail(error));
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
        hash: await this.#assetHashes.get(blob, (durationMs) =>
          collaborationMetrics.recordHashDuration(durationMs),
        ),
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
        for (const id of removedIds) {
          this.#materializedAssetHashes.delete(id);
          this.#appliedPlaybackCommandIds.delete(id);
          this.#placeholderEntityIds.delete(id);
          this.#placeholderStartedAt.delete(id);
        }
      }

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
          this.#placeholderEntityIds.delete(id);
          this.#placeholderStartedAt.delete(id);
        }
      }
      if (placeholders.length > 0) {
        const timing = await adapter.adoptRemotePlaceholders(placeholders);
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
          if (!sameProjectedEntity(current, entity) || applyPlayback) {
            await adapter.updateRemoteEntity(entity, applyPlayback);
            this.#markPlaybackApplied(entity);
          }
          continue;
        }
        if (
          current &&
          !adoptedPlaceholderIds.has(entity.id) &&
          this.#placeholderEntityIds.has(entity.id) &&
          (!sameProjectedEntity(current, entity) || applyPlayback)
        ) {
          await adapter.updateRemoteEntity(entity, applyPlayback);
          this.#markPlaybackApplied(entity);
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
          const timing = await adapter.hydrateRemoteEntities(hydrations);
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
          }
          if (hydratedPreviewCount > 0) {
            collaborationMetrics.recordPreviewHydration(totalPreviewDwellMs, hydratedPreviewCount);
          }
          collaborationMetrics.recordDecodeDuration(timing.decodeDurationMs);
        } finally {
          for (const { entity } of hydrations) {
            this.#pendingMaterializations.delete(entity.id);
          }
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
      if (entity.asset.hash && !this.#assets.has(entity.asset.hash)) {
        this.#requestAsset(entity.asset.hash);
      }
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
    const descriptor = this.#document
      ?.getEntities()
      .find((entity) => entity.asset.hash === metadata.hash)?.asset;
    if (descriptor) this.#assetDescriptors.set(metadata.hash, descriptor);
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
    if (commandId) this.#appliedPlaybackCommandIds.set(entity.id, commandId);
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
    }
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

function requireBlobMimeType(blob: Blob, entityName: string): string {
  if (blob.type) return blob.type;
  throw new Error(`Cannot share ${entityName}: its media Blob has no MIME type`);
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
    JSON.stringify(current.originalPalette) === JSON.stringify(collaborative.originalPalette)
  );
}

export const collaborationService = new CollaborationService();
