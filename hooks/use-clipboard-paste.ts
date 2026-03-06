import { useEffect } from "react";

interface UseClipboardPasteOptions {
  enabled?: boolean;
}

export function useClipboardPaste(
  onPaste: (items: (File | string)[]) => void,
  options: UseClipboardPasteOptions = {},
) {
  const { enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;

      // First collect all media files (images and videos)
      const files: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }

      if (files.length > 0) {
        e.preventDefault();
        onPaste(files);
        return;
      }

      // Then check for text (voidmesh effects JSON or URLs)
      for (const item of items) {
        if (item.type === "text/plain") {
          e.preventDefault();
          item.getAsString((text) => {
            const trimmed = text.trim();
            // Check for voidmesh effects JSON
            if (trimmed.startsWith("{")) {
              try {
                const parsed = JSON.parse(trimmed);
                if (parsed?.__voidmesh === true) {
                  onPaste([trimmed]);
                  return;
                }
              } catch {
                // Not valid JSON, fall through to URL check
              }
            }
            if (URL.canParse(trimmed)) {
              onPaste([trimmed]);
            }
          });
          return;
        }
      }
    };

    document.addEventListener("paste", handlePaste);
    return () => {
      document.removeEventListener("paste", handlePaste);
    };
  }, [enabled, onPaste]);
}
