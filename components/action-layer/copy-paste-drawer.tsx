import { Copy, PasteClipboard } from "iconoir-react";
import { Drawer } from "#ui/drawer/index.tsx";
import { Button } from "#ui/button/button.tsx";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import "./copy-paste-drawer.css";

interface CopyPasteDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CopyPasteDrawer({ open, onOpenChange }: CopyPasteDrawerProps) {
  const { copyEntityParams, pasteEntityParams, selectionState } = useCanvasActions();

  const handleCopy = () => {
    copyEntityParams();
    onOpenChange(false);
  };

  const handlePaste = () => {
    pasteEntityParams();
    onOpenChange(false);
  };

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Popup className="copy-paste-drawer">
        <Drawer.Content>
          <div className="copy-paste-drawer-actions">
            <Button variant="secondary" onClick={handleCopy} disabled={selectionState.isMultiple}>
              <Copy />
              <span>Copy Effects</span>
            </Button>
            <Button variant="secondary" onClick={handlePaste}>
              <PasteClipboard />
              <span>Paste Effects</span>
            </Button>
          </div>
        </Drawer.Content>
      </Drawer.Popup>
    </Drawer.Root>
  );
}
