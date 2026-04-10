import {
  MediaType,
  ShaderType,
  type MediaAsset,
  type ShaderCanvasEntity,
  type ShaderParams,
} from "#types/canvas.ts";
import { unzipSync } from "fflate";
import { canvasStore } from "#engine";
import { config } from "#config";
import { deepMerge } from "../deep-merge.ts";
import { decodeGif } from "../gif-decoder.ts";
import { mediaAssetRegistry } from "../media-asset-registry.ts";
import { loadVideo, rasterizeSvg } from "../media-loader.ts";
import { paletteStore } from "../palette-store.ts";
import { bytesToImageBitmap } from "./media.ts";
import { runMigrations } from "./migrations.ts";
import type {
  DeserializeResult,
  SerializedAsset,
  SerializedEntity,
  StudioManifest,
} from "./types.ts";
import { isStudioManifest, toPlaybackState } from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  gif: "image/gif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

interface DecodedAsset {
  serialized: SerializedAsset;
  asset: MediaAsset;
}

export async function deserialize(source: Blob | ArrayBuffer): Promise<DeserializeResult> {
  const warnings: string[] = [];
  const errors: { entityId: string; entityName: string; error: string }[] = [];

  if (!(source instanceof Blob) && !(source instanceof ArrayBuffer)) {
    throw new Error(
      "deserialize() expects a Blob or ArrayBuffer. Did you forget to await serialize()?",
    );
  }

  const buffer = source instanceof Blob ? await source.arrayBuffer() : source;
  const zipEntries = unzipSync(new Uint8Array(buffer));
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

  let doc = manifest as StudioManifest;
  if (doc.version < CURRENT_VERSION) {
    doc = runMigrations(doc);
    warnings.push(
      `Migrated from v${(manifest as { version: number }).version} to v${CURRENT_VERSION}`,
    );
  }
  if (doc.version > CURRENT_VERSION) {
    warnings.push(
      `Document is from a newer version (v${doc.version}). Some features may not restore correctly.`,
    );
  }

  if (doc.palettes?.length) {
    const existingIds = new Set(paletteStore.getPalettes().map((palette) => palette.id));
    for (const palette of doc.palettes) {
      if (palette.id && !existingIds.has(palette.id)) {
        paletteStore.addPalette(palette);
      }
    }
  }

  canvasStore.reset();
  canvasStore.setViewport({
    offset: { x: doc.viewport.offset.x, y: doc.viewport.offset.y },
    zoom: doc.viewport.zoom,
  });

  const decodedAssets = await Promise.all(
    doc.assets.map(async (serialized) => {
      try {
        return await decodeAsset(serialized, zipEntries);
      } catch (error) {
        warnings.push(
          `Asset ${serialized.assetId} failed to restore: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      }
    }),
  );

  const assetMap = new Map<string, MediaAsset>();
  for (const decoded of decodedAssets) {
    if (!decoded) continue;
    assetMap.set(decoded.serialized.assetId, decoded.asset);
  }

  const validEntities: ShaderCanvasEntity[] = [];
  for (const serialized of doc.entities) {
    try {
      const entity = deserializeEntity(serialized, assetMap, warnings);
      validEntities.push(entity);
    } catch (error) {
      errors.push({
        entityId: serialized.id,
        entityName: serialized.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (validEntities.length === 0 && doc.entities.length > 0) {
    for (const asset of assetMap.values()) {
      mediaAssetRegistry.destroyAssetResources(asset.assetId);
    }
    return {
      success: false,
      entityCount: 0,
      warnings,
      errors,
    };
  }

  for (const entity of validEntities) {
    mediaAssetRegistry.retainAsset(entity.assetId);
    canvasStore.addEntity(entity);
  }

  for (const entity of validEntities) {
    if (!entity.playback?.isPlaying) continue;
    if (entity.mediaSource.type === MediaType.video) {
      void canvasStore.playVideo(entity.id);
    } else if (entity.mediaSource.type === MediaType.gif) {
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

export function getMaxCounters(_result: DeserializeResult): {
  maxId: number;
  maxZIndex: number;
} {
  const state = canvasStore.getState();
  let maxId = 0;
  let maxZIndex = 0;

  for (const entity of state.entities.values()) {
    const match = entity.id.match(/^entity-(\d+)$/);
    if (match) {
      maxId = Math.max(maxId, Number(match[1]));
    }
    maxZIndex = Math.max(maxZIndex, entity.zIndex);
  }

  return { maxId, maxZIndex };
}

function validateShaderType(raw: string): ShaderType {
  const valid = Object.values(ShaderType) as string[];
  return valid.includes(raw) ? (raw as ShaderType) : config.defaults.shader;
}

async function decodeAsset(
  serialized: SerializedAsset,
  zipEntries: Record<string, Uint8Array>,
): Promise<DecodedAsset> {
  const bytes = zipEntries[serialized.mediaFile];
  if (!bytes) {
    throw new Error(`Missing media file: ${serialized.mediaFile}`);
  }

  const ext = serialized.mediaFile.split(".").pop()?.toLowerCase() ?? "";
  const mimeType = MIME_BY_EXT[ext] ?? "application/octet-stream";

  switch (serialized.mediaType) {
    case MediaType.image: {
      const blob = new Blob([bytes.slice()], { type: mimeType });
      const bitmap = await bytesToImageBitmap(bytes, mimeType);
      return {
        serialized,
        asset: mediaAssetRegistry.createImageAsset(blob, bitmap, serialized.assetId),
      };
    }
    case MediaType.svg: {
      const text = new TextDecoder().decode(bytes);
      const blob = new Blob([bytes.slice()], { type: "image/svg+xml" });
      const { bitmap } = await rasterizeSvg(text);
      return {
        serialized,
        asset: mediaAssetRegistry.createSvgAsset(
          blob,
          bitmap,
          serialized.width,
          serialized.height,
          serialized.assetId,
        ),
      };
    }
    case MediaType.gif: {
      const blob = new Blob([bytes.slice()], { type: "image/gif" });
      const { frames, duration, fps, width, height } = await decodeGif(blob);
      return {
        serialized,
        asset: mediaAssetRegistry.createGifAsset(
          blob,
          frames,
          width,
          height,
          duration,
          fps,
          serialized.assetId,
        ),
      };
    }
    case MediaType.video: {
      const blob = new Blob([bytes.slice()], { type: mimeType });
      const loaded = await loadVideo(blob);
      loaded.videoElement.pause();
      loaded.videoElement.src = "";
      loaded.videoElement.load();
      return {
        serialized,
        asset: mediaAssetRegistry.createVideoAsset(
          blob,
          loaded.initialFrame,
          loaded.width,
          loaded.height,
          serialized.duration,
          serialized.fps,
          serialized.hasAudio,
          serialized.assetId,
        ),
      };
    }
  }
}

function deserializeEntity(
  serialized: SerializedEntity,
  assetMap: Map<string, MediaAsset>,
  warnings: string[],
): ShaderCanvasEntity {
  const shaderType = validateShaderType(serialized.shaderType);
  if (shaderType !== serialized.shaderType) {
    warnings.push(
      `Entity "${serialized.name}": unknown shader "${serialized.shaderType}", using "${shaderType}"`,
    );
  }

  const asset = assetMap.get(serialized.assetId);
  if (!asset) {
    throw new Error(`Missing asset: ${serialized.assetId}`);
  }

  const shaderParams = deepMerge(
    structuredClone(config.defaults.shaderParams) as ShaderParams,
    serialized.shaderParams,
  );

  const base = {
    id: serialized.id,
    assetId: serialized.assetId,
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
    ...(serialized.originalPalette && {
      originalPalette: serialized.originalPalette,
    }),
  };

  switch (asset.type) {
    case MediaType.image:
      return {
        ...base,
        imageBitmap: asset.imageBitmap,
        mediaSource: { type: MediaType.image, blob: asset.blob, assetId: asset.assetId },
      };
    case MediaType.svg:
      return {
        ...base,
        imageBitmap: asset.imageBitmap,
        mediaSource: { type: MediaType.svg, blob: asset.blob, assetId: asset.assetId },
      };
    case MediaType.gif:
      return {
        ...base,
        imageBitmap: asset.frames[0]!.bitmap,
        mediaSource: {
          type: MediaType.gif,
          assetId: asset.assetId,
          duration: asset.duration,
          fps: asset.fps,
          blob: asset.blob,
        },
        playback: toPlaybackState(serialized.playback),
      };
    case MediaType.video:
      return {
        ...base,
        imageBitmap: asset.posterFrame,
        mediaSource: {
          type: MediaType.video,
          assetId: asset.assetId,
          blob: asset.blob,
          duration: asset.duration,
          fps: asset.fps,
          hasAudio: asset.hasAudio,
        },
        playback: toPlaybackState(serialized.playback),
      };
  }
}
