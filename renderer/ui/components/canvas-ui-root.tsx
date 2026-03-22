// ---------------------------------------------------------------------------
// Canvas UI Root — single React root for all GPU-rendered overlay UI
// ---------------------------------------------------------------------------
//
// Like <App /> in a normal React app, but for the WebGPU canvas overlay.
// Fixed-position overlay components (context menu, future tooltips/toasts)
// live here as children.
//

import type { CanvasContextMenuProps } from "./canvas-context-menu.tsx";
import { CanvasContextMenu } from "./canvas-context-menu.tsx";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CanvasUIRootProps {
  contextMenu: CanvasContextMenuProps | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CanvasUIRoot({ contextMenu }: CanvasUIRootProps) {
  if (!contextMenu) return null;
  return <CanvasContextMenu {...contextMenu} />;
}
