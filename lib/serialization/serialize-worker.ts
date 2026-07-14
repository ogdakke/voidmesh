/**
 * Web Worker for workspace serialization.
 *
 * Receives entity media data + manifest JSON from the main thread and performs
 * zip compression (fflate) entirely off the main thread.
 * Posts the final zip bytes back (transferred).
 */

import type { SerializeMediaEntry } from "./types.ts";

interface SerializeRequest {
  manifest: string;
  mediaEntries: SerializeMediaEntry[];
}

self.onmessage = async (e: MessageEvent<SerializeRequest>) => {
  try {
    const { manifest, mediaEntries } = e.data;
    const zipEntries: Record<string, Uint8Array> = {};

    // Add manifest
    zipEntries["manifest.json"] = new TextEncoder().encode(manifest);

    for (const entry of mediaEntries) zipEntries[entry.path] = entry.bytes;

    // Compress into zip archive
    const { zipSync } = await import("fflate");
    const zipped = zipSync(zipEntries, { level: 6 });

    self.postMessage({ type: "done", zip: zipped }, { transfer: [zipped.buffer] });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  }
};
