import type { ShaderCanvasEntity, Point, ColorPalette, MediaSource } from "#types/canvas.ts";
import type { ColorSpace } from "#types/enums.ts";
import { logger } from "./client.logger.ts";
import { config } from "./config/index.ts";
import { mediaAssetRegistry } from "./media-asset-registry.ts";
import { extractPaletteFromImage } from "./palette-extraction/index.ts";
import { decodeGif, isAnimatedGif, type GifDecodeResult } from "./gif-decoder.ts";

/** Check if a file is a video */
export function isVideoFile(file: File): boolean {
  return config.supports.video.includes(file.type);
}

/** Check if a file is an image */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** Check if a file is an SVG */
export function isSvgFile(file: File): boolean {
  return file.type === "image/svg+xml";
}

/** Check if a MIME type string is a supported video type */
export function isVideoMimeType(mimeType: string): boolean {
  return config.supports.video.includes(mimeType);
}

/** Check if a MIME type string is an image type */
export function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/** Result of loading a video file */
export interface VideoLoadResult {
  videoElement: HTMLVideoElement;
  initialFrame: ImageBitmap;
  width: number;
  height: number;
  duration: number;
  hasAudio: boolean;
  fps: number | null;
}

/** Common frame rates to round to */
const COMMON_FRAME_RATES = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 120] as const;

/**
 * Round detected fps to the nearest common frame rate
 */
function roundToCommonFrameRate(fps: number): number {
  let closest: number = COMMON_FRAME_RATES[0];
  let minDiff = Math.abs(fps - closest);

  for (const rate of COMMON_FRAME_RATES) {
    const diff = Math.abs(fps - rate);
    if (diff < minDiff) {
      minDiff = diff;
      closest = rate;
    }
  }

  // Only round if within 5% of a common rate, otherwise return raw
  if (minDiff / closest < 0.05) {
    return closest;
  }
  return Math.round(fps * 100) / 100;
}

/**
 * Detect video frame rate using requestVideoFrameCallback
 * Observes frames from an already-playing video without controlling playback.
 * @param video - The video element to detect fps from (should already be playing)
 * @param sampleCount - Number of frames to sample (default: 5)
 * @param timeoutMs - Timeout in milliseconds (default: 2000)
 * @returns Detected fps or null if detection fails
 */
async function detectVideoFps(
  video: HTMLVideoElement,
  sampleCount = 5,
  timeoutMs = 2000,
): Promise<number | null> {
  // Check if requestVideoFrameCallback is supported
  if (!("requestVideoFrameCallback" in video)) {
    console.warn("[detectVideoFps] requestVideoFrameCallback not supported");
    return null;
  }

  return new Promise((resolve) => {
    const timestamps: number[] = [];
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let resolved = false;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      // Don't pause video - let it continue playing for the user
    };

    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      if (resolved) return;

      timestamps.push(metadata.mediaTime);

      if (timestamps.length >= sampleCount + 1) {
        cleanup();
        resolved = true;

        // Calculate average frame duration from deltas
        const deltas: number[] = [];
        for (let i = 1; i < timestamps.length; i++) {
          const current = timestamps[i];
          const previous = timestamps[i - 1];
          if (current !== undefined && previous !== undefined) {
            const delta = current - previous;
            if (delta > 0) {
              deltas.push(delta);
            }
          }
        }

        if (deltas.length === 0) {
          resolve(null);
          return;
        }

        const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        const rawFps = 1 / avgDelta;

        // Validate reasonable fps range (1-240)
        if (rawFps < 1 || rawFps > 240) {
          resolve(null);
          return;
        }

        const fps = roundToCommonFrameRate(rawFps);
        resolve(fps);
        return;
      }

      // Request next frame (only if not resolved)
      video.requestVideoFrameCallback(onFrame);
    };

    // Set timeout
    timeoutId = setTimeout(() => {
      if (!resolved) {
        cleanup();
        resolved = true;
        resolve(null);
      }
    }, timeoutMs);

    // Register callback - video should already be playing
    video.requestVideoFrameCallback(onFrame);
  });
}

