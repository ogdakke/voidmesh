import { canvasStore } from "#engine";
import { config } from "#config";
import { createPlaybackState } from "#lib/media-playback.ts";
import type { ColorPalette, ShaderCanvasEntity, ShaderParams } from "#types/canvas.ts";
import { startWorkspaceDownload } from "#lib/download.ts";
import { paletteStore } from "#lib/palette-store.ts";
import {
  imageExtensionFromMime,
  videoExtensionFromMime,
} from "#lib/serialization/media.ts";
import type {
  SerializeMediaEntry,
  SerializedEntity,
  SerializedPlaybackState,
  StudioManifest,
} from "#lib/serialization/types.ts";
import { CURRENT_VERSION } from "#lib/serialization/version.ts";
import { getStaticShaderParamsIdentity } from "#lib/shader-params-identity.ts";
import { logger } from "#lib/client.logger.ts";

export interface SerializeWorkspaceOptions {
  /** Opens the direct File System Access sink after metadata preparation. */
  openOutput?: () => Promise<MessagePort>;
}

/** Synchronous flag — prevents overlapping saves even when React state hasn't flushed yet. */
let isSaving = false;

export function getIsSaving(): boolean {
  return isSaving;
}

/**
 * Serialize the current canvas state into a streamed .vdmsh file or download.
 *
 * ZIP compression runs in a Web Worker.
 * The main thread only prepares entity metadata and retains source Blob references.
 * Concurrent calls are rejected (returns null) to prevent queuing redundant saves.
 */
export async function serialize(
  filename: string,
  options: SerializeWorkspaceOptions = {},
): Promise<string | null> {
  if (isSaving) return null;
  isSaving = true;
  let downloadPort: MessagePort | null = null;

  try {
    if (!options.openOutput) {
      downloadPort = startWorkspaceDownload(filename);
    }
    const state = canvasStore.getState();
    const entities = Array.from(state.entities.values());
    logger.debug("[workspace-save] preparing workspace", {
      filename,
      destination: options.openOutput ? "file-handle" : "download",
      entityCount: entities.length,
    });

    // Sort by zIndex for deterministic output
    entities.sort((a, b) => a.zIndex - b.zIndex);

    // Prepare only metadata and retain each source Blob. Encoding and ZIP output
    // are streamed in the worker one media entry at a time.
    const serializedEntities: SerializedEntity[] = [];
    const mediaEntries: SerializeMediaEntry[] = [];
    const serializedImageAssets = new Set<string>();
    const compactTables = createCompactTables();

    for (const entity of entities) {
      const { serialized, media } = prepareEntity(entity, serializedImageAssets, compactTables);
      serializedEntities.push(serialized);
      if (media) mediaEntries.push(media);
    }

    // Collect custom/extracted palettes referenced by entities
    const referencedPalettes = collectReferencedPalettes(entities);

    const manifest: StudioManifest = {
      type: "studio-canvas",
      version: CURRENT_VERSION,
      createdAt: new Date().toISOString(),
      viewport: {
        offset: { x: state.viewport.offset.x, y: state.viewport.offset.y },
        zoom: state.viewport.zoom,
      },
      entities: serializedEntities,
      shaderParamsTable: compactTables.shaderParams,
      mediaFiles: compactTables.mediaFiles,
      ...(compactTables.originalPalettes.length > 0 && {
        originalPalettes: compactTables.originalPalettes,
      }),
      ...(referencedPalettes.length > 0 && { palettes: referencedPalettes }),
    };

    const manifestJson = JSON.stringify(manifest, null, 2);

    if (!downloadPort) downloadPort = await (options.openOutput?.() ?? Promise.resolve(null));
    if (!downloadPort) throw new Error("Workspace download service worker is not ready");
    logger.debug("[workspace-save] starting archive worker", {
      filename,
      manifestBytes: new TextEncoder().encode(manifestJson).byteLength,
      mediaEntryCount: mediaEntries.length,
    });
    const workerDownloadPort = downloadPort;
    downloadPort = null;
    await compressInWorker(manifestJson, mediaEntries, workerDownloadPort);
    logger.debug("[workspace-save] workspace saved", { filename });
    return filename;
  } catch (error) {
    logger.error("[workspace-save] workspace save failed", {
      filename,
      error: error instanceof Error ? error.message : String(error),
    });
    if (downloadPort) {
      downloadPort.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      downloadPort.close();
    }
    throw error;
  } finally {
    isSaving = false;
  }
}

let serializeWorker: Worker | null = null;

