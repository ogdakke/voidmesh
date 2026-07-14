export type SerializedMediaType = "image" | "video" | "gif" | "svg";

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "image/bmp": "bmp",
  "image/tiff": "tif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/mpeg": "mpeg",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/matroska": "mkv",
  "video/x-matroska": "mkv",
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mimeType, extension]) => [extension, mimeType]),
);

export function requireMediaBlobMimeType(blob: Blob, mediaType: SerializedMediaType): string {
  const mimeType = blob.type.trim().toLowerCase();
  const expectedPrefix = mediaType === "video" ? "video/" : "image/";
  if (!mimeType.startsWith(expectedPrefix)) {
    throw new Error(`Cannot serialize ${mediaType} media without a ${expectedPrefix} MIME type`);
  }
  return mimeType;
}

export function getMediaExtension(mimeType: string): string {
  const known = EXTENSION_BY_MIME[mimeType];
  if (known) return known;

  // MIME metadata, not the archive extension, is authoritative during decode. The
  // generic extension keeps uncommon but valid browser image/video formats lossless.
  return "media";
}

export function inferLegacyMediaMimeType(
  mediaType: SerializedMediaType,
  mediaFile: string,
): string {
  if (mediaType === "gif") return "image/gif";
  if (mediaType === "svg") return "image/svg+xml";
  if (mediaType === "image") return MIME_BY_EXTENSION[getExtension(mediaFile)] ?? "image/png";
  return MIME_BY_EXTENSION[getExtension(mediaFile)] ?? "video/mp4";
}

function getExtension(path: string): string {
  const filename = path.slice(path.lastIndexOf("/") + 1);
  const dot = filename.lastIndexOf(".");
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase();
}
