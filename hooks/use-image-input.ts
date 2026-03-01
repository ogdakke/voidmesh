import { toastManager } from "#components/ui/toast/toast-manager.ts";
import { config } from "#config";
import { addFilesToCanvas, addUrlToCanvas, fitEntitiesToView } from "#lib/entity-placement.ts";
import { wait } from "#lib/util.ts";
import { useRef } from "react";
import { useCanvas } from "../context/use-canvas.ts";
import { canvasStore } from "../engine/canvas-store.ts";
import { useClipboardPaste } from "./use-clipboard-paste.ts";
import { useIsMobile } from "./use-is-mobile.ts";
import { importStudioWithToasts } from "./use-studio-file.ts";

interface UseImageInputOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  multipleFiles?: boolean;
}

function isStudioFile(file: File): boolean {
  return file.name.endsWith(".studio") || file.name.endsWith(".vdmsh");
}

export function useImageInput({ containerRef, multipleFiles = true }: UseImageInputOptions) {
  const { addEntity, setRenderStateFromURL, deserializeCanvas } = useCanvas();
  const isLoadingRef = useRef(false);
  const isMobile = useIsMobile();
  const bottomInset = isMobile ? config.canvas.mobile.bottomInset : 0;

  /**
   * Handle pasted items from clipboard (files or URLs)
   */
  const handlePastedItems = async (items: (File | string)[]) => {
    if (isLoadingRef.current || items.length === 0) return;
    isLoadingRef.current = true;

    const container = containerRef.current;
    if (!container) {
      isLoadingRef.current = false;
      return;
    }

    const files: File[] = [];
    const urls: string[] = [];

    for (const item of items) {
      if (typeof item === "string") {
        urls.push(item);
      } else {
        files.push(item);
      }
    }

    // Handle pasted files (images and videos)
    if (files.length > 0) {
      const maxFiles = multipleFiles ? files.length : 1;
      await addFilesToCanvas(files.slice(0, maxFiles), addEntity, container, bottomInset);
    }

    // Handle pasted URLs
    if (urls.length > 0) {
      const maxUrls = multipleFiles ? urls.length : 1;
      const urlsToProcess = urls.slice(0, maxUrls);
      const entityIds: string[] = [];

      for (const urlString of urlsToProcess) {
        const url = new URL(urlString);
        if (url.origin === window.origin && url.searchParams.size > 0) {
          toastManager.add({ title: "Got params from pasted link" });
          setRenderStateFromURL(url.searchParams);
          continue;
        }

        const entityId = await addUrlToCanvas(urlString, addEntity, container, bottomInset);
        if (entityId) {
          entityIds.push(entityId);
          toastManager.add({ title: "Pasted Link" });
        } else {
          toastManager.add({
            title: "Failed to load media from link",
            description: "Check if the link points to a supported image or video",
            type: "destructive",
          });
        }
      }

      // If multiple URLs were pasted, re-select all and fit-to-view together
      if (entityIds.length > 1) {
        canvasStore.replaceSelection(entityIds);
        fitEntitiesToView(entityIds, container, bottomInset);
      }
    }

    isLoadingRef.current = false;
  };

  // Set up clipboard paste listener
  useClipboardPaste(handlePastedItems);

  /**
   * Handle file selection from FileTrigger
   */
  const handleFileSelect = async (files: FileList | null) => {
    if (!files || files.length === 0 || isLoadingRef.current) return;
    isLoadingRef.current = true;

    const container = containerRef.current;
    if (!container) {
      isLoadingRef.current = false;
      return;
    }

    const fileArray = Array.from(files);
    const maxFiles = multipleFiles ? fileArray.length : 1;
    const filesToProcess = fileArray.slice(0, maxFiles);

    await addFilesToCanvas(filesToProcess, addEntity, container, bottomInset);

    isLoadingRef.current = false;
  };

  /**
   * Handle drag-and-drop events
   */
  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    if (isLoadingRef.current) return;
    isLoadingRef.current = true;

    const container = containerRef.current;
    if (!container) {
      isLoadingRef.current = false;
      return;
    }

    const { dataTransfer } = e;

    // Handle dropped .studio files — deserialize instead of adding as media
    if (dataTransfer.files.length > 0) {
      const studioFile = Array.from(dataTransfer.files).find(isStudioFile);
      if (studioFile) {
        await importStudioWithToasts(studioFile, deserializeCanvas);
        isLoadingRef.current = false;
        return;
      }
    }

    // Handle dropped files (images and videos)
    if (dataTransfer.files.length > 0) {
      const fileArray = Array.from(dataTransfer.files);
      const maxFiles = multipleFiles ? fileArray.length : 1;
      await addFilesToCanvas(fileArray.slice(0, maxFiles), addEntity, container, bottomInset);
    }
    // Handle dropped URLs
    else {
      const uriList = dataTransfer.getData("text/uri-list") || dataTransfer.getData("text/plain");
      if (uriList) {
        // text/uri-list: newline-separated URIs, lines starting with # are comments (RFC 2483)
        const urls = uriList.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith("#"));

        const maxUrls = multipleFiles ? urls.length : 1;
        const urlsToProcess = urls.slice(0, maxUrls);
        const entityIds: string[] = [];

        for (const uriString of urlsToProcess) {
          if (URL.canParse(uriString)) {
            const url = new URL(uriString);
            const toastId = toastManager.add({
              title: "Dropped Link",
              timeout: 0,
            });

            const loadPromise = async () => {
              const entityId = await addUrlToCanvas(
                url.toString(),
                addEntity,
                container,
                bottomInset,
              );
              if (entityId) {
                entityIds.push(entityId);
              }
            };
            // show the toast for at least N ms
            await Promise.all([loadPromise(), wait(2000)]);

            toastManager.close(toastId);
          }
        }

        // If multiple URLs were dropped, re-select all and fit-to-view together
        if (entityIds.length > 1) {
          canvasStore.replaceSelection(entityIds);
          fitEntitiesToView(entityIds, container, bottomInset);
        }
      }
    }

    isLoadingRef.current = false;
  };

  return {
    handleDrop,
    handleFileSelect,
    handlePastedItems,
  };
}
