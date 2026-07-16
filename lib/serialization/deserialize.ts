import {
  type ColorPalette,
  ShaderType,
  type MediaImageAsset,
  type ShaderCanvasEntity,
  type ShaderParams,
} from "#types/canvas.ts";
import { unzip, type AsyncTerminable } from "fflate";
import { config } from "#config";
import { deepMerge } from "../deep-merge.ts";
import { decodeGif } from "../gif-decoder.ts";
import { probeVideoAlphaMode, rasterizeSvg } from "../media-loader.ts";
import { createAlphaHitGrid } from "../alpha-hit-testing.ts";
import { logger } from "../client.logger.ts";
import { disposeEntityMedia, disposeVideoElement } from "../media-resources.ts";
import { bytesToImageBitmap, bytesToVideoElement } from "./media.ts";
import { runMigrations } from "./migrations.ts";
import type {
  CommitDecodedWorkspace,
  DeserializeOptions,
  DeserializeProgress,
  DeserializeResult,
  SerializedEntity,
  StudioManifest,
} from "./types.ts";
import { isStudioManifest, toPlaybackState } from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";
import { analytics } from "#lib/analytics.ts";
import { createImageAsset, retainImageAsset } from "#lib/media-assets.ts";

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

const LARGE_WORKSPACE_PROGRESS_THRESHOLD = 1_000;
const DESERIALIZE_CHUNK_SIZE = 512;
const VALID_SHADER_TYPES = new Set<string>(Object.values(ShaderType));

interface DeserializationInternPool {
  shaderParams: Map<string, ShaderParams>;
  palettes: Map<string, ColorPalette>;
}

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

  // 0. Validate input type
  if (!(source instanceof Blob) && !(source instanceof ArrayBuffer)) {
    throw new Error(
      "deserialize() expects a Blob or ArrayBuffer. Did you forget to await serialize()?",
    );
  }

  const fileSizeBytes = source instanceof Blob ? source.size : source.byteLength;
  logger.debug("[workspace-import] deserialize start", {
    fileSizeBytes,
    sourceType: source instanceof Blob ? "blob" : "array-buffer",
  });

  reportProgress({ stage: "reading", fileSizeBytes });

  // 1. Unzip the archive
  const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
  throwIfAborted(signal);
  reportProgress({ stage: "unzipping", fileSizeBytes: buffer.byteLength });
  const zipEntries = await unzipArchive(buffer, signal);
  throwIfAborted(signal);

  // 2. Read and parse manifest
  reportProgress({ stage: "parsing", fileSizeBytes: buffer.byteLength });
  const manifestBytes = zipEntries["manifest.json"];
  if (!manifestBytes) {
    throw new Error("Invalid .vdmsh file: missing manifest.json");
  }

  const manifestJson = new TextDecoder().decode(manifestBytes);
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestJson);
  } catch {
    throw new Error("Invalid .vdmsh file: manifest.json is not valid JSON");
  }

  if (!isStudioManifest(manifest)) {
    throw new Error("Invalid .vdmsh file: manifest contains missing or invalid workspace fields");
  }
  const duplicateEntityId = findDuplicateEntityId(manifest.entities);
  if (duplicateEntityId) {
    throw new Error(`Invalid .vdmsh file: duplicate entity ID "${duplicateEntityId}"`);
  }
  throwIfAborted(signal);
  logger.debug("[workspace-import] manifest parsed", {
    version: (manifest as StudioManifest).version,
    entityCount: (manifest as StudioManifest).entities.length,
    paletteCount: (manifest as StudioManifest).palettes?.length ?? 0,
  });

  // 3. Run migrations if needed
  let doc = manifest as StudioManifest;
  const mergeShaderParamDefaults = doc.version !== CURRENT_VERSION;
  const workspaceEntityCount = doc.entities.length;
  let videoEntityCount = 0;
  for (const entity of doc.entities) {
    if (entity.mediaType === "video") videoEntityCount++;
  }
  let videoSeekTimeoutCount = 0;
  if (doc.version < CURRENT_VERSION) {
    doc = runMigrations(doc);
    warnings.push(`Migrated from v${manifest.version} to v${CURRENT_VERSION}`);
  }
  if (doc.version > CURRENT_VERSION) {
    warnings.push(
      `Document is from a newer version (v${doc.version}). Some features may not restore correctly.`,
    );
  }
  if (warnings.length > 0) {
    logger.debug("[workspace-import] manifest warnings", warnings);
  }

  // 4. Decode entities before committing so a failed import cannot mutate the
  //    current workspace or palette store. This function owns every successfully
  //    decoded media reference until the commit callback adopts the batch.
  //    Keep decoding sequential to reduce memory pressure on iOS Safari and give
  //    cancellation/progress updates time to run.
  const validEntities: ShaderCanvasEntity[] = [];
  const imageAssets = new Map<string, MediaImageAsset>();
  const internPool: DeserializationInternPool = {
    shaderParams: new Map(),
    palettes: new Map(),
  };
  let maxEntityId = 0;
  let maxZIndex = 0;
  let ownershipTransferred = false;

  try {
    for (let index = 0; index < doc.entities.length; index++) {
      const serialized = doc.entities[index]!;
      if (shouldReportEntityProgress(index, doc.entities.length)) {
        reportProgress({
          stage: "decoding",
          entityIndex: index + 1,
          entityCount: doc.entities.length,
          entityName: serialized.name,
          fileSizeBytes: buffer.byteLength,
        });
      }
      throwIfAborted(signal);

      if (index > 0 && index % DESERIALIZE_CHUNK_SIZE === 0) {
        await yieldToMainThread();
        throwIfAborted(signal);
      }

      try {
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
            const entity: ShaderCanvasEntity = {
              ...base,
              imageBitmap: cachedAsset.imageBitmap,
              mediaSource: { type: "image", asset: cachedAsset },
            };
            validEntities.push(entity);
            maxEntityId = Math.max(maxEntityId, parseEntityIdNumber(entity.id));
            maxZIndex = Math.max(maxZIndex, entity.zIndex);
            continue;
          }
        }
        const entity = await deserializeEntity(serialized, zipEntries, warnings, {
          workspaceEntityCount,
          videoEntityCount,
          imageAssets,
          internPool,
          mergeShaderParamDefaults,
          onVideoSeekTimeout: () => {
            videoSeekTimeoutCount++;
          },
        });
        validEntities.push(entity);
        maxEntityId = Math.max(maxEntityId, parseEntityIdNumber(entity.id));
        maxZIndex = Math.max(maxZIndex, entity.zIndex);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({
          entityId: serialized.id,
          entityName: serialized.name,
          error: message,
        });
        logger.warn(`[deserialize] Failed to restore "${serialized.name}": ${message}`);
      }
    }

    // If nothing decoded at all, bail without touching the current workspace.
    if (validEntities.length === 0 && doc.entities.length > 0) {
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

    reportProgress({
      stage: "restoring",
      entityCount: doc.entities.length,
      fileSizeBytes: buffer.byteLength,
    });

    commitWorkspace({
      palettes: doc.palettes ?? [],
      adopt: (replaceWorkspace) => {
        if (ownershipTransferred) {
          throw new Error("Decoded workspace has already been adopted");
        }
        replaceWorkspace(validEntities, doc.viewport);
        ownershipTransferred = true;
        return validEntities;
      },
    });
    if (!ownershipTransferred) {
      throw new Error("Workspace commit returned without adopting decoded media");
    }

    reportProgress({
      stage: "done",
      entityCount: validEntities.length,
      fileSizeBytes: buffer.byteLength,
    });
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
      for (const entity of validEntities) disposeEntityMedia(entity);
    }
  }
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
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function shouldReportEntityProgress(index: number, entityCount: number): boolean {
  return (
    entityCount < LARGE_WORKSPACE_PROGRESS_THRESHOLD ||
    index === 0 ||
    index === entityCount - 1 ||
    (index + 1) % DESERIALIZE_CHUNK_SIZE === 0
  );
}

