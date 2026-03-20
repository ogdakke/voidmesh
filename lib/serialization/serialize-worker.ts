/**
 * Web Worker for workspace serialization.
 *
 * Receives entity media data + manifest JSON from the main thread,
 * performs PNG encoding (ImageBitmap → bytes via OffscreenCanvas) and
 * zip compression (fflate) entirely off the main thread.
 * Posts the final zip bytes back (transferred).
 */

interface MediaEntry {
  path: string;
  type: "imageBitmap" | "bytes";
  bitmap?: ImageBitmap;
  bytes?: Uint8Array;
}

interface SerializeRequest {
  manifest: string;
  mediaEntries: MediaEntry[];
}

self.onmessage = async (e: MessageEvent<SerializeRequest>) => {
  try {
    const { manifest, mediaEntries } = e.data;
    const zipEntries: Record<string, Uint8Array> = {};

    // Add manifest
    zipEntries["manifest.json"] = new TextEncoder().encode(manifest);

    // Process media entries — PNG-encode ImageBitmaps, pass through raw bytes
    await Promise.all(
      mediaEntries.map(async (entry) => {
        if (entry.type === "imageBitmap") {
          const bitmap = entry.bitmap!;
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const ctx = canvas.getContext("2d")!;
          ctx.drawImage(bitmap, 0, 0);
          const blob = await canvas.convertToBlob({ type: "image/png" });
          zipEntries[entry.path] = new Uint8Array(await blob.arrayBuffer());
          bitmap.close();
        } else {
          zipEntries[entry.path] = entry.bytes!;
        }
      }),
    );

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
