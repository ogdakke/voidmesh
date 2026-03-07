import { Copy, InfoCircle, PasteClipboard, ShareIos } from "iconoir-react";
import { Drawer } from "#ui/drawer/index.tsx";
import { Button } from "#ui/button/button.tsx";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import "./copy-paste-drawer.css";
import { logger } from "#lib/client.logger.ts";
import { toastManager } from "#ui/toast/toast-manager.ts";

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
        <Drawer.Title>Effects</Drawer.Title>
        <Drawer.Content>
          <p>
            <InfoCircle /> Copy currently active effects, and paste them onto another file. Most
            effects are also shareable through a link
          </p>
          <div className="copy-paste-drawer-actions">
            <Button variant="primary" onClick={handleCopy} disabled={selectionState.isMultiple}>
              <Copy />
              <span>Copy All Effects</span>
            </Button>
            <div className="bottom">
              <Button variant="secondary" onClick={handlePaste}>
                <PasteClipboard />
                <span>Paste Effects</span>
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  navigator
                    .share({
                      title: "Check out my edits on Voidmesh",
                      url: window.location.href,
                    })
                    .then(() => {
                      onOpenChange(false);
                      toastManager.add({
                        title: "Effects shared",
                      });
                    })
                    .catch((e) => logger.error(e));
                }}
              >
                <ShareIos />
                <span>Share Effects</span>
              </Button>
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Popup>
    </Drawer.Root>
  );
}
