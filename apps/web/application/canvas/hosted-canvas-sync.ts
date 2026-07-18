import type { CanvasEntityMutation } from "#engine";
import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { MediaType, isAnimatedEntity } from "#types/canvas.ts";
import {
  HostedWorkspaceDocument,
  type HostedAssetReference,
  type HostedWorkspaceEntity,
} from "#lib/hosted-workspace-document.ts";

const GEOMETRY_SYNC_INTERVAL_MS = 16;
const PLAYBACK_DRIFT_INTERVAL_MS = 1_000;

export interface HostedCanvasSource {
  getEntity(id: string): ShaderCanvasEntity | undefined;
  getEntities(): readonly ShaderCanvasEntity[];
  subscribeMutations(listener: (mutation: CanvasEntityMutation) => void): () => void;
}

export interface HostedCanvasProjection {
  applyRemoteEntity(entity: HostedWorkspaceEntity, applyPlayback: boolean): Promise<void>;
  applyRemoteEntities(entries: readonly HostedRemoteEntityProjection[]): Promise<void>;
  removeRemoteEntities(entityIds: readonly string[]): void;
}

export interface HostedRemoteEntityProjection {
  applyPlayback: boolean;
  entity: HostedWorkspaceEntity;
}

export interface HostedAssetRegistry {
  getReference(entityId: string): HostedAssetReference | undefined;
  register(entity: ShaderCanvasEntity, signal: AbortSignal): Promise<HostedAssetReference>;
  release(entityId: string): void;
}

export interface HostedCanvasSyncOptions {
  assets: HostedAssetRegistry;
  document: HostedWorkspaceDocument;
  onError(error: unknown): void;
  projection: HostedCanvasProjection;
  source: HostedCanvasSource;
  writable: boolean;
}

