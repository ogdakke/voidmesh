import type {
  HostedAssetReference,
  HostedEntityPatch,
  HostedEntityRevisions,
  HostedPlaybackAnchor,
  HostedPlaybackCommand,
  HostedSceneChange,
  HostedSceneCommand,
  HostedSceneEntity,
  HostedSceneEntityInput,
  JsonObject,
  ServerPlaybackMessage,
  ServerScenePatchMessage,
  ServerSceneSnapshotMessage,
} from "@voidmesh/collaboration";
import { initialEntityRevisions, isTimeDependentShader } from "@voidmesh/collaboration";
import type { CanvasEntityMutation } from "#engine";
import type { ShaderCanvasEntity, ShaderParams } from "#types/canvas.ts";
import { MediaType, isAnimatedEntity } from "#types/canvas.ts";

const GEOMETRY_SYNC_INTERVAL_MS = 16;
const PLAYBACK_DRIFT_INTERVAL_MS = 1_000;

export interface HostedCanvasSource {
  getEntity(id: string): ShaderCanvasEntity | undefined;
  getEntities(): readonly ShaderCanvasEntity[];
  subscribeMutations(listener: (mutation: CanvasEntityMutation) => void): () => void;
}

export interface HostedCanvasProjection {
  applyChange(change: HostedSceneChange): Promise<void>;
  applyPlayback(anchor: HostedPlaybackAnchor, roomNow: number): Promise<void>;
  applySnapshot(entities: readonly HostedSceneEntity[]): Promise<void>;
}

export interface HostedSceneTransport {
  onPatch(listener: (message: ServerScenePatchMessage) => void): () => void;
  onPlayback(listener: (message: ServerPlaybackMessage) => void): () => void;
  onSnapshot(listener: (message: ServerSceneSnapshotMessage) => Promise<void> | void): () => void;
  serverNow(): number;
  submitPlaybackCommand(command: HostedPlaybackCommand): void;
  submitSceneCommand(command: HostedSceneCommand): void;
}

export interface HostedAssetRegistry {
  getReference(entityId: string): HostedAssetReference | undefined;
  register(entity: ShaderCanvasEntity, signal: AbortSignal): Promise<HostedAssetReference>;
  release(entityId: string): void;
}

export interface HostedCanvasSyncOptions {
  assets: HostedAssetRegistry;
  onError(error: unknown): void;
  projection: HostedCanvasProjection;
  source: HostedCanvasSource;
  transport: HostedSceneTransport;
  writable: boolean;
}

/** Adds hosted commands around the local canvas without introducing a second live scene model. */
export class HostedCanvasSync {
  readonly #assets: HostedAssetRegistry;
  readonly #projection: HostedCanvasProjection;
  readonly #source: HostedCanvasSource;
  readonly #transport: HostedSceneTransport;
  readonly #writable: boolean;
  readonly #onError: (error: unknown) => void;
  readonly #abortController = new AbortController();
  readonly #entityRevisions = new Map<string, number>();
  readonly #geometryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #remoteEntities = new Map<string, HostedSceneEntity>();
  readonly #playbackAnchors = new Map<string, HostedPlaybackAnchor>();
  #unsubscribeMutations: (() => void) | null = null;
  #unsubscribeSnapshot: (() => void) | null = null;
  #unsubscribePatch: (() => void) | null = null;
  #unsubscribePlayback: (() => void) | null = null;
  #driftTimer: ReturnType<typeof setInterval> | null = null;
  #remoteQueue: Promise<void> = Promise.resolve();

  constructor(options: HostedCanvasSyncOptions) {
    this.#assets = options.assets;
    this.#onError = options.onError;
    this.#projection = options.projection;
    this.#source = options.source;
    this.#transport = options.transport;
    this.#writable = options.writable;
  }

