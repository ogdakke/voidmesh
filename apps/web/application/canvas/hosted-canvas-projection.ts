import type {
  HostedAssetReference,
  HostedEntityPatch,
  HostedPlaybackAnchor,
  HostedSceneChange,
  HostedSceneEntity,
} from "@voidmesh/collaboration";
import type { WorkspaceId } from "@voidmesh/domain";
import type { CanvasStore } from "#engine";
import type { HostedCanvasProjection } from "#application/canvas/hosted-canvas-sync.ts";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { HostedApiClient } from "#lib/hosted-api-client.ts";
import { loadMediaFromBlob, loadVideo } from "#lib/media-loader.ts";
import { createPlaybackState } from "#lib/media-playback.ts";
import {
  createImageAsset,
  getImageAssetReferenceCount,
  releaseImageAsset,
  retainImageAsset,
} from "#lib/media-assets.ts";
import {
  activateVideoElement,
  createDormantVideoElement,
  disposeEntityMedia,
  disposeMediaSource,
  disposeVideoElement,
  hasActiveVideoSource,
  isMediaPlaybackInterruption,
} from "#lib/media-resources.ts";
import type { HostedAssetCache } from "#lib/hosted-asset-cache.ts";
import {
  MediaType,
  ShaderType,
  isGifEntity,
  isVideoEntity,
  type MediaImageAsset,
  type ColorPalette,
  type ShaderCanvasEntity,
  type ShaderParams,
} from "#types/canvas.ts";

const PLAYBACK_DRIFT_TOLERANCE_SECONDS = 0.15;
const MAX_CONCURRENT_REMOTE_ASSET_LOADS = 4;

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
  onAutoplayBlocked?(entity: HostedSceneEntity): void;
  onCacheError?(error: unknown): void;
  onError(error: unknown): void;
  requestRender(entityId?: string): void;
  store: CanvasStore;
  workspaceId: WorkspaceId;
}