function getSerializeWorker(): Worker {
  if (!serializeWorker) {
    serializeWorker = new Worker(
      new URL("../../lib/serialization/serialize-worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
  }
  return serializeWorker;
}

function compressInWorker(
  manifest: string,
  mediaEntries: SerializeMediaEntry[],
  downloadPort: MessagePort,
): Promise<void> {
  const worker = getSerializeWorker();

  return new Promise<void>((resolve, reject) => {
    let mediaIndex = 0;
    let settled = false;
    const failWorker = (error: Error) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      if (serializeWorker === worker) serializeWorker = null;
      reject(error);
    };
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "log") {
        logger.debug("[workspace-save] archive worker stage", e.data);
      } else if (e.data.type === "ready-for-media") {
        sendNextMedia();
      } else if (e.data.type === "media-done") {
        sendNextMedia();
      } else if (e.data.type === "done") {
        settled = true;
        logger.debug("[workspace-save] archive worker completed", { mediaCount: mediaEntries.length });
        worker.terminate();
        serializeWorker = null;
        resolve();
      } else if (e.data.type === "error") {
        logger.error("[workspace-save] archive worker failed", e.data);
        failWorker(new Error(e.data.message));
      } else if (e.data.type === "fatal-error") {
        logger.error("[workspace-save] archive worker fatal error", e.data);
        failWorker(new Error(formatWorkerError(e.data)));
      }
    };

    worker.onerror = (err) => {
      const details = {
        message: err.message || "Unknown worker error",
        filename: err.filename,
        lineno: err.lineno,
        colno: err.colno,
        error: err.error instanceof Error ? err.error.stack || err.error.message : err.error,
      };
      logger.error("[workspace-save] archive worker runtime error", details);
      failWorker(new Error(formatWorkerError(details)));
      // Worker is broken — discard so next save creates a fresh one
    };

    worker.postMessage({ type: "start", manifest, downloadPort }, [downloadPort]);

    function sendNextMedia(): void {
      const entry = mediaEntries[mediaIndex++];
      if (entry) {
        logger.debug("[workspace-save] sending media to archive worker", {
          path: entry.path,
          index: mediaIndex,
          total: mediaEntries.length,
        });
        worker.postMessage({ type: "media", entry });
      } else {
        logger.debug("[workspace-save] finishing archive worker", { mediaCount: mediaEntries.length });
        worker.postMessage({ type: "finish" });
      }
    }
  });
}

function formatWorkerError(error: {
  message?: unknown;
  filename?: unknown;
  lineno?: unknown;
  colno?: unknown;
  error?: unknown;
  stack?: unknown;
}): string {
  const message = String(error.message ?? error.error ?? "Unknown worker error");
  const location =
    error.filename && error.lineno
      ? ` (${String(error.filename)}:${String(error.lineno)}:${String(error.colno ?? 0)})`
      : "";
  const stack = error.stack ? `\n${String(error.stack)}` : "";
  return `Serialization worker failed: ${message}${location}${stack}`;
}

interface PreparedEntity {
  serialized: SerializedEntity;
  media?: SerializeMediaEntry;
}

interface CompactTables {
  shaderParams: ShaderParams[];
  shaderParamRefs: Map<number | string, number>;
  mediaFiles: string[];
  mediaFileRefs: Map<string, number>;
  originalPalettes: ColorPalette[];
  originalPaletteRefs: Map<string, number>;
}

function createCompactTables(): CompactTables {
  return {
    shaderParams: [],
    shaderParamRefs: new Map(),
    mediaFiles: [],
    mediaFileRefs: new Map(),
    originalPalettes: [],
    originalPaletteRefs: new Map(),
  };
}

