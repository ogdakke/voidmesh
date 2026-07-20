import type {
  HostedAssetReference,
  HostedPlaybackAnchor,
  HostedPlaybackCommand,
  HostedSceneCommand,
  HostedSceneEntity,
  ServerPlaybackMessage,
  ServerScenePatchMessage,
  ServerSceneSnapshotMessage,
} from "@voidmesh/collaboration";
import { describe, expect, it, vi } from "vitest";
import {
  HostedCanvasSync,
  type HostedAssetRegistry,
  type HostedCanvasProjection,
  type HostedCanvasSource,
  type HostedSceneTransport,
} from "#application/canvas/hosted-canvas-sync.ts";
import type { CanvasEntityMutation } from "#engine";
import { config } from "#config";
import { GlassKind, MediaType, ShaderType, type ShaderCanvasEntity } from "#types/canvas.ts";

const asset: HostedAssetReference = {
  byteLength: 100,
  contentType: "image/png",
  id: "asset-1",
  mediaType: "image",
  originalFilename: "source.png",
};

function runtimeEntity(): ShaderCanvasEntity {
  return {
    edited: false,
    id: "entity-1",
    imageBitmap: {} as ImageBitmap,
    locked: false,
    mediaSource: {
      asset: {
        alphaMode: "supported",
        blob: new Blob(),
        id: "local-asset",
        imageBitmap: {} as ImageBitmap,
        revision: 0,
      },
      type: MediaType.image,
    },
    name: "Source",
    originalSize: { height: 100, width: 100 },
    position: { x: 0, y: 0 },
    rotation: 0,
    shaderParams: structuredClone(config.defaults.shaderParams),
    shaderType: ShaderType.dithering,
    size: { height: 100, width: 100 },
    zIndex: 1,
  };
}

function hostedEntity(): HostedSceneEntity {
  const runtime = runtimeEntity();
  return {
    asset,
    edited: false,
    generation: 0,
    id: runtime.id,
    locked: false,
    name: runtime.name,
    originalSize: runtime.originalSize,
    position: runtime.position,
    revisions: { appearance: 0, asset: 0, geometry: 0, identity: 0, layering: 0 },
    rotation: 0,
    shaderParams: JSON.parse(JSON.stringify(runtime.shaderParams)),
    shaderType: runtime.shaderType,
    size: runtime.size,
    zIndex: 1,
  };
}

class FakeSource implements HostedCanvasSource {
  readonly entities = new Map<string, ShaderCanvasEntity>();
  readonly listeners = new Set<(mutation: CanvasEntityMutation) => void>();

  getEntity(id: string): ShaderCanvasEntity | undefined {
    return this.entities.get(id);
  }

  getEntities(): readonly ShaderCanvasEntity[] {
    return [...this.entities.values()];
  }

