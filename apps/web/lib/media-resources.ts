import { releaseImageAsset } from "#lib/media-assets.ts";
import { MediaType, type MediaSource, type ShaderCanvasEntity } from "#types/canvas.ts";

/** Release the browser resources owned by a video element. */
export function disposeVideoElement(video: HTMLVideoElement): void {
  const src = video.getAttribute("src") ?? video.currentSrc;
  video.pause();
  video.removeAttribute("src");
  video.srcObject = null;
  video.load();
  if (src.startsWith("blob:")) URL.revokeObjectURL(src);
}

/** Release one detached media source and its current bitmap ownership. */
export function disposeMediaSource(mediaSource: MediaSource, imageBitmap: ImageBitmap): void {
  switch (mediaSource.type) {
    case MediaType.video:
      disposeVideoElement(mediaSource.videoElement);
      imageBitmap.close();
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
