import { useCanvas } from "#context/use-canvas.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import { Button } from "#ui/button/button.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import { FloppyDiskArrowIn, Import } from "iconoir-react";
import {
  FancyDeleteToggle,
  FeedbackLink,
  LinkItem,
  ShareLink,
  SnapToGridToggle,
} from "./settings.shared.tsx";

export default function DesktopSettingsContent({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  const { entities } = useCanvas();
  const { exportStudioFile, importStudioFile, isExporting, isImporting } = useStudioFile();

  const isLoading = isExporting || isImporting;

  return (
    <Modal.Root open={isOpen} onClose={onClose}>
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
          <Button variant="quiet" onClick={() => importStudioFile(onClose)} disabled={isLoading}>
            <Import />
            <span>Open workspace</span>
          </Button>
          {entities.length > 0 && (
            <Button variant="primary" onClick={exportStudioFile} disabled={isLoading}>
              <FloppyDiskArrowIn />
              <span>Save workspace</span>
            </Button>
          )}
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
