import {
  type ColorPalette,
  ShaderType,
  type MediaImageAsset,
  type ShaderCanvasEntity,
  type ShaderParams,
} from "#types/canvas.ts";
import { config } from "#config";
import { deepMerge } from "../deep-merge.ts";
import { decodeGif } from "../gif-decoder.ts";
import { probeVideoAlphaMode, rasterizeSvg } from "../media-loader.ts";
import { createAlphaHitGrid } from "../alpha-hit-testing.ts";
import { logger } from "../client.logger.ts";
import { disposeEntityMedia, disposeVideoElement } from "../media-resources.ts";
import { bytesToImageBitmap, bytesToVideoElement, MIME_BY_EXT } from "./media.ts";
import { runMigrations } from "./migrations.ts";
import type {
  CommitDecodedWorkspace,
  DeserializeOptions,
  DeserializeProgress,
  DeserializeResult,
  SerializedEntity,
  StudioManifest,
} from "./types.ts";
import { toPlaybackState, validateStudioManifest } from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";
import { analytics } from "#lib/analytics.ts";
import { createImageAsset, retainImageAsset } from "#lib/media-assets.ts";
import { registerShaderParamsIdentity } from "#lib/shader-params-identity.ts";

const DESERIALIZE_TIME_BUDGET_MS = 8;
const SHADER_PARAMS_SCHEMA_VERSION = 5;
const VALID_SHADER_TYPES = new Set<string>(Object.values(ShaderType));

interface DeserializationInternPool {
  shaderParams: Map<string, { identity: number; params: ShaderParams }>;
  palettes: Map<string, ColorPalette>;
  nextShaderParamsIdentity: number;
}

type ResolvedSerializedEntity = SerializedEntity & {
  mediaFile: string;
  shaderParams: ShaderParams;
  originalPalette?: ColorPalette;
  compactShaderParamsIdentity?: number;
};

/**
 * Deserialize a .vdmsh archive (Blob or ArrayBuffer) and restore the canvas.
 *
 * Clears the existing canvas state, restores viewport, and adds all entities.
 * Returns a result object with success status, warnings, and per-entity errors.
 */
