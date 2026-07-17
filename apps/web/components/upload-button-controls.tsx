import {
  useCanvasAccess,
  useCanvasCommands,
  useCanvasInteraction,
  useHasEntities,
} from "#context/use-canvas.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { addFilesToCanvas } from "#application/canvas/entity-placement.ts";
import { showMediaLoadFailureToasts } from "#application/canvas/media-load-notifications.ts";
import { MediaImagePlus } from "iconoir-react";
import { useRef } from "react";
import { config } from "#config";
import { Button } from "./ui/button";

export function UploadControls() {
  const access = useCanvasAccess();
  const hasEntities = useHasEntities();
  if (!access.canEdit) {
    return (
      <div className="mobile-common-knobs pb-1">
        <div className="mobile-row no-selection-message">
          <p>Viewer access · editing is disabled</p>
        </div>
      </div>
    );
  }
  return (
    <div className="mobile-common-knobs pb-1">
      <div className="mobile-row">
        <FileUploadComponent />
      </div>
      {!hasEntities && (
        <div className="mobile-row no-selection-message">
          <p>Add images, videos or GIFs for editing</p>
        </div>
      )}
    </div>
  );
}

export function FileUploadComponent() {
  const access = useCanvasAccess();
  const inputRef = useRef<HTMLInputElement>(null);
  const { addEntity } = useCanvasCommands();
  const interaction = useCanvasInteraction();
  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;

  if (!access.canEdit) return null;

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const container = document.querySelector(".infinite-canvas");
    if (!(container instanceof HTMLElement)) return;

    const anchor = interaction.getViewportCenter(
      container.getBoundingClientRect(),
      window.devicePixelRatio,
    );

    await addFilesToCanvas(Array.from(files), addEntity, container, {
      anchor,
      select: true,
      fitToView: true,
      bottomInset,
      onLoadFailure: showMediaLoadFailureToasts,
    });
  };

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={[...config.supports.image, ...config.supports.video].join(",")}
        onChange={(e) => handleFileSelect(e.target.files)}
        hidden
        multiple
      />
      <Button
        variant="primary"
        onClick={() => {
          inputRef.current?.click();
        }}
      >
        <MediaImagePlus />
        <span>Add Images/Videos</span>
      </Button>
    </>
  );
}