/**
 * Load a video blob and extract metadata + initial frame
 */
export async function loadVideo(blob: Blob): Promise<VideoLoadResult> {
  const video = document.createElement("video");
  video.src = URL.createObjectURL(blob);
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";

  // Wait for metadata to load
  await new Promise<void>((resolve, reject) => {
    video.onloadedmetadata = () => resolve();
    video.onerror = () => reject(new Error("Failed to load video"));
  });

  const width = video.videoWidth;
  const height = video.videoHeight;

  // Seek to first frame and wait for it
  video.currentTime = 0;
  await new Promise<void>((resolve) => {
    video.onseeked = () => resolve();
  });

  // Create initial frame snapshot
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0);
  const initialFrame = await createImageBitmap(canvas);

  // Start playing for autoplay
  await video.play().catch((e) => {
    logger.error("Failed to autoplay video", e);
  });

  // Detect fps and probe for audio track in parallel
  const [fps, hasAudio] = await Promise.all([
    detectVideoFps(video),
    import("#lib/audio-demux.ts").then(({ hasAudioTrack }) => hasAudioTrack(blob)),
  ]);

  return {
    videoElement: video,
    initialFrame,
    width,
    height,
    duration: video.duration,
    fps,
    hasAudio,
  };
}

/**
 * Create entity data from an ImageBitmap (for images)
 */
export function createImageEntityData(
  bitmap: ImageBitmap,
  blob: Blob,
  position: Point = { x: 0, y: 0 },
  filename?: string,
): Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string } {
  const asset = mediaAssetRegistry.createImageAsset(blob, bitmap);
  return {
    assetId: asset.assetId,
    name: filename,
    mediaSource: { type: "image", blob, assetId: asset.assetId },
    imageBitmap: asset.imageBitmap,
    position,
    size: { width: asset.width, height: asset.height },
    originalSize: { width: asset.width, height: asset.height },
    rotation: 0,
    shaderType: config.defaults.shader,
    shaderParams: config.defaults.shaderParams,
    textureDirty: true,
    selected: false,
    locked: false,
    edited: false,
  };
}

/**
 * Load an animated GIF file and decode all frames
 */
export async function loadGif(file: File): Promise<GifDecodeResult> {
  return decodeGif(file);
}

/**
 * Create entity data from a GifDecodeResult (for animated GIFs)
 */
export function createGifEntityData(
  gifResult: GifDecodeResult,
  blob: Blob,
  position: Point = { x: 0, y: 0 },
  filename?: string,
): Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string } {
  const { frames, width, height, duration, fps } = gifResult;
  const asset = mediaAssetRegistry.createGifAsset(blob, frames, width, height, duration, fps);

  return {
    assetId: asset.assetId,
    name: filename,
    mediaSource: {
      type: "gif",
      assetId: asset.assetId,
      duration,
      fps,
      blob,
    },
    imageBitmap: asset.frames[0]!.bitmap,
    position,
    size: { width, height },
    originalSize: { width, height },
    rotation: 0,
    shaderType: config.defaults.shader,
    shaderParams: config.defaults.shaderParams,
    textureDirty: true,
    selected: false,
    locked: false,
    edited: false,
    playback: {
      isPlaying: true, // Autoplay when added
      currentTime: 0,
      loop: true,
      playbackRate: 1,
    },
  };
}