export async function deserialize(
  source: Blob | ArrayBuffer,
  commitWorkspace: CommitDecodedWorkspace,
  options: DeserializeOptions = {},
): Promise<DeserializeResult> {
  const { signal, onProgress } = options;
  const warnings: string[] = [];
  const errors: { entityId: string; entityName: string; error: string }[] = [];
  const startedAt = performance.now();
  let lastStage: DeserializeProgress["stage"] | null = null;
  let ownershipTransferred = false;
  const validEntities: ShaderCanvasEntity[] = [];
  const imageAssets = new Map<string, MediaImageAsset>();
  const internPool: DeserializationInternPool = {
    shaderParams: new Map(),
    palettes: new Map(),
    nextShaderParamsIdentity: 1,
  };

  const fileSizeBytes = source instanceof Blob ? source.size : source.byteLength;
  const reportProgress = (progress: DeserializeProgress) => {
    throwIfAborted(signal);
    if (progress.stage !== lastStage) {
      lastStage = progress.stage;
      logger.debug("[workspace-import] stage", progress);
    } else if (progress.stage === "decoding") {
      logger.debug("[workspace-import] decoding entity", progress);
    }
    onProgress?.(progress);
  };

  if (!(source instanceof Blob) && !(source instanceof ArrayBuffer)) {
    throw new Error(
      "deserialize() expects a Blob or ArrayBuffer. Did you forget to await serialize()?",
    );
  }

  reportProgress({ stage: "reading", fileSizeBytes });
  logger.debug("[workspace-import] deserialize start", {
    fileSizeBytes,
    sourceType: source instanceof Blob ? "blob" : "array-buffer",
  });

  let doc: StudioManifest | null = null;
  let validation: ReturnType<typeof validateStudioManifest> = null;
  let workspaceEntityCount = 0;
  let videoEntityCount = 0;
  let videoSeekTimeoutCount = 0;
  let mergeShaderParamDefaults = false;
  let decodedEntities: Array<ShaderCanvasEntity | undefined> = [];
  const mediaGroups = new Map<string, Array<{ entity: ResolvedSerializedEntity; index: number }>>();
  const seenMediaFiles = new Set<string>();

  const processMediaFile = async (path: string, bytes: Uint8Array | null): Promise<void> => {
    if (!doc || !validation) throw new Error("Invalid .vdmsh file: manifest.json must come first");
    const group = mediaGroups.get(path);
    logger.debug("[workspace-import] page media entry received", {
      path,
      byteLength: bytes?.byteLength ?? 0,
      entityCount: group?.length ?? 0,
    });
    if (!group) return;
    seenMediaFiles.add(path);

    let lastYieldAt = performance.now();
    for (const { entity: serialized, index } of group) {
      const shouldYield = index > 0 && performance.now() - lastYieldAt >= DESERIALIZE_TIME_BUDGET_MS;
      reportProgress({
        stage: "decoding",
        entityIndex: index + 1,
        entityCount: workspaceEntityCount,
        entityName: serialized.name,
        fileSizeBytes,
      });
      throwIfAborted(signal);
      if (shouldYield) {
        await yieldToMainThread();
        lastYieldAt = performance.now();
        throwIfAborted(signal);
      }

      try {
        if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);
        if (serialized.mediaType === "image") {
          const cachedAsset = imageAssets.get(serialized.mediaFile);
          if (cachedAsset) {
            const base = createDeserializedEntityBase(
              serialized,
              warnings,
              mergeShaderParamDefaults,
              internPool,
            );
            retainImageAsset(cachedAsset);
            decodedEntities[index] = {
              ...base,
              imageBitmap: cachedAsset.imageBitmap,
              mediaSource: { type: "image", asset: cachedAsset },
            };
            continue;
          }
          logger.debug("[workspace-import] page decoding image", {
            path,
            entityIndex: index + 1,
            byteLength: bytes.byteLength,
          });
        }
        decodedEntities[index] = await deserializeEntity(serialized, bytes, warnings, {
          workspaceEntityCount,
          videoEntityCount,
          imageAssets,
          internPool,
          mergeShaderParamDefaults,
          onVideoSeekTimeout: () => {
            videoSeekTimeoutCount++;
          },
        });
        logger.debug("[workspace-import] page decoded entity", {
          path,
          entityIndex: index + 1,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          entityId: serialized.id,
          entityName: serialized.name,
          error: message,
        });
        logger.warn(`[deserialize] Failed to restore "${serialized.name}": ${message}`);
      }
    }
  };

  try {
    reportProgress({ stage: "unzipping", fileSizeBytes });
    await streamArchive(
      source,
      async (path, bytes) => {
        logger.debug("[workspace-import] page received ZIP entry", {
          path,
          byteLength: bytes.byteLength,
        });
        if (path === "manifest.json") {
          reportProgress({ stage: "parsing", fileSizeBytes });
          let parsed: unknown;
          try {
            parsed = JSON.parse(new TextDecoder().decode(bytes));
          } catch {
            throw new Error("Invalid .vdmsh file: manifest.json is not valid JSON");
          }
          validation = validateStudioManifest(parsed);
          if (!validation) {
            throw new Error("Invalid .vdmsh file: manifest contains missing or invalid workspace fields");
          }
          if (validation.duplicateEntityId) {
            throw new Error(
              `Invalid .vdmsh file: duplicate entity ID "${validation.duplicateEntityId}"`,
            );
          }
          const importedManifest = validation.manifest;
          const importedVersion = importedManifest.version;
          mergeShaderParamDefaults = importedVersion < SHADER_PARAMS_SCHEMA_VERSION;
          workspaceEntityCount = importedManifest.entities.length;
          videoEntityCount = validation.videoEntityCount;
          const migratedDoc =
            importedVersion < CURRENT_VERSION ? runMigrations(importedManifest) : importedManifest;
          doc = migratedDoc;
          if (importedVersion < CURRENT_VERSION) {
            warnings.push(`Migrated from v${importedVersion} to v${CURRENT_VERSION}`);
          }
          if (migratedDoc.version > CURRENT_VERSION) {
            warnings.push(
              `Document is from a newer version (v${migratedDoc.version}). Some features may not restore correctly.`,
            );
          }
          decodedEntities = new Array(migratedDoc.entities.length);
          internPool.nextShaderParamsIdentity = (migratedDoc.shaderParamsTable?.length ?? 0) + 1;
          for (let index = 0; index < (migratedDoc.shaderParamsTable?.length ?? 0); index++) {
            registerShaderParamsIdentity(migratedDoc.shaderParamsTable![index]!, index + 1);
          }
          for (let index = 0; index < migratedDoc.entities.length; index++) {
            const resolved = resolveSerializedEntity(migratedDoc.entities[index]!, migratedDoc);
            const group = mediaGroups.get(resolved.mediaFile) ?? [];
            group.push({ entity: resolved, index });
            mediaGroups.set(resolved.mediaFile, group);
          }
          logger.debug("[workspace-import] manifest parsed", {
            version: migratedDoc.version,
            entityCount: workspaceEntityCount,
            paletteCount: migratedDoc.palettes?.length ?? 0,
          });
          return;
        }

        await processMediaFile(path, bytes);
        logger.debug("[workspace-import] page completed ZIP entry", { path });
      },
      signal,
    );

    if (!doc || !validation) throw new Error("Invalid .vdmsh file: missing manifest.json");
    for (const [path] of mediaGroups) {
      if (!seenMediaFiles.has(path)) await processMediaFile(path, null);
    }

    for (const entity of decodedEntities) {
      if (entity) {
        validEntities.push(entity);
      }
    }

    const workspace = doc as StudioManifest;
    if (validEntities.length === 0 && workspace.entities.length > 0) {
      analytics.track("deserialization.import_summary", {
        workspaceEntityCount,
        videoEntityCount,
        videoSeekTimeoutCount,
        errorCount: errors.length,
        success: false,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return {
        success: false,
        entityCount: 0,
        maxEntityId: 0,
        maxZIndex: 0,
        warnings,
        errors,
      };
    }

    let maxEntityId = 0;
    let maxZIndex = 0;
    for (const entity of validEntities) {
      maxEntityId = Math.max(maxEntityId, parseEntityIdNumber(entity.id));
      maxZIndex = Math.max(maxZIndex, entity.zIndex);
    }

    reportProgress({ stage: "restoring", entityCount: workspaceEntityCount, fileSizeBytes });
    commitWorkspace({
      palettes: workspace.palettes ?? [],
      adopt: (replaceWorkspace) => {
        if (ownershipTransferred) throw new Error("Decoded workspace has already been adopted");
        replaceWorkspace(validEntities, workspace.viewport);
        ownershipTransferred = true;
        return validEntities;
      },
    });
    if (!ownershipTransferred) throw new Error("Workspace commit returned without adopting decoded media");

    reportProgress({ stage: "done", entityCount: validEntities.length, fileSizeBytes });
    logger.debug("[workspace-import] deserialize complete", {
      durationMs: Math.round(performance.now() - startedAt),
      entityCount: validEntities.length,
      errorCount: errors.length,
      warningCount: warnings.length,
    });
    analytics.track("deserialization.import_summary", {
      workspaceEntityCount,
      videoEntityCount,
      videoSeekTimeoutCount,
      errorCount: errors.length,
      success: errors.length === 0,
      durationMs: Math.round(performance.now() - startedAt),
    });

    return {
      success: errors.length === 0,
      entityCount: validEntities.length,
      maxEntityId,
      maxZIndex,
      warnings,
      errors,
    };
  } finally {
    if (!ownershipTransferred) {
      const stagedEntities = new Set(validEntities);
      for (const entity of decodedEntities) {
        if (entity) stagedEntities.add(entity);
      }
      for (const entity of stagedEntities) disposeEntityMedia(entity);
    }
  }
}

async function streamArchive(
  source: Blob | ArrayBuffer,
  onEntry: (path: string, bytes: Uint8Array) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const worker = new Worker(new URL("./deserialize-worker.ts", import.meta.url), { type: "module" });

  return new Promise<void>((resolve, reject) => {
    let currentPath: string | null = null;
    let currentChunks: Uint8Array[] = [];
    let currentSize = 0;
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      worker.terminate();
      callback();
    };
    const onAbort = () => {
      worker.postMessage({ type: "cancel" });
      finish(() => reject(createAbortError()));
    };
    const fail = (error: unknown) => {
      worker.postMessage({ type: "cancel" });
      finish(() => reject(error instanceof Error ? error : new Error(String(error))));
    };

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === "worker-log") {
        const details = message.details ?? {};
        if (message.level === "error") {
          logger.error("[workspace-import] worker error", message.message, details);
          console.error("[workspace-import] worker error", message.message, details);
        } else {
          logger.debug("[workspace-import] worker", message.message, details);
        }
        return;
      }
      if (message.type === "error") {
        const stage = message.stage ? ` (${String(message.stage)})` : "";
        const error = new Error(`${String(message.message ?? "Deserialize worker failed")}${stage}`);
        if (message.stack) error.stack = String(message.stack);
        logger.error("[workspace-import] deserialize worker failed", error);
        console.error("[workspace-import] deserialize worker failed", error);
        return fail(error);
      }
      if (message.type === "done") {
        return finish(resolve);
      }
      if (message.type === "entry-start") {
        if (currentPath) return fail(new Error("ZIP archive emitted overlapping entries"));
        currentPath = message.path;
        currentChunks = [];
        currentSize = 0;
        worker.postMessage({ type: "ack" });
      } else if (message.type === "entry-chunk") {
        if (currentPath !== message.path) return fail(new Error("ZIP entry chunk path mismatch"));
        const chunk = new Uint8Array(message.chunk);
        currentChunks.push(chunk);
        currentSize += chunk.byteLength;
        worker.postMessage({ type: "ack" });
      } else if (message.type === "entry-end") {
        if (currentPath !== message.path) return fail(new Error("ZIP entry end path mismatch"));
        const path = currentPath as string;
        const bytes = concatBytes(currentChunks, currentSize);
        currentPath = null;
        currentChunks = [];
        currentSize = 0;
        worker.postMessage({ type: "ack" });
        logger.debug("[workspace-import] dispatching ZIP entry to page", {
          path,
          byteLength: bytes.byteLength,
        });
        void onEntry(path, bytes)
          .then(() => worker.postMessage({ type: "entry-done", path }))
          .catch((error) => {
            logger.error("[workspace-import] page ZIP entry failed", { path, error });
            console.error("[workspace-import] page ZIP entry failed", path, error);
            fail(error);
          });
      }
    };
    worker.onerror = (event) => fail(new Error(`Deserialize worker failed: ${event.message}`));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();

    const transfer = source instanceof ArrayBuffer ? [source] : [];
    worker.postMessage({ type: "start", source }, transfer);
  });
}

