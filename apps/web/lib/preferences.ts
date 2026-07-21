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
  async getFancyDelete(): Promise<boolean | null> {
    return (await storage.getItem<boolean>("fancyDelete")) ?? null;
  },
  async setFancyDelete(enabled: boolean): Promise<void> {
    await storage.setItem("fancyDelete", enabled);
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
