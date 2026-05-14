import { createContext, use, useSyncExternalStore } from "react";
import { config } from "#config";
import { canvasStore, type PreferencesSnapshot } from "#engine";
import type {
  ColorPalette,
  Point,
  ShaderCanvasEntity,
  ShaderParams,
  ShaderType,
  Viewport,
} from "#types/canvas.ts";
import { createEnum } from "#types/index.ts";
import type { ColorSpace } from "#types/enums.ts";
import type { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import type { ImageExportOptions } from "#renderer/export-formats.ts";
import type { WlurOverlayDebugConfig } from "#renderer/wlur-debug.ts";
import type { DeserializeOptions, DeserializeResult } from "#lib/serialization/types.ts";
import type { Options } from "nuqs";
import type { PartialDeep } from "type-fest";

export const DebugType = createEnum({
  /** load the debug image */
  load: "load",
  /** just set debug mode */
  default: "default",
});
export type DebugType = typeof DebugType.infer;

export interface AddEntityOptions {
  skipUndo?: boolean;
  source?: "user" | "onboarding";
}

export interface CanvasCommands {
  setViewport: (viewport: Viewport) => void;
  panBy: (delta: Point) => void;
  resetViewport: () => void;
  addEntity: (
    entity: Omit<ShaderCanvasEntity, "id" | "zIndex" | "name">,
    filename?: string,
    options?: AddEntityOptions,
  ) => string;
  updateEntity: (id: string, updates: Partial<ShaderCanvasEntity>) => void;
  removeEntity: (id: string) => void;
  clearWorkspace: () => void;
  selectEntity: (id: string | null) => void;
  moveEntity: (id: string, delta: Point) => void;
  duplicateEntities: () => Promise<string[]>;
  updateSelectedEntityParams: (
    updates: PartialDeep<ShaderParams>,
    options?: { skipUndo?: boolean },
  ) => void;
  setSelectedEntityTimeAutoPlay: (playing: boolean) => void;
  syncSelectedEntityTimes: () => void;
  changeShaderType: (value: string | null) => void;
  changeDitheringKind: (value: string | null) => void;
  changeAsciiKind: (value: string | null) => void;
  setAsciiInvert: (value: boolean) => void;
  changeGlassKind: (value: string | null) => void;
  changeGlitchKind: (value: string | null) => void;
  changePalette: (palette: ColorPalette) => void;
  renamePalette: (paletteId: string, name: string) => void;
  uploadPalette: (files: FileList | File | null) => Promise<void>;
  deletePalette: (paletteId: string) => void;
  setShowOriginal: (value: boolean) => void;
  toggleShowOriginal: () => void;
  setPreserveColors: (value: boolean) => void;
  togglePreserveColors: () => void;
  setReversePalette: (value: boolean) => void;
  toggleReversePalette: () => void;
  deleteSelection: (e?: KeyboardEvent, source?: "keyboard" | "context_menu" | "drop_zone") => void;
  copySelectionImage: (e?: KeyboardEvent) => Promise<void>;
  copySelectionEffects: () => void;
  pasteEffects: () => Promise<void>;
  resetSelectionToDefaults: () => void;
  setSnapToGrid: (enabled: boolean) => void;
  setFancyDelete: (enabled: boolean) => void;
  setHaptics: (enabled: boolean) => void;
  changeSize: (value: number | number[]) => void;
  copySelectedEntityToClipboard: () => Promise<boolean>;
  saveSelectedEntityToFile: (options?: ImageExportOptions) => Promise<void>;
  serializeCanvas: () => Promise<Blob | null>;
  deserializeCanvas: (
    source: Blob | ArrayBuffer,
    options?: DeserializeOptions,
  ) => Promise<DeserializeResult>;
  applyUrlState: (params: URLSearchParams) => void;
  applyEffectsToSelection: (data: {
    shaderType: ShaderType;
    shaderParams: ShaderParams;
    originalPalette?: ColorPalette;
  }) => void;
  setDebugType: (
    value: DebugType | ((old: DebugType | null) => DebugType | null) | null,
    options?: Options,
  ) => Promise<URLSearchParams>;
}

export interface CanvasRendererService {
  registerRenderer: (renderer: InfiniteCanvasRenderer) => void;
  renderer: InfiniteCanvasRenderer | null;
  colorSpace: ColorSpace;
  debugMode: boolean;
  wlurDebugConfig: WlurOverlayDebugConfig;
  setWlurDebugConfig: (updates: Partial<WlurOverlayDebugConfig>) => void;
  resetWlurDebugConfig: () => void;
}

const CanvasCommandsContext = createContext<CanvasCommands | null>(null);
const CanvasRendererContext = createContext<CanvasRendererService | null>(null);

export function useCanvasSelector<T>(
  selector: (state: ReturnType<typeof canvasStore.getState>) => T,
  equalityFn?: (a: T, b: T) => boolean,
): T {
  return useSyncExternalStore(
    (listener) => canvasStore.subscribeSelector(selector, listener, equalityFn),
    () => selector(canvasStore.getState()),
  );
}

export function useCanvasCommands(): CanvasCommands {
  const context = use(CanvasCommandsContext);
  if (!context) {
    throw new Error("useCanvasCommands must be used within CanvasProvider");
  }
  return context;
}

export function useCanvasRendererService(): CanvasRendererService {
  const context = use(CanvasRendererContext);
  if (!context) {
    throw new Error("useCanvasRendererService must be used within CanvasProvider");
  }
  return context;
}

export function useViewport(): Viewport {
  return useCanvasSelector((state) => state.viewport);
}

export function useSelectedEntityIds(): ReadonlySet<string> {
  return useCanvasSelector((state) => state.selectedEntityIds);
}

export function useSelectedEntity(): ShaderCanvasEntity | undefined {
  return useCanvasSelector(() => canvasStore.getSelectedEntity());
}

export function useSelectedEntities(): ShaderCanvasEntity[] {
  return useCanvasSelector(() => canvasStore.getSelectedEntitiesStable());
}

export function useSelectedEntityParams(): ShaderParams | null {
  return useCanvasSelector(() => canvasStore.getSelectedEntity()?.shaderParams ?? null);
}

export function useSelectedShaderType(): ShaderType {
  return useCanvasSelector(
    () => canvasStore.getSelectedEntity()?.shaderType ?? config.defaults.shader,
  );
}

export function useMultiSelectMode(): boolean {
  return useCanvasSelector((state) => state.multiSelectMode);
}

export function useDebugMode(): boolean {
  return useCanvasSelector((state) => state.debugMode);
}

export function useContextOpenEntityId(): string | null {
  return useCanvasSelector((state) => state.contextOpenEntityId);
}

export function useEntityCount(): number {
  return useCanvasSelector((state) => state.entities.size);
}

export function useHasEntities(): boolean {
  return useCanvasSelector((state) => state.entities.size > 0);
}

export function useCanvasPreferences(): PreferencesSnapshot {
  const snapToGrid = useCanvasSelector((state) => state.snapToGrid);
  const fancyDelete = useCanvasSelector((state) => state.fancyDelete);
  const haptics = useCanvasSelector((state) => state.haptics);
  const version = useCanvasSelector((state) => state.preferencesVersion);
  return { snapToGrid, fancyDelete, haptics, version };
}

export function useHasSelection(): boolean {
  return useCanvasSelector((state) => state.selectedEntityIds.size > 0);
}

export function useHasUniformSelectedShader(): boolean {
  return useCanvasSelector(() => canvasStore.getSelectionState().hasUniformShader);
}

export function useSelectionState() {
  return useCanvasSelector(() => canvasStore.getSelectionState());
}

export { CanvasCommandsContext, CanvasRendererContext };
