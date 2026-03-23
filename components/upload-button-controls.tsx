import { useCanvasCommands, useHasEntities } from "#context/use-canvas.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { addFilesToCanvas } from "#lib/entity-placement.ts";
import { MediaImagePlus } from "iconoir-react";
import { useRef } from "react";
import { config } from "../lib/config";
import { Button } from "./ui/button";

export function UploadControls() {
  const hasEntities = useHasEntities();
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
  const inputRef = useRef<HTMLInputElement>(null);
  const { addEntity } = useCanvasCommands();
  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;

  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0) return;

    const container = document.querySelector(".infinite-canvas");
    if (!(container instanceof HTMLElement)) return;

    await addFilesToCanvas(Array.from(files), addEntity, container, bottomInset);
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