/** Projects authoritative scene records into the one local, resource-owning canvas scene. */
export class HostedCanvasProjectionService implements HostedCanvasProjection {
  readonly #api: HostedApiClient;
  readonly #assets: R2HostedAssetRegistry;
  readonly #cache: HostedAssetCache;
  readonly #beforeRemoveEntity: (entityId: string) => void;
  readonly #onAutoplayBlocked: (entity: HostedSceneEntity) => void;
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
  readonly #remoteEntities = new Map<string, HostedSceneEntity>();
  readonly #autoplayBlocked = new Set<string>();
  readonly #previewActivations = new Map<string, Promise<void>>();

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
    this.#remoteEntities.clear();
    this.#previewActivations.clear();
  }

  async applySnapshot(entities: readonly HostedSceneEntity[]): Promise<void> {
    const nextIds = new Set(entities.map((entity) => entity.id));
    this.#remoteEntities.clear();
    for (const entity of entities) this.#remoteEntities.set(entity.id, entity);
    this.#removeRemoteEntities(
      [...this.#store.getState().entities.keys()].filter((id) => !nextIds.has(id)),
    );

    let nextIndex = 0;
    const errors: unknown[] = [];
    const projectNext = async (): Promise<void> => {
      while (nextIndex < entities.length) {
        const entity = entities[nextIndex++]!;
        try {
          await this.#projectEntity(entity);
        } catch (error) {
          errors.push(error);
        }
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_REMOTE_ASSET_LOADS, entities.length) },
        projectNext,
      ),
    );
    if (errors.length === 1) this.#onError(errors[0]);
    else if (errors.length > 1) {
      this.#onError(
        new AggregateError(errors, `${errors.length} hosted media items could not be loaded`),
      );
    }
  }

  async applyChange(change: HostedSceneChange): Promise<void> {
    switch (change.type) {
      case "entity.created":
        this.#remoteEntities.set(change.entity.id, change.entity);
        await this.#projectEntity(change.entity);
        return;
      case "entity.patched": {
        const current = this.#remoteEntities.get(change.entityId);
        if (!current) return;
        const entity = applyHostedPatch(current, change.patch, change.revisions);
        this.#remoteEntities.set(entity.id, entity);
        if (change.patch.asset && this.#entityAssets.get(entity.id) !== entity.asset.id) {
          await this.#materialize(entity);
          return;
        }
        this.#applyNarrowPatch(entity, change.patch);
        return;
      }
      case "entity.removed":
        this.#remoteEntities.delete(change.entityId);
        this.#removeRemoteEntities([change.entityId]);
        return;
      case "scene.replaced":
        await this.applySnapshot(change.entities);
    }
  }

  async applyPlayback(
    anchor: HostedPlaybackAnchor,
    roomNow: number,
    activateDormantPreview = false,
  ): Promise<void> {
    const current = this.#store.getState().entities.get(anchor.entityId);
    const collaborative = this.#remoteEntities.get(anchor.entityId);
    if (!current || !collaborative) return;
    if (anchor.type === "shader") {
      if (anchor.appearanceRevision !== collaborative.revisions.appearance) return;
      current.shaderParams.time = shaderTimeAt(anchor, roomNow);
      current.shaderParams.timeAutoPlay = anchor.state === "playing";
      // The flowing shader consumes time directly during rendering. This is deliberately
      // not a CanvasStore entity update and does not invalidate a processed texture.
      this.#requestRender();
      return;
    }
    if (anchor.mediaRevision !== collaborative.revisions.asset) return;
    await this.#applyMediaPlayback(
      current,
      collaborative,
      anchor,
      roomNow,
      activateDormantPreview,
    );
  }

  async #projectEntity(entity: HostedSceneEntity): Promise<void> {
    const current = this.#store.getState().entities.get(entity.id);
    if (!current || this.#entityAssets.get(entity.id) !== entity.asset.id) {
      await this.#materialize(entity);
      return;
    }
    const appearanceChanged =
      current.shaderType !== entity.shaderType ||
      JSON.stringify(staticShaderParams(current.shaderParams)) !==
        JSON.stringify(entity.shaderParams);
    this.#store.updateEntity(
      entity.id,
      {
        ...toCanvasFields(entity, current.shaderParams),
        ...(appearanceChanged && { textureDirty: true }),
      },
      true,
    );
    this.#requestRender(appearanceChanged ? entity.id : undefined);
  }

  #applyNarrowPatch(entity: HostedSceneEntity, patch: HostedEntityPatch): void {
    const current = this.#store.getState().entities.get(entity.id);
    if (!current) return;
    const updates: Partial<ShaderCanvasEntity> = {};
    if (patch.identity) {
      Object.assign(updates, {
        edited: entity.edited,
        locked: entity.locked,
        name: entity.name,
        originalPalette: entity.originalPalette
          ? structuredClone(entity.originalPalette)
          : undefined,
      });
    }
    if (patch.geometry) {
      Object.assign(updates, {
        originalSize: { ...entity.originalSize },
        position: { ...entity.position },
        rotation: entity.rotation,
        size: { ...entity.size },
      });
    }
    if (patch.layering) updates.zIndex = entity.zIndex;
    if (patch.appearance) {
      updates.shaderType = parseShaderType(entity.shaderType);
      updates.shaderParams = toShaderParams(entity.shaderParams, current.shaderParams);
      updates.textureDirty = true;
    }
    if (patch.asset) {
      // Asset metadata can change without changing the underlying object identity.
      this.#assets.adopt(entity.id, entity.asset, getEntityBlob(current));
    }
    if (Object.keys(updates).length === 0) return;
    this.#store.updateEntity(entity.id, updates, true);
    this.#requestRender(patch.appearance ? entity.id : undefined);
  }

  async #materialize(entity: HostedSceneEntity): Promise<void> {
    const revision = this.#bumpRevision(entity.id);
    const media = await this.#loadMedia(entity);
    if (
      this.#entityRevisions.get(entity.id) !== revision ||
      this.#remoteEntities.get(entity.id)?.asset.id !== entity.asset.id
    ) {
      this.#disposeLoadedMedia(entity.asset.id, media);
      return;
    }
    const previous = this.#store.getState().entities.get(entity.id);
    const next = {
      ...media,
      ...toCanvasFields(entity, previous?.shaderParams),
      textureDirty: true,
    } as ShaderCanvasEntity;
    this.#beforeRemoveEntity(entity.id);
    if (previous) this.#store.updateEntity(entity.id, next, true);
    else this.#store.addEntity(next, true);
    if (previous) this.#releaseEntity(previous);
    this.#bindEntityAsset(entity.id, entity.asset);
    this.#assets.adopt(entity.id, entity.asset, getEntityBlob(next));
    // Commit each decoded entity immediately; no whole-scene staging array retains media.
    this.#requestRender(entity.id);
  }

  #removeRemoteEntities(entityIds: readonly string[]): void {
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

  async #loadMedia(
    entity: HostedSceneEntity,
  ): Promise<Pick<ShaderCanvasEntity, "imageBitmap" | "mediaSource" | "playback">> {
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
        playback: createPlaybackState({ isPlaying: false }),
      };
    }
    const shared = this.#sharedImages.get(entity.asset.id);
    if (shared) {
      retainImageAsset(shared);
      return {
        imageBitmap: shared.imageBitmap,
        mediaSource: { asset: shared, type: MediaType.image },
        playback: undefined,
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
    if (loaded.mediaSource.type === MediaType.image) {
      this.#sharedImages.set(entity.asset.id, loaded.mediaSource.asset);
    }
    return {
      imageBitmap: loaded.imageBitmap,
      mediaSource: loaded.mediaSource,
      playback: loaded.playback ? { ...loaded.playback, isPlaying: false } : undefined,
    };
  }

  #disposeLoadedMedia(
    assetId: string,
    media: Pick<ShaderCanvasEntity, "imageBitmap" | "mediaSource">,
  ): void {
    if (
      media.mediaSource.type === MediaType.image &&
      this.#sharedImages.get(assetId) === media.mediaSource.asset &&
      getImageAssetReferenceCount(media.mediaSource.asset) === 1
    ) {
      this.#sharedImages.delete(assetId);
    }
    disposeMediaSource(media.mediaSource, media.imageBitmap);
  }

  #getVideoTemplate(entity: HostedSceneEntity): Promise<HostedVideoTemplate> {
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

  async #createVideoTemplate(entity: HostedSceneEntity): Promise<HostedVideoTemplate> {
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

  #getAssetBlob(entity: HostedSceneEntity): Promise<Blob> {
    const blobKey = entity.asset.contentHash ?? entity.asset.id;
    let pending = this.#assetBlobs.get(blobKey);
    if (pending) return pending;
    pending = this.#downloadAsset(entity);
    this.#assetBlobs.set(blobKey, pending);
    void pending.catch(() => this.#assetBlobs.delete(blobKey));
    return pending;
  }

  async #downloadAsset(entity: HostedSceneEntity): Promise<Blob> {
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

  async #applyMediaPlayback(
    current: ShaderCanvasEntity,
    collaborative: HostedSceneEntity,
    anchor: Extract<HostedPlaybackAnchor, { type: "media" }>,
    roomNow: number,
    activateDormantPreview: boolean,
  ): Promise<void> {
    if (!current.playback) return;
    const target = mediaTimeAt(anchor, roomNow);
    if (isVideoEntity(current)) {
      const video = current.mediaSource.videoElement;
      // Audio preference is local. Collaboration never overwrites mute or volume.
      video.muted = current.playback.muted;
      video.volume = current.playback.volume;
      const hasDecoder = hasActiveVideoSource(video);
      const playbackTime = hasDecoder ? video.currentTime : current.playback.currentTime;
      const currentTime =
        playbackDistance(playbackTime, target, current.mediaSource.duration, anchor.loop) >=
        PLAYBACK_DRIFT_TOLERANCE_SECONDS
          ? target
          : current.playback.currentTime;
      const remainsActive = this.#store.setVideoPlaybackIntent(
        current.id,
        {
          currentTime,
          isPlaying: anchor.state === "playing",
          loop: anchor.loop,
          playbackRate: anchor.playbackRate,
        },
        true,
      );
      if (!remainsActive) {
        if (anchor.state === "paused") this.#autoplayBlocked.delete(current.id);
        if (anchor.state === "paused" && activateDormantPreview) {
          this.#activatePausedVideoPreview(current);
        }
        return;
      }
      if (anchor.state === "paused") this.#autoplayBlocked.delete(current.id);
      if (anchor.state === "playing" && video.paused) {
        if (this.#autoplayBlocked.has(current.id) && !current.playback.muted) return;
        try {
          await this.#store.playVideo(current.id, true);
          this.#autoplayBlocked.delete(current.id);
        } catch (error) {
          if (isMediaPlaybackInterruption(error)) return;
          if (error instanceof Error && error.name === "NotAllowedError") {
            if (this.#autoplayBlocked.has(current.id)) return;
            this.#autoplayBlocked.add(current.id);
            this.#onAutoplayBlocked(collaborative);
          } else {
            this.#onError(error);
          }
        }
      } else if (anchor.state === "paused" && !video.paused) {
        this.#store.pauseVideo(current.id, true);
      }
      return;
    }
    if (isGifEntity(current)) {
      current.playback.loop = anchor.loop;
      current.playback.playbackRate = anchor.playbackRate;
      if (
        playbackDistance(
          current.playback.currentTime,
          target,
          current.mediaSource.duration,
          anchor.loop,
        ) >= PLAYBACK_DRIFT_TOLERANCE_SECONDS
      ) {
        this.#store.seekGif(current.id, target, true);
      }
      if (anchor.state === "playing" && !current.playback.isPlaying)
        this.#store.playGif(current.id, true);
      else if (anchor.state === "paused" && current.playback.isPlaying)
        this.#store.pauseGif(current.id, true);
    }
  }

  #activatePausedVideoPreview(entity: ShaderCanvasEntity): void {
    if (!isVideoEntity(entity) || this.#previewActivations.has(entity.id)) return;
    const expectedVideo = entity.mediaSource.videoElement;
    const pending = activateVideoElement(expectedVideo, entity.mediaSource.blob)
      .then(() => {
        const current = this.#store.getState().entities.get(entity.id);
        if (
          !current ||
          !isVideoEntity(current) ||
          current.mediaSource.videoElement !== expectedVideo
        )
          return;
        if (!current.playback || current.playback.isPlaying) return;
        expectedVideo.muted = current.playback.muted;
        expectedVideo.volume = current.playback.volume;
        this.#store.setVideoPlaybackIntent(
          current.id,
          {
            currentTime: current.playback.currentTime,
            isPlaying: false,
            loop: current.playback.loop,
            playbackRate: current.playback.playbackRate,
          },
          true,
        );
      })
      .catch(this.#onError)
      .finally(() => this.#previewActivations.delete(entity.id));
    this.#previewActivations.set(entity.id, pending);
  }

  #releaseEntity(entity: ShaderCanvasEntity): void {
    const assetId = this.#entityAssets.get(entity.id);
    if (
      entity.mediaSource.type === MediaType.image &&
      assetId &&
      getImageAssetReferenceCount(entity.mediaSource.asset) === 1
    ) {
      this.#sharedImages.delete(assetId);
    }
    disposeEntityMedia(entity);
    if (assetId) this.#unbindEntityAsset(entity.id, assetId);
  }

  #bindEntityAsset(entityId: string, asset: HostedAssetReference): void {
    const previous = this.#entityAssets.get(entityId);
    if (previous) this.#unbindEntityAsset(entityId, previous);
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

function applyHostedPatch(
  current: HostedSceneEntity,
  patch: HostedEntityPatch,
  revisions: HostedSceneEntity["revisions"],
): HostedSceneEntity {
  return {
    ...current,
    ...(patch.identity && patch.identity),
    ...(patch.geometry && patch.geometry),
    ...(patch.appearance && patch.appearance),
    ...(patch.layering && patch.layering),
    ...(patch.asset && patch.asset),
    revisions,
  };
}

function getEntityBlob(entity: ShaderCanvasEntity): Blob {
  return entity.mediaSource.type === MediaType.image
    ? entity.mediaSource.asset.blob
    : entity.mediaSource.blob;
}

function toCanvasFields(
  entity: HostedSceneEntity,
  currentShaderParams?: ShaderParams,
): Pick<
  ShaderCanvasEntity,
  | "edited"
  | "id"
  | "locked"
  | "name"
  | "originalPalette"
  | "originalSize"
  | "position"
  | "rotation"
  | "shaderParams"
  | "shaderType"
  | "size"
  | "zIndex"
> {
  return {
    edited: entity.edited,
    id: entity.id,
    locked: entity.locked,
    name: entity.name,
    originalPalette: parseColorPalette(entity.originalPalette),
    originalSize: { ...entity.originalSize },
    position: { ...entity.position },
    rotation: entity.rotation,
    shaderParams: toShaderParams(entity.shaderParams, currentShaderParams),
    shaderType: parseShaderType(entity.shaderType),
    size: { ...entity.size },
    zIndex: entity.zIndex,
  };
}

function toShaderParams(
  staticParams: HostedSceneEntity["shaderParams"],
  current?: ShaderParams,
): ShaderParams {
  return Object.assign(structuredClone(current ?? defaultShaderParams()), staticParams, {
    ...(current?.time !== undefined && { time: current.time }),
    ...(current?.timeAutoPlay !== undefined && { timeAutoPlay: current.timeAutoPlay }),
  });
}

function staticShaderParams(params: ShaderParams): Omit<ShaderParams, "time" | "timeAutoPlay"> {
  const { time: _time, timeAutoPlay: _timeAutoPlay, ...rest } = params;
  return rest;
}

function parseShaderType(value: string): ShaderCanvasEntity["shaderType"] {
  if (Object.values(ShaderType).some((entry) => entry === value)) {
    return value as ShaderCanvasEntity["shaderType"];
  }
  throw new Error(`Unsupported hosted shader type: ${value}`);
}

function parseColorPalette(value: HostedSceneEntity["originalPalette"]): ColorPalette | undefined {
  if (!value) return undefined;
  if (
    typeof value.name !== "string" ||
    typeof value.shortName !== "string" ||
    !Array.isArray(value.colors) ||
    !value.colors.every(isRgba)
  ) {
    throw new Error("Hosted entity has an invalid original palette");
  }
  return {
    colors: value.colors.map((color) => [...color]),
    ...(typeof value.id === "string" && { id: value.id }),
    name: value.name,
    shortName: value.shortName,
  };
}

function isRgba(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((channel) => typeof channel === "number" && Number.isFinite(channel))
  );
}

function defaultShaderParams(): ShaderParams {
  return {
    background: [1, 1, 1, 1],
    color: [0, 0, 0, 1],
    intensity: 1,
    preserveColors: false,
    reversePalette: false,
    scale: 1,
    shape: "circle",
    showOriginal: false,
    size: 8,
  };
}

function mediaTimeAt(
  anchor: Extract<HostedPlaybackAnchor, { type: "media" }>,
  roomNow: number,
): number {
  if (anchor.state === "paused") return anchor.positionSeconds;
  const elapsed = Math.max(0, roomNow - anchor.effectiveAtRoomMs) / 1_000;
  const advanced = anchor.positionSeconds + elapsed * anchor.playbackRate;
  if (anchor.loop && anchor.duration > 0) return advanced % anchor.duration;
  return Math.min(advanced, anchor.duration);
}

function shaderTimeAt(
  anchor: Extract<HostedPlaybackAnchor, { type: "shader" }>,
  roomNow: number,
): number {
  return anchor.state === "playing"
    ? anchor.shaderTime + Math.max(0, roomNow - anchor.effectiveAtRoomMs) / 1_000
    : anchor.shaderTime;
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
