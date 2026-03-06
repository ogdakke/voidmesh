import { createContext, use, useSyncExternalStore } from "react";
import { canvasStore } from "#engine";
import type {
  ColorPalette,
  Viewport,
  ShaderCanvasEntity,
  Point,
  ShaderParams,
  ShaderType,
} from "#types/canvas.ts";
import type { InfiniteCanvasRenderer } from "../renderer/canvas-renderer.ts";
import type { ImageExportOptions } from "../renderer/export-formats.ts";
import type { DeserializeResult } from "../lib/serialization/types.ts";
import type { SetValues, Options } from "nuqs";
import type { PartialDeep } from "type-fest";
import { createEnum } from "#types/index.ts";
import type { ColorSpace } from "#types/enums.ts";

export const DebugType = createEnum({
  /** load the debug image */
  load: "load",
  /** just set debug mode */
  default: "default",
});
export type DebugType = typeof DebugType.infer;

export interface CanvasContextValue {
  // Viewport state — use useViewport() or canvasStore.getViewport() (imperative) instead of reading viewport from context
  setViewport: (viewport: Viewport) => void;
  panBy: (delta: Point) => void;
  resetViewport: () => void;

  // Entity state
  entities: ShaderCanvasEntity[];
  /** Multi-select: all selected entity IDs */
  selectedEntityIds: ReadonlySet<string>;
  /** Whether multi-select toggle mode is active (touch devices) */
  multiSelectMode: boolean;
  contextOpenEntityId: string | null;
  hoveredEntityId: string | null;
  addEntity: (
    entity: Omit<ShaderCanvasEntity, "id" | "zIndex" | "name">,
    filename?: string,
  ) => string;
  updateEntity: (id: string, updates: Partial<ShaderCanvasEntity>) => void;
  removeEntity: (id: string) => void;
  selectEntity: (id: string | null) => void;
  moveEntity: (id: string, delta: Point) => void;
  bringToFront: (id: string) => void;
  sendToBack: (id: string) => void;
  duplicateEntities: () => Promise<string[]>;

  // Shader params for selected entity (first entity's values when multi-select)
  selectedShaderType: ShaderType;
  selectedEntityParams: ShaderParams | null;
  updateSelectedShaderType: (shaderType: ShaderType) => void;
  updateSelectedEntityParams: (
    updates: PartialDeep<ShaderParams>,
    options?: { skipUndo?: boolean },
  ) => void;

  // Renderer registration
  registerRenderer: (renderer: InfiniteCanvasRenderer) => void;
  renderer: InfiniteCanvasRenderer | null;

  // Color space detected from GPU capabilities
  colorSpace: ColorSpace;

  // Export functions (copy: single only PNG, save: supports multi + format options)
  copySelectedEntityToClipboard: () => Promise<boolean>;
  saveSelectedEntityToFile: (options?: ImageExportOptions) => Promise<void>;

  // Utility
  getContextOpenEntity: () => ShaderCanvasEntity | undefined;

  // Serialization
  serializeCanvas: () => Promise<Blob>;
  deserializeCanvas: (source: Blob | ArrayBuffer) => Promise<DeserializeResult>;

  // url state
  setRenderState: SetValues<any>;
  setRenderStateFromURL: (params: URLSearchParams) => void;
  applyEffectsToSelection: (data: {
    shaderType: ShaderType;
    shaderParams: ShaderParams;
    originalPalettes?: {
      palette8?: ColorPalette;
      palette16?: ColorPalette;
    };
  }) => void;
  setDebugType: (
    value: DebugType | ((old: DebugType | null) => DebugType | null) | null,
    options?: Options,
  ) => Promise<URLSearchParams>;
}

export const CanvasContext = createContext<CanvasContextValue | null>(null);

export function useCanvas(): CanvasContextValue {
  const context = use(CanvasContext);
  if (!context) {
    throw new Error("useCanvas must be used within CanvasProvider");
  }
  return context;
}

/**
 * Hook that subscribes ONLY to viewport changes.
 * Use this for components that need to re-render when zoom/pan changes (e.g., zoom indicator).
 * Sidebar components should NOT use this hook.
 */
export function useViewport(): Viewport {
  const snapshot = useSyncExternalStore(canvasStore.subscribe.bind(canvasStore), () =>
    canvasStore.getViewportSnapshot(),
  );
  return snapshot.viewport;
}
