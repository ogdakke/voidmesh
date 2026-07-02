import type { ShaderCanvasEntity, Point, ColorPalette, MediaSource } from "#types/canvas.ts";
import type { ColorSpace } from "#types/enums.ts";
import { analytics } from "./analytics.ts";
import { logger } from "./client.logger.ts";
import { config } from "./config/index.ts";
import { extractPaletteFromImage } from "./palette-extraction/index.ts";
import { decodeGif, isAnimatedGif, type GifDecodeResult } from "./gif-decoder.ts";
import { createPlaybackState } from "./media-playback.ts";

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

interface VideoLoadFailureDetails {
  errorCode: number | null;
  errorType: string;
  errorMessage: string;
  mimeType: string;
  canPlayMimeType: string;
  canPlayVideoCodec: string;
  sizeBytes: number;
  videoCodec: string | null;
  webCodecsVideoDecoderSupported: boolean | null;
  webCodecsVideoDecoderSupportError: string | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  demuxError: string | null;
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

async function probeVideoMetadata(blob: Blob): Promise<{ fps: number | null; hasAudio: boolean }> {
  const startedAt = performance.now();
  const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });

  try {
    const tracksStartedAt = performance.now();
    const [videoTrack, audioTrack] = await Promise.all([
      input.getPrimaryVideoTrack(),
      input.getPrimaryAudioTrack(),
    ]);
    logger.info("[media-loader] Mediabunny track probe complete", {
      durationMs: Math.round(performance.now() - tracksStartedAt),
      hasVideo: videoTrack !== null,
      hasAudio: audioTrack !== null,
    });
    if (!videoTrack) return { fps: null, hasAudio: audioTrack !== null };

    let fps: number | null = null;
    try {
      const statsStartedAt = performance.now();
      const stats = await videoTrack.computePacketStats(100);
      const statsDurationMs = Math.round(performance.now() - statsStartedAt);
      const rawFps = stats.averagePacketRate;
      if (rawFps >= 1 && rawFps <= 240) {
        fps = roundToCommonFrameRate(rawFps);
      }
      logger.info("[media-loader] Mediabunny video packet stats complete", {
        durationMs: statsDurationMs,
        packetCount: stats.packetCount,
        rawFps,
        fps,
        averageBitrate: Math.round(stats.averageBitrate),
      });
    } catch (error) {
      logger.debug("[media-loader] Failed to compute video packet stats", error);
    }

    return { fps, hasAudio: audioTrack !== null };
  } finally {
    logger.info("[media-loader] Mediabunny video metadata probe complete", {
      durationMs: Math.round(performance.now() - startedAt),
      sizeBytes: blob.size,
      mimeType: blob.type || "unknown",
    });
    input.dispose();
  }
}

/**
 * Load a video blob and extract metadata + initial frame
 */
export async function loadVideo(blob: Blob): Promise<VideoLoadResult> {
  const loadStartedAt = performance.now();
  const video = document.createElement("video");
  video.muted = true;
  video.defaultMuted = true;
  video.loop = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(blob);

  // Wait for metadata to load
  try {
    const metadataStartedAt = performance.now();
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => {
        void createVideoLoadError(video, blob).then(reject);
      };
    });
    logger.info("[media-loader] HTML video metadata loaded", {
      durationMs: Math.round(performance.now() - metadataStartedAt),
      mediaDurationSeconds: video.duration,
      width: video.videoWidth,
      height: video.videoHeight,
      sizeBytes: blob.size,
      mimeType: blob.type || "unknown",
    });
  } catch (error) {
    cleanupVideoElement(video);
    trackUnsupportedVideoLoad(blob, error);
    throw error;
  }

  const width = video.videoWidth;
  const height = video.videoHeight;

  // Seek to first frame and wait for it
  const seekStartedAt = performance.now();
  video.currentTime = 0;
  await new Promise<void>((resolve) => {
    video.onseeked = () => resolve();
  });
  logger.info("[media-loader] HTML video initial seek complete", {
    durationMs: Math.round(performance.now() - seekStartedAt),
  });

  // Create initial frame snapshot
  const captureStartedAt = performance.now();
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(video, 0, 0);
  const initialFrame = await createImageBitmap(canvas);
  logger.info("[media-loader] Initial video frame captured", {
    durationMs: Math.round(performance.now() - captureStartedAt),
    width,
    height,
  });

  // Start playing for autoplay
  const playStartedAt = performance.now();
  await video.play().catch((e) => {
    logger.error("Failed to autoplay video", e);
  });
  logger.info("[media-loader] HTML video autoplay request complete", {
    durationMs: Math.round(performance.now() - playStartedAt),
    paused: video.paused,
  });

  const { fps, hasAudio } = await probeVideoMetadata(blob);
  logger.info("[media-loader] Video load complete", {
    durationMs: Math.round(performance.now() - loadStartedAt),
    fps,
    hasAudio,
    width,
    height,
    mediaDurationSeconds: video.duration,
  });

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

