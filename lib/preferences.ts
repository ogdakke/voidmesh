import { FancyEffects, isFancyEffects } from "#types/fancy-effects.ts";
import { createStorage } from "unstorage";
import localStorageDriver from "unstorage/drivers/localstorage";
import type { ColorPalette } from "#types/canvas.ts";
import { CanvasLensing } from "#types/enums.ts";

export const storage = createStorage({
  driver: localStorageDriver({ base: "studio:" }),
});

export const preferences = {
  async getSnapToGrid(): Promise<boolean> {
    return (await storage.getItem<boolean>("snapToGrid")) ?? false;
  },
  async setSnapToGrid(enabled: boolean): Promise<void> {
    await storage.setItem("snapToGrid", enabled);
  },
  async getFancyEffects(): Promise<FancyEffects | null> {
    const saved = await storage.getItem<unknown>("fancyEffects");
    if (isFancyEffects(saved)) return saved;
    const legacy = await storage.getItem<unknown>("fancyDelete");
    if (typeof legacy !== "boolean") return null;
    // Write the replacement before removing the old key. Migration is silent
    // and repeated reads preserve any explicit choice in the new preference.
    const migrated = legacy ? FancyEffects.all : FancyEffects.none;
    await storage.setItem("fancyEffects", migrated);
    await storage.removeItem("fancyDelete");
    return migrated;
  },
  async setFancyEffects(value: FancyEffects): Promise<void> {
    await storage.setItem("fancyEffects", value);
  },
  async getCustomPalettes(): Promise<ColorPalette[]> {
    return (await storage.getItem<ColorPalette[]>("customPalettes")) ?? [];
  },
  async setCustomPalettes(palettes: ColorPalette[]): Promise<void> {
    await storage.setItem("customPalettes", palettes);
  },
  async getHaptics(): Promise<boolean> {
    return (await storage.getItem<boolean>("haptics")) ?? true;
  },
  async setHaptics(enabled: boolean): Promise<void> {
    await storage.setItem("haptics", enabled);
  },
  async getCanvasLensing(): Promise<CanvasLensing> {
    return (await storage.getItem<CanvasLensing>("canvasLensing")) ?? CanvasLensing.off;
  },
  async setCanvasLensing(value: CanvasLensing): Promise<void> {
    await storage.setItem("canvasLensing", value);
  },
};