function concatBytes(chunks: Uint8Array[], totalSize: number): Uint8Array {
  const bytes = new Uint8Array(totalSize);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function createAbortError(): Error {
  if (typeof DOMException !== "undefined") {
    return new DOMException("Workspace import cancelled", "AbortError");
  }

  const error = new Error("Workspace import cancelled");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    logger.debug("[workspace-import] abort requested");
    throw createAbortError();
  }
}

async function yieldToMainThread(): Promise<void> {
  await mainThreadYieldScheduler.yield();
}

const mainThreadYieldScheduler = createMainThreadYieldScheduler();

function createMainThreadYieldScheduler(): { yield: () => Promise<void> } {
  if (typeof MessageChannel === "undefined") {
    return {
      yield: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    };
  }

  const channel = new MessageChannel();
  const pending: Array<() => void> = [];
  channel.port1.onmessage = () => pending.shift()?.();
  return {
    yield: () =>
      new Promise<void>((resolve) => {
        pending.push(resolve);
        channel.port2.postMessage(undefined);
      }),
  };
}

/**
 * Returns the maximum entity ID number and zIndex from the restored entities.
 * Used by canvas-context to update its counters after deserialization.
 */
export function getMaxCounters(result: DeserializeResult): {
  maxId: number;
  maxZIndex: number;
} {
  return { maxId: result.maxEntityId, maxZIndex: result.maxZIndex };
}

