import { releaseImageAsset } from "#lib/media-assets.ts";
import { MediaType, type MediaSource, type ShaderCanvasEntity } from "#types/canvas.ts";

const VIDEO_READY_TIMEOUT_MS = 15_000;
const HAVE_CURRENT_DATA_READY_STATE = 2;
const videoActivations = new WeakMap<HTMLVideoElement, Promise<void>>();

export function createDormantVideoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  return video;
}

export function hasActiveVideoSource(video: HTMLVideoElement): boolean {
  return (
    video.readyState >= HAVE_CURRENT_DATA_READY_STATE && Boolean(video.currentSrc || video.src)
  );
}

/** Attach a decoder only when a video is admitted by the visible playback budget. */
export function activateVideoElement(video: HTMLVideoElement, blob: Blob): Promise<void> {
  if (hasActiveVideoSource(video)) return Promise.resolve();
  const existing = videoActivations.get(video);
  if (existing) return existing;

  const pending = new Promise<void>((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const timeoutId = setTimeout(
      () => finish(new Error("Timed out activating video")),
      VIDEO_READY_TIMEOUT_MS,
    );
    const cleanup = () => {
      clearTimeout(timeoutId);
      video.removeEventListener("loadeddata", onReady);
      video.removeEventListener("error", onError);
    };
    const finish = (error?: Error) => {
      cleanup();
      if (error) {
        suspendVideoElement(video);
        reject(error);
      } else resolve();
    };
    const onReady = () => finish();
    const onError = () => finish(new Error("Video decoder could not be activated"));

    video.addEventListener("loadeddata", onReady, { once: true });
    video.addEventListener("error", onError, { once: true });
    video.src = objectUrl;
    video.load();
    if (video.readyState >= HAVE_CURRENT_DATA_READY_STATE) onReady();
  }).finally(() => videoActivations.delete(video));
  videoActivations.set(video, pending);
  return pending;
}

/** Release decoder state while preserving the Blob and fallback frame owned by the entity. */
export function suspendVideoElement(video: HTMLVideoElement): void {
  const src = video.getAttribute("src") ?? video.currentSrc;
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (src.startsWith("blob:")) URL.revokeObjectURL(src);
}

/** Release the browser resources owned by a video element. */
export function disposeVideoElement(video: HTMLVideoElement): void {
  suspendVideoElement(video);
  video.srcObject = null;
}

/** Release one detached media source and its current bitmap ownership. */
export function disposeMediaSource(mediaSource: MediaSource, imageBitmap: ImageBitmap): void {
  switch (mediaSource.type) {
    case MediaType.video:
      disposeVideoElement(mediaSource.videoElement);
      if (mediaSource.posterAsset) releaseImageAsset(mediaSource.posterAsset);
      else imageBitmap.close();
      break;
    case MediaType.gif:
      for (const frame of mediaSource.frames) frame.bitmap.close();
      break;
    case MediaType.svg:
      imageBitmap.close();
      break;
    case MediaType.image:
      releaseImageAsset(mediaSource.asset);
      break;
  }
}

/** Release the one media ownership reference represented by an entity. */
export function disposeEntityMedia(entity: ShaderCanvasEntity): void {
  disposeMediaSource(entity.mediaSource, entity.imageBitmap);
}
