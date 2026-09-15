import { useHasEntities } from "#context/use-canvas.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import { WorkspaceActions } from "#components/workspace-actions/workspace-actions.tsx";
import { Button } from "#ui/button/index.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { MoreVert } from "iconoir-react";
import { useState } from "react";
import "./settings.mobile.css";
import { CanvasLensingPreviews } from "./canvas-lensing-previews.tsx";
import {
  FancyDeleteToggle,
  FeedbackLink,
  HapticsToggle,
  LinkItem,
  RedoOnboardingLink,
  ShareLink,
  SnapToGridToggle,
} from "./settings.shared.tsx";
export default function SettingsDrawer() {
  const hasEntities = useHasEntities();
  const {
    exportStudioFile,
    importStudioFile,
    clearWorkspace,
    hasActiveWorkspaceFile,
    activeWorkspaceFileName,
    isExporting,
    isImporting,
  } = useStudioFile();
  const [open, setOpen] = useState(location.hash.slice(1) === "settings");

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    history.replaceState(
      null,
      "",
      `${location.pathname}${location.search}${nextOpen ? "#settings" : ""}`,
    );
  };

  const importAndClose = (onSuccess?: () => void) => {
    importStudioFile(() => {
      onSuccess?.();
      handleOpenChange(false);
    });
  };

  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
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
          <CanvasLensingPreviews layout="mobile" />
          <div className="settings-drawer-switch">
            <SnapToGridToggle />
          </div>
          <div className="settings-drawer-switch">
            <FancyDeleteToggle />
          </div>
          <div className="settings-drawer-switch">
            <HapticsToggle />
          </div>
          <div className="settings-drawer-switch">
            <OverlapLabToggle />
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
          <hr className="divider" />
          <div className="settings-drawer-ext-item field-label">
            <LinkItem>
              <RedoOnboardingLink onDone={() => handleOpenChange(false)} />
            </LinkItem>
          </div>
          <WorkspaceActions
            className="settings-drawer-workspace-actions"
            hasEntities={hasEntities}
            exportStudioFile={exportStudioFile}
            importStudioFile={importAndClose}
            clearWorkspace={clearWorkspace}
            hasActiveWorkspaceFile={hasActiveWorkspaceFile}
            activeWorkspaceFileName={activeWorkspaceFileName}
            isExporting={isExporting}
            isImporting={isImporting}
            moreActionsPresentation="sheet"
          />
        </div>
      </Drawer.Popup>
    </Drawer.Root>
  );
}