  subscribeMutations(listener: (mutation: CanvasEntityMutation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(mutation: CanvasEntityMutation): void {
    for (const listener of this.listeners) listener(mutation);
  }
}

class FakeTransport implements HostedSceneTransport {
  readonly sceneCommands: HostedSceneCommand[] = [];
  readonly playbackCommands: HostedPlaybackCommand[] = [];
  readonly snapshots = new Set<(message: ServerSceneSnapshotMessage) => void>();
  readonly patches = new Set<(message: ServerScenePatchMessage) => void>();
  readonly playback = new Set<(message: ServerPlaybackMessage) => void>();
  now = 2_000;

  onSnapshot(listener: (message: ServerSceneSnapshotMessage) => void): () => void {
    this.snapshots.add(listener);
    return () => this.snapshots.delete(listener);
  }

  onPatch(listener: (message: ServerScenePatchMessage) => void): () => void {
    this.patches.add(listener);
    return () => this.patches.delete(listener);
  }

  onPlayback(listener: (message: ServerPlaybackMessage) => void): () => void {
    this.playback.add(listener);
    return () => this.playback.delete(listener);
  }

  serverNow(): number {
    return this.now;
  }

  submitSceneCommand(command: HostedSceneCommand): void {
    this.sceneCommands.push(command);
  }

  submitPlaybackCommand(command: HostedPlaybackCommand): void {
    this.playbackCommands.push(command);
  }

  emitSnapshot(entities: HostedSceneEntity[], playback: HostedPlaybackAnchor[] = []): void {
    for (const listener of this.snapshots) {
      listener({ entities, playback, roomSequence: 1, type: "scene-snapshot" });
    }
  }

  emitPlayback(anchor: HostedPlaybackAnchor): void {
    for (const listener of this.playback) {
      listener({ anchor, roomSequence: anchor.sequence, type: "playback" });
    }
  }
}

function createSync(source: FakeSource, transport: FakeTransport) {
  const register = vi.fn<HostedAssetRegistry["register"]>(async () => asset);
  const applyPlayback = vi.fn<HostedCanvasProjection["applyPlayback"]>(async () => {});
  const projection: HostedCanvasProjection = {
    applyChange: async () => {},
    applyPlayback,
    applySnapshot: async () => {},
  };
  const sync = new HostedCanvasSync({
    assets: { getReference: () => asset, register, release: () => {} },
    onError: (error) => {
      throw error;
    },
    projection,
    source,
    transport,
    writable: true,
  });
  return { applyPlayback, register, sync };
}

describe("HostedCanvasSync", () => {
  it("publishes a typed create without a playback command for a static shader", async () => {
    const source = new FakeSource();
    const transport = new FakeTransport();
    const entity = runtimeEntity();
    source.entities.set(entity.id, entity);
    const { register, sync } = createSync(source, transport);
    sync.start();

    source.emit({ entities: [entity], projected: false, type: "add" });

    await vi.waitFor(() => expect(transport.sceneCommands).toHaveLength(1));
    expect(transport.sceneCommands[0]?.kind).toBe("entity.create");
    expect(transport.playbackCommands).toHaveLength(0);
    expect(register).toHaveBeenCalledOnce();
    sync.destroy();
  });

  it("creates shader playback only for flowing glass", async () => {
    const source = new FakeSource();
    const transport = new FakeTransport();
    const entity = runtimeEntity();
    entity.shaderType = ShaderType.glass;
    entity.shaderParams.glass = {
      ...config.defaults.shaderParams.glass!,
      kind: GlassKind.flowing,
    };
    entity.shaderParams.time = 3;
    entity.shaderParams.timeAutoPlay = true;
    source.entities.set(entity.id, entity);
    const { sync } = createSync(source, transport);
    sync.start();

    source.emit({ entities: [entity], projected: false, type: "add" });

    await vi.waitFor(() => expect(transport.playbackCommands).toHaveLength(1));
    expect(transport.playbackCommands[0]).toMatchObject({ entityId: entity.id, type: "shader" });
    sync.destroy();
  });

  it("refreshes active anchors directly without publishing entity updates", async () => {
    const source = new FakeSource();
    const transport = new FakeTransport();
    const { applyPlayback, sync } = createSync(source, transport);
    const anchor: HostedPlaybackAnchor = {
      appearanceRevision: 0,
      commandId: "shader-command",
      effectiveAtRoomMs: 1_000,
      entityId: "entity-1",
      sequence: 1,
      shaderTime: 2,
      state: "playing",
      type: "shader",
    };
    sync.start();
    transport.emitSnapshot([hostedEntity()], [anchor]);
    await vi.waitFor(() => expect(applyPlayback).toHaveBeenCalledOnce());
    applyPlayback.mockClear();

    sync.refreshPlayback();

    await vi.waitFor(() => expect(applyPlayback).toHaveBeenCalledWith(anchor, 2_000));
    expect(transport.sceneCommands).toHaveLength(0);
    sync.destroy();
  });

  it("allows a live remote scrub to activate one dormant preview", async () => {
    const source = new FakeSource();
    const transport = new FakeTransport();
    const { applyPlayback, sync } = createSync(source, transport);
    const anchor: HostedPlaybackAnchor = {
      commandId: "remote-scrub",
      duration: 10,
      effectiveAtRoomMs: 2_000,
      entityId: "entity-1",
      loop: true,
      mediaRevision: 0,
      playbackRate: 1,
      positionSeconds: 4,
      sequence: 2,
      state: "paused",
      type: "media",
    };
    sync.start();

    transport.emitPlayback(anchor);

    await vi.waitFor(() => expect(applyPlayback).toHaveBeenCalledWith(anchor, 2_000, true));
    sync.destroy();
  });

  it("ignores canvas mutations marked as projections", async () => {
    const source = new FakeSource();
    const transport = new FakeTransport();
    const entity = runtimeEntity();
    source.entities.set(entity.id, entity);
    const { register, sync } = createSync(source, transport);
    sync.start();

    source.emit({ entities: [entity], projected: true, type: "add" });
    await Promise.resolve();

    expect(register).not.toHaveBeenCalled();
    expect(transport.sceneCommands).toHaveLength(0);
    sync.destroy();
  });
});
