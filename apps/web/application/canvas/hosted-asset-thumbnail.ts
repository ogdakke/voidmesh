import type { ShaderCanvasEntity } from "#types/canvas.ts";

const THUMBNAIL_EDGE = 320;
const THUMBNAIL_QUALITY = 0.78;
const MAX_THUMBNAIL_BYTES = 128 * 1024;

/** Creates a bounded first-frame preview without reading the original again. */
export async function createHostedAssetThumbnail(
  entity: ShaderCanvasEntity,
): Promise<Blob | undefined> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  let edge = THUMBNAIL_EDGE;
  let quality = THUMBNAIL_QUALITY;
  while (edge >= 96) {
    const scale = Math.min(
      1,
      edge / Math.max(entity.originalSize.width, entity.originalSize.height),
    );
    canvas.width = Math.max(1, Math.round(entity.originalSize.width * scale));
    canvas.height = Math.max(1, Math.round(entity.originalSize.height * scale));
    const source =
      entity.mediaSource.type === "video" ? entity.mediaSource.videoElement : entity.imageBitmap;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const blob = await encodeWebp(canvas, quality);
    if (!blob || blob.size <= MAX_THUMBNAIL_BYTES) return blob;
    edge = Math.floor(edge * 0.75);
    quality = Math.max(0.45, quality - 0.1);
  }
  return undefined;
}

function encodeWebp(canvas: HTMLCanvasElement, quality: number): Promise<Blob | undefined> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob ?? undefined), "image/webp", quality);
  });
}

export function blobToBase64(blob: Blob): Promise<string> {
  return blob.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
}
