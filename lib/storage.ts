import { createStorage } from "unstorage";
import localStorageDriver from "unstorage/drivers/localstorage";
import type { ColorPalette } from "#types/canvas.ts";

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
};