/** Coordinates canvas mutations and remote Yjs projections without owning either subsystem. */
export class HostedCanvasSync {
  readonly #assets: HostedAssetRegistry;
  readonly #document: HostedWorkspaceDocument;
  readonly #projection: HostedCanvasProjection;
  readonly #source: HostedCanvasSource;
  readonly #writable: boolean;
  readonly #onError: (error: unknown) => void;
  readonly #abortController = new AbortController();
  readonly #entityRevisions = new Map<string, number>();
  readonly #geometryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #appliedPlaybackCommands = new Map<string, string>();
  readonly #appliedShaderPlaybackCommands = new Map<string, string>();
  #unsubscribeMutations: (() => void) | null = null;
  #unsubscribeDocument: (() => void) | null = null;
  #projectionDepth = 0;
  #reconcileQueued = false;
  #reconcileRunning = false;
  #reconcileAgain = false;
  #pendingRemoteIds = new Set<string>();
  #driftTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: HostedCanvasSyncOptions) {
    this.#assets = options.assets;
    this.#document = options.document;
    this.#onError = options.onError;
    this.#projection = options.projection;
    this.#source = options.source;
    this.#writable = options.writable;
  }

  start(): void {
    if (this.#unsubscribeDocument) return;
    this.#unsubscribeDocument = this.#document.onChange((change) => {
      if (change.shouldProject) this.#scheduleReconcile(change.entityIds);
    });
    if (this.#writable) {
      this.#unsubscribeMutations = this.#source.subscribeMutations((mutation) =>
        this.#handleMutation(mutation),
      );
    }
    this.#scheduleReconcile(this.#document.getEntityIds());
    this.#driftTimer = setInterval(() => this.#refreshPlayback(), PLAYBACK_DRIFT_INTERVAL_MS);
  }

  destroy(): void {
    this.#abortController.abort();
    this.#unsubscribeMutations?.();
    this.#unsubscribeDocument?.();
    this.#unsubscribeMutations = null;
    this.#unsubscribeDocument = null;
    if (this.#driftTimer) clearInterval(this.#driftTimer);
    this.#driftTimer = null;
    for (const timer of this.#geometryTimers.values()) clearTimeout(timer);
    this.#geometryTimers.clear();
  }

  refreshPlayback(): void {
    this.#refreshPlayback();
  }

  #handleMutation(mutation: CanvasEntityMutation): void {
    if (mutation.projected || this.#projectionDepth > 0) return;
    switch (mutation.type) {
      case "add":
        for (const entity of mutation.entities) this.#register(entity.id);
        break;
      case "update":
        for (const { id, updates } of mutation.batch) {
          const entity = this.#source.getEntity(id);
          if (!entity) continue;
          if (!this.#document.getEntity(id) || updates.mediaSource) {
            this.#register(id);
            continue;
          }
          const collaborative = this.#toHostedEntity(entity, this.#assets.getReference(id));
          if (!collaborative) continue;
          if (hasGeometryUpdate(updates)) this.#document.setGeometry(collaborative);
          if (hasIdentityUpdate(updates)) this.#document.setIdentity(collaborative);
          if (updates.shaderType !== undefined || updates.shaderParams !== undefined) {
            this.#document.setAppearance(collaborative);
          }
          if (updates.playback && entity.playback) this.#publishPlayback(entity);
        }
        break;
      case "move":
        for (const id of mutation.entityIds) this.#scheduleGeometry(id);
        break;
      case "remove":
        for (const id of mutation.entityIds) {
          this.#bumpRevision(id);
          this.#assets.release(id);
        }
        this.#document.removeEntities(mutation.entityIds);
        break;
      case "replace":
        void this.#replace(mutation.entities).catch(this.#onError);
        break;
      case "playback": {
        const entity = this.#source.getEntity(mutation.entityId);
        if (entity) this.#publishPlayback(entity);
        break;
      }
    }
  }

  #register(entityId: string): void {
    const entity = this.#source.getEntity(entityId);
    if (!entity) return;
    const revision = this.#bumpRevision(entityId);
    void this.#assets
      .register(entity, this.#abortController.signal)
      .then((asset) => {
        if (this.#entityRevisions.get(entityId) !== revision) return;
        const latest = this.#source.getEntity(entityId);
        if (!latest) return;
        const collaborative = this.#toHostedEntity(latest, asset);
        if (!collaborative) return;
        if (this.#document.getEntity(entityId)) {
          this.#document.setAsset(entityId, asset);
          this.#document.setIdentity(collaborative);
          this.#document.setGeometry(collaborative);
          this.#document.setAppearance(collaborative);
          if (latest.playback) this.#publishPlayback(latest);
        } else this.#document.addEntity(collaborative);
      })
      .catch((error: unknown) => {
        if (!this.#abortController.signal.aborted) this.#onError(error);
      });
  }

  async #replace(entities: readonly ShaderCanvasEntity[]): Promise<void> {
    const replacementIds = new Set(entities.map((entity) => entity.id));
    const removedIds = this.#document
      .getEntityIds()
      .filter((entityId) => !replacementIds.has(entityId));
    const revision = new Map(entities.map((entity) => [entity.id, this.#bumpRevision(entity.id)]));
    const registered = await Promise.all(
      entities.map(async (entity) => ({
        asset: await this.#assets.register(entity, this.#abortController.signal),
        entity,
      })),
    );
    if (this.#abortController.signal.aborted) return;
    const collaborative: HostedWorkspaceEntity[] = [];
    for (const entry of registered) {
      if (this.#entityRevisions.get(entry.entity.id) !== revision.get(entry.entity.id)) continue;
      const latest = this.#source.getEntity(entry.entity.id);
      const converted = latest && this.#toHostedEntity(latest, entry.asset);
      if (converted) collaborative.push(converted);
    }
    for (const entityId of removedIds) this.#assets.release(entityId);
    this.#document.replaceEntities(collaborative);
  }

  #scheduleGeometry(entityId: string): void {
    if (this.#geometryTimers.has(entityId)) return;
    const timer = setTimeout(() => {
      this.#geometryTimers.delete(entityId);
      const entity = this.#source.getEntity(entityId);
      const collaborative =
        entity && this.#toHostedEntity(entity, this.#assets.getReference(entityId));
      if (collaborative) this.#document.setGeometry(collaborative);
    }, GEOMETRY_SYNC_INTERVAL_MS);
    this.#geometryTimers.set(entityId, timer);
  }

  #publishPlayback(entity: ShaderCanvasEntity): void {
    if (!entity.playback || !isAnimatedEntity(entity)) return;
    this.#document.setPlayback(entity.id, entity.playback, entity.mediaSource.duration);
  }

  #scheduleReconcile(entityIds: Iterable<string>): void {
    for (const id of entityIds) this.#pendingRemoteIds.add(id);
    if (this.#reconcileQueued) return;
    this.#reconcileQueued = true;
    queueMicrotask(() => {
      this.#reconcileQueued = false;
      void this.#reconcile();
    });
  }

  async #reconcile(): Promise<void> {
    if (this.#reconcileRunning) {
      this.#reconcileAgain = true;
      return;
    }
    this.#reconcileRunning = true;
    try {
      do {
        this.#reconcileAgain = false;
        const ids = this.#pendingRemoteIds;
        this.#pendingRemoteIds = new Set();
        const removed: string[] = [];
        const changed: HostedWorkspaceEntity[] = [];
        for (const id of ids) {
          const entity = this.#document.getEntity(id);
          if (entity) changed.push(entity);
          else if (this.#source.getEntity(id)) removed.push(id);
        }
        this.#projectionDepth++;
        try {
          if (removed.length > 0) this.#projection.removeRemoteEntities(removed);
          for (const entityId of removed) {
            this.#appliedPlaybackCommands.delete(entityId);
            this.#appliedShaderPlaybackCommands.delete(entityId);
          }
          const projections = changed.map((entity) => ({
            applyPlayback:
              entity.playbackCommandId !== undefined &&
              this.#appliedPlaybackCommands.get(entity.id) !== entity.playbackCommandId,
            entity,
          }));
          await this.#projection.applyRemoteEntities(projections);
          for (const { entity } of projections) {
            if (entity.playbackCommandId) {
              this.#appliedPlaybackCommands.set(entity.id, entity.playbackCommandId);
            } else this.#appliedPlaybackCommands.delete(entity.id);
            if (entity.shaderPlaybackCommandId) {
              this.#appliedShaderPlaybackCommands.set(entity.id, entity.shaderPlaybackCommandId);
            } else this.#appliedShaderPlaybackCommands.delete(entity.id);
          }
        } finally {
          this.#projectionDepth--;
        }
      } while (this.#reconcileAgain || this.#pendingRemoteIds.size > 0);
    } catch (error) {
      this.#onError(error);
    } finally {
      this.#reconcileRunning = false;
    }
  }

  #refreshPlayback(): void {
    for (const [entityId, commandId] of this.#appliedPlaybackCommands) {
      const entity = this.#document.getEntity(entityId);
      if (!entity?.playback || entity.playbackCommandId !== commandId || !entity.playback.isPlaying)
        continue;
      this.#projectionDepth++;
      void this.#projection.applyRemoteEntity(entity, true).finally(() => this.#projectionDepth--);
    }
    for (const [entityId, commandId] of this.#appliedShaderPlaybackCommands) {
      const entity = this.#document.getEntity(entityId);
      if (
        !entity ||
        entity.shaderPlaybackCommandId !== commandId ||
        entity.shaderParams.timeAutoPlay === false
      ) {
        continue;
      }
      this.#projectionDepth++;
      void this.#projection.applyRemoteEntity(entity, false).finally(() => this.#projectionDepth--);
    }
  }

  #toHostedEntity(
    entity: ShaderCanvasEntity,
    asset: HostedAssetReference | undefined,
  ): HostedWorkspaceEntity | null {
    if (!asset) return null;
    return {
      asset,
      edited: entity.edited,
      ...(isAnimatedEntity(entity) && { fps: entity.mediaSource.fps }),
      ...(entity.mediaSource.type === MediaType.video && {
        hasAudio: entity.mediaSource.hasAudio,
      }),
      id: entity.id,
      locked: entity.locked ?? false,
      name: entity.name,
      ...(entity.originalPalette && {
        originalPalette: structuredClone(entity.originalPalette),
      }),
      originalSize: { ...entity.originalSize },
      ...(entity.playback && { playback: { ...entity.playback } }),
      ...(isAnimatedEntity(entity) && {
        playbackDuration: entity.mediaSource.duration,
      }),
      position: { ...entity.position },
      rotation: entity.rotation,
      shaderParams: structuredClone(entity.shaderParams),
      shaderType: entity.shaderType,
      size: { ...entity.size },
      zIndex: entity.zIndex,
    };
  }

  #bumpRevision(entityId: string): number {
    const revision = (this.#entityRevisions.get(entityId) ?? 0) + 1;
    this.#entityRevisions.set(entityId, revision);
    return revision;
  }
}

function hasGeometryUpdate(updates: Partial<ShaderCanvasEntity>): boolean {
  return (
    updates.position !== undefined ||
    updates.size !== undefined ||
    updates.originalSize !== undefined ||
    updates.rotation !== undefined ||
    updates.zIndex !== undefined
  );
}

function hasIdentityUpdate(updates: Partial<ShaderCanvasEntity>): boolean {
  return (
    updates.name !== undefined ||
    updates.locked !== undefined ||
    updates.edited !== undefined ||
    updates.originalPalette !== undefined
  );
}