function parseEntityIdNumber(entityId: string): number {
  const prefixLength = 7;
  if (!entityId.startsWith("entity-") || entityId.length === prefixLength) return 0;
  let value = 0;
  for (let index = prefixLength; index < entityId.length; index++) {
    const digit = entityId.charCodeAt(index) - 48;
    if (digit < 0 || digit > 9) return 0;
    value = value * 10 + digit;
  }
  return value;
}

function resolveSerializedEntity(
  serialized: SerializedEntity,
  doc: StudioManifest,
): ResolvedSerializedEntity {
  const mediaFile =
    serialized.mediaFile ??
    (serialized.mediaFileRef === undefined ? undefined : doc.mediaFiles?.[serialized.mediaFileRef]);
  const staticShaderParams =
    serialized.shaderParams ??
    (serialized.shaderParamsRef === undefined
      ? undefined
      : doc.shaderParamsTable?.[serialized.shaderParamsRef]);
  if (!mediaFile || !staticShaderParams) {
    throw new Error(`Invalid compact entity references for "${serialized.name}"`);
  }

  if (serialized.shaderParamsRef === undefined) {
    return serialized as ResolvedSerializedEntity;
  }

  const identity = serialized.shaderParamsRef + 1;
  const shaderParams: ShaderParams = {
    ...staticShaderParams,
    ...(serialized.shaderTime !== undefined && { time: serialized.shaderTime }),
    ...(serialized.shaderTimeAutoPlay !== undefined && {
      timeAutoPlay: serialized.shaderTimeAutoPlay,
    }),
  };
  registerShaderParamsIdentity(shaderParams, identity);
  const resolved = serialized as ResolvedSerializedEntity;
  resolved.mediaFile = mediaFile;
  resolved.shaderParams = shaderParams;
  resolved.originalPalette =
    serialized.originalPalette ??
    (serialized.originalPaletteRef === undefined
      ? undefined
      : doc.originalPalettes?.[serialized.originalPaletteRef]);
  resolved.compactShaderParamsIdentity = identity;
  return resolved;
}

