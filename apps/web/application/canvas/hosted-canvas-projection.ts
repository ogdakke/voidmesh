import type { WorkspaceId } from "@voidmesh/domain";
import type { CanvasEntityUpdate, CanvasStore } from "#engine";
import type {
  HostedCanvasProjection,
  HostedRemoteEntityProjection,
} from "#application/canvas/hosted-canvas-sync.ts";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { HostedApiClient } from "#lib/hosted-api-client.ts";
import { loadMediaFromBlob, loadVideo } from "#lib/media-loader.ts";
import {
  createImageAsset,
  getImageAssetReferenceCount,
  releaseImageAsset,
  retainImageAsset,
} from "#lib/media-assets.ts";
import {
  createDormantVideoElement,
  disposeEntityMedia,
  disposeMediaSource,
  disposeVideoElement,
  hasActiveVideoSource,
} from "#lib/media-resources.ts";
import type { HostedWorkspaceEntity } from "#lib/hosted-workspace-document.ts";
import type { HostedAssetCache } from "#lib/hosted-asset-cache.ts";
import {
  MediaType,
  isGifEntity,
  isVideoEntity,
  type MediaImageAsset,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";

const PLAYBACK_DRIFT_TOLERANCE_SECONDS = 0.15;
const MAX_CONCURRENT_REMOTE_ASSET_LOADS = 4;

interface StagedRemoteEntity extends HostedRemoteEntityProjection {
  media: Pick<ShaderCanvasEntity, "imageBitmap" | "mediaSource">;
  revision: number;
}

interface HostedVideoTemplate {
  alphaMode: Extract<
    ShaderCanvasEntity,
    { mediaSource: { type: "video" } }
  >["mediaSource"]["alphaMode"];
  blob: Blob;
  duration: number;
  fps: number | null;
  hasAudio: boolean;
  posterAsset: MediaImageAsset;
  released: boolean;
}

export interface HostedCanvasProjectionOptions {
  api: HostedApiClient;
  assets: R2HostedAssetRegistry;
  cache: HostedAssetCache;
  beforeRemoveEntity?(entityId: string): void;
  onAutoplayBlocked?(entity: HostedWorkspaceEntity): void;
  onCacheError?(error: unknown): void;
  onError(error: unknown): void;
  requestRender(entityId?: string): void;
  store: CanvasStore;
  workspaceId: WorkspaceId;
}

export class HostedCanvasProjectionService implements HostedCanvasProjection {
  readonly #api: HostedApiClient;
  readonly #assets: R2HostedAssetRegistry;
  readonly #cache: HostedAssetCache;
  readonly #beforeRemoveEntity: (entityId: string) => void;
  readonly #onAutoplayBlocked: (entity: HostedWorkspaceEntity) => void;
  readonly #onCacheError: (error: unknown) => void;
  readonly #onError: (error: unknown) => void;
  readonly #requestRender: (entityId?: string) => void;
  readonly #store: CanvasStore;
  readonly #workspaceId: WorkspaceId;
  readonly #assetBlobs = new Map<string, Promise<Blob>>();
  readonly #sharedImages = new Map<string, MediaImageAsset>();
  readonly #videoTemplates = new Map<string, Promise<HostedVideoTemplate>>();
  readonly #entityAssets = new Map<string, string>();
  readonly #entityBlobKeys = new Map<string, string>();
  readonly #blobEntityCounts = new Map<string, number>();
  readonly #entityRevisions = new Map<string, number>();
  readonly #autoplayBlocked = new Set<string>();

  constructor(options: HostedCanvasProjectionOptions) {
    this.#api = options.api;
    this.#assets = options.assets;
    this.#cache = options.cache;
    this.#beforeRemoveEntity = options.beforeRemoveEntity ?? (() => {});
    this.#onAutoplayBlocked = options.onAutoplayBlocked ?? (() => {});
    this.#onCacheError = options.onCacheError ?? options.onError;
    this.#onError = options.onError;
    this.#requestRender = options.requestRender;
    this.#store = options.store;
    this.#workspaceId = options.workspaceId;
  }

  destroy(): void {
    for (const pending of this.#videoTemplates.values()) this.#releaseVideoTemplate(pending);
    this.#videoTemplates.clear();
  }

  async applyRemoteEntity(entity: HostedWorkspaceEntity, applyPlayback: boolean): Promise<void> {
    const current = this.#store.getState().entities.get(entity.id);
    if (!current || this.#entityAssets.get(entity.id) !== entity.asset.id) {
      await this.#materialize(entity, applyPlayback);
      return;
    }
    this.#store.updateEntity(entity.id, toCanvasUpdates(entity, applyPlayback), true);
    const updated = this.#store.getState().entities.get(entity.id);
    if (applyPlayback && updated) await this.#applyPlayback(updated, entity);
    this.#requestRender(entity.id);
  }

  async applyRemoteEntities(entries: readonly HostedRemoteEntityProjection[]): Promise<void> {
    if (entries.length === 0) return;

    const staged = new Array<StagedRemoteEntity | null>(entries.length).fill(null);
    const errors: unknown[] = [];
    const groups = groupProjectionIndicesByAsset(entries);
    let nextGroupIndex = 0;
    const loadNextGroup = async (): Promise<void> => {
      while (nextGroupIndex < groups.length) {
        const group = groups[nextGroupIndex++]!;
        for (const index of group) {
          const entry = entries[index]!;
          const current = this.#store.getState().entities.get(entry.entity.id);
          if (current && this.#entityAssets.get(entry.entity.id) === entry.entity.asset.id) {
            continue;
          }
          try {
            staged[index] = await this.#stageRemoteEntity(entry);
          } catch (error) {
            errors.push(error);
          }
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_REMOTE_ASSET_LOADS, groups.length) },
        loadNextGroup,
      ),
    );

    const additions: ShaderCanvasEntity[] = [];
    const updates: CanvasEntityUpdate[] = [];
    const replacements: Array<{
      collaborative: HostedWorkspaceEntity;
      next: ShaderCanvasEntity;
      previous: ShaderCanvasEntity | undefined;
    }> = [];
    const playback: HostedRemoteEntityProjection[] = [];

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]!;
      const prepared = staged[index];
      if (!prepared) {
        const current = this.#store.getState().entities.get(entry.entity.id);
        if (current && this.#entityAssets.get(entry.entity.id) === entry.entity.asset.id) {
          updates.push({
            id: entry.entity.id,
            updates: toCanvasUpdates(entry.entity, entry.applyPlayback),
          });
          playback.push(entry);
        }
        continue;
      }
      if (this.#entityRevisions.get(entry.entity.id) !== prepared.revision) {
        this.#disposeStagedRemoteEntity(prepared);
        continue;
      }
      const previous = this.#store.getState().entities.get(entry.entity.id);
      const next = {
        ...prepared.media,
        ...toCanvasFields(entry.entity),
        textureDirty: true,
      } as ShaderCanvasEntity;
      if (previous) {
        this.#beforeRemoveEntity(entry.entity.id);
        updates.push({ id: entry.entity.id, updates: next });
      } else additions.push(next);
      replacements.push({ collaborative: entry.entity, next, previous });
      playback.push(entry);
    }

    this.#store.updateEntities(updates, true);
    this.#store.addEntities(additions, true);
    for (const { collaborative, next, previous } of replacements) {
      if (previous) this.#releaseEntity(previous);
      this.#bindEntityAsset(collaborative.id, collaborative.asset);
      this.#assets.adopt(collaborative.id, collaborative.asset, getEntityBlob(next));
    }
    for (const entry of playback) {
      if (!entry.applyPlayback) continue;
      const current = this.#store.getState().entities.get(entry.entity.id);
      if (current) await this.#applyPlayback(current, entry.entity);
    }
    if (updates.length > 0 || additions.length > 0) this.#requestRender();
    if (errors.length === 1) this.#onError(errors[0]);
    else if (errors.length > 1) {
      this.#onError(
        new AggregateError(errors, `${errors.length} hosted media items could not be loaded`),
      );
    }
  }

  removeRemoteEntities(entityIds: readonly string[]): void {
    const removed = new Set<string>();
    const resources: ShaderCanvasEntity[] = [];
    for (const id of entityIds) {
      this.#bumpRevision(id);
      const entity = this.#store.getState().entities.get(id);
      if (!entity) continue;
      if (isVideoEntity(entity)) entity.mediaSource.videoElement.pause();
      else if (isGifEntity(entity) && entity.playback) entity.playback.isPlaying = false;
      this.#beforeRemoveEntity(id);
      removed.add(id);
      resources.push(entity);
    }
    this.#store.removeEntities(removed, true);
    for (const entity of resources) this.#releaseEntity(entity);
    for (const id of removed) {
      this.#assets.release(id);
      this.#autoplayBlocked.delete(id);
    }
    if (removed.size > 0) this.#requestRender();
  }

  async #materialize(entity: HostedWorkspaceEntity, applyPlayback: boolean): Promise<void> {
    const revision = this.#bumpRevision(entity.id);
    const media = await this.#loadMedia(entity);
    if (this.#entityRevisions.get(entity.id) !== revision) {
      if (
        media.mediaSource.type === MediaType.image &&
        this.#sharedImages.get(entity.asset.id) === media.mediaSource.asset &&
        getImageAssetReferenceCount(media.mediaSource.asset) === 1
      ) {
        this.#sharedImages.delete(entity.asset.id);
      }
      disposeMediaSource(media.mediaSource, media.imageBitmap);
      return;
    }
    const previous = this.#store.getState().entities.get(entity.id);
    const next = {
      ...media,
      ...toCanvasFields(entity),
      textureDirty: true,
    } as ShaderCanvasEntity;
    this.#beforeRemoveEntity(entity.id);
    if (previous) this.#store.updateEntity(entity.id, next, true);
    else this.#store.addEntity(next, true);
    if (previous) this.#releaseEntity(previous);
    this.#bindEntityAsset(entity.id, entity.asset);
    this.#assets.adopt(entity.id, entity.asset, getEntityBlob(next));
    if (applyPlayback) await this.#applyPlayback(next, entity);
    this.#requestRender(entity.id);
  }

  async #stageRemoteEntity(entry: HostedRemoteEntityProjection): Promise<StagedRemoteEntity> {
    const revision = this.#bumpRevision(entry.entity.id);
    return {
      ...entry,
      media: await this.#loadMedia(entry.entity),
      revision,
    };
  }

  #disposeStagedRemoteEntity(entry: StagedRemoteEntity): void {
    if (
      entry.media.mediaSource.type === MediaType.image &&
      this.#sharedImages.get(entry.entity.asset.id) === entry.media.mediaSource.asset &&
      getImageAssetReferenceCount(entry.media.mediaSource.asset) === 1
    ) {
      this.#sharedImages.delete(entry.entity.asset.id);
    }
    disposeMediaSource(entry.media.mediaSource, entry.media.imageBitmap);
  }

  async #loadMedia(
    entity: HostedWorkspaceEntity,
  ): Promise<Pick<ShaderCanvasEntity, "imageBitmap" | "mediaSource">> {
    if (entity.asset.mediaType === MediaType.video) {
      const template = await this.#getVideoTemplate(entity);
      retainImageAsset(template.posterAsset);
      return {
        imageBitmap: template.posterAsset.imageBitmap,
        mediaSource: {
          alphaMode: template.alphaMode,
          blob: template.blob,
          duration: template.duration,
          fps: template.fps,
          hasAudio: template.hasAudio,
          posterAsset: template.posterAsset,
          type: MediaType.video,
          videoElement: createDormantVideoElement(),
        },
      };
    }
    const shared = this.#sharedImages.get(entity.asset.id);
    if (shared) {
      retainImageAsset(shared);
      return {
        imageBitmap: shared.imageBitmap,
        mediaSource: { asset: shared, type: MediaType.image },
      };
    }
    const blob = await this.#getAssetBlob(entity);
    const loaded = await loadMediaFromBlob(
      blob,
      entity.asset.contentType,
      entity.position,
      entity.name,
    );
    if (!loaded) throw new Error(`Unable to decode hosted asset ${entity.name}`);
    const media = { imageBitmap: loaded.imageBitmap, mediaSource: loaded.mediaSource };
    if (media.mediaSource.type === MediaType.image) {
      this.#sharedImages.set(entity.asset.id, media.mediaSource.asset);
    }
    return media;
  }

  #getVideoTemplate(entity: HostedWorkspaceEntity): Promise<HostedVideoTemplate> {
    const blobKey = entity.asset.contentHash ?? entity.asset.id;
    let pending = this.#videoTemplates.get(blobKey);
    if (pending) return pending;
    pending = this.#createVideoTemplate(entity);
    this.#videoTemplates.set(blobKey, pending);
    void pending.catch(() => {
      if (this.#videoTemplates.get(blobKey) === pending) this.#videoTemplates.delete(blobKey);
    });
    return pending;
  }

  async #createVideoTemplate(entity: HostedWorkspaceEntity): Promise<HostedVideoTemplate> {
    const blob = await this.#getAssetBlob(entity);
    const loaded = await loadVideo(blob, {
      alphaMode: "unknown",
      fps: entity.fps,
      hasAudio: entity.hasAudio,
      startPlayback: false,
    });
    const posterAsset = createImageAsset({
      alphaMode: loaded.alphaMode,
      blob,
      imageBitmap: loaded.initialFrame,
    });
    disposeVideoElement(loaded.videoElement);
    return {
      alphaMode: loaded.alphaMode,
      blob,
      duration: loaded.duration,
      fps: loaded.fps,
      hasAudio: loaded.hasAudio,
      posterAsset,
      released: false,
    };
  }

  #getAssetBlob(entity: HostedWorkspaceEntity): Promise<Blob> {
    const blobKey = entity.asset.contentHash ?? entity.asset.id;
    let pending = this.#assetBlobs.get(blobKey);
    if (pending) return pending;
    pending = this.#downloadAsset(entity);
    this.#assetBlobs.set(blobKey, pending);
    pending.catch(() => this.#assetBlobs.delete(blobKey));
    return pending;
  }

  async #downloadAsset(entity: HostedWorkspaceEntity): Promise<Blob> {
    try {
      const cached = await this.#cache.get(entity.asset.id, entity.asset.contentType);
      if (cached?.size === entity.asset.byteLength) return cached;
    } catch (error) {
      this.#onCacheError(error);
    }
    const grant = await this.#api.createAssetContent(this.#workspaceId, entity.asset.id);
    const response = await fetch(grant.downloadUrl);
    if (!response.ok) throw new Error(`Object download failed with HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== entity.asset.byteLength) {
      throw new Error(`Hosted asset ${entity.asset.id} has an unexpected byte length`);
    }
    const blob = new Blob([bytes], { type: entity.asset.contentType });
    void this.#cache.put(entity.asset.id, blob).catch(this.#onCacheError);
    return blob;
  }

  async #applyPlayback(
    current: ShaderCanvasEntity,
    collaborative: HostedWorkspaceEntity,
  ): Promise<void> {
    const playback = collaborative.playback;
    if (!playback || !current.playback) return;
    if (isVideoEntity(current)) {
      const video = current.mediaSource.videoElement;
      video.loop = playback.loop;
      video.playbackRate = playback.playbackRate;
      video.muted = playback.muted;
      video.volume = playback.volume;
      if (!hasActiveVideoSource(video)) {
        if (!playback.isPlaying) this.#autoplayBlocked.delete(current.id);
        return;
      }
      if (
        playbackDistance(video.currentTime, playback.currentTime, video.duration, playback.loop) >=
        PLAYBACK_DRIFT_TOLERANCE_SECONDS
      ) {
        this.#store.seekVideo(current.id, playback.currentTime, true);
      }
      if (!playback.isPlaying) this.#autoplayBlocked.delete(current.id);
      if (playback.isPlaying && video.paused) {
        if (this.#autoplayBlocked.has(current.id) && !playback.muted) return;
        try {
          await this.#store.playVideo(current.id, true);
          this.#autoplayBlocked.delete(current.id);
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "NotAllowedError") {
            this.#onError(error);
          } else if (!this.#autoplayBlocked.has(current.id)) {
            this.#autoplayBlocked.add(current.id);
            this.#onAutoplayBlocked(collaborative);
          }
        }
      } else if (!playback.isPlaying && !video.paused) this.#store.pauseVideo(current.id, true);
      return;
    }
    if (isGifEntity(current)) {
      if (
        playbackDistance(
          current.playback.currentTime,
          playback.currentTime,
          current.mediaSource.duration,
          playback.loop,
        ) >= PLAYBACK_DRIFT_TOLERANCE_SECONDS
      ) {
        this.#store.seekGif(current.id, playback.currentTime, true);
      }
      if (playback.isPlaying && !current.playback.isPlaying) this.#store.playGif(current.id, true);
      else if (!playback.isPlaying && current.playback.isPlaying)
        this.#store.pauseGif(current.id, true);
    }
  }

  #releaseEntity(entity: ShaderCanvasEntity): void {
    const assetId = this.#entityAssets.get(entity.id);
    if (entity.mediaSource.type === MediaType.image) {
      if (assetId && getImageAssetReferenceCount(entity.mediaSource.asset) === 1) {
        this.#sharedImages.delete(assetId);
      }
    }
    disposeEntityMedia(entity);
    if (assetId) this.#unbindEntityAsset(entity.id, assetId);
  }

  #bindEntityAsset(entityId: string, asset: HostedWorkspaceEntity["asset"]): void {
    const blobKey = asset.contentHash ?? asset.id;
    this.#entityAssets.set(entityId, asset.id);
    this.#entityBlobKeys.set(entityId, blobKey);
    this.#blobEntityCounts.set(blobKey, (this.#blobEntityCounts.get(blobKey) ?? 0) + 1);
  }

  #unbindEntityAsset(entityId: string, assetId: string): void {
    this.#entityAssets.delete(entityId);
    const blobKey = this.#entityBlobKeys.get(entityId) ?? assetId;
    this.#entityBlobKeys.delete(entityId);
    const nextCount = (this.#blobEntityCounts.get(blobKey) ?? 1) - 1;
    if (nextCount > 0) {
      this.#blobEntityCounts.set(blobKey, nextCount);
      return;
    }
    this.#blobEntityCounts.delete(blobKey);
    this.#assetBlobs.delete(blobKey);
    const template = this.#videoTemplates.get(blobKey);
    if (template) {
      this.#videoTemplates.delete(blobKey);
      this.#releaseVideoTemplate(template);
    }
  }

  #releaseVideoTemplate(pending: Promise<HostedVideoTemplate>): void {
    void pending.then(
      (template) => {
        if (template.released) return;
        template.released = true;
        releaseImageAsset(template.posterAsset);
      },
      () => {},
    );
  }

  #bumpRevision(entityId: string): number {
    const revision = (this.#entityRevisions.get(entityId) ?? 0) + 1;
    this.#entityRevisions.set(entityId, revision);
    return revision;
  }
}

function groupProjectionIndicesByAsset(
  entries: readonly HostedRemoteEntityProjection[],
): number[][] {
  const groupsByAsset = new Map<string, number[]>();
  for (let index = 0; index < entries.length; index++) {
    const assetId = entries[index]!.entity.asset;
    const key = assetId.contentHash ?? assetId.id;
    const group = groupsByAsset.get(key);
    if (group) group.push(index);
    else groupsByAsset.set(key, [index]);
  }
  return [...groupsByAsset.values()];
}

function getEntityBlob(entity: ShaderCanvasEntity): Blob {
  return entity.mediaSource.type === MediaType.image
    ? entity.mediaSource.asset.blob
    : entity.mediaSource.blob;
}

function toCanvasFields(
  entity: HostedWorkspaceEntity,
): Omit<ShaderCanvasEntity, "imageBitmap" | "mediaSource"> {
  return {
    edited: entity.edited,
    id: entity.id,
    locked: entity.locked,
    name: entity.name,
    ...(entity.originalPalette && { originalPalette: structuredClone(entity.originalPalette) }),
    originalSize: { ...entity.originalSize },
    ...(entity.playback && { playback: { ...entity.playback } }),
    position: { ...entity.position },
    rotation: entity.rotation,
    shaderParams: structuredClone(entity.shaderParams),
    shaderType: entity.shaderType,
    size: { ...entity.size },
    zIndex: entity.zIndex,
  };
}

function toCanvasUpdates(
  entity: HostedWorkspaceEntity,
  applyPlayback: boolean,
): Partial<ShaderCanvasEntity> {
  const updates: Partial<ShaderCanvasEntity> = {
    ...toCanvasFields(entity),
    textureDirty: true,
  } as Partial<ShaderCanvasEntity>;
  if (!applyPlayback) Reflect.deleteProperty(updates, "playback");
  return updates;
}

function playbackDistance(
  current: number,
  target: number,
  duration: number,
  loop: boolean,
): number {
  const direct = Math.abs(current - target);
  return loop && duration > 0 ? Math.min(direct, Math.abs(duration - direct)) : direct;
}
