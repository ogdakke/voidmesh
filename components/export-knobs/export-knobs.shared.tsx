import { useCanvas } from "#context/use-canvas.ts";
import { useExportQueue } from "#context/use-export-queue.ts";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import { type ImageExportFormat, imageExportOptionsForFormat } from "#renderer/export-formats.ts";
import { isAnimatedEntity } from "#types/canvas.ts";
import { Button } from "#ui/button/button.tsx";
import { Copy, Download, MediaVideo } from "iconoir-react";

/** Export save buttons - frame copy/save and video export */
export function ExportSaveButtons({ imageFormat }: { imageFormat: ImageExportFormat }) {
  const isMobile = useIsMobile();
  const { exportOptions, addToQueue } = useExportQueue();
  const { selectionState, selectedEntities } = useCanvasActions();
  const {
    saveSelectedEntityToFile: saveToFile,
    copySelectedEntityToClipboard,
    renderer,
  } = useCanvas();

  const saveSelectedEntityToFile = () => saveToFile(imageExportOptionsForFormat(imageFormat));

  const animatedEntities = selectedEntities.filter(isAnimatedEntity);
  const hasAnimated = animatedEntities.length > 0;
  const animatedCount = animatedEntities.length;
  const isMultiAnimated = animatedCount > 1;
  const isGif = exportOptions.format === "gif";

  const handleStartExport = () => {
    if (!renderer || animatedEntities.length === 0) return;
    for (const entity of animatedEntities) {
      addToQueue(entity, renderer);
    }
  };

  return (
    <>
      {/* Video export button - adds to queue */}
      {hasAnimated && (
        <div className="export-video-row sidebar-row">
          <Button onClick={handleStartExport} className="export-video-btn">
            <MediaVideo />
            <span>
              {isMultiAnimated
                ? `Export ${animatedCount} ${isGif ? "GIFs" : "Videos"}`
                : isGif
                  ? "Export GIF"
                  : "Export Video"}
            </span>
          </Button>
        </div>
      )}

      {/* Frame export buttons (always shown, labeled differently for video) */}
      <div className="export-row sidebar-row">
        {selectionState.isSingle && (
          <Button
            onClick={copySelectedEntityToClipboard}
            size={isMobile ? "md" : "sm"}
            variant="secondary"
          >
            <Copy />
            <span className="text-xs no-wrap">{hasAnimated ? "Copy Frame" : "Copy"}</span>
          </Button>
        )}
        <Button
          onClick={saveSelectedEntityToFile}
          size={isMobile ? "md" : "sm"}
          variant={hasAnimated ? "secondary" : "primary"}
        >
          <Download />
          <span className="text-xs no-wrap">{hasAnimated ? "Save Frame" : "Save"}</span>
        </Button>
      </div>
    </>
  );
}
