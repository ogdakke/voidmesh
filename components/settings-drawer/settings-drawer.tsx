import { useState, type ChangeEvent } from "react";
import { FloppyDiskArrowIn, Import, MoreVert, NavArrowRight } from "iconoir-react";
import { Drawer } from "../ui/drawer/index.tsx";
import { Checkbox } from "../ui/checkbox/index.tsx";
import { Button } from "../ui/button/index.tsx";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import { useCanvas } from "#context/use-canvas.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import "./settings-drawer.css";
import { shareOrCopyUrl } from "./share.ts";

export default function SettingsDrawer() {
  const { snapToGrid, handleSnapToGridChange } = useCanvasActions();
  const { entities } = useCanvas();
  const { exportStudioFile, importStudioFile, isExporting, isImporting } = useStudioFile();
  const [open, setOpen] = useState(false);

  const handleSnapChange = (e: ChangeEvent<HTMLInputElement>) => {
    handleSnapToGridChange(e.target.checked);
  };

  const isLoading = isExporting || isImporting;

  return (
    <Drawer.Root open={open} onOpenChange={setOpen}>
      <Drawer.Trigger
        render={(props) => (
          <Button
            {...props}
            variant="secondary"
            className="settings-drawer-trigger"
            aria-label="Settings"
          >
            <MoreVert />
          </Button>
        )}
      ></Drawer.Trigger>
      <Drawer.Popup>
        <div className="settings-drawer-inner">
          <div className="settings-drawer-header">
            <h3 className="settings-drawer-title">Settings</h3>
          </div>
          <div className="settings-drawer-switch">
            <Checkbox name="snap_to_grid" checked={snapToGrid} onChange={handleSnapChange} switch>
              Snap to Grid
            </Checkbox>
          </div>
          <hr className="divider" />
          <div className="settings-drawer-ext-item field-label">
            <button type="button" onClick={shareOrCopyUrl}>
              Share
            </button>
            <NavArrowRight />
          </div>
          <div className="settings-drawer-ext-item field-label">
            <a
              href={`mailto:dw@danielwargh.com?subject=${encodeURIComponent("Feedback on voidmesh")}`}
              className="settings-drawer-link"
            >
              Send feedback
            </a>
            <NavArrowRight />
          </div>
          <div className="settings-drawer-studio-buttons">
            {entities.length > 0 && (
              <Button variant="primary" onClick={exportStudioFile} disabled={isLoading}>
                <FloppyDiskArrowIn />
                <span>Export voidmesh File</span>
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => importStudioFile(() => setOpen(false))}
              disabled={isLoading}
            >
              <Import />
              <span>Import voidmesh File</span>
            </Button>
          </div>
        </div>
      </Drawer.Popup>
    </Drawer.Root>
  );
}