  start(): void {
    if (this.#unsubscribeSnapshot) return;
    this.#unsubscribeSnapshot = this.#transport.onSnapshot((snapshot) =>
      this.#enqueueRemote(() => this.#applySnapshot(snapshot)),
    );
    this.#unsubscribePatch = this.#transport.onPatch((patch) => {
      void this.#enqueueRemote(() => this.#applyPatch(patch));
    });
    this.#unsubscribePlayback = this.#transport.onPlayback((message) => {
      this.#playbackAnchors.set(message.anchor.entityId, message.anchor);
      void this.#enqueueRemote(() =>
        this.#projection.applyPlayback(message.anchor, this.#transport.serverNow()),
      );
    });
    if (this.#writable) {
      this.#unsubscribeMutations = this.#source.subscribeMutations((mutation) =>
        this.#handleMutation(mutation),
      );
    }
    this.#driftTimer = setInterval(() => this.refreshPlayback(), PLAYBACK_DRIFT_INTERVAL_MS);
  }

  destroy(): void {
    this.#abortController.abort();
    this.#unsubscribeMutations?.();
    this.#unsubscribeSnapshot?.();
    this.#unsubscribePatch?.();
    this.#unsubscribePlayback?.();
    this.#unsubscribeMutations = null;
    this.#unsubscribeSnapshot = null;
    this.#unsubscribePatch = null;
    this.#unsubscribePlayback = null;
    if (this.#driftTimer) clearInterval(this.#driftTimer);
    this.#driftTimer = null;
    for (const timer of this.#geometryTimers.values()) clearTimeout(timer);
    this.#geometryTimers.clear();
    this.#remoteEntities.clear();
    this.#playbackAnchors.clear();
  }

  refreshPlayback(): void {
    void this.#enqueueRemote(async () => {
      const roomNow = this.#transport.serverNow();
      for (const anchor of this.#playbackAnchors.values()) {
        if (anchor.state !== "playing") continue;
        await this.#projection.applyPlayback(anchor, roomNow);
      }
    });
  }

  #handleMutation(mutation: CanvasEntityMutation): void {
    if (mutation.projected) return;
    switch (mutation.type) {
      case "add":
        for (const entity of mutation.entities) this.#register(entity.id, "create");
        break;
      case "update":
        for (const { id, updates } of mutation.batch) {
          if (updates.mediaSource || !this.#remoteEntities.has(id)) this.#register(id, "patch");
          else this.#publishUpdate(id, updates);
        }
        break;
      case "move":
        for (const id of mutation.entityIds) this.#scheduleGeometry(id);
        break;
      case "remove": {
        const entities = [...mutation.entityIds]
          .map((id) => this.#remoteEntities.get(id))
          .filter((entity): entity is HostedSceneEntity => entity !== undefined)
          .map((entity) => ({ generation: entity.generation, id: entity.id }));
        if (entities.length > 0) {
          this.#transport.submitSceneCommand({
            entities,
            kind: "entities.remove",
            operationId: crypto.randomUUID(),
          });
        }
        for (const id of mutation.entityIds) {
          this.#remoteEntities.delete(id);
          this.#playbackAnchors.delete(id);
          this.#assets.release(id);
        }
        break;
      }
      case "replace":
        void this.#replace(mutation.entities).catch(this.#onError);
        break;
      case "playback": {
        const entity = this.#source.getEntity(mutation.entityId);
        if (entity) this.#publishMediaPlayback(entity);
        break;
      }
    }
  }

  #register(entityId: string, mode: "create" | "patch"): void {
    const entity = this.#source.getEntity(entityId);
    if (!entity) return;
    const revision = this.#bumpRevision(entityId);
    void this.#assets
      .register(entity, this.#abortController.signal)
      .then((asset) => {
        if (this.#entityRevisions.get(entityId) !== revision) return;
        const latest = this.#source.getEntity(entityId);
        if (!latest) return;
        const remote = this.#remoteEntities.get(entityId);
        if (mode === "create" || !remote) {
          const hosted = toHostedEntity(latest, asset, remote?.generation ?? 0);
          this.#transport.submitSceneCommand({
            entity: hosted,
            kind: "entity.create",
            operationId: crypto.randomUUID(),
          });
          this.#remoteEntities.set(latest.id, {
            ...structuredClone(hosted),
            revisions: initialEntityRevisions(),
          });
        } else {
          const patch: HostedEntityPatch = {
            asset: toAssetGroup(latest, asset),
            identity: toIdentityGroup(latest),
          };
          this.#submitPatch(remote, patch);
        }
        this.#publishInitialPlayback(latest, this.#remoteEntities.get(latest.id));
      })
      .catch((error: unknown) => {
        if (!this.#abortController.signal.aborted) this.#onError(error);
      });
  }

  #publishUpdate(entityId: string, updates: Partial<ShaderCanvasEntity>): void {
    const entity = this.#source.getEntity(entityId);
    const remote = this.#remoteEntities.get(entityId);
    if (!entity || !remote) return;
    const patch: HostedEntityPatch = {};
    if (hasIdentityUpdate(updates)) patch.identity = toIdentityGroup(entity);
    if (hasGeometryUpdate(updates)) patch.geometry = toGeometryGroup(entity);
    if (updates.zIndex !== undefined) patch.layering = { zIndex: entity.zIndex };
    if (updates.shaderType !== undefined || updates.shaderParams !== undefined) {
      patch.appearance = toAppearanceGroup(entity);
      if (isTimeDependentCanvasEntity(entity)) this.#publishShaderPlayback(entity, remote);
    }
    if (Object.keys(patch).length > 0) this.#submitPatch(remote, patch);
  }

  #submitPatch(remote: HostedSceneEntity, patch: HostedEntityPatch): void {
    const expected: Partial<HostedEntityRevisions> = {};
    for (const group of Object.keys(patch) as Array<keyof HostedEntityRevisions>) {
      expected[group] = remote.revisions[group];
    }
    this.#transport.submitSceneCommand({
      entityId: remote.id,
      expected,
      generation: remote.generation,
      kind: "entity.patch",
      operationId: crypto.randomUUID(),
      patch,
    });
    const revisions = { ...remote.revisions };
    for (const group of Object.keys(patch) as Array<keyof HostedEntityRevisions>) {
      revisions[group] += 1;
    }
    this.#remoteEntities.set(remote.id, applyHostedPatch(remote, { patch, revisions }));
  }

  #scheduleGeometry(entityId: string): void {
    if (this.#geometryTimers.has(entityId)) return;
    const timer = setTimeout(() => {
      this.#geometryTimers.delete(entityId);
      const entity = this.#source.getEntity(entityId);
      const remote = this.#remoteEntities.get(entityId);
      if (entity && remote) this.#submitPatch(remote, { geometry: toGeometryGroup(entity) });
    }, GEOMETRY_SYNC_INTERVAL_MS);
    this.#geometryTimers.set(entityId, timer);
  }

  async #replace(entities: readonly ShaderCanvasEntity[]): Promise<void> {
    const registered = await Promise.all(
      entities.map(async (entity) => ({
        asset: await this.#assets.register(entity, this.#abortController.signal),
        entity,
      })),
    );
    if (this.#abortController.signal.aborted) return;
    this.#transport.submitSceneCommand({
      entities: registered.map(({ asset, entity }) => toHostedEntity(entity, asset, 0)),
      kind: "scene.replace",
      operationId: crypto.randomUUID(),
    });
    this.#remoteEntities.clear();
    for (const { asset, entity } of registered) {
      const hosted = toHostedEntity(entity, asset, 0);
      this.#remoteEntities.set(entity.id, {
        ...structuredClone(hosted),
        revisions: initialEntityRevisions(),
      });
    }
    for (const { entity } of registered) this.#publishInitialPlayback(entity);
  }

  #publishInitialPlayback(entity: ShaderCanvasEntity, remote?: HostedSceneEntity): void {
    if (isAnimatedEntity(entity) && entity.playback) this.#publishMediaPlayback(entity, remote);
    if (isTimeDependentCanvasEntity(entity)) this.#publishShaderPlayback(entity, remote);
  }

  #publishMediaPlayback(entity: ShaderCanvasEntity, remote?: HostedSceneEntity): void {
    if (!isAnimatedEntity(entity) || !entity.playback) return;
    const collaborative = remote ?? this.#remoteEntities.get(entity.id);
    const mediaRevision = collaborative?.revisions.asset ?? 0;
    this.#transport.submitPlaybackCommand({
      commandId: crypto.randomUUID(),
      duration: entity.mediaSource.duration,
      entityId: entity.id,
      loop: entity.playback.loop,
      mediaRevision,
      playbackRate: entity.playback.playbackRate,
      positionSeconds: entity.playback.currentTime,
      state: entity.playback.isPlaying ? "playing" : "paused",
      type: "media",
    });
  }

  #publishShaderPlayback(entity: ShaderCanvasEntity, remote?: HostedSceneEntity): void {
    if (!isTimeDependentCanvasEntity(entity)) return;
    const collaborative = remote ?? this.#remoteEntities.get(entity.id);
    this.#transport.submitPlaybackCommand({
      appearanceRevision: collaborative?.revisions.appearance ?? 0,
      commandId: crypto.randomUUID(),
      entityId: entity.id,
      shaderTime: entity.shaderParams.time ?? 0,
      state: entity.shaderParams.timeAutoPlay === false ? "paused" : "playing",
      type: "shader",
    });
  }

  async #applySnapshot(snapshot: ServerSceneSnapshotMessage): Promise<void> {
    this.#remoteEntities.clear();
    for (const entity of snapshot.entities) this.#remoteEntities.set(entity.id, entity);
    this.#playbackAnchors.clear();
    for (const anchor of snapshot.playback) this.#playbackAnchors.set(anchor.entityId, anchor);
    await this.#projection.applySnapshot(snapshot.entities);
    const roomNow = this.#transport.serverNow();
    for (const anchor of snapshot.playback) await this.#projection.applyPlayback(anchor, roomNow);
  }

  async #applyPatch(message: ServerScenePatchMessage): Promise<void> {
    for (const change of message.changes) {
      if (change.type === "entity.created")
        this.#remoteEntities.set(change.entity.id, change.entity);
      else if (change.type === "entity.patched") {
        const current = this.#remoteEntities.get(change.entityId);
        if (current) {
          this.#remoteEntities.set(change.entityId, applyHostedPatch(current, change));
        }
        if (change.patch.asset || change.patch.appearance) {
          this.#playbackAnchors.delete(change.entityId);
        }
      } else if (change.type === "entity.removed") {
        this.#remoteEntities.delete(change.entityId);
        this.#playbackAnchors.delete(change.entityId);
      } else {
        this.#remoteEntities.clear();
        for (const entity of change.entities) this.#remoteEntities.set(entity.id, entity);
        this.#playbackAnchors.clear();
      }
      await this.#projection.applyChange(change);
      const anchor =
        change.type === "entity.created" || change.type === "entity.patched"
          ? this.#playbackAnchors.get(
              change.type === "entity.created" ? change.entity.id : change.entityId,
            )
          : undefined;
      if (anchor) await this.#projection.applyPlayback(anchor, this.#transport.serverNow());
    }
  }

  #enqueueRemote(operation: () => Promise<void>): Promise<void> {
    const next = this.#remoteQueue.then(operation, operation);
    this.#remoteQueue = next.catch(this.#onError);
    return next;
  }

  #bumpRevision(entityId: string): number {
    const revision = (this.#entityRevisions.get(entityId) ?? 0) + 1;
    this.#entityRevisions.set(entityId, revision);
    return revision;
  }
}