function unzipArchive(
  buffer: ArrayBuffer,
  signal?: AbortSignal,
): Promise<Record<string, Uint8Array>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let terminate: AsyncTerminable | null = null;
    const startedAt = performance.now();

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => {
      terminate?.();
      logger.debug("[workspace-import] unzip aborted");
      finish(() => reject(createAbortError()));
    };

    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
    terminate = unzip(new Uint8Array(buffer), (err, entries) => {
      finish(() => {
        if (err) {
          logger.debug("[workspace-import] unzip failed", err);
          reject(err);
          return;
        }
        logger.debug("[workspace-import] unzip complete", {
          entryCount: Object.keys(entries).length,
          durationMs: Math.round(performance.now() - startedAt),
        });
        resolve(entries);
      });
    });
  });
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

function findDuplicateEntityId(entities: readonly SerializedEntity[]): string | null {
  const seen = new Set<string>();
  for (const entity of entities) {
    if (seen.has(entity.id)) return entity.id;
    seen.add(entity.id);
  }
  return null;
}

// ============================================================================
// Per-entity deserialization
// ============================================================================

/** Validate shaderType against known values, falling back to the default */
function validateShaderType(raw: string): ShaderType {
  return VALID_SHADER_TYPES.has(raw) ? (raw as ShaderType) : config.defaults.shader;
}

async function deserializeEntity(
  serialized: SerializedEntity,
  zipEntries: Record<string, Uint8Array>,
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
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);
      const imageBlob = new Blob([bytes.slice()]);
      const bitmap = await bytesToImageBitmap(bytes);
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
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);

      const ext = serialized.mediaFile.split(".").pop() ?? "mp4";
      const mimeType = MIME_BY_EXT[ext] ?? "video/mp4";
      const container = ext.toLowerCase();

      const videoBlob = new Blob([bytes.slice()], { type: mimeType });
      const savedTime = serialized.playback?.currentTime ?? 0;
      const { videoElement, initialFrame, duration, currentTime, seekApplied } =
        await bytesToVideoElement(bytes, mimeType, savedTime);
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
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);

      const blob = new Blob([bytes.slice()], { type: "image/gif" });
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
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);

      const text = new TextDecoder().decode(bytes);
      const blob = new Blob([bytes.slice()], { type: "image/svg+xml" });
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
  serialized: SerializedEntity,
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
  const shaderParams = internShaderParams(decodedShaderParams, internPool);
  const originalPalette = serialized.originalPalette
    ? internPalette(serialized.originalPalette, internPool)
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
  let canonical = internPool.shaderParams.get(signature);
  if (!canonical) {
    canonical = staticParams as ShaderParams;
    internPool.shaderParams.set(signature, canonical);
  }

  // Renderer animation controls mutate these two top-level fields in place. Keep
  // one shallow wrapper per entity while sharing the immutable nested parameter tree.
  return {
    ...canonical,
    ...(time !== undefined && { time }),
    ...(timeAutoPlay !== undefined && { timeAutoPlay }),
  };
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
