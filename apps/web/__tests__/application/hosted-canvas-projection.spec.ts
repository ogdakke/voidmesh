import type { HostedAssetReference, HostedSceneEntity } from "@voidmesh/collaboration";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { R2HostedAssetRegistry } from "#application/canvas/hosted-asset-registry.ts";
import { HostedCanvasProjectionService } from "#application/canvas/hosted-canvas-projection.ts";
import { config } from "#config";
import { CanvasStore } from "#engine";
import type { HostedApiClient } from "#lib/hosted-api-client.ts";
import type { HostedAssetCache } from "#lib/hosted-asset-cache.ts";
import { GlassKind, ShaderType } from "#types/canvas.ts";
import { createMockVideoElement, mockAllMediaAPIs } from "../mocks/media.mock.ts";

function asset(id: string): HostedAssetReference {
  return {
    byteLength: 1,
    contentType: "image/png",
    id,
    mediaType: "image",
    originalFilename: `${id}.png`,
  };
}

function hostedEntity(id: string, reference = asset(`asset-${id}`)): HostedSceneEntity {
  return {
    asset: reference,
    edited: false,
    generation: 0,
    id,
    locked: false,
    name: reference.originalFilename,
    originalSize: { height: 10, width: 10 },
    position: { x: 0, y: 0 },
    revisions: { appearance: 0, asset: 0, geometry: 0, identity: 0, layering: 0 },
    rotation: 0,
    shaderParams: JSON.parse(JSON.stringify(config.defaults.shaderParams)),
    shaderType: ShaderType.dithering,
    size: { height: 10, width: 10 },
    zIndex: 1,
  };
}

function createProjection(cache: HostedAssetCache) {
  const api = {} as HostedApiClient;
  const assets = new R2HostedAssetRegistry(
    api,
    "workspace-1",
    cache,
    vi.fn<(error: unknown) => void>(),
    vi.fn<() => void>(),
  );
  const store = new CanvasStore();
  const requestRender = vi.fn<(entityId?: string) => void>();
  const onError = vi.fn<(error: unknown) => void>();
  const projection = new HostedCanvasProjectionService({
    api,
    assets,
    cache,
    onError,
    requestRender,
    store,
    workspaceId: "workspace-1",
  });
  return { onError, projection, requestRender, store };
}

