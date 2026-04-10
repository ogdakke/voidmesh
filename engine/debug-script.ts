import { palettes } from "#lib/config/palettes.config.ts";
import { mediaAssetRegistry } from "#lib/media-asset-registry.ts";
import { GlassKind, ShaderType } from "#types/canvas.ts";
import type { CanvasStore } from "./canvas-store";

export async function debugCanvas(store: CanvasStore) {
  // add test image
  const imageUrl = "/media/medusas-768w.webp";
  const response = await fetch(imageUrl);
  const blob = await response.blob();
  const imageBitmap = await createImageBitmap(blob);
  const asset = mediaAssetRegistry.createImageAsset(blob, imageBitmap);
  mediaAssetRegistry.retainAsset(asset.assetId);

  const entityId = "debug-entity";

  store.addEntity({
    id: entityId,
    assetId: asset.assetId,
    name: "Debug Image",
    mediaSource: { type: "image", blob, assetId: asset.assetId },
    imageBitmap: asset.imageBitmap,
    originalSize: { width: imageBitmap.width, height: imageBitmap.height },
    position: { x: -400, y: -600 },
    rotation: 0,
    shaderParams: {
      background: [0, 0, 0, 1],
      size: 12,
      color: [1, 1, 1, 1],
      ascii: {
        kind: "standard",
        invert: false,
      },
      preserveColors: true,
      reversePalette: false,
      showOriginal: false,
      shape: "circle",
      scale: 1.0,
      intensity: 1.0,
      blobs: { eagerness: 0 },
      adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
      glass: {
        kind: GlassKind.frostedVoronoi,
        angle: 0,
        caustic: 0,
        frostiness: 0.4,
        highlight: 0.5,
        dispersion: 0.3,
        flow: 0.5,
      },
      postProcess: {
        enabled: true,
        grain: { enabled: false, intensity: 0.1, size: 1 },
      },
      palette: palettes.winter,
    },
    shaderType: ShaderType.ascii,
    size: { width: imageBitmap.width, height: imageBitmap.height },
    zIndex: 0,
    textureDirty: true,
    edited: true,
  });

  // Auto-select the debug entity
  // store.setSelectedEntity(entityId);
}
