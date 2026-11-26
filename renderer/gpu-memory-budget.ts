import { config } from "#config";
import { isMobileWebKit } from "#lib/util.ts";

export interface GpuMemoryBudget {
  entityTextureBytes: number;
  texturePoolBytes: number;
  /** Longest side of a preview texture; `Infinity` leaves media at its own size. */
  previewMaxSide: number;
}

/**
 * Phones and tablets end the GPU process, and with it the device, far below what a desktop
 * tolerates, and their pixel ratio makes every cached LOD tier several times larger. WebKit
 * on iOS reports no memory size, so it is recognised by its gesture events; elsewhere the
 * browser's own `deviceMemory` (GiB, absent in Safari and Firefox) decides.
 */
export function isMemoryConstrainedDevice(): boolean {
  if (typeof window === "undefined") return false;
  if (isMobileWebKit()) return true;
  const { deviceMemory } = navigator as Navigator & { deviceMemory?: number };
  return deviceMemory !== undefined && deviceMemory <= config.rendering.constrainedDeviceMemoryGiB;
}

/** Cache budgets for this device. Textures in use by the current frame are never evicted. */
export function getGpuMemoryBudget(constrained = isMemoryConstrainedDevice()): GpuMemoryBudget {
  const { rendering } = config;
  return constrained
    ? {
        entityTextureBytes: rendering.constrainedEntityTextureBudgetBytes,
        texturePoolBytes: rendering.constrainedTexturePoolBudgetBytes,
        previewMaxSide: rendering.constrainedPreviewMaxSide,
      }
    : {
        entityTextureBytes: rendering.entityTextureBudgetBytes,
        texturePoolBytes: rendering.texturePoolBudgetBytes,
        previewMaxSide: Infinity,
      };
}
