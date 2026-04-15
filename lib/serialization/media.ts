import { logger } from "../client.logger.ts";
import { wait } from "../util.ts";

const VIDEO_SEEK_TIMEOUT_MS = 1500;

/**
 * Convert an ImageBitmap to PNG bytes via OffscreenCanvas.
 */
export async function imageBitmapToBytes(bitmap: ImageBitmap): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Convert raw bytes back to an ImageBitmap.
 */
export async function bytesToImageBitmap(
  bytes: Uint8Array,
  mimeType = "image/png",
): Promise<ImageBitmap> {
  const blob = new Blob([bytes.slice()], { type: mimeType });
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
 * Fetch the original file bytes from a video element's blob URL.
 * Works because blob URLs are alive while the entity exists.
 */
export async function videoElementToBytes(videoElement: HTMLVideoElement): Promise<Uint8Array> {
  const src = videoElement.src;
  if (!src || !src.startsWith("blob:")) {
    throw new Error("Video element has no blob URL source");
  }
  const response = await fetch(src);
  const buffer = await response.arrayBuffer();
  return new Uint8Array(buffer);
}

/**
 * Detect the MIME type of a video blob by reading its magic bytes.
 * Returns a file extension suitable for the archive.
 */
export function detectVideoExtension(bytes: Uint8Array): string {
  // Check for common video format magic bytes
  if (bytes.length >= 12) {
    // MP4/MOV: ftyp box at offset 4
    if (
      bytes[4] === 0x66 && // f
      bytes[5] === 0x74 && // t
      bytes[6] === 0x79 && // y
      bytes[7] === 0x70 // p
    ) {
      return "mp4";
    }
    // WebM: EBML header
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      return "webm";
    }
  }
  // Default to mp4
  return "mp4";
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
  bytes: Uint8Array,
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
  const blob = new Blob([bytes.slice()], { type: mimeType });
  let video = createArchiveVideoElement(blob);
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
      cleanupVideoElement(video);
      video = createArchiveVideoElement(blob);
      await waitForVideoMetadata(video);
    }
  }

  // Capture frame using play-then-capture for reliable decode (fixes iOS blank frames)
  const width = video.videoWidth;
  const height = video.videoHeight;
  const initialFrame = await captureVideoFrame(video, width, height);

  return {
    videoElement: video,
    initialFrame,
    width,
    height,
    duration: video.duration,
    currentTime: video.currentTime,
    seekApplied,
  };
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
  video.src = URL.createObjectURL(blob);
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  return video;
}

async function waitForVideoMetadata(video: HTMLVideoElement): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Failed to load video from archive"));
  });
}

function cleanupVideoElement(video: HTMLVideoElement): void {
  const src = video.src;
  video.pause();
  video.src = "";
  video.load();
  if (src.startsWith("blob:")) {
    URL.revokeObjectURL(src);
  }
}
