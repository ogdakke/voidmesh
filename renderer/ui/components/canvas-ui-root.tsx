// ---------------------------------------------------------------------------
// Canvas UI Root — single React root for all GPU-rendered overlay UI
// ---------------------------------------------------------------------------
//
// Like <App /> in a normal React app, but for the WebGPU canvas overlay.
// Fixed-position overlay components (context menu, future tooltips/toasts)
// live here as children.
//

import { memo } from "react";
import type { CanvasContextMenuProps } from "./canvas-context-menu.tsx";
import { CanvasContextMenu } from "./canvas-context-menu.tsx";
import type { DebugOverlayStats } from "../debug-ui.tsx";
import { PerfHud } from "../debug-ui.tsx";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface CanvasUIRootProps {
  contextMenu: CanvasContextMenuProps | null;
  perf: DebugOverlayStats | null;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const CanvasUIRoot = memo(function CanvasUIRoot({ contextMenu, perf }: CanvasUIRootProps) {
  if (!contextMenu && !perf) return null;

  return (
    <>
      {perf ? <PerfHud perf={perf} /> : null}
      {contextMenu ? <CanvasContextMenu {...contextMenu} /> : null}
    </>
  );
});
