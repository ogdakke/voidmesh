import { canvasStore } from "#engine";
import { config } from "#config";
import type { ColorPalette, ShaderCanvasEntity } from "#types/canvas.ts";
import { paletteStore } from "../palette-store.ts";
import { detectVideoExtension, videoElementToBytes } from "./media.ts";
import type {
  SerializeMediaEntry,
  SerializedEntity,
  SerializedPlaybackState,
  StudioManifest,
} from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";

/** Synchronous flag — prevents overlapping saves even when React state hasn't flushed yet. */
let isSaving = false;

export function getIsSaving(): boolean {
  return isSaving;
}

/**
 * Serialize the current canvas state into a .vdmsh zip archive (Blob).
 *
 * Heavy work (PNG encoding + zip compression) runs in a Web Worker.
 * The main thread only prepares entity metadata and collects transferable media data.
 * Concurrent calls are rejected (returns null) to prevent queuing redundant saves.
 */
export async function serialize(): Promise<Blob | null> {
  if (isSaving) return null;
  isSaving = true;

  try {
    const state = canvasStore.getState();
    const entities = Array.from(state.entities.values());

    // Sort by zIndex for deterministic output
    entities.sort((a, b) => a.zIndex - b.zIndex);

    // Prepare entity metadata and media data in parallel (main thread)
    const serializedEntities: SerializedEntity[] = [];
    const mediaEntries: SerializeMediaEntry[] = [];

    await Promise.all(
      entities.map(async (entity) => {
        const { serialized, media } = await prepareEntity(entity);
        serializedEntities.push(serialized);
        mediaEntries.push(media);
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

    const manifestJson = JSON.stringify(manifest, null, 2);

    // Delegate PNG encoding + zip compression to worker
    return await compressInWorker(manifestJson, mediaEntries);
  } finally {
    isSaving = false;
  }
}

let serializeWorker: Worker | null = null;

function getSerializeWorker(): Worker {
  if (!serializeWorker) {
    serializeWorker = new Worker(new URL("./serialize-worker.ts", import.meta.url), {
      type: "module",
    });
  }
  return serializeWorker;
}

function compressInWorker(manifest: string, mediaEntries: SerializeMediaEntry[]): Promise<Blob> {
  const worker = getSerializeWorker();

  return new Promise<Blob>((resolve, reject) => {
    worker.onmessage = (e: MessageEvent) => {
      if (e.data.type === "done") {
        resolve(new Blob([e.data.zip.buffer as ArrayBuffer], { type: "application/zip" }));
      } else if (e.data.type === "error") {
        reject(new Error(e.data.message));
      }
    };

    worker.onerror = (err) => {
      reject(new Error(`Serialization worker failed: ${err.message}`));
      // Worker is broken — discard so next save creates a fresh one
      serializeWorker?.terminate();
      serializeWorker = null;
    };

    // Build transfer list for zero-copy posting
    const transferList: Transferable[] = [];
    for (const entry of mediaEntries) {
      if (entry.type === "imageBitmap") {
        transferList.push(entry.bitmap!);
      } else {
        transferList.push(entry.bytes!.buffer);
      }
    }

    worker.postMessage({ manifest, mediaEntries }, transferList);
  });
}

interface PreparedEntity {
  serialized: SerializedEntity;
  media: SerializeMediaEntry;
}

async function prepareEntity(entity: ShaderCanvasEntity): Promise<PreparedEntity> {
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

  switch (entity.mediaSource.type) {
    case "image": {
      const path = `media/${entity.id}.png`;
      // Clone bitmap — transfer destroys the source, entity still needs it for rendering
      const cloned = await createImageBitmap(entity.imageBitmap);
      return {
        serialized: { ...base, mediaType: "image", mediaFile: path },
        media: { path, type: "imageBitmap", bitmap: cloned },
      };
    }

    case "video": {
      // Fetch blob URL bytes on main thread (blob URLs don't work in workers)
      const bytes = await videoElementToBytes(entity.mediaSource.videoElement);
      const ext = detectVideoExtension(bytes);
      const path = `media/${entity.id}.${ext}`;
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
        media: { path, type: "bytes", bytes },
      };
    }

    case "gif": {
      const bytes = new Uint8Array(await entity.mediaSource.blob.arrayBuffer());
      const path = `media/${entity.id}.gif`;
      return {
        serialized: {
          ...base,
          mediaType: "gif",
          mediaFile: path,
          duration: entity.mediaSource.duration,
          fps: entity.mediaSource.fps,
          playback: serializePlayback(entity.playback),
        },
        media: { path, type: "bytes", bytes },
      };
    }

    case "svg": {
      const bytes = new Uint8Array(await entity.mediaSource.blob.arrayBuffer());
      const path = `media/${entity.id}.svg`;
      return {
        serialized: { ...base, mediaType: "svg", mediaFile: path },
        media: { path, type: "bytes", bytes },
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