// ============================================================================
// Per-entity deserialization
// ============================================================================

/** Validate shaderType against known values, falling back to the default */
function validateShaderType(raw: string): ShaderType {
  return VALID_SHADER_TYPES.has(raw) ? (raw as ShaderType) : config.defaults.shader;
}

async function deserializeEntity(
  serialized: ResolvedSerializedEntity,
  bytes: Uint8Array,
  warnings: string[],
  analyticsContext: {
    workspaceEntityCount: number;
    videoEntityCount: number;
    imageAssets: Map<string, MediaImageAsset>;
    internPool: DeserializationInternPool;
    mergeShaderParamDefaults: boolean;
    onVideoSeekTimeout: () => void;
  },
): Promise<ShaderCanvasEntity> {
  const base = createDeserializedEntityBase(
    serialized,
    warnings,
    analyticsContext.mergeShaderParamDefaults,
    analyticsContext.internPool,
  );

  switch (serialized.mediaType) {
    case "image": {
          const extension = serialized.mediaFile.split(".").pop()?.toLowerCase() ?? "png";
          const imageBlob = new Blob([bytes as Uint8Array<ArrayBuffer>], {
            type: MIME_BY_EXT[extension] ?? "image/png",
          });
      const bitmap = await bytesToImageBitmap(imageBlob);
      let asset: MediaImageAsset;
      try {
        asset = createImageAsset({
          imageBitmap: bitmap,
          blob: imageBlob,
          alphaHitGrid: createAlphaHitGrid(bitmap, config.hitTesting.alphaGrid),
        });
      } catch (error) {
        bitmap.close();
        throw error;
      }
      analyticsContext.imageAssets.set(serialized.mediaFile, asset);
      return {
        ...base,
        imageBitmap: bitmap,
        mediaSource: { type: "image" as const, asset },
      };
    }

    case "video": {
      const ext = serialized.mediaFile.split(".").pop() ?? "mp4";
      const mimeType = MIME_BY_EXT[ext] ?? "video/mp4";
      const container = ext.toLowerCase();

      const videoBlob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mimeType });
      const savedTime = serialized.playback?.currentTime ?? 0;
      const { videoElement, initialFrame, duration, currentTime, seekApplied } =
        await bytesToVideoElement(videoBlob, mimeType, savedTime);
      try {
        const playback = toPlaybackState(serialized.playback);
        playback.currentTime = currentTime;

        let timedOutSeekMetadata: Awaited<
          ReturnType<typeof probeTimedOutVideoSeekMetadata>
        > | null = null;
        if (!seekApplied && savedTime > 0) {
          analyticsContext.onVideoSeekTimeout();
          timedOutSeekMetadata = await probeTimedOutVideoSeekMetadata(videoBlob);
          const hasAudio = serialized.hasAudio ?? timedOutSeekMetadata.hasAudio;
          analytics.track("deserialization.video_seek_timed_out", {
            mediaType: "video",
            container,
            mimeType,
            videoCodec: timedOutSeekMetadata.videoCodec,
            audioCodec: timedOutSeekMetadata.audioCodec,
            sizeBytes: bytes.length,
            duration,
            width: videoElement.videoWidth,
            height: videoElement.videoHeight,
            fps: serialized.fps,
            hasAudio,
            savedSeekTime: savedTime,
            savedSeekRatio: duration > 0 ? savedTime / duration : null,
            currentTimeAfterRecovery: currentTime,
            bitrateEstimate: duration > 0 ? (bytes.length * 8) / duration : null,
            workspaceEntityCount: analyticsContext.workspaceEntityCount,
            videoEntityCount: analyticsContext.videoEntityCount,
          });
        }

        // v3+ files have hasAudio in the manifest; legacy files need a probe
        const hasAudio =
          serialized.hasAudio ??
          timedOutSeekMetadata?.hasAudio ??
          (await import("#lib/audio-demux.ts").then(({ hasAudioTrack }) =>
            hasAudioTrack(videoBlob),
          ));
        const alphaMode = await probeVideoAlphaMode(videoBlob);

        return {
          ...base,
          imageBitmap: initialFrame,
          mediaSource: {
            type: "video" as const,
            videoElement,
            blob: videoBlob,
            duration,
            fps: serialized.fps,
            hasAudio,
            alphaMode,
          },
          playback,
        };
      } catch (error) {
        disposeVideoElement(videoElement);
        initialFrame.close();
        throw error;
      }
    }

    case "gif": {
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/gif" });
      const { frames, duration, fps } = await decodeGif(blob);
      try {
        const framesWithAlpha = frames.map((frame) => ({
          ...frame,
          alphaHitGrid: createAlphaHitGrid(frame.bitmap, config.hitTesting.alphaGrid),
        }));

        if (framesWithAlpha.length === 0) throw new Error("GIF has no frames");

        return {
          ...base,
          imageBitmap: framesWithAlpha[0]!.bitmap,
          mediaSource: {
            type: "gif" as const,
            frames: framesWithAlpha,
            duration,
            fps,
            blob,
          },
          playback: toPlaybackState(serialized.playback),
        };
      } catch (error) {
        for (const frame of frames) frame.bitmap.close();
        throw error;
      }
    }

    case "svg": {
      const text = new TextDecoder().decode(bytes);
      const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "image/svg+xml" });
      const { bitmap } = await rasterizeSvg(text);
      try {
        return {
          ...base,
          imageBitmap: bitmap,
          mediaSource: {
            type: "svg" as const,
            blob,
            alphaHitGrid: createAlphaHitGrid(bitmap, config.hitTesting.alphaGrid),
          },
        };
      } catch (error) {
        bitmap.close();
        throw error;
      }
    }

    default:
      throw new Error(`Unknown media type: ${(serialized as Record<string, unknown>).mediaType}`);
  }
}