/** Result of rasterizing an SVG */
export interface SvgRasterizeResult {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/** Fixed rasterization size for SVGs (longest axis) */
const SVG_RASTER_SIZE = 1024;

/**
 * Rasterize SVG text to an ImageBitmap.
 * Always renders at {@link SVG_RASTER_SIZE}px on the longest axis, preserving aspect ratio.
 * Shared by both the media loader (file drop) and deserializer (.vdmsh restore).
 */
export async function rasterizeSvg(text: string): Promise<SvgRasterizeResult> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "image/svg+xml");
  const svgEl = doc.documentElement;

  // Extract aspect ratio from viewBox, width/height, or default to 1:1
  let aspectRatio = 1;
  const viewBox = svgEl.getAttribute("viewBox");
  if (viewBox) {
    const parts = viewBox.split(/[\s,]+/).map(Number);
    const vbW = parts[2] ?? 0;
    const vbH = parts[3] ?? 0;
    if (vbW > 0 && vbH > 0) aspectRatio = vbW / vbH;
  } else {
    const w = parseFloat(svgEl.getAttribute("width") ?? "");
    const h = parseFloat(svgEl.getAttribute("height") ?? "");
    if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
      aspectRatio = w / h;
    }
  }

  // Scale to fixed size, longest axis = SVG_RASTER_SIZE
  let width: number;
  let height: number;
  if (aspectRatio >= 1) {
    width = SVG_RASTER_SIZE;
    height = Math.round(SVG_RASTER_SIZE / aspectRatio);
  } else {
    height = SVG_RASTER_SIZE;
    width = Math.round(SVG_RASTER_SIZE * aspectRatio);
  }

  // Rasterize via Image element + OffscreenCanvas
  const blob = new Blob([text], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Failed to rasterize SVG"));
    });

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, width, height);
    const bitmap = await createImageBitmap(canvas);

    return { bitmap, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Create entity data from an SVG file
 */
export function createSvgEntityData(
  rasterResult: SvgRasterizeResult,
  blob: Blob,
  position: Point = { x: 0, y: 0 },
  filename?: string,
): Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string } {
  const { bitmap, width, height } = rasterResult;
  const asset = mediaAssetRegistry.createSvgAsset(blob, bitmap, width, height);
  return {
    assetId: asset.assetId,
    name: filename,
    mediaSource: { type: "svg", blob, assetId: asset.assetId },
    imageBitmap: asset.imageBitmap,
    position,
    size: { width, height },
    originalSize: { width, height },
    rotation: 0,
    shaderType: config.defaults.shader,
    shaderParams: config.defaults.shaderParams,
    textureDirty: true,
    selected: false,
    locked: false,
    edited: false,
  };
}

/**
 * Create entity data from a VideoLoadResult (for videos)
 */
export function createVideoEntityData(
  videoResult: VideoLoadResult,
  blob: Blob,
  position: Point = { x: 0, y: 0 },
  filename?: string,
): Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string } {
  const { videoElement, initialFrame, width, height, duration, fps, hasAudio } = videoResult;
  const asset = mediaAssetRegistry.createVideoAsset(
    blob,
    initialFrame,
    width,
    height,
    duration,
    fps,
    hasAudio,
  );
  videoElement.pause();
  videoElement.src = "";
  videoElement.load();

  return {
    assetId: asset.assetId,
    name: filename,
    mediaSource: {
      type: "video",
      blob,
      assetId: asset.assetId,
      duration,
      fps,
      hasAudio,
    },
    imageBitmap: asset.posterFrame,
    position,
    size: { width, height },
    originalSize: { width, height },
    rotation: 0,
    shaderType: config.defaults.shader,
    shaderParams: config.defaults.shaderParams,
    textureDirty: true,
    selected: false,
    locked: false,
    edited: false,
    playback: {
      isPlaying: true, // Autoplay when added
      currentTime: 0,
      loop: true,
      playbackRate: 1,
    },
  };
}

/**
 * Load a media file (image or video) and return entity data
 */