function prepareEntity(
  entity: ShaderCanvasEntity,
  serializedImageAssets: Set<string>,
  tables: CompactTables,
): PreparedEntity {
  const { time, timeAutoPlay, ...staticShaderParams } = entity.shaderParams;
  const base = {
    id: entity.id,
    name: entity.name,
    position: { x: entity.position.x, y: entity.position.y },
    size: { width: entity.size.width, height: entity.size.height },
    originalSize: {
      width: entity.originalSize.width,
      height: entity.originalSize.height,
    },
    zIndex: entity.zIndex,
    rotation: entity.rotation,
    locked: entity.locked ?? false,
    edited: entity.edited,
    shaderType: entity.shaderType,
    shaderParamsRef: internShaderParams(
      entity.shaderParams,
      staticShaderParams as ShaderParams,
      tables,
    ),
    ...(time !== undefined && { shaderTime: time }),
    ...(timeAutoPlay !== undefined && { shaderTimeAutoPlay: timeAutoPlay }),
    ...(entity.originalPalette && {
      originalPaletteRef: internOriginalPalette(entity.originalPalette, tables),
    }),
  };

  switch (entity.mediaSource.type) {
    case "image": {
      const asset = entity.mediaSource.asset;
      const extension = imageExtensionFromMime(asset.blob.type);
      const path = `media/assets/${encodeURIComponent(asset.id)}-${asset.revision}.${extension}`;
      const mediaFileRef = internMediaFile(path, tables);
      if (serializedImageAssets.has(path)) {
        return { serialized: { ...base, mediaType: "image", mediaFileRef } };
      }
      serializedImageAssets.add(path);
      return {
        serialized: { ...base, mediaType: "image", mediaFileRef },
        media: { path, type: "blob", blob: asset.blob },
      };
    }

    case "video": {
      const ext = videoExtensionFromMime(entity.mediaSource.blob.type);
      const path = `media/${entity.id}.${ext}`;
      return {
        serialized: {
          ...base,
          mediaType: "video",
          mediaFileRef: internMediaFile(path, tables),
          duration: entity.mediaSource.duration,
          fps: entity.mediaSource.fps,
          hasAudio: entity.mediaSource.hasAudio,
          playback: serializePlayback(entity.playback),
        },
        media: { path, type: "blob", blob: entity.mediaSource.blob },
      };
    }

    case "gif": {
      const path = `media/${entity.id}.gif`;
      return {
        serialized: {
          ...base,
          mediaType: "gif",
          mediaFileRef: internMediaFile(path, tables),
          duration: entity.mediaSource.duration,
          fps: entity.mediaSource.fps,
          playback: serializePlayback(entity.playback),
        },
        media: { path, type: "blob", blob: entity.mediaSource.blob },
      };
    }

    case "svg": {
      const path = `media/${entity.id}.svg`;
      return {
        serialized: {
          ...base,
          mediaType: "svg",
          mediaFileRef: internMediaFile(path, tables),
        },
        media: { path, type: "blob", blob: entity.mediaSource.blob },
      };
    }
  }
}

function internShaderParams(
  params: ShaderParams,
  staticParams: ShaderParams,
  tables: CompactTables,
): number {
  const identity = getStaticShaderParamsIdentity(params);
  const existing = tables.shaderParamRefs.get(identity);
  if (existing !== undefined) return existing;
  const index = tables.shaderParams.length;
  tables.shaderParams.push(structuredClone(staticParams));
  tables.shaderParamRefs.set(identity, index);
  return index;
}

function internMediaFile(path: string, tables: CompactTables): number {
  const existing = tables.mediaFileRefs.get(path);
  if (existing !== undefined) return existing;
  const index = tables.mediaFiles.length;
  tables.mediaFiles.push(path);
  tables.mediaFileRefs.set(path, index);
  return index;
}

function internOriginalPalette(palette: ColorPalette, tables: CompactTables): number {
  const signature = JSON.stringify(palette);
  const existing = tables.originalPaletteRefs.get(signature);
  if (existing !== undefined) return existing;
  const index = tables.originalPalettes.length;
  tables.originalPalettes.push(structuredClone(palette));
  tables.originalPaletteRefs.set(signature, index);
  return index;
}

export function serializePlayback(
  playback: ShaderCanvasEntity["playback"],
): SerializedPlaybackState {
  const safePlayback = createPlaybackState(playback);
  return {
    currentTime: safePlayback.currentTime,
    loop: safePlayback.loop,
    playbackRate: safePlayback.playbackRate,
    muted: safePlayback.muted,
    volume: safePlayback.volume,
    isPlaying: safePlayback.isPlaying,
  };
}

function isUserPaletteId(id: string | undefined): id is string {
  if (!id) return false;
  const { custom, extracted } = config.paletteIdPrefix;
  return id.startsWith(custom) || id.startsWith(extracted);
}

/** Collect custom/extracted palettes referenced by entities from the palette store */
function collectReferencedPalettes(entities: ShaderCanvasEntity[]): ColorPalette[] {
  const referencedIds = new Set<string>();
  for (const entity of entities) {
    const paletteId = entity.shaderParams.palette?.id;
    if (isUserPaletteId(paletteId)) {
      referencedIds.add(paletteId);
    }
  }

  if (referencedIds.size === 0) return [];

  const storePalettes = paletteStore.getPalettes();
  return storePalettes
    .filter((p) => p.id != null && referencedIds.has(p.id))
    .map((p) => structuredClone(p));
}
