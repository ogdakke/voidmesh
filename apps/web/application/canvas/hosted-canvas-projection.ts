import type { WorkspaceId } from "@voidmesh/domain";
import type { CanvasStore } from "#engine";
import type { HostedCanvasProjection } from "#application/canvas/hosted-canvas-sync.ts";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { HostedApiClient } from "#lib/hosted-api-client.ts";
import { loadMediaFromBlob } from "#lib/media-loader.ts";
import { getImageAssetReferenceCount, retainImageAsset } from "#lib/media-assets.ts";
import { disposeEntityMedia, disposeMediaSource } from "#lib/media-resources.ts";
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

export interface HostedCanvasProjectionOptions {
  api: HostedApiClient;
  assets: R2HostedAssetRegistry;
  cache: HostedAssetCache;
  beforeRemoveEntity?(entityId: string): void;
  onAutoplayBlocked?(entity: HostedWorkspaceEntity): void;
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
  readonly #onError: (error: unknown) => void;
  readonly #requestRender: (entityId?: string) => void;
  readonly #store: CanvasStore;
  readonly #workspaceId: WorkspaceId;
  readonly #assetBlobs = new Map<string, Promise<Blob>>();
  readonly #sharedImages = new Map<string, MediaImageAsset>();
  readonly #entityAssets = new Map<string, string>();
  readonly #entityRevisions = new Map<string, number>();
  readonly #autoplayBlocked = new Set<string>();

  constructor(options: HostedCanvasProjectionOptions) {
    this.#api = options.api;
    this.#assets = options.assets;
    this.#cache = options.cache;
    this.#beforeRemoveEntity = options.beforeRemoveEntity ?? (() => {});
    this.#onAutoplayBlocked = options.onAutoplayBlocked ?? (() => {});
    this.#onError = options.onError;
    this.#requestRender = options.requestRender;
    this.#store = options.store;
    this.#workspaceId = options.workspaceId;
  }

  async applyRemoteEntity(entity: HostedWorkspaceEntity, applyPlayback: boolean): Promise<void> {
    const current = this.#store.getState().entities.get(entity.id);
    if (!current || this.#entityAssets.get(entity.id) !== entity.asset.id) {
      await this.#materialize(entity, applyPlayback);
      return;
    }
    this.#store.updateEntity(entity.id, toCanvasUpdates(entity, applyPlayback));
    const updated = this.#store.getState().entities.get(entity.id);
    if (applyPlayback && updated) await this.#applyPlayback(updated, entity);
    this.#requestRender(entity.id);
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
    this.#store.removeEntities(removed);
    for (const entity of resources) this.#releaseEntity(entity);
    for (const id of removed) {
      this.#entityAssets.delete(id);
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
    if (previous) this.#store.updateEntity(entity.id, next);
    else this.#store.addEntity(next);
    this.#entityAssets.set(entity.id, entity.asset.id);
    this.#assets.adopt(entity.id, entity.asset);
    if (previous) this.#releaseEntity(previous);
    if (applyPlayback) await this.#applyPlayback(next, entity);
    this.#requestRender(entity.id);
  }

  async #loadMedia(
    entity: HostedWorkspaceEntity,
  ): Promise<Pick<ShaderCanvasEntity, "imageBitmap" | "mediaSource">> {
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

  #getAssetBlob(entity: HostedWorkspaceEntity): Promise<Blob> {
    let pending = this.#assetBlobs.get(entity.asset.id);
    if (pending) return pending;
    pending = this.#downloadAsset(entity);
    this.#assetBlobs.set(entity.asset.id, pending);
    pending.catch(() => this.#assetBlobs.delete(entity.asset.id));
    return pending;
  }

  async #downloadAsset(entity: HostedWorkspaceEntity): Promise<Blob> {
    try {
      const cached = await this.#cache.get(entity.asset.id, entity.asset.contentType);
      if (cached?.size === entity.asset.byteLength) return cached;
    } catch (error) {
      this.#onError(error);
    }
    const grant = await this.#api.createAssetContent(this.#workspaceId, entity.asset.id);
    const response = await fetch(grant.downloadUrl);
    if (!response.ok) throw new Error(`Object download failed with HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength !== entity.asset.byteLength) {
      throw new Error(`Hosted asset ${entity.asset.id} has an unexpected byte length`);
    }
    const blob = new Blob([bytes], { type: entity.asset.contentType });
    void this.#cache.put(entity.asset.id, blob).catch(this.#onError);
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
      if (
        playbackDistance(video.currentTime, playback.currentTime, video.duration, playback.loop) >=
        PLAYBACK_DRIFT_TOLERANCE_SECONDS
      ) {
        this.#store.seekVideo(current.id, playback.currentTime);
      }
      if (!playback.isPlaying) this.#autoplayBlocked.delete(current.id);
      if (playback.isPlaying && video.paused) {
        if (this.#autoplayBlocked.has(current.id) && !playback.muted) return;
        try {
          await this.#store.playVideo(current.id);
          this.#autoplayBlocked.delete(current.id);
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "NotAllowedError") {
            this.#onError(error);
          } else if (!this.#autoplayBlocked.has(current.id)) {
            this.#autoplayBlocked.add(current.id);
            this.#onAutoplayBlocked(collaborative);
          }
        }
      } else if (!playback.isPlaying && !video.paused) this.#store.pauseVideo(current.id);
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
        this.#store.seekGif(current.id, playback.currentTime);
      }
      if (playback.isPlaying && !current.playback.isPlaying) this.#store.playGif(current.id);
      else if (!playback.isPlaying && current.playback.isPlaying) this.#store.pauseGif(current.id);
    }
  }

  #releaseEntity(entity: ShaderCanvasEntity): void {
    if (entity.mediaSource.type === MediaType.image) {
      const assetId = this.#entityAssets.get(entity.id);
      if (assetId && getImageAssetReferenceCount(entity.mediaSource.asset) === 1) {
        this.#sharedImages.delete(assetId);
      }
    }
    disposeEntityMedia(entity);
  }

  #bumpRevision(entityId: string): number {
    const revision = (this.#entityRevisions.get(entityId) ?? 0) + 1;
    this.#entityRevisions.set(entityId, revision);
    return revision;
  }
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
