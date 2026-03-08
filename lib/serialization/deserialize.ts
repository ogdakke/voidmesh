import { ShaderType, type ShaderCanvasEntity, type ShaderParams } from "#types/canvas.ts";
import { unzipSync } from "fflate";
import { canvasStore } from "#engine";
import { config } from "#config";
import { deepMerge } from "../deep-merge.ts";
import { decodeGif } from "../gif-decoder.ts";
import { rasterizeSvg } from "../media-loader.ts";
import { bytesToImageBitmap, bytesToVideoElement } from "./media.ts";
import { runMigrations } from "./migrations.ts";
import type { DeserializeResult, SerializedEntity, StudioManifest } from "./types.ts";
import { isStudioManifest, toPlaybackState } from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

/**
 * Deserialize a .vdmsh archive (Blob or ArrayBuffer) and restore the canvas.
 *
 * Clears the existing canvas state, restores viewport, and adds all entities.
 * Returns a result object with success status, warnings, and per-entity errors.
 */
export async function deserialize(source: Blob | ArrayBuffer): Promise<DeserializeResult> {
  const warnings: string[] = [];
  const errors: { entityId: string; entityName: string; error: string }[] = [];

  // 0. Validate input type
  if (!(source instanceof Blob) && !(source instanceof ArrayBuffer)) {
    throw new Error(
      "deserialize() expects a Blob or ArrayBuffer. Did you forget to await serialize()?",
    );
  }

  // 1. Unzip the archive
  const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
  const zipEntries = unzipSync(new Uint8Array(buffer));

  // 2. Read and parse manifest
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
    throw new Error(
      "Invalid .vdmsh file: manifest missing 'type: \"studio-canvas\"' or 'version' field",
    );
  }

  // 3. Run migrations if needed
  let doc = manifest as StudioManifest;
  if (doc.version < CURRENT_VERSION) {
    doc = runMigrations(doc);
    warnings.push(`Migrated from v${manifest.version} to v${CURRENT_VERSION}`);
  }
  if (doc.version > CURRENT_VERSION) {
    warnings.push(
      `Document is from a newer version (v${doc.version}). Some features may not restore correctly.`,
    );
  }

  // 4. Decode all entities BEFORE clearing canvas (so we don't destroy existing
  //    state if decoding fails entirely)
  const entityPromises = doc.entities.map(async (serialized) => {
    try {
      return await deserializeEntity(serialized, zipEntries, warnings);
    } catch (err) {
      errors.push({
        entityId: serialized.id,
        entityName: serialized.name,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  });

  const decodedEntities = await Promise.all(entityPromises);
  const validEntities = decodedEntities.filter((e): e is ShaderCanvasEntity => e !== null);

  // If nothing decoded at all, bail without touching the canvas
  if (validEntities.length === 0 && doc.entities.length > 0) {
    return {
      success: false,
      entityCount: 0,
      warnings,
      errors,
    };
  }

  // 5. Pause all existing animated entities before clearing
  for (const entity of canvasStore.getState().entities.values()) {
    if (entity.mediaSource.type === "video") {
      entity.mediaSource.videoElement.pause();
    }
  }

  // 6. Clear canvas and restore viewport
  canvasStore.reset();
  canvasStore.setViewport({
    offset: { x: doc.viewport.offset.x, y: doc.viewport.offset.y },
    zoom: doc.viewport.zoom,
  });

  // 7. Add decoded entities sequentially (maintains zIndex ordering from manifest)
  for (const entity of validEntities) {
    canvasStore.addEntity(entity);
  }

  // 8. Resume playback for entities that were playing when saved
  for (const entity of validEntities) {
    if (!entity.playback?.isPlaying) continue;
    if (entity.mediaSource.type === "video") {
      canvasStore.playVideo(entity.id);
    } else if (entity.mediaSource.type === "gif") {
      canvasStore.playGif(entity.id);
    }
  }

  return {
    success: errors.length === 0,
    entityCount: validEntities.length,
    warnings,
    errors,
  };
}

/**
 * Returns the maximum entity ID number and zIndex from the restored entities.
 * Used by canvas-context to update its counters after deserialization.
 */
export function getMaxCounters(_result: DeserializeResult): {
  maxId: number;
  maxZIndex: number;
} {
  const state = canvasStore.getState();
  let maxId = 0;
  let maxZIndex = 0;

  for (const entity of state.entities.values()) {
    // Extract numeric part from "entity-N" IDs
    const match = entity.id.match(/^entity-(\d+)$/);
    if (match) {
      maxId = Math.max(maxId, Number(match[1]));
    }
    maxZIndex = Math.max(maxZIndex, entity.zIndex);
  }

  return { maxId, maxZIndex };
}

// ============================================================================
// Per-entity deserialization
// ============================================================================

/** Validate shaderType against known values, falling back to the default */
function validateShaderType(raw: string): ShaderType {
  const valid = Object.values(ShaderType) as string[];
  return valid.includes(raw) ? (raw as ShaderType) : config.defaults.shader;
}

async function deserializeEntity(
  serialized: SerializedEntity,
  zipEntries: Record<string, Uint8Array>,
  warnings: string[],
): Promise<ShaderCanvasEntity> {
  // Validate shaderType (1b) and merge shaderParams with defaults (1c/3d)
  const shaderType = validateShaderType(serialized.shaderType);
  if (shaderType !== serialized.shaderType) {
    warnings.push(
      `Entity "${serialized.name}": unknown shader "${serialized.shaderType}", using "${shaderType}"`,
    );
  }

  const shaderParams = deepMerge(
    structuredClone(config.defaults.shaderParams) as ShaderParams,
    serialized.shaderParams,
  );

  const base = {
    id: serialized.id,
    name: serialized.name,
    position: { ...serialized.position },
    size: { ...serialized.size },
    originalSize: { ...serialized.originalSize },
    zIndex: serialized.zIndex,
    rotation: serialized.rotation,
    locked: serialized.locked,
    edited: serialized.edited,
    shaderType,
    shaderParams,
    textureDirty: true as const,
    selected: false as const,
  };

  switch (serialized.mediaType) {
    case "image": {
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);
      const imageBlob = new Blob([bytes.slice()]);
      const bitmap = await bytesToImageBitmap(bytes);
      return {
        ...base,
        imageBitmap: bitmap,
        mediaSource: { type: "image" as const, imageBitmap: bitmap, blob: imageBlob },
      };
    }

    case "video": {
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);

      const ext = serialized.mediaFile.split(".").pop() ?? "mp4";
      const mimeType = MIME_BY_EXT[ext] ?? "video/mp4";

      const videoBlob = new Blob([bytes.slice()], { type: mimeType });
      const savedTime = serialized.playback?.currentTime ?? 0;
      const { videoElement, initialFrame, duration } = await bytesToVideoElement(
        bytes,
        mimeType,
        savedTime,
      );

      // v3+ files have hasAudio in the manifest; legacy files need a probe
      const hasAudio =
        serialized.hasAudio ??
        (await import("#lib/audio-demux.ts").then(({ hasAudioTrack }) => hasAudioTrack(videoBlob)));

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
        },
        playback: toPlaybackState(serialized.playback),
      };
    }

    case "gif": {
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);

      const blob = new Blob([bytes.slice()], { type: "image/gif" });
      const { frames, duration, fps } = await decodeGif(blob);

      if (frames.length === 0) throw new Error("GIF has no frames");

      return {
        ...base,
        imageBitmap: frames[0]!.bitmap,
        mediaSource: {
          type: "gif" as const,
          frames,
          duration,
          fps,
          blob,
        },
        playback: toPlaybackState(serialized.playback),
      };
    }

    case "svg": {
      const bytes = zipEntries[serialized.mediaFile];
      if (!bytes) throw new Error(`Missing media file: ${serialized.mediaFile}`);

      const text = new TextDecoder().decode(bytes);
      const blob = new Blob([bytes.slice()], { type: "image/svg+xml" });
      const { bitmap } = await rasterizeSvg(text);

      return {
        ...base,
        imageBitmap: bitmap,
        mediaSource: { type: "svg" as const, blob },
      };
    }

    default:
      throw new Error(`Unknown media type: ${(serialized as Record<string, unknown>).mediaType}`);
  }
}
