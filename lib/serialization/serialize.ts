import { canvasStore } from "#engine";
import { config } from "#config";
import {
  MediaType,
  type ColorPalette,
  type MediaAsset,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";
import { mediaAssetRegistry } from "../media-asset-registry.ts";
import { paletteStore } from "../palette-store.ts";
import { detectVideoExtension } from "./media.ts";
import type {
  SerializeMediaEntry,
  SerializedAsset,
  SerializedEntity,
  SerializedPlaybackState,
  StudioManifest,
} from "./types.ts";
import { CURRENT_VERSION } from "./version.ts";

let isSaving = false;

export function getIsSaving(): boolean {
  return isSaving;
}

export async function serialize(): Promise<Blob | null> {
  if (isSaving) return null;
  isSaving = true;

  try {
    const state = canvasStore.getState();
    const entities = Array.from(state.entities.values());
    entities.sort((a, b) => a.zIndex - b.zIndex);

    const referencedAssetIds = new Set(entities.map((entity) => entity.assetId));
    const assets = mediaAssetRegistry
      .getAllAssets()
      .filter((asset) => referencedAssetIds.has(asset.assetId))
      .sort((a, b) => a.assetId.localeCompare(b.assetId));

    const serializedEntities = entities.map(prepareEntity);
    const assetResults = await Promise.all(assets.map((asset) => prepareAsset(asset)));
    const serializedAssets = assetResults.map((result) => result.serialized);
    const mediaEntries = assetResults.map((result) => result.media);
    const referencedPalettes = collectReferencedPalettes(entities);

    const manifest: StudioManifest = {
      type: "studio-canvas",
      version: CURRENT_VERSION,
      createdAt: new Date().toISOString(),
      viewport: {
        offset: { x: state.viewport.offset.x, y: state.viewport.offset.y },
        zoom: state.viewport.zoom,
      },
      assets: serializedAssets,
      entities: serializedEntities,
      ...(referencedPalettes.length > 0 && { palettes: referencedPalettes }),
    };

    return await compressInWorker(JSON.stringify(manifest, null, 2), mediaEntries);
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
        resolve(new Blob([e.data.zip.buffer as ArrayBuffer], { type: "application/vdmsh" }));
      } else if (e.data.type === "error") {
        reject(new Error(e.data.message));
      }
    };

    worker.onerror = (err) => {
      reject(new Error(`Serialization worker failed: ${err.message}`));
      serializeWorker?.terminate();
      serializeWorker = null;
    };

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

interface PreparedAsset {
  serialized: SerializedAsset;
  media: SerializeMediaEntry;
}

function prepareEntity(entity: ShaderCanvasEntity): SerializedEntity {
  return {
    id: entity.id,
    assetId: entity.assetId,
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
    ...(entity.playback && { playback: serializePlayback(entity.playback) }),
  };
}

async function prepareAsset(asset: MediaAsset): Promise<PreparedAsset> {
  const bytes = new Uint8Array(await asset.blob.arrayBuffer());

  switch (asset.type) {
    case MediaType.image: {
      const extension = getImageExtension(asset.blob.type);
      const path = `assets/${asset.assetId}.${extension}`;
      return {
        serialized: {
          assetId: asset.assetId,
          mediaType: MediaType.image,
          mediaFile: path,
          width: asset.width,
          height: asset.height,
        },
        media: { path, type: "bytes", bytes },
      };
    }
    case MediaType.svg: {
      const path = `assets/${asset.assetId}.svg`;
      return {
        serialized: {
          assetId: asset.assetId,
          mediaType: MediaType.svg,
          mediaFile: path,
          width: asset.width,
          height: asset.height,
        },
        media: { path, type: "bytes", bytes },
      };
    }
    case MediaType.gif: {
      const path = `assets/${asset.assetId}.gif`;
      return {
        serialized: {
          assetId: asset.assetId,
          mediaType: MediaType.gif,
          mediaFile: path,
          width: asset.width,
          height: asset.height,
          duration: asset.duration,
          fps: asset.fps,
        },
        media: { path, type: "bytes", bytes },
      };
    }
    case MediaType.video: {
      const ext = detectVideoExtension(bytes);
      const path = `assets/${asset.assetId}.${ext}`;
      return {
        serialized: {
          assetId: asset.assetId,
          mediaType: MediaType.video,
          mediaFile: path,
          width: asset.width,
          height: asset.height,
          duration: asset.duration,
          fps: asset.fps,
          hasAudio: asset.hasAudio,
        },
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

function getImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/png":
    default:
      return "png";
  }
}

function isUserPaletteId(id: string | undefined): id is string {
  if (!id) return false;
  const { custom, extracted } = config.paletteIdPrefix;
  return id.startsWith(custom) || id.startsWith(extracted);
}

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
    .filter((palette) => palette.id != null && referencedIds.has(palette.id))
    .map((palette) => structuredClone(palette));
}