function toHostedEntity(
  entity: ShaderCanvasEntity,
  asset: HostedAssetReference,
  generation: number,
): HostedSceneEntityInput {
  return {
    asset,
    edited: entity.edited,
    ...(isAnimatedEntity(entity) && { fps: entity.mediaSource.fps }),
    generation,
    ...(entity.mediaSource.type === MediaType.video && {
      hasAudio: entity.mediaSource.hasAudio,
    }),
    id: entity.id,
    locked: entity.locked ?? false,
    name: entity.name,
    ...(entity.originalPalette && {
      originalPalette: toJsonObject(entity.originalPalette),
    }),
    originalSize: { ...entity.originalSize },
    ...(isAnimatedEntity(entity) && { playbackDuration: entity.mediaSource.duration }),
    position: { ...entity.position },
    rotation: entity.rotation,
    shaderParams: staticShaderParams(entity.shaderParams),
    shaderType: entity.shaderType,
    size: { ...entity.size },
    zIndex: entity.zIndex,
  };
}

function toIdentityGroup(entity: ShaderCanvasEntity): NonNullable<HostedEntityPatch["identity"]> {
  return {
    edited: entity.edited,
    locked: entity.locked ?? false,
    name: entity.name,
    ...(entity.originalPalette && {
      originalPalette: toJsonObject(entity.originalPalette),
    }),
  };
}

