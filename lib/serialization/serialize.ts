import { canvasStore } from "#engine";
import { config } from "#config";
import type { ColorPalette, ShaderCanvasEntity } from "#types/canvas.ts";
import { zipSync } from "fflate";
import { paletteStore } from "../palette-store.ts";
import { detectVideoExtension, imageBitmapToBytes, videoElementToBytes } from "./media.ts";
import type { SerializedEntity, SerializedPlaybackState, StudioManifest } from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";

/**
 * Serialize the current canvas state into a .studio zip archive (Blob).
 *
 * The archive contains:
 *   manifest.json  — viewport + entity metadata
 *   media/         — original media files (images, videos, GIF frames)
 */
export async function serialize(): Promise<Blob> {
  const state = canvasStore.getState();
  const entities = Array.from(state.entities.values());

  // Sort by zIndex for deterministic output
  entities.sort((a, b) => a.zIndex - b.zIndex);

  // Build manifest entries and zip file entries in parallel
  const zipEntries: Record<string, Uint8Array> = {};
  const serializedEntities: SerializedEntity[] = [];

  await Promise.all(
    entities.map(async (entity) => {
      const { serialized, mediaEntries } = await serializeEntity(entity);
      serializedEntities.push(serialized);
      Object.assign(zipEntries, mediaEntries);
    }),
  );

  // Re-sort after parallel processing (order may have been scrambled)
  serializedEntities.sort((a, b) => a.zIndex - b.zIndex);

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
    ...(referencedPalettes.length > 0 && { palettes: referencedPalettes }),
  };

  // Add manifest to zip
  const manifestJson = JSON.stringify(manifest, null, 2);
  zipEntries["manifest.json"] = new TextEncoder().encode(manifestJson);

  // Create zip archive
  const zipped = zipSync(zipEntries, { level: 6 });
  return new Blob([zipped.buffer as ArrayBuffer], { type: "application/zip" });
}

interface EntitySerializeResult {
  serialized: SerializedEntity;
  mediaEntries: Record<string, Uint8Array>;
}

async function serializeEntity(entity: ShaderCanvasEntity): Promise<EntitySerializeResult> {
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
    shaderParams: structuredClone(entity.shaderParams),
    ...(entity.originalPalette && {
      originalPalette: structuredClone(entity.originalPalette),
    }),
  };

  const mediaEntries: Record<string, Uint8Array> = {};

  switch (entity.mediaSource.type) {
    case "image": {
      const path = `media/${entity.id}.png`;
      mediaEntries[path] = await imageBitmapToBytes(entity.imageBitmap);
      return {
        serialized: { ...base, mediaType: "image", mediaFile: path },
        mediaEntries,
      };
    }

    case "video": {
      const bytes = await videoElementToBytes(entity.mediaSource.videoElement);
      const ext = detectVideoExtension(bytes);
      const path = `media/${entity.id}.${ext}`;
      mediaEntries[path] = bytes;
      return {
        serialized: {
          ...base,
          mediaType: "video",
          mediaFile: path,
          duration: entity.mediaSource.duration,
          fps: entity.mediaSource.fps,
          hasAudio: entity.mediaSource.hasAudio,
          playback: serializePlayback(entity.playback),
        },
        mediaEntries,
      };
    }

    case "gif": {
      const bytes = new Uint8Array(await entity.mediaSource.blob.arrayBuffer());
      const path = `media/${entity.id}.gif`;
      mediaEntries[path] = bytes;
      return {
        serialized: {
          ...base,
          mediaType: "gif",
          mediaFile: path,
          duration: entity.mediaSource.duration,
          fps: entity.mediaSource.fps,
          playback: serializePlayback(entity.playback),
        },
        mediaEntries,
      };
    }

    case "svg": {
      const bytes = new Uint8Array(await entity.mediaSource.blob.arrayBuffer());
      const path = `media/${entity.id}.svg`;
      mediaEntries[path] = bytes;
      return {
        serialized: { ...base, mediaType: "svg", mediaFile: path },
        mediaEntries,
      };
    }
  }
}

function serializePlayback(playback: ShaderCanvasEntity["playback"]): SerializedPlaybackState {
  return {
    currentTime: playback?.currentTime ?? 0,
    loop: playback?.loop ?? true,
    playbackRate: playback?.playbackRate ?? 1,
    isPlaying: playback?.isPlaying ?? false,
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
