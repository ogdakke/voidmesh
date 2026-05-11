import { Keybind } from "#components/keyboard-shortcuts/keybind.tsx";
import { undo } from "#lib/undo.ts";
import { ButtonGroup, ButtonGroupSeparator } from "#ui/button-group/button-group.tsx";
import { Button } from "#ui/button/button.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { Menu } from "#ui/menu/menu.tsx";
import clsx from "clsx";
import { FloppyDiskArrowIn, Import, NavArrowDown, Trash } from "iconoir-react";
import { useState, useSyncExternalStore } from "react";
import "./workspace-actions.css";

const getHasUndoHistory = () => undo.canUndo() || undo.canRedo();
type MoreActionsPresentation = "menu" | "sheet";

export function WorkspaceActions({
  hasEntities,
  exportStudioFile,
  importStudioFile,
  clearWorkspace,
  hasActiveWorkspaceFile,
  activeWorkspaceFileName,
  isExporting,
  isImporting,
  className,
  moreActionsPresentation = "menu",
}: {
  hasEntities: boolean;
  exportStudioFile: () => void;
  importStudioFile: (onSuccess?: () => void) => void;
  clearWorkspace: () => void;
  hasActiveWorkspaceFile: boolean;
  activeWorkspaceFileName: string | null;
  isExporting: boolean;
  isImporting: boolean;
  className?: string;
  moreActionsPresentation?: MoreActionsPresentation;
}) {
  const isBusy = isExporting || isImporting;
  const hasUndoHistory = useSyncExternalStore(undo.subscribe, getHasUndoHistory);
  const canSaveWorkspace = hasEntities && !isBusy;
  const canClearWorkspace = (hasEntities || hasActiveWorkspaceFile || hasUndoHistory) && !isBusy;
  const [sheetOpen, setSheetOpen] = useState(false);
  const disabledReason =
    !hasEntities && !hasActiveWorkspaceFile && !hasUndoHistory && !isBusy
      ? "Add something to the canvas first."
      : null;

  const saveWorkspace = () => {
    setSheetOpen(false);
    exportStudioFile();
  };

  const clearCurrentWorkspace = () => {
    setSheetOpen(false);
    clearWorkspace();
  };

  if (moreActionsPresentation === "sheet") {
    return (
      <div className={clsx("workspace-actions", className)}>
        <Drawer.Root open={sheetOpen} onOpenChange={setSheetOpen}>
          <ButtonGroup aria-label="Workspace actions" className="workspace-button-group">
            <Button
              type="button"
              variant="primary"
              className="workspace-button-group__primary"
              data-button-group-position="first"
              onClick={() => importStudioFile()}
              disabled={isBusy}
            >
              <span>Open workspace</span>
            </Button>
            <ButtonGroupSeparator />
            <Drawer.Trigger
              disabled={isBusy}
              render={(props) => (
                <Button
                  {...props}
                  type="button"
                  variant="primary"
                  icon
                  className={`workspace-button-group__menu-trigger ${props.className ?? ""}`}
                  data-button-group-position="last"
                  aria-label="More workspace actions"
                >
                  <NavArrowDown />
                </Button>
              )}
            />
          </ButtonGroup>
          <Drawer.Popup backdrop={false} className="workspace-actions-sheet">
            <Drawer.Title>Workspace</Drawer.Title>
            <Drawer.Content>
              <div className="workspace-actions-sheet__copy">
                <p>
                  Save this canvas as a portable Voidmesh workspace file, or clear the current
                  workspace and start fresh.
                </p>
                {activeWorkspaceFileName && (
                  <div className="workspace-actions-sheet__file" title={activeWorkspaceFileName}>
                    {activeWorkspaceFileName}
                  </div>
                )}
              </div>
              <div className="workspace-actions-sheet__actions">
                {disabledReason && (
                  <p className="workspace-actions-sheet__disabled-reason">{disabledReason}</p>
                )}
                <Button type="button" onClick={saveWorkspace} disabled={!canSaveWorkspace}>
                  <span>Save workspace</span>
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={clearCurrentWorkspace}
                  disabled={!canClearWorkspace}
                >
                  <span>Clear workspace</span>
                </Button>
              </div>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Root>
      </div>
    );
  }

  return (
    <div className={clsx("workspace-actions", className)}>
      <Menu.Root>
        <ButtonGroup aria-label="Workspace actions" className="workspace-button-group">
          <Button
            type="button"
            variant="primary"
            className="workspace-button-group__primary"
            data-button-group-position="first"
            onClick={() => importStudioFile()}
            disabled={isBusy}
          >
            <span>Open workspace</span>
          </Button>
          <ButtonGroupSeparator />
          <Menu.Trigger
            disabled={isBusy}
            render={(props) => (
              <Button
                {...props}
                type="button"
                variant="primary"
                icon
                className={`workspace-button-group__menu-trigger ${props.className ?? ""}`}
                data-button-group-position="last"
                aria-label="More workspace actions"
              >
                <NavArrowDown />
              </Button>
            )}
          />
        </ButtonGroup>
        <Menu.Popup align="end" sideOffset={6} className="workspace-actions-menu">
          {activeWorkspaceFileName && (
            <>
              <Menu.Group>
                <Menu.GroupLabel title={activeWorkspaceFileName}>
                  {activeWorkspaceFileName}
                </Menu.GroupLabel>
              </Menu.Group>
              <Menu.Separator />
            </>
          )}
          <Menu.Item
            className="menu-item--icon-left menu-item--icon-right"
            onClick={exportStudioFile}
            disabled={!canSaveWorkspace}
          >
            <Menu.IconLeft>
              <FloppyDiskArrowIn />
            </Menu.IconLeft>
            Save workspace
            <Keybind keybindId="save_studio" />
          </Menu.Item>
          <Menu.Item
            className="menu-item--icon-left"
            onClick={clearWorkspace}
            disabled={!canClearWorkspace}
            variant="destructive"
          >
            <Menu.IconLeft>
              <Trash />
            </Menu.IconLeft>
            Clear workspace
          </Menu.Item>
        </Menu.Popup>
      </Menu.Root>
    </div>
  );
}
