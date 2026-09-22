import { logger } from "../client.logger.ts";
import { disposeVideoElement } from "../media-resources.ts";
import { wait } from "../util.ts";

const VIDEO_SEEK_TIMEOUT_MS = 1500;

export const MIME_BY_EXT: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  svg: "image/svg+xml",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

export function videoExtensionFromMime(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  return (
    Object.entries(MIME_BY_EXT).find(
      ([, mime]) => mime.startsWith("video/") && mime === normalized,
    )?.[0] ?? "mp4"
  );
}

export function imageExtensionFromMime(mimeType: string): string {
  const normalized = normalizeMimeType(mimeType);
  return (
    Object.entries(MIME_BY_EXT).find(
      ([, mime]) => mime.startsWith("image/") && mime === normalized,
    )?.[0] ?? "png"
  );
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.toLowerCase().trim();
  return normalized === "image/jpg" ? "image/jpeg" : normalized;
}

/**
 * Convert raw bytes back to an ImageBitmap.
 */
export async function bytesToImageBitmap(
  source: Blob | Uint8Array,
  mimeType = "image/png",
): Promise<ImageBitmap> {
  const blob =
    source instanceof Blob
      ? source
      : new Blob([source as Uint8Array<ArrayBuffer>], { type: mimeType });
  return createImageBitmap(blob);
}

/**
 * Reliably capture a video frame as an ImageBitmap.
 *
 * On iOS Safari, `onseeked` fires before the video decoder has decoded the frame,
 * so `drawImage` after a seek produces a blank/transparent image. The workaround
 * is to briefly play the video and wait for `requestVideoFrameCallback` (Safari 15.4+)
 * which only fires when a frame is actually ready for presentation.
 *
 * The video is muted + playsInline, so the brief play/pause is invisible and
 * doesn't require user interaction.
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  try {
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      await video.play();
      await new Promise<void>((resolve) => {
        (video as any).requestVideoFrameCallback(() => resolve());
      });
      video.pause();
    } else {
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 100));
      video.pause();
    }
  } catch {
    // play() was rejected (e.g. autoplay policy). The video was already seeked
    // by the caller, but the decoder may not have finished (iOS Safari).
    // Re-trigger seek and wait for the decoder to settle.
    const seekTarget = video.currentTime;
    await seekVideoWithTimeout(video, seekTarget, "capture fallback");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0);
  return createImageBitmap(canvas);
}

/**
 * Load a video from raw bytes, creating an HTMLVideoElement.
 * Mirrors the pattern in media-loader.ts loadVideo().
 *
 * @param bytes - Raw video file bytes
 * @param mimeType - MIME type of the video
 * @param seekTime - Time in seconds to seek to before capturing the frame (default: 0)
 */
export async function bytesToVideoElement(
  source: Blob | Uint8Array,
  mimeType: string,
  seekTime = 0,
): Promise<{
  videoElement: HTMLVideoElement;
  initialFrame: ImageBitmap;
  width: number;
  height: number;
  duration: number;
  currentTime: number;
  seekApplied: boolean;
}> {
  const blob =
    source instanceof Blob
      ? source
      : new Blob([source as Uint8Array<ArrayBuffer>], { type: mimeType });
  let video = createArchiveVideoElement(blob);
  let initialFrame: ImageBitmap | null = null;

  try {
    await waitForVideoMetadata(video);
    let seekApplied = true;

    // Seek to the requested time before capturing
    if (seekTime > 0) {
      const seekResult = await seekVideoWithTimeout(video, seekTime, "initial frame");
      if (seekResult === "timeout") {
        seekApplied = false;
        logger.debug("[workspace-import] rebuilding video element after timed out seek", {
          seekTime,
          currentTime: video.currentTime,
        });
        disposeVideoElement(video);
        video = createArchiveVideoElement(blob);
        await waitForVideoMetadata(video);
      }
    }

    // Capture frame using play-then-capture for reliable decode (fixes iOS blank frames)
    const width = video.videoWidth;
    const height = video.videoHeight;
    initialFrame = await captureVideoFrame(video, width, height);

    return {
      videoElement: video,
      initialFrame,
      width,
      height,
      duration: video.duration,
      currentTime: video.currentTime,
      seekApplied,
    };
  } catch (error) {
    initialFrame?.close();
    disposeVideoElement(video);
    throw error;
  }
}

async function seekVideoWithTimeout(
  video: HTMLVideoElement,
  seekTime: number,
  context: string,
): Promise<"seeked" | "timeout"> {
  video.currentTime = seekTime;

  const result = await new Promise<"seeked" | "timeout">((resolve) => {
    let settled = false;

    const finish = (value: "seeked" | "timeout") => {
      if (settled) return;
      settled = true;
      video.removeEventListener("seeked", onSeeked);
      resolve(value);
    };

    const onSeeked = () => finish("seeked");

    video.addEventListener("seeked", onSeeked, { once: true });
    void wait(VIDEO_SEEK_TIMEOUT_MS).then(() => finish("timeout"));
  });

  if (result === "timeout") {
    logger.debug("[workspace-import] video seek timed out", {
      context,
      seekTime,
      timeoutMs: VIDEO_SEEK_TIMEOUT_MS,
      currentTime: video.currentTime,
      readyState: video.readyState,
      networkState: video.networkState,
    });
  }

  return result;
}

function createArchiveVideoElement(blob: Blob): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(blob);
  return video;
}

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Failed to load video from archive"));
  });
}
