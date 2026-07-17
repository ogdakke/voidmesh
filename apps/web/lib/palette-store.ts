import { useSyncExternalStore } from "react";
import type { ColorPalette } from "#types/canvas.ts";
import { Store } from "./store.ts";
import { preferences } from "./preferences.ts";

interface PaletteStoreState {
  customPalettes: ColorPalette[];
  version: number;
}

class PaletteStore extends Store<PaletteStoreState> {
  readonly getSnapshot: () => PaletteStoreState;

  constructor() {
    super({ customPalettes: [], version: 0 });
    this.getSnapshot = this.createSnapshot("version", (s) => ({
      customPalettes: s.customPalettes,
      version: s.version,
    }));
  }

  /** Get current custom palettes (synchronous) */
  getPalettes(): ColorPalette[] {
    return this.state.customPalettes;
  }

  /** Bulk set palettes (for hydration from localStorage) */
  setPalettes(palettes: ColorPalette[]): void {
    this.state.customPalettes = palettes;
    this.state.version++;
    this.notify();
    // No persist on hydration — data already came from storage
  }

  /** Add a new custom palette */
  addPalette(palette: ColorPalette): void {
    this.state.customPalettes = [...this.state.customPalettes, palette];
    this.state.version++;
    this.notify();
    this.#persist();
  }

  /** Add palettes whose IDs are not already present, in one mutation. */
  mergePalettes(palettes: readonly ColorPalette[]): void {
    if (palettes.length === 0) return;

    const knownIds = new Set<string>();
    for (const palette of this.state.customPalettes) {
      if (palette.id) knownIds.add(palette.id);
    }
    const additions: ColorPalette[] = [];
    for (const palette of palettes) {
      if (!palette.id || knownIds.has(palette.id)) continue;
      knownIds.add(palette.id);
      additions.push(palette);
    }
    if (additions.length === 0) return;

    this.state.customPalettes = [...this.state.customPalettes, ...additions];
    this.state.version++;
    this.notify();
    this.#persist();
  }

  /** Update an existing palette by ID */
  updatePalette(id: string, palette: ColorPalette): void {
    this.state.customPalettes = this.state.customPalettes.map((p) => (p.id === id ? palette : p));
    this.state.version++;
    this.notify();
    this.#persist();
  }

  /** Remove a palette by ID */
  removePalette(id: string): void {
    this.state.customPalettes = this.state.customPalettes.filter((p) => p.id !== id);
    this.state.version++;
    this.notify();
    this.#persist();
  }

  /** Fire-and-forget persist to localStorage */
  #persist(): void {
    preferences.setCustomPalettes(this.state.customPalettes);
  }
}

export const paletteStore = new PaletteStore();

/** React hook to subscribe to the shared custom palette list */
export function usePaletteStore(): ColorPalette[] {
  const snapshot = useSyncExternalStore(paletteStore.subscribe, paletteStore.getSnapshot);
  return snapshot.customPalettes;
}
