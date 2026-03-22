// ---------------------------------------------------------------------------
// Context Menu Action Interface
// ---------------------------------------------------------------------------
//
// Defines the callback interface between the canvas-rendered context menu
// and the React application layer. Populated in canvas-context.tsx from
// existing hooks/store methods, passed to the renderer.
//

import type { ShaderCanvasEntity, ColorPalette } from "#types/canvas.ts";
import type { ImageExportFormat } from "#renderer/export-formats.ts";

export interface ContextMenuActions {
  // Canvas actions (no entity selected)
  paste: () => void;
  saveWorkspace: () => void;
  saveAsWorkspace: () => void;
  openWorkspace: () => void;
  toggleSnapToGrid: (checked: boolean) => void;

  // Shader / style
  changeShaderType: (type: string) => void;

  // Palette
  changePalette: (palette: ColorPalette) => void;
  triggerPaletteUpload: () => void;

  // Toggles
  toggleShowOriginal: (checked: boolean) => void;
  togglePreserveColors: (checked: boolean) => void;
  toggleReversePalette: (checked: boolean) => void;

  // Entity actions
  copyImage: () => void;
  saveAsFormat: (format: ImageExportFormat) => void;
  copyEffects: () => void;
  pasteEffects: () => void;
  bringToFront: () => void;
  sendToBack: () => void;
  duplicate: () => void;
  upscale: (entityIds: string[]) => void;
  exportAnimated: (entities: ShaderCanvasEntity[]) => void;
  reset: () => void;
  deleteEntity: () => void;

  // Menu lifecycle
  close: () => void;
}