function createDeserializedEntityBase(
  serialized: ResolvedSerializedEntity,
  warnings: string[],
  mergeShaderParamDefaults: boolean,
  internPool: DeserializationInternPool,
) {
  const shaderType = validateShaderType(serialized.shaderType);
  if (shaderType !== serialized.shaderType) {
    warnings.push(
      `Entity "${serialized.name}": unknown shader "${serialized.shaderType}", using "${shaderType}"`,
    );
  }

  // JSON.parse already created a unique params object for every current-version entity.
  // Only schema-mismatched documents need compatibility defaults filled recursively.
  const decodedShaderParams = mergeShaderParamDefaults
    ? deepMerge(
        structuredClone(config.defaults.shaderParams) as ShaderParams,
        serialized.shaderParams,
      )
    : serialized.shaderParams;
  const shaderParams =
    serialized.compactShaderParamsIdentity === undefined
      ? internShaderParams(decodedShaderParams, internPool)
      : decodedShaderParams;
  const originalPalette = serialized.originalPalette
    ? serialized.originalPaletteRef === undefined
      ? internPalette(serialized.originalPalette, internPool)
      : serialized.originalPalette
    : undefined;

  return {
    id: serialized.id,
    name: serialized.name,
    position: serialized.position,
    size: serialized.size,
    originalSize: serialized.originalSize,
    zIndex: serialized.zIndex,
    rotation: serialized.rotation,
    locked: serialized.locked,
    edited: serialized.edited,
    shaderType,
    shaderParams,
    textureDirty: true as const,
    selected: false as const,
    ...(originalPalette && {
      originalPalette,
    }),
  };
}

