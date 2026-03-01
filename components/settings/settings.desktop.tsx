import { useCanvas } from "#context/use-canvas.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import { Button } from "#ui/button/button.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import { FloppyDiskArrowIn, Import, MoreVert } from "iconoir-react";
import { useState } from "react";
import "./settings.desktop.css";
import {
  FancyDeleteToggle,
  FeedbackLink,
  LinkItem,
  ShareLink,
  SnapToGridToggle,
} from "./settings.shared.tsx";

export default function DesktopSettings() {
  const [isOpen, setIsOpen] = useState(false);
  const { entities } = useCanvas();
  const { exportStudioFile, importStudioFile, isExporting, isImporting } = useStudioFile();

  const isLoading = isExporting || isImporting;

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
            <SnapToGridToggle />
          </div>
          <div className="desktop-settings-switch">
            <FancyDeleteToggle />
          </div>
          <hr className="divider" />
          <div className="desktop-settings-ext-item field-label">
            <LinkItem>
              <ShareLink />
            </LinkItem>
          </div>
          <div className="desktop-settings-ext-item field-label">
            <LinkItem>
              <FeedbackLink className="desktop-settings-link" />
            </LinkItem>
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
