import { useHasEntities } from "#context/use-canvas.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import { Button } from "#ui/button/index.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { FloppyDiskArrowIn, Import, MoreVert } from "iconoir-react";
import { useState } from "react";
import "./settings.mobile.css";
import {
  FancyDeleteToggle,
  FeedbackLink,
  HapticsToggle,
  LinkItem,
  ShareLink,
  SnapToGridToggle,
} from "./settings.shared.tsx";
export default function SettingsDrawer() {
  const hasEntities = useHasEntities();
  const { exportStudioFile, importStudioFile, isExporting, isImporting } = useStudioFile();
  const [open, setOpen] = useState(false);

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
            <SnapToGridToggle />
          </div>
          <div className="settings-drawer-switch">
            <FancyDeleteToggle />
          </div>
          <div className="settings-drawer-switch">
            <HapticsToggle />
          </div>
          <hr className="divider" />
          <div className="settings-drawer-ext-item field-label">
            <LinkItem>
              <ShareLink />
            </LinkItem>
          </div>
          <div className="settings-drawer-ext-item field-label">
            <LinkItem>
              <FeedbackLink className="settings-drawer-link" />
            </LinkItem>
          </div>
          <div className="settings-drawer-studio-buttons">
            {hasEntities && (
              <Button variant="primary" onClick={exportStudioFile} disabled={isLoading}>
                <FloppyDiskArrowIn />
                <span>Save workspace</span>
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={() => importStudioFile(() => setOpen(false))}
              disabled={isLoading}
            >
              <Import />
              <span>Open workspace</span>
            </Button>
          </div>
        </div>
      </Drawer.Popup>
    </Drawer.Root>
  );
}