async function createVideoLoadError(video: HTMLVideoElement, blob: Blob): Promise<Error> {
  const details = await getVideoLoadFailureDetails(video, blob);
  logger.error("[media-loader] Failed to load video", details);

  const error = new Error(
    `Failed to load video (${details.errorType}; type=${details.mimeType}; canPlay=${details.canPlayMimeType}; size=${details.sizeBytes}; videoCodec=${details.videoCodec ?? "unknown"}; audioCodec=${details.audioCodec ?? "unknown"})`,
  );
  return Object.assign(error, { details });
}

function getVideoLoadErrorDetails(error: unknown): VideoLoadFailureDetails | null {
  if (!(error instanceof Error) || !("details" in error)) return null;
  const details = (error as Error & { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  return details as VideoLoadFailureDetails;
}

function trackUnsupportedVideoLoad(blob: Blob, error: unknown): void {
  const details = getVideoLoadErrorDetails(error);
  if (!details) return;

  analytics.track("media.video_unsupported", {
    mimeType: details.mimeType,
    sizeBytes: blob.size,
    errorType: details.errorType,
    errorCode: details.errorCode,
    canPlayMimeType: details.canPlayMimeType,
    canPlayVideoCodec: details.canPlayVideoCodec,
    videoCodec: details.videoCodec,
    audioCodec: details.audioCodec,
    audioSampleRate: details.audioSampleRate,
    audioChannels: details.audioChannels,
    demuxError: details.demuxError,
    webCodecsVideoDecoderSupported: details.webCodecsVideoDecoderSupported,
    webCodecsVideoDecoderSupportError: details.webCodecsVideoDecoderSupportError,
  });
}

async function getVideoLoadFailureDetails(
  video: HTMLVideoElement,
  blob: Blob,
): Promise<VideoLoadFailureDetails> {
  const mediaError = video.error;
  const code = mediaError?.code;
  const codeLabel =
    code === 1
      ? "aborted"
      : code === 2
        ? "network"
        : code === 3
          ? "decode"
          : code === 4
            ? "source-not-supported"
            : "unknown";
  const demux = await probeVideoLoadFailureCodecs(blob);
  const support = blob.type ? video.canPlayType(blob.type) || "no" : "unknown";
  const videoCodecSupport =
    blob.type && demux.videoCodec
      ? video.canPlayType(`${blob.type}; codecs="${demux.videoCodec}"`) || "no"
      : "unknown";
  const videoDecoderSupport = await checkVideoDecoderSupport(demux.videoDecoderConfig);

  return {
    errorCode: code ?? null,
    errorType: codeLabel,
    errorMessage: mediaError?.message ?? "",
    mimeType: blob.type || "unknown",
    canPlayMimeType: support,
    canPlayVideoCodec: videoCodecSupport,
    sizeBytes: blob.size,
    videoCodec: demux.videoCodec,
    webCodecsVideoDecoderSupported: videoDecoderSupport.supported,
    webCodecsVideoDecoderSupportError: videoDecoderSupport.error,
    audioCodec: demux.audioCodec,
    audioSampleRate: demux.audioSampleRate,
    audioChannels: demux.audioChannels,
    demuxError: demux.error,
  };
}

async function probeVideoLoadFailureCodecs(blob: Blob): Promise<{
  videoCodec: string | null;
  videoDecoderConfig: VideoDecoderConfig | null;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
  error: string | null;
}> {
  try {
    const { ALL_FORMATS, BlobSource, Input } = await import("mediabunny");
    const input = new Input({
      source: new BlobSource(blob),
      formats: ALL_FORMATS,
    });

    try {
      const [videoTrack, audioTrack] = await Promise.all([
        input.getPrimaryVideoTrack(),
        input.getPrimaryAudioTrack(),
      ]);
      const [videoConfig, audioConfig, audioSampleRate, audioChannels] = await Promise.all([
        videoTrack?.getDecoderConfig() ?? Promise.resolve(null),
        audioTrack?.getDecoderConfig() ?? Promise.resolve(null),
        audioTrack?.getSampleRate() ?? Promise.resolve(null),
        audioTrack?.getNumberOfChannels() ?? Promise.resolve(null),
      ]);

      return {
        videoCodec: videoConfig?.codec ?? null,
        videoDecoderConfig: videoConfig,
        audioCodec: audioConfig?.codec ?? null,
        audioSampleRate,
        audioChannels,
        error: null,
      };
    } finally {
      input.dispose();
    }
  } catch (error) {
    return {
      videoCodec: null,
      videoDecoderConfig: null,
      audioCodec: null,
      audioSampleRate: null,
      audioChannels: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkVideoDecoderSupport(
  decoderConfig: VideoDecoderConfig | null,
): Promise<{ supported: boolean | null; error: string | null }> {
  if (!decoderConfig) return { supported: null, error: null };
  if (typeof VideoDecoder === "undefined") {
    return { supported: false, error: "VideoDecoder is unavailable" };
  }

  try {
    const support = await VideoDecoder.isConfigSupported(decoderConfig);
    return { supported: support.supported === true, error: null };
  } catch (error) {
    return {
      supported: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function cleanupVideoElement(video: HTMLVideoElement): void {
  const { src } = video;
  video.pause();
  video.removeAttribute("src");
  video.load();
  if (src.startsWith("blob:")) {
    URL.revokeObjectURL(src);
  }
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
  return {
    name: filename,
    mediaSource: { type: "image", imageBitmap: bitmap, blob },
    imageBitmap: bitmap,
    position,
    size: { width: bitmap.width, height: bitmap.height },
    originalSize: { width: bitmap.width, height: bitmap.height },
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

  return {
    name: filename,
    mediaSource: {
      type: "gif",
      frames,
      duration,
      fps,
      blob,
    },
    imageBitmap: frames[0]!.bitmap,
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
    playback: createPlaybackState({ isPlaying: true }), // Autoplay when added
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
  return {
    name: filename,
    mediaSource: { type: "svg", blob },
    imageBitmap: bitmap,
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

  return {
    name: filename,
    mediaSource: {
      type: "video",
      videoElement,
      blob,
      duration,
      fps,
      hasAudio,
    },
    imageBitmap: initialFrame,
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
    playback: createPlaybackState({ isPlaying: true }), // Autoplay when added
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
    const videoResult = await loadVideo(file);
    return createVideoEntityData(videoResult, file, position, file.name);
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
    const videoResult = await loadVideo(blob);
    return createVideoEntityData(videoResult, blob, position, filename);
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
      const bitmap = await createImageBitmap(source.blob);
      return {
        mediaSource: { type: "image", imageBitmap: bitmap, blob: source.blob },
        imageBitmap: bitmap,
      };
    }

    case "video": {
      const videoResult = await loadVideo(source.blob);
      return {
        mediaSource: {
          type: "video",
          videoElement: videoResult.videoElement,
          blob: source.blob,
          duration: source.duration,
          fps: source.fps,
          hasAudio: videoResult.hasAudio,
        },
        imageBitmap: videoResult.initialFrame,
      };
    }

    case "gif": {
      const gifResult = await decodeGif(source.blob);
      return {
        mediaSource: {
          type: "gif",
          frames: gifResult.frames,
          duration: source.duration,
          fps: source.fps,
          blob: source.blob,
        },
        imageBitmap: gifResult.frames[0]?.bitmap ?? currentBitmap,
      };
    }

    case "svg": {
      const text = await source.blob.text();
      const rasterResult = await rasterizeSvg(text);
      return {
        mediaSource: { type: "svg", blob: source.blob },
        imageBitmap: rasterResult.bitmap,
      };
    }
  }
}