describe("HostedCanvasProjectionService", () => {
  let cleanupMedia: () => void;

  beforeEach(() => {
    cleanupMedia = mockAllMediaAPIs();
  });

  afterEach(() => {
    cleanupMedia();
    vi.restoreAllMocks();
  });

  it("bounds hydration concurrency and commits each entity as soon as it decodes", async () => {
    const pending = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    const cache: HostedAssetCache = {
      delete: async () => {},
      get: vi.fn<HostedAssetCache["get"]>(async (assetId, contentType) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => pending.set(assetId, resolve));
        active--;
        return new Blob([new Uint8Array([1])], { type: contentType });
      }),
      put: async () => {},
    };
    const { projection, store } = createProjection(cache);
    const entities = Array.from({ length: 6 }, (_, index) => hostedEntity(`entity-${index}`));

    const hydration = projection.applySnapshot(entities);
    await vi.waitFor(() => expect(pending.size).toBe(4));
    expect(peak).toBe(4);

    pending.get("asset-entity-0")?.();
    await vi.waitFor(() => expect(store.getState().entities.size).toBe(1));
    expect(store.getState().entities.has("entity-0")).toBe(true);

    for (const resolve of pending.values()) resolve();
    await vi.waitFor(() => expect(pending.size).toBe(6));
    for (const resolve of pending.values()) resolve();
    await hydration;

    expect(store.getState().entities.size).toBe(6);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("applies geometry patches without invalidating an entity texture", async () => {
    const cache: HostedAssetCache = {
      delete: async () => {},
      get: async (_assetId, contentType) => new Blob([new Uint8Array([1])], { type: contentType }),
      put: async () => {},
    };
    const { projection, store } = createProjection(cache);
    const entity = hostedEntity("entity-1");
    await projection.applySnapshot([entity]);
    const current = store.getState().entities.get(entity.id)!;
    current.textureDirty = false;

    await projection.applyChange({
      entityId: entity.id,
      generation: 0,
      patch: {
        geometry: {
          originalSize: entity.originalSize,
          position: { x: 40, y: 50 },
          rotation: 12,
          size: entity.size,
        },
      },
      revisions: { ...entity.revisions, geometry: 1 },
      type: "entity.patched",
    });

    const updated = store.getState().entities.get(entity.id)!;
    expect(updated.position).toEqual({ x: 40, y: 50 });
    expect(updated.textureDirty).toBe(false);
  });

  it("refreshes flowing shader time without replacing or dirtying the entity", async () => {
    const cache: HostedAssetCache = {
      delete: async () => {},
      get: async (_assetId, contentType) => new Blob([new Uint8Array([1])], { type: contentType }),
      put: async () => {},
    };
    const { projection, requestRender, store } = createProjection(cache);
    const entity = hostedEntity("entity-1");
    entity.shaderType = ShaderType.glass;
    entity.shaderParams = {
      ...entity.shaderParams,
      glass: { kind: GlassKind.flowing },
    };
    await projection.applySnapshot([entity]);
    const current = store.getState().entities.get(entity.id)!;
    current.textureDirty = false;
    requestRender.mockClear();
    const mutations = vi.fn<Parameters<CanvasStore["subscribeEntityMutations"]>[0]>();
    store.subscribeEntityMutations(mutations);

    await projection.applyPlayback(
      {
        appearanceRevision: 0,
        commandId: "shader-command",
        effectiveAtRoomMs: 1_000,
        entityId: entity.id,
        sequence: 1,
        shaderTime: 2,
        state: "playing",
        type: "shader",
      },
      4_000,
    );

    expect(store.getState().entities.get(entity.id)).toBe(current);
    expect(current.shaderParams.time).toBe(5);
    expect(current.shaderParams.timeAutoPlay).toBe(true);
    expect(current.textureDirty).toBe(false);
    expect(mutations).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledWith();
  });

  it("hydrates each hosted video as an independent source-attached element", async () => {
    const nativeCreateElement = document.createElement.bind(document);
    const videos: HTMLVideoElement[] = [];
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) => {
      if (tagName !== "video") return nativeCreateElement(tagName, options);
      const video = createMockVideoElement({ duration: 10 });
      videos.push(video);
      return video;
    }) as typeof document.createElement);
    const cache: HostedAssetCache = {
      delete: async () => {},
      get: async (_assetId, contentType) => new Blob([new Uint8Array([1])], { type: contentType }),
      put: async () => {},
    };
    const { projection, store } = createProjection(cache);
    const reference: HostedAssetReference = {
      byteLength: 1,
      contentHash: "shared-video-content",
      contentType: "video/mp4",
      id: "asset-video",
      mediaType: "video",
      originalFilename: "video.mp4",
    };
    const entities = [hostedEntity("video-1", reference), hostedEntity("video-2", reference)];
    for (const entity of entities) {
      entity.fps = 30;
      entity.hasAudio = false;
      entity.playbackDuration = 10;
    }

    await projection.applySnapshot(entities);

    expect(videos).toHaveLength(2);
    expect(videos[0]).not.toBe(videos[1]);
    for (const entity of entities) {
      const current = store.getState().entities.get(entity.id)!;
      if (current.mediaSource.type !== "video") throw new Error("Expected video entity");
      expect(current.mediaSource.videoElement.src).toMatch(/^blob:mock-/);
      expect(current.mediaSource.videoElement.paused).toBe(true);
      expect(current.playback?.isPlaying).toBe(false);
    }
  });

  it("does not report an interrupted play as a hosted media failure", async () => {
    const nativeCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation(((
      tagName: string,
      options?: ElementCreationOptions,
    ) =>
      tagName === "video"
        ? createMockVideoElement({ duration: 10 })
        : nativeCreateElement(tagName, options)) as typeof document.createElement);
    const cache: HostedAssetCache = {
      delete: async () => {},
      get: async (_assetId, contentType) => new Blob([new Uint8Array([1])], { type: contentType }),
      put: async () => {},
    };
    const { onError, projection, store } = createProjection(cache);
    const entity = hostedEntity("entity-video", {
      byteLength: 1,
      contentType: "video/mp4",
      id: "asset-video",
      mediaType: "video",
      originalFilename: "video.mp4",
    });
    entity.fps = 30;
    entity.hasAudio = false;
    entity.playbackDuration = 10;
    await projection.applySnapshot([entity]);
    const current = store.getState().entities.get(entity.id)!;
    if (current.mediaSource.type !== "video") throw new Error("Expected video entity");
    vi.spyOn(store, "playVideo").mockRejectedValue(
      new DOMException("Playback was interrupted", "AbortError"),
    );

    await projection.applyPlayback(
      {
        commandId: "remote-play",
        duration: 10,
        effectiveAtRoomMs: 1_000,
        entityId: entity.id,
        loop: true,
        mediaRevision: 0,
        playbackRate: 1,
        positionSeconds: 2,
        sequence: 1,
        state: "playing",
        type: "media",
      },
      1_000,
    );

    expect(onError).not.toHaveBeenCalled();
  });
});
