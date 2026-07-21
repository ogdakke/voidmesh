import { MediaType, type ShaderCanvasEntity } from "#types/canvas.ts";

const THUMBNAIL_EDGE = 320;
const THUMBNAIL_QUALITY = 0.78;
const MAX_THUMBNAIL_BYTES = 128 * 1024;

/** Creates a bounded first-frame preview without reading the original again. */
export async function createHostedAssetThumbnail(
  entity: Pick<ShaderCanvasEntity, "imageBitmap" | "mediaSource" | "originalSize">,
): Promise<Blob | undefined> {
  const source =
    entity.mediaSource.type === MediaType.video
      ? entity.mediaSource.videoElement
      : entity.imageBitmap;
  return createThumbnailFromSource(source, entity.originalSize.width, entity.originalSize.height);
}

/** Recreates a first-frame thumbnail when only a pending original survived browser recovery. */
export async function createHostedAssetThumbnailFromBlob(
  blob: Blob,
  mediaType: string,
): Promise<Blob | undefined> {
  if (mediaType === MediaType.video) return createVideoBlobThumbnail(blob);

  const bitmap = await createImageBitmap(blob);
  try {
    return await createThumbnailFromSource(bitmap, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

async function createVideoBlobThumbnail(blob: Blob): Promise<Blob | undefined> {
  const video = document.createElement("video");
  const url = URL.createObjectURL(blob);
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = url;
  try {
    await waitForVideoFrame(video);
    return await createThumbnailFromSource(video, video.videoWidth, video.videoHeight);
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

function waitForVideoFrame(video: HTMLVideoElement): Promise<void> {
  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out while preparing a recovered video thumbnail"));
    }, 15_000);
    const cleanup = () => {
      clearTimeout(timeout);
      video.removeEventListener("loadeddata", onLoaded);
      video.removeEventListener("error", onError);
    };
    const onLoaded = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Unable to decode a recovered video thumbnail"));
    };
    video.addEventListener("loadeddata", onLoaded, { once: true });
    video.addEventListener("error", onError, { once: true });
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) onLoaded();
  });
}

async function createThumbnailFromSource(
  source: CanvasImageSource,
  width: number,
  height: number,
): Promise<Blob | undefined> {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) return undefined;
  let edge = THUMBNAIL_EDGE;
  let quality = THUMBNAIL_QUALITY;
  while (edge >= 96) {
    const scale = Math.min(1, edge / Math.max(width, height));
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
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