function internShaderParams(
  params: ShaderParams,
  internPool: DeserializationInternPool,
): ShaderParams {
  const palette = params.palette ? internPalette(params.palette, internPool) : undefined;
  const paramsWithInternedPalette =
    palette && palette !== params.palette ? { ...params, palette } : params;
  const { time, timeAutoPlay, ...staticParams } = paramsWithInternedPalette;
  const signature = JSON.stringify(staticParams);
  let entry = internPool.shaderParams.get(signature);
  if (!entry) {
    const canonical = staticParams as ShaderParams;
    entry = {
      identity: internPool.nextShaderParamsIdentity++,
      params: canonical,
    };
    internPool.shaderParams.set(signature, entry);
    registerShaderParamsIdentity(canonical, entry.identity);
  }

  // Renderer animation controls mutate these two top-level fields in place. Keep
  // one shallow wrapper per entity while sharing the immutable nested parameter tree.
  const result = {
    ...entry.params,
    ...(time !== undefined && { time }),
    ...(timeAutoPlay !== undefined && { timeAutoPlay }),
  };
  registerShaderParamsIdentity(result, entry.identity);
  return result;
}

function internPalette(palette: ColorPalette, internPool: DeserializationInternPool): ColorPalette {
  const signature = JSON.stringify(palette);
  const canonical = internPool.palettes.get(signature);
  if (canonical) return canonical;
  internPool.palettes.set(signature, palette);
  return palette;
}

async function probeTimedOutVideoSeekMetadata(videoBlob: Blob): Promise<{
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
}> {
  try {
    const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
    const input = new Input({
      source: new BlobSource(videoBlob),
      formats: ALL_FORMATS,
    });

    try {
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]);
      const [videoDecoderConfig, audioDecoderConfig] = await Promise.all([
        videoTrack?.getDecoderConfig() ?? Promise.resolve(null),
        audioTrack?.getDecoderConfig() ?? Promise.resolve(null),
      ]);

      return {
        hasAudio: audioTrack !== null,
        videoCodec: videoDecoderConfig?.codec ?? null,
        audioCodec: audioDecoderConfig?.codec ?? null,
      };
    } finally {
      input.dispose();
    }
  } catch (error) {
    logger.debug("[workspace-import] failed to probe timed out video metadata", error);
    return {
      hasAudio: false,
      videoCodec: null,
      audioCodec: null,
    };
  }
}
