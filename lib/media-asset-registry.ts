import { logger } from "#lib/client.logger.ts";
import {
  MediaType,
  type GifFrame,
  type MediaAsset,
  type MediaAssetGif,
  type MediaAssetImage,
  type MediaAssetSvg,
  type MediaAssetVideo,
} from "#types/canvas.ts";

interface AssetEntry {
  asset: MediaAsset;
  entityRefs: number;
  runtimeRefs: number;
}

interface VideoPlaybackSession {
  entityId: string;
  assetId: string;
  videoElement: HTMLVideoElement;
  objectUrl: string;
}

let nextAssetId = 1;

function createAssetId(): string {
  return `asset-${nextAssetId++}`;
}

function syncNextAssetId(assetId: string): void {
  const match = assetId.match(/^asset-(\d+)$/);
  if (!match) return;
  const parsed = Number(match[1]);
  if (Number.isFinite(parsed)) {
    nextAssetId = Math.max(nextAssetId, parsed + 1);
  }
}

async function captureVideoFrameBitmap(
  video: HTMLVideoElement,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  try {
    if ("requestVideoFrameCallback" in HTMLVideoElement.prototype) {
      await video.play();
      await new Promise<void>((resolve) => {
        (
          video as HTMLVideoElement & {
            requestVideoFrameCallback: (
              callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
            ) => number;
          }
        ).requestVideoFrameCallback(() => resolve());
      });
      video.pause();
    } else {
      await video.play();
      await new Promise((resolve) => setTimeout(resolve, 100));
      video.pause();
    }
  } catch {
    const seekTarget = video.currentTime;
    video.currentTime = seekTarget;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create 2D context for video frame capture");
  }
  ctx.drawImage(video, 0, 0);
  return createImageBitmap(canvas);
}

async function createVideoElementFromBlob(blob: Blob, seekTime = 0): Promise<HTMLVideoElement> {
  const video = document.createElement("video");
  video.src = URL.createObjectURL(blob);
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Failed to load video"));
  });

  if (seekTime > 0) {
    video.currentTime = seekTime;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });
  }

  return video;
}

function cleanupAsset(asset: MediaAsset): void {
  switch (asset.type) {
    case MediaType.image:
    case MediaType.svg:
      asset.imageBitmap.close();
      return;
    case MediaType.gif:
      for (const frame of asset.frames) {
        frame.bitmap.close();
      }
      return;
    case MediaType.video:
      asset.posterFrame.close();
      return;
  }
}

class MediaAssetRegistry {
  #assets = new Map<string, AssetEntry>();
  #videoSessions = new Map<string, VideoPlaybackSession>();

  createImageAsset(
    blob: Blob,
    imageBitmap: ImageBitmap,
    assetId: string = createAssetId(),
  ): MediaAssetImage {
    syncNextAssetId(assetId);
    const asset: MediaAssetImage = {
      assetId,
      type: MediaType.image,
      blob,
      width: imageBitmap.width,
      height: imageBitmap.height,
      imageBitmap,
    };
    this.#assets.set(asset.assetId, { asset, entityRefs: 0, runtimeRefs: 0 });
    return asset;
  }

  createSvgAsset(
    blob: Blob,
    imageBitmap: ImageBitmap,
    width: number,
    height: number,
    assetId: string = createAssetId(),
  ): MediaAssetSvg {
    syncNextAssetId(assetId);
    const asset: MediaAssetSvg = {
      assetId,
      type: MediaType.svg,
      blob,
      width,
      height,
      imageBitmap,
    };
    this.#assets.set(asset.assetId, { asset, entityRefs: 0, runtimeRefs: 0 });
    return asset;
  }

  createGifAsset(
    blob: Blob,
    frames: GifFrame[],
    width: number,
    height: number,
    duration: number,
    fps: number,
    assetId: string = createAssetId(),
  ): MediaAssetGif {
    syncNextAssetId(assetId);
    const asset: MediaAssetGif = {
      assetId,
      type: MediaType.gif,
      blob,
      width,
      height,
      frames,
      duration,
      fps,
    };
    this.#assets.set(asset.assetId, { asset, entityRefs: 0, runtimeRefs: 0 });
    return asset;
  }

  createVideoAsset(
    blob: Blob,
    posterFrame: ImageBitmap,
    width: number,
    height: number,
    duration: number,
    fps: number | null,
    hasAudio: boolean,
    assetId: string = createAssetId(),
  ): MediaAssetVideo {
    syncNextAssetId(assetId);
    const asset: MediaAssetVideo = {
      assetId,
      type: MediaType.video,
      blob,
      width,
      height,
      posterFrame,
      duration,
      fps,
      hasAudio,
    };
    this.#assets.set(asset.assetId, { asset, entityRefs: 0, runtimeRefs: 0 });
    return asset;
  }

  getAsset<T extends MediaAsset = MediaAsset>(assetId: string): T {
    const entry = this.#assets.get(assetId);
    if (!entry) {
      throw new Error(`Unknown media asset: ${assetId}`);
    }
    return entry.asset as T;
  }

  hasAsset(assetId: string): boolean {
    return this.#assets.has(assetId);
  }

  retainAsset(assetId: string): void {
    const entry = this.#assets.get(assetId);
    if (!entry) throw new Error(`Unknown media asset: ${assetId}`);
    entry.entityRefs++;
  }

