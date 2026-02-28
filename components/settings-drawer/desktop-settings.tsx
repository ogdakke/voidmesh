import { Button } from "#ui/button/button.tsx";
import { Checkbox } from "#ui/checkbox/index.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import { useCanvas } from "#context/use-canvas.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import { FloppyDiskArrowIn, Import, MoreVert, NavArrowRight } from "iconoir-react";
import { useState, type ChangeEvent } from "react";
import "./desktop-settings.css";
import { shareOrCopyUrl } from "./share.ts";

export default function DesktopSettings() {
  const [isOpen, setIsOpen] = useState(false);
  const { snapToGrid, handleSnapToGridChange, fancyDelete, handleFancyDeleteChange } =
    useCanvasActions();
  const { entities } = useCanvas();
  const { exportStudioFile, importStudioFile, isExporting, isImporting } = useStudioFile();

  const isLoading = isExporting || isImporting;

  const handleSnapChange = (e: ChangeEvent<HTMLInputElement>) => {
    handleSnapToGridChange(e.target.checked);
  };

  const handleFancyChange = (e: ChangeEvent<HTMLInputElement>) => {
    handleFancyDeleteChange(e.target.checked);
  };

  return (
    <div className="desktop-settings">
      <Button
        size="sm"
        variant="secondary"
        className="settings-trigger"
        onClick={() => {
          setIsOpen(true);
        }}
      >
        <MoreVert />
      </Button>
      <Modal.Root
        open={isOpen}
        onClose={() => {
          setIsOpen(false);
        }}
      >
        <Modal.Content className="desktop-settings-modal">
          <h3 className="desktop-settings-title">Settings</h3>
          <hr className="divider" />
          <div className="desktop-settings-switch">
            <Checkbox name="snap_to_grid" checked={snapToGrid} onChange={handleSnapChange} switch>
              Snap to Grid
            </Checkbox>
          </div>
          <div className="desktop-settings-switch">
            <Checkbox name="fancy_delete" checked={fancyDelete} onChange={handleFancyChange} switch>
              Fancy deletions
            </Checkbox>
          </div>
          <hr className="divider" />
          <div className="field-label flex">
            <button
              className="desktop-settings-ext-item desktop-settings-button"
              type="button"
              onClick={shareOrCopyUrl}
            >
              <span>Share</span>
              <NavArrowRight />
            </button>
          </div>
          <div className="field-label">
            <a
              href={`mailto:dw@danielwargh.com?subject=${encodeURIComponent("Feedback on voidmesh")}`}
              className="desktop-settings-ext-item desktop-settings-link"
            >
              <span>Send feedback</span>
              <NavArrowRight />
            </a>
          </div>
          <hr className="divider" />
          <div className="desktop-settings-studio-buttons">
            <Button
              variant="quiet"
              onClick={() => importStudioFile(() => setIsOpen(false))}
              disabled={isLoading}
            >
              <Import />
              <span>Import voidmesh File</span>
            </Button>
            {entities.length > 0 && (
              <Button variant="primary" onClick={exportStudioFile} disabled={isLoading}>
                <FloppyDiskArrowIn />
                <span>Export voidmesh File</span>
              </Button>
            )}
          </div>
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}
