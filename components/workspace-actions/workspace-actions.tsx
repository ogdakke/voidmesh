import { Keybind } from "#components/keyboard-shortcuts/keybind.tsx";
import { undo } from "#lib/undo.ts";
import { ButtonGroup, ButtonGroupSeparator } from "#ui/button-group/button-group.tsx";
import { Button } from "#ui/button/button.tsx";
import { Menu } from "#ui/menu/menu.tsx";
import clsx from "clsx";
import { FloppyDiskArrowIn, Import, NavArrowDown, Trash } from "iconoir-react";
import { useSyncExternalStore } from "react";
import "./workspace-actions.css";

const getHasUndoHistory = () => undo.canUndo() || undo.canRedo();

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
}) {
  const isBusy = isExporting || isImporting;
  const hasUndoHistory = useSyncExternalStore(undo.subscribe, getHasUndoHistory);
  const canSaveWorkspace = hasEntities && !isBusy;
  const canClearWorkspace = (hasEntities || hasActiveWorkspaceFile || hasUndoHistory) && !isBusy;

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
            <Import />
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