  releaseAsset(assetId: string): boolean {
    const entry = this.#assets.get(assetId);
    if (!entry) return false;
    entry.entityRefs = Math.max(0, entry.entityRefs - 1);
    if (entry.entityRefs === 0 && entry.runtimeRefs === 0) {
      this.#assets.delete(assetId);
      cleanupAsset(entry.asset);
      return true;
    }
    return false;
  }

  acquireRuntimeLease(assetId: string): void {
    const entry = this.#assets.get(assetId);
    if (!entry) throw new Error(`Unknown media asset: ${assetId}`);
    entry.runtimeRefs++;
  }

  releaseRuntimeLease(assetId: string): void {
    const entry = this.#assets.get(assetId);
    if (!entry) return;
    entry.runtimeRefs = Math.max(0, entry.runtimeRefs - 1);
    if (entry.entityRefs === 0 && entry.runtimeRefs === 0) {
      this.#assets.delete(assetId);
      cleanupAsset(entry.asset);
    }
  }

  getAllAssets(): MediaAsset[] {
    return Array.from(this.#assets.values(), (entry) => entry.asset);
  }

  getStaticAssetBitmap(assetId: string): ImageBitmap {
    const asset = this.getAsset(assetId);
    switch (asset.type) {
      case MediaType.image:
      case MediaType.svg:
        return asset.imageBitmap;
      case MediaType.gif:
        if (asset.frames.length === 0) {
          throw new Error("GIF asset has no frames");
        }
        return asset.frames[0]!.bitmap;
      case MediaType.video:
        return asset.posterFrame;
    }
  }

  getGifFrames(assetId: string): GifFrame[] {
    const asset = this.getAsset<MediaAssetGif>(assetId);
    if (asset.type !== MediaType.gif) {
      throw new Error(`Asset ${assetId} is not a GIF`);
    }
    return asset.frames;
  }

  async ensureVideoSession(
    entityId: string,
    assetId: string,
    seekTime = 0,
  ): Promise<HTMLVideoElement> {
    const existing = this.#videoSessions.get(entityId);
    if (existing) {
      return existing.videoElement;
    }

    const asset = this.getAsset<MediaAssetVideo>(assetId);
    if (asset.type !== MediaType.video) {
      throw new Error(`Asset ${assetId} is not a video`);
    }

    const videoElement = await createVideoElementFromBlob(asset.blob, seekTime);
    const session: VideoPlaybackSession = {
      entityId,
      assetId,
      videoElement,
      objectUrl: videoElement.src,
    };
    this.acquireRuntimeLease(assetId);
    this.#videoSessions.set(entityId, session);
    return videoElement;
  }

  getVideoElement(entityId: string): HTMLVideoElement | null {
    return this.#videoSessions.get(entityId)?.videoElement ?? null;
  }

  getVideoCurrentTime(entityId: string): number | null {
    return this.#videoSessions.get(entityId)?.videoElement.currentTime ?? null;
  }

  registerVideoSession(
    entityId: string,
    assetId: string,
    videoElement: HTMLVideoElement,
    objectUrl: string = videoElement.src,
  ): void {
    const existing = this.#videoSessions.get(entityId);
    if (existing) {
      this.destroyVideoSession(entityId);
    }
    this.acquireRuntimeLease(assetId);
    this.#videoSessions.set(entityId, {
      entityId,
      assetId,
      videoElement,
      objectUrl,
    });
  }

  async captureSessionFrame(entityId: string): Promise<ImageBitmap | null> {
    const session = this.#videoSessions.get(entityId);
    if (!session) return null;

    const asset = this.getAsset<MediaAssetVideo>(session.assetId);
    return captureVideoFrameBitmap(session.videoElement, asset.width, asset.height);
  }

  async seekVideoSession(
    entityId: string,
    assetId: string,
    time: number,
  ): Promise<HTMLVideoElement> {
    const video = await this.ensureVideoSession(entityId, assetId);
    video.currentTime = time;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
    });
    return video;
  }

  destroyVideoSession(entityId: string): void {
    const session = this.#videoSessions.get(entityId);
    if (!session) return;

    session.videoElement.pause();
    session.videoElement.src = "";
    session.videoElement.load();
    URL.revokeObjectURL(session.objectUrl);
    this.#videoSessions.delete(entityId);
    this.releaseRuntimeLease(session.assetId);
  }

  destroyAssetResources(assetId: string): void {
    for (const [entityId, session] of this.#videoSessions.entries()) {
      if (session.assetId === assetId) {
        this.destroyVideoSession(entityId);
      }
    }
    const entry = this.#assets.get(assetId);
    if (!entry) return;
    if (entry.entityRefs === 0 && entry.runtimeRefs === 0) {
      this.#assets.delete(assetId);
      cleanupAsset(entry.asset);
    }
  }

  reset(): void {
    for (const entityId of this.#videoSessions.keys()) {
      this.destroyVideoSession(entityId);
    }
    for (const entry of this.#assets.values()) {
      cleanupAsset(entry.asset);
    }
    this.#assets.clear();
    this.#videoSessions.clear();
    nextAssetId = 1;
  }

  logStats(): void {
    logger.debug("[mediaAssetRegistry] stats", {
      assetCount: this.#assets.size,
      videoSessions: this.#videoSessions.size,
    });
  }
}

export const mediaAssetRegistry = new MediaAssetRegistry();