function toGeometryGroup(entity: ShaderCanvasEntity): NonNullable<HostedEntityPatch["geometry"]> {
  return {
    originalSize: { ...entity.originalSize },
    position: { ...entity.position },
    rotation: entity.rotation,
    size: { ...entity.size },
  };
}

function toAppearanceGroup(
  entity: ShaderCanvasEntity,
): NonNullable<HostedEntityPatch["appearance"]> {
  return { shaderParams: staticShaderParams(entity.shaderParams), shaderType: entity.shaderType };
}

function toAssetGroup(
  entity: ShaderCanvasEntity,
  asset: HostedAssetReference,
): NonNullable<HostedEntityPatch["asset"]> {
  return {
    asset,
    ...(isAnimatedEntity(entity) && {
      fps: entity.mediaSource.fps,
      playbackDuration: entity.mediaSource.duration,
    }),
    ...(entity.mediaSource.type === MediaType.video && { hasAudio: entity.mediaSource.hasAudio }),
  };
}

function staticShaderParams(params: ShaderParams): JsonObject {
  const { time: _time, timeAutoPlay: _timeAutoPlay, ...staticParams } = params;
  return toJsonObject(staticParams);
}

function toJsonObject(value: object): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function isTimeDependentCanvasEntity(entity: ShaderCanvasEntity): boolean {
  return isTimeDependentShader({
    shaderParams: staticShaderParams(entity.shaderParams),
    shaderType: entity.shaderType,
  });
}

function hasGeometryUpdate(updates: Partial<ShaderCanvasEntity>): boolean {
  return (
    updates.position !== undefined ||
    updates.size !== undefined ||
    updates.originalSize !== undefined ||
    updates.rotation !== undefined
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

function applyHostedPatch(
  current: HostedSceneEntity,
  change: Pick<Extract<HostedSceneChange, { type: "entity.patched" }>, "patch" | "revisions">,
): HostedSceneEntity {
  const patch = change.patch;
  return {
    ...current,
    ...(patch.identity && patch.identity),
    ...(patch.geometry && patch.geometry),
    ...(patch.appearance && patch.appearance),
    ...(patch.layering && patch.layering),
    ...(patch.asset && patch.asset),
    revisions: change.revisions,
  };
}
