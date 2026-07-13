import { rgbaToThumbHash, thumbHashToDataURL, thumbHashToRGBA } from "thumbhash";
import type { MediaPreview, ShaderCanvasEntity } from "#types/canvas.ts";

const cache = new Map<string, string>();
const encodedBitmapCache = new WeakMap<ImageBitmap, MediaPreview>();
const THUMBHASH_MAX_DIMENSION = 100;
const MAX_THUMBHASH_BYTES = 128;

/** Decode a compact base64 thumbhash into a data URL. Results are cached. */
export function decodeThumbhash(base64: string): string {
  let url = cache.get(base64);
  if (url) return url;

  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  url = thumbHashToDataURL(bytes);
  cache.set(base64, url);
  return url;
}

export function encodeThumbhash(bitmap: ImageBitmap): MediaPreview {
  const cached = encodedBitmapCache.get(bitmap);
  if (cached) return cached;

  const scale = Math.min(1, THUMBHASH_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("Unable to create ThumbHash canvas context");
  context.drawImage(bitmap, 0, 0, width, height);
  const image = context.getImageData(0, 0, width, height);
  const preview: MediaPreview = {
    codec: "thumbhash-v1",
    bytes: rgbaToThumbHash(width, height, image.data),
  };
  encodedBitmapCache.set(bitmap, preview);
  return preview;
}

export function getEntityThumbhash(entity: ShaderCanvasEntity): MediaPreview {
  if (entity.preview && isMediaPreview(entity.preview)) return entity.preview;
  return encodeThumbhash(entity.imageBitmap);
}

export async function decodeThumbhashMedia(preview: MediaPreview): Promise<{
  imageBitmap: ImageBitmap;
  blob: Blob;
}> {
  if (!isMediaPreview(preview)) throw new Error("Invalid collaborative ThumbHash preview");
  const decoded = thumbHashToRGBA(preview.bytes);
  const canvas = new OffscreenCanvas(decoded.w, decoded.h);
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to create ThumbHash decode context");
  context.putImageData(
    new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.w, decoded.h),
    0,
    0,
  );
  const [imageBitmap, blob] = await Promise.all([
    createImageBitmap(canvas),
    canvas.convertToBlob({ type: "image/png" }),
  ]);
  return { imageBitmap, blob };
}

export function isMediaPreview(value: unknown): value is MediaPreview {
  if (!value || typeof value !== "object") return false;
  const preview = value as Partial<MediaPreview>;
  return (
    preview.codec === "thumbhash-v1" &&
    preview.bytes instanceof Uint8Array &&
    preview.bytes.byteLength > 0 &&
    preview.bytes.byteLength <= MAX_THUMBHASH_BYTES
  );
}

export function thumbhashToBase64(preview: MediaPreview): string {
  if (!isMediaPreview(preview)) throw new Error("Invalid ThumbHash preview");
  let binary = "";
  for (const byte of preview.bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function thumbhashFromBase64(base64: string): MediaPreview | null {
  try {
    const preview: MediaPreview = {
      codec: "thumbhash-v1",
      bytes: Uint8Array.from(atob(base64), (character) => character.charCodeAt(0)),
    };
    return isMediaPreview(preview) ? preview : null;
  } catch {
    return null;
  }
}
