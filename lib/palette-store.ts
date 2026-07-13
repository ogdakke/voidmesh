import { useSyncExternalStore } from "react";
import type { ColorPalette } from "#types/canvas.ts";
import { Store } from "./store.ts";
import { preferences } from "./preferences.ts";

interface PaletteStoreState {
  customPalettes: ColorPalette[];
  transientPalettes: ColorPalette[];
  version: number;
}

class PaletteStore extends Store<PaletteStoreState> {
  readonly getSnapshot: () => PaletteStoreState;

  constructor() {
    super({ customPalettes: [], transientPalettes: [], version: 0 });
    this.getSnapshot = this.createSnapshot("version", (s) => ({
      customPalettes: combinePalettes(s.transientPalettes, s.customPalettes),
      transientPalettes: s.transientPalettes,
      version: s.version,
    }));
  }

  /** Get personal and transient workspace palettes, with room values winning ID conflicts. */
  getPalettes(): ColorPalette[] {
    return combinePalettes(this.state.transientPalettes, this.state.customPalettes);
  }

  getPersonalPalettes(): ColorPalette[] {
    return this.state.customPalettes;
  }

  isPersonalPalette(id: string): boolean {
    return this.state.customPalettes.some((palette) => palette.id === id);
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

  /** Replace non-persistent palettes discovered from the active workspace or room. */
  setTransientPalettes(palettes: readonly ColorPalette[]): void {
    const unique = new Map<string, ColorPalette>();
    for (const palette of palettes) {
      if (palette.id) unique.set(palette.id, palette);
    }
    const next = [...unique.values()];
    if (samePaletteList(this.state.transientPalettes, next)) return;
    this.state.transientPalettes = next;
    this.state.version++;
    this.notify();
  }

  /** Update an existing palette by ID */
  updatePalette(id: string, palette: ColorPalette): void {
    const isPersonal = this.isPersonalPalette(id);
    if (isPersonal) {
      this.state.customPalettes = this.state.customPalettes.map((p) => (p.id === id ? palette : p));
    } else {
      this.state.transientPalettes = this.state.transientPalettes.map((p) =>
        p.id === id ? palette : p,
      );
    }
    this.state.version++;
    this.notify();
    if (isPersonal) this.#persist();
  }

  /** Remove a palette by ID */
  removePalette(id: string): void {
    this.state.customPalettes = this.state.customPalettes.filter((p) => p.id !== id);
    this.state.transientPalettes = this.state.transientPalettes.filter((p) => p.id !== id);
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

function combinePalettes(
  transientPalettes: readonly ColorPalette[],
  personalPalettes: readonly ColorPalette[],
): ColorPalette[] {
  const transientIds = new Set(transientPalettes.map(({ id }) => id).filter(Boolean));
  return [
    ...transientPalettes,
    ...personalPalettes.filter((palette) => !palette.id || !transientIds.has(palette.id)),
  ];
}

function samePaletteList(left: readonly ColorPalette[], right: readonly ColorPalette[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((palette, index) => {
    const candidate = right[index];
    return candidate?.id === palette.id && JSON.stringify(candidate) === JSON.stringify(palette);
  });
}