export async function loadMediaFile(
  file: File,
  position: Point = { x: 0, y: 0 },
): Promise<(Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string }) | null> {
  if (isVideoFile(file)) {
    try {
      const videoResult = await loadVideo(file);
      return createVideoEntityData(videoResult, file, position, file.name);
    } catch (err) {
      console.error("Failed to load video:", err);
      return null;
    }
  }

  if (isImageFile(file)) {
    // Check for SVG before other image types (image/svg+xml starts with "image/")
    if (isSvgFile(file)) {
      try {
        const text = await file.text();
        const blob = new Blob([text], { type: "image/svg+xml" });
        const rasterResult = await rasterizeSvg(text);
        return createSvgEntityData(rasterResult, blob, position, file.name);
      } catch (err) {
        console.error("Failed to load SVG:", err);
        return null;
      }
    }

    // Check for animated GIF before treating as static image
    if (file.type === "image/gif") {
      try {
        const animated = await isAnimatedGif(file);
        if (animated) {
          const gifResult = await loadGif(file);
          return createGifEntityData(gifResult, file, position, file.name);
        }
      } catch (err) {
        console.error("Failed to load animated GIF:", err);
        // Fall through to static image path
      }
    }

    try {
      const bitmap = await createImageBitmap(file);
      return createImageEntityData(bitmap, file, position, file.name);
    } catch (err) {
      console.error("Failed to load image:", err);
      return null;
    }
  }

  console.warn(`Unsupported file type: ${file.type}`);
  return null;
}

/**
 * Load a media blob with a known MIME type and return entity data.
 * Mirrors loadMediaFile() but works with Blobs (e.g. fetched from a URL).
 */
export async function loadMediaFromBlob(
  blob: Blob,
  mimeType: string,
  position: Point = { x: 0, y: 0 },
  filename?: string,
): Promise<(Omit<ShaderCanvasEntity, "id" | "zIndex" | "name"> & { name?: string }) | null> {
  if (isVideoMimeType(mimeType)) {
    try {
      const videoResult = await loadVideo(blob);
      return createVideoEntityData(videoResult, blob, position, filename);
    } catch (err) {
      console.error("Failed to load video from URL:", err);
      return null;
    }
  }

  if (isImageMimeType(mimeType)) {
    if (mimeType === "image/svg+xml") {
      try {
        const text = await blob.text();
        const svgBlob = new Blob([text], { type: "image/svg+xml" });
        const rasterResult = await rasterizeSvg(text);
        return createSvgEntityData(rasterResult, svgBlob, position, filename);
      } catch (err) {
        console.error("Failed to load SVG from URL:", err);
        return null;
      }
    }

    if (mimeType === "image/gif") {
      try {
        const gifResult = await decodeGif(blob);
        if (gifResult.frames.length > 1) {
          return createGifEntityData(gifResult, blob, position, filename);
        }
      } catch {
        // Fall through to static image
      }
    }

    try {
      const bitmap = await createImageBitmap(blob);
      return createImageEntityData(bitmap, blob, position, filename);
    } catch (err) {
      console.error("Failed to load image from URL:", err);
      return null;
    }
  }

  console.warn(`Unsupported MIME type from URL: ${mimeType}`);
  return null;
}

/**
 * Extract 6-color palette from an image
 */
export async function extractOriginalPalette(
  bitmap: ImageBitmap,
  colorSpace: ColorSpace,
): Promise<ColorPalette> {
  const palette = await extractPaletteFromImage(bitmap, {
    colorCount: 6,
    sampleSize: 100,
    iterations: 10,
    colorSpace,
  });
  return {
    id: "original",
    name: "Original",
    shortName: "Original",
    colors: palette.colors,
  };
}

/**
 * Create a fully independent clone of a media source.
 * Returns a new media source with its own video element, image bitmaps, etc.
 */
export async function cloneMediaSource(
  source: MediaSource,
  currentBitmap: ImageBitmap,
): Promise<{ mediaSource: MediaSource; imageBitmap: ImageBitmap }> {
  switch (source.type) {
    case "image": {
      return {
        mediaSource: source,
        imageBitmap: mediaAssetRegistry.getStaticAssetBitmap(source.assetId),
      };
    }

    case "video": {
      return {
        mediaSource: source,
        imageBitmap: currentBitmap,
      };
    }

    case "gif": {
      return {
        mediaSource: source,
        imageBitmap: currentBitmap,
      };
    }

    case "svg": {
      return {
        mediaSource: source,
        imageBitmap: mediaAssetRegistry.getStaticAssetBitmap(source.assetId),
      };
    }
  }
}
