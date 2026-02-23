/**
 * FFmpeg Service - Lazy-loaded ffmpeg.wasm for audio extraction and video muxing
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import coreUrl from "@ffmpeg/core?url";
import wasmUrl from "@ffmpeg/core/wasm?url";
// oxlint-disable-next-line
import workerUrl from "@ffmpeg/ffmpeg/worker?url";
import { logger } from "./client.logger.ts";
import {
  type ExportFormat,
  type QualityPreset,
  type GifDitherMode,
  formatConfigs,
  buildVideoEncodeArgs,
  buildGifPaletteArgs,
  buildGifEncodeArgs,
  defaultGifConfig,
} from "#renderer/export-formats.ts";

/** FFmpeg loading state */
export type FFmpegState = "idle" | "loading" | "ready" | "error";

/** Progress callback for FFmpeg operations */
export type FFmpegProgressCallback = (progress: {
  stage: "loading" | "extracting-audio" | "muxing";
  percent: number;
  message?: string;
}) => void;

// Singleton state
let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<FFmpeg> | null = null;
let state: FFmpegState = "idle";

/**
 * Convert FFmpeg FileData (string | Uint8Array) to Blob
 */
function fileDataToBlob(data: Uint8Array | string, mimeType: string): Blob {
  if (typeof data === "string") {
    return new Blob([data], { type: mimeType });
  }
  const buffer = new ArrayBuffer(data.byteLength);
  new Uint8Array(buffer).set(data);
  return new Blob([buffer], { type: mimeType });
}

/**
 * Get current FFmpeg state
 */
export function getFFmpegState(): FFmpegState {
  return state;
}

/**
 * Get or initialize the FFmpeg instance (lazy singleton)
 */
export async function getFFmpeg(onProgress?: FFmpegProgressCallback): Promise<FFmpeg> {
  logger.info("[ffmpeg-service] getFFmpeg called, state:", state, "loaded:", ffmpeg?.loaded);

  if (ffmpeg?.loaded) {
    return ffmpeg;
  }

  if (loadPromise) {
    logger.info("[ffmpeg-service] Returning existing load promise");
    return loadPromise;
  }

  state = "loading";
  onProgress?.({ stage: "loading", percent: 0, message: "Downloading FFmpeg..." });

  loadPromise = (async () => {
    try {
      logger.info("[ffmpeg-service] Creating FFmpeg instance");
      ffmpeg = new FFmpeg();

      ffmpeg.on("log", ({ message }) => {
        logger.debug(`[ffmpeg] ${message}`);
      });

      // Convert to blob URLs for proper cross-origin isolation
      const [coreURL, wasmURL, workerURL] = await Promise.all([
        toBlobURL(coreUrl, "text/javascript"),
        toBlobURL(wasmUrl, "application/wasm"),
        toBlobURL(workerUrl, "text/javascript"),
      ]);

      onProgress?.({ stage: "loading", percent: 50, message: "Initializing FFmpeg..." });

      await ffmpeg.load({ coreURL, wasmURL, workerURL });

      state = "ready";
      onProgress?.({ stage: "loading", percent: 100, message: "FFmpeg ready" });
      logger.info("[ffmpeg-service] FFmpeg loaded successfully");

      return ffmpeg;
    } catch (error) {
      state = "error";
      loadPromise = null;
      ffmpeg = null;
      logger.error("[ffmpeg-service] Failed to load FFmpeg:", error);
      throw error;
    }
  })();

  return loadPromise;
}

/**
 * Extract audio track from a video blob
 */
export async function extractAudio(
  videoBlob: Blob,
  onProgress?: FFmpegProgressCallback,
): Promise<Blob | null> {
  logger.info("[ffmpeg-service] extractAudio called, blob size:", videoBlob.size);

  const ff = await getFFmpeg(onProgress);
  logger.info("[ffmpeg-service] FFmpeg ready, writing input file...");

  onProgress?.({ stage: "extracting-audio", percent: 0, message: "Preparing video..." });

  const inputData = await fetchFile(videoBlob);
  logger.info("[ffmpeg-service] Input data size:", inputData.length);

  await ff.writeFile("input.mp4", inputData);
  logger.info("[ffmpeg-service] File written, starting extraction...");

  onProgress?.({ stage: "extracting-audio", percent: 20, message: "Extracting audio..." });

  // Progress listener
  const progressHandler = ({ progress }: { progress: number }) => {
    const percent = 20 + progress * 60;
    onProgress?.({ stage: "extracting-audio", percent, message: "Extracting audio..." });
  };
  ff.on("progress", progressHandler);

  try {
    logger.info("[ffmpeg-service] Running ffmpeg exec...");
    const exitCode = await ff.exec(["-i", "input.mp4", "-vn", "-c:a", "copy", "audio.aac"]);
    logger.info("[ffmpeg-service] ffmpeg exec done, exit code:", exitCode);

    ff.off("progress", progressHandler);

    if (exitCode !== 0) {
      logger.warn("[ffmpeg-service] No audio track found");
      await ff.deleteFile("input.mp4").catch(() => {});
      onProgress?.({ stage: "extracting-audio", percent: 100, message: "No audio found" });
      return null;
    }

    onProgress?.({ stage: "extracting-audio", percent: 90, message: "Reading audio..." });

    const audioData = await ff.readFile("audio.aac");
    await ff.deleteFile("input.mp4").catch(() => {});
    await ff.deleteFile("audio.aac").catch(() => {});

    onProgress?.({ stage: "extracting-audio", percent: 100, message: "Audio extracted" });
    logger.info("[ffmpeg-service] Audio extraction complete");

    return fileDataToBlob(audioData, "audio/aac");
  } catch (error) {
    ff.off("progress", progressHandler);
    logger.error("[ffmpeg-service] Audio extraction failed:", error);
    await ff.deleteFile("input.mp4").catch(() => {});
    await ff.deleteFile("audio.aac").catch(() => {});
    return null;
  }
}

/**
 * Mux video and audio into MP4
 */
export async function muxVideoAudio(
  videoBlob: Blob,
  audioBlob: Blob | null,
  onProgress?: FFmpegProgressCallback,
): Promise<Blob> {
  if (!audioBlob) {
    logger.info("[ffmpeg-service] No audio, returning video as-is");
    return videoBlob;
  }

  logger.info("[ffmpeg-service] Muxing video and audio");
  const ff = await getFFmpeg(onProgress);

  onProgress?.({ stage: "muxing", percent: 0, message: "Preparing files..." });

  const [videoData, audioData] = await Promise.all([fetchFile(videoBlob), fetchFile(audioBlob)]);
  await ff.writeFile("video.mp4", videoData);
  await ff.writeFile("audio.aac", audioData);

  onProgress?.({ stage: "muxing", percent: 20, message: "Muxing..." });

  const progressHandler = ({ progress }: { progress: number }) => {
    const percent = 20 + progress * 60;
    onProgress?.({ stage: "muxing", percent, message: "Muxing..." });
  };
  ff.on("progress", progressHandler);

  try {
    const exitCode = await ff.exec([
      "-i",
      "video.mp4",
      "-i",
      "audio.aac",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      "output.mp4",
    ]);

    ff.off("progress", progressHandler);

    if (exitCode !== 0) {
      throw new Error(`Muxing failed with exit code ${exitCode}`);
    }

    onProgress?.({ stage: "muxing", percent: 90, message: "Finalizing..." });

    const outputData = await ff.readFile("output.mp4");
    await Promise.all([
      ff.deleteFile("video.mp4").catch(() => {}),
      ff.deleteFile("audio.aac").catch(() => {}),
      ff.deleteFile("output.mp4").catch(() => {}),
    ]);

    onProgress?.({ stage: "muxing", percent: 100, message: "Complete" });
    logger.info("[ffmpeg-service] Muxing complete");

    return fileDataToBlob(outputData, "video/mp4");
  } catch (error) {
    ff.off("progress", progressHandler);
    await ff.deleteFile("video.mp4").catch(() => {});
    await ff.deleteFile("audio.aac").catch(() => {});
    await ff.deleteFile("output.mp4").catch(() => {});
    throw error;
  }
}

/**
 * Full pipeline: Extract audio from original and mux with processed video
 */
export async function addAudioToProcessedVideo(
  originalVideoBlob: Blob,
  processedVideoBlob: Blob,
  onProgress?: FFmpegProgressCallback,
): Promise<Blob> {
  const audioBlob = await extractAudio(originalVideoBlob, onProgress);
  return muxVideoAudio(processedVideoBlob, audioBlob, onProgress);
}

/**
 * Preload FFmpeg in background
 */
export function preloadFFmpeg(): void {
  if (state === "idle") {
    getFFmpeg().catch((error) => {
      logger.warn("[ffmpeg-service] Preload failed:", error);
    });
  }
}

/**
 * Terminate FFmpeg instance and reset state.
 * Use this to forcefully stop all ongoing FFmpeg operations.
 * The instance will be lazily recreated on next use.
 */
export function terminateFFmpeg(): void {
  if (ffmpeg) {
    try {
      ffmpeg.terminate();
      logger.info("[ffmpeg-service] FFmpeg terminated");
    } catch {
      // Ignore termination errors
    }
  }
  ffmpeg = null;
  loadPromise = null;
  state = "idle";
}

/**
 * Check if FFmpeg is ready
 */
export function isFFmpegReady(): boolean {
  return state === "ready" && ffmpeg?.loaded === true;
}

// ============================================================================
// Video Encoding Functions (for multi-format export)
// ============================================================================

/** Progress callback for encoding operations */
export type EncodeProgressCallback = (progress: {
  stage: "writing-frames" | "encoding" | "encoding-gif-palette" | "encoding-gif" | "cleanup";
  percent: number;
  message?: string;
}) => void;

/**
 * Write PNG frames to the ffmpeg virtual filesystem
 */
export async function writeFramesToFS(
  frames: Blob[],
  onProgress?: EncodeProgressCallback,
): Promise<string> {
  const ff = await getFFmpeg();
  const framePattern = "frame_%05d.png";

  onProgress?.({ stage: "writing-frames", percent: 0, message: "Preparing frames..." });

  for (let i = 0; i < frames.length; i++) {
    const frameData = await fetchFile(frames[i]);
    const filename = `frame_${String(i).padStart(5, "0")}.png`;
    await ff.writeFile(filename, frameData);

    if (i % 10 === 0 || i === frames.length - 1) {
      const percent = ((i + 1) / frames.length) * 100;
      onProgress?.({
        stage: "writing-frames",
        percent,
        message: `Writing frame ${i + 1}/${frames.length}`,
      });
    }
  }

  logger.info(`[ffmpeg-service] Wrote ${frames.length} frames to filesystem`);
  return framePattern;
}

/**
 * Clean up frame files from the ffmpeg filesystem
 */
export async function cleanupFrames(frameCount: number): Promise<void> {
  const ff = await getFFmpeg();

  const deletePromises: Promise<void>[] = [];
  for (let i = 0; i < frameCount; i++) {
    const filename = `frame_${String(i).padStart(5, "0")}.png`;
    deletePromises.push(
      ff.deleteFile(filename).then(
        () => {},
        () => {},
      ),
    );
  }

  // Also clean up palette file if it exists
  deletePromises.push(
    ff.deleteFile("palette.png").then(
      () => {},
      () => {},
    ),
  );

  await Promise.all(deletePromises);
  logger.info(`[ffmpeg-service] Cleaned up ${frameCount} frame files`);
}

export interface EncodeVideoOptions {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  quality: QualityPreset;
  crf?: number;
  bitrate?: number;
  audioBlob?: Blob | null;
  framePattern: string;
  twoPass?: boolean;
}

/**
 * Encode video from frames in the ffmpeg filesystem
 */
export async function encodeVideo(
  options: EncodeVideoOptions,
  onProgress?: EncodeProgressCallback,
): Promise<Blob> {
  const ff = await getFFmpeg();
  const config = formatConfigs[options.format];
  const outputFile = `output.${config.extension}`;

  // Write audio if provided
  let audioInputFile: string | undefined;
  if (options.audioBlob && config.supportsAudio) {
    const audioData = await fetchFile(options.audioBlob);
    audioInputFile = "audio_input.aac";
    await ff.writeFile(audioInputFile, audioData);
  }

  onProgress?.({ stage: "encoding", percent: 0, message: "Starting encode..." });

  // Set up progress listener
  const progressHandler = ({ progress }: { progress: number }) => {
    const percent = progress * 100;
    onProgress?.({ stage: "encoding", percent, message: `Encoding... ${Math.round(percent)}%` });
  };
  ff.on("progress", progressHandler);

  try {
    const args = buildVideoEncodeArgs({
      format: options.format,
      width: options.width,
      height: options.height,
      fps: options.fps,
      quality: options.quality,
      crf: options.crf,
      bitrate: options.bitrate,
      inputPattern: options.framePattern,
      outputFile,
      audioInputFile,
      twoPass: options.twoPass,
    });

    logger.info(`[ffmpeg-service] Running ffmpeg with args:`, args.join(" "));
    const exitCode = await ff.exec(args);

    ff.off("progress", progressHandler);

    if (exitCode !== 0) {
      throw new Error(`FFmpeg encoding failed with exit code ${exitCode}`);
    }

    onProgress?.({ stage: "encoding", percent: 100, message: "Reading output..." });

    const outputData = await ff.readFile(outputFile);

    // Cleanup
    await ff.deleteFile(outputFile).catch(() => {});
    if (audioInputFile) {
      await ff.deleteFile(audioInputFile).catch(() => {});
    }

    logger.info(`[ffmpeg-service] Video encoding complete`);
    return fileDataToBlob(outputData, config.mimeType);
  } catch (error) {
    ff.off("progress", progressHandler);
    await ff.deleteFile(outputFile).catch(() => {});
    if (audioInputFile) {
      await ff.deleteFile(audioInputFile).catch(() => {});
    }
    throw error;
  }
}

export interface EncodeGifOptions {
  width: number;
  height: number;
  fps: number;
  framePattern: string;
  maxWidth?: number;
  dither?: GifDitherMode;
}

/**
 * Encode GIF using two-pass palette generation for optimal quality
 */
export async function encodeGif(
  options: EncodeGifOptions,
  onProgress?: EncodeProgressCallback,
): Promise<Blob> {
  const ff = await getFFmpeg();
  const outputFile = "output.gif";

  // Clamp FPS for GIF
  const gifFps = Math.min(options.fps, defaultGifConfig.maxFps);

  onProgress?.({ stage: "encoding-gif-palette", percent: 0, message: "Generating palette..." });

  // Set up progress listener for palette generation
  let progressHandler = ({ progress }: { progress: number }) => {
    const percent = progress * 50; // First pass is 0-50%
    onProgress?.({
      stage: "encoding-gif-palette",
      percent,
      message: `Generating palette... ${Math.round(percent)}%`,
    });
  };
  ff.on("progress", progressHandler);

  try {
    // Pass 1: Generate palette
    const paletteArgs = buildGifPaletteArgs({
      width: options.width,
      height: options.height,
      fps: gifFps,
      inputPattern: options.framePattern,
      outputFile,
      maxWidth: options.maxWidth,
      dither: options.dither,
    });

    logger.info(`[ffmpeg-service] GIF Pass 1 (palette):`, paletteArgs.join(" "));
    let exitCode = await ff.exec(paletteArgs);

    ff.off("progress", progressHandler);

    if (exitCode !== 0) {
      throw new Error(`GIF palette generation failed with exit code ${exitCode}`);
    }

    onProgress?.({ stage: "encoding-gif", percent: 50, message: "Encoding GIF..." });

    // Pass 2: Encode with palette
    progressHandler = ({ progress }: { progress: number }) => {
      const percent = 50 + progress * 50; // Second pass is 50-100%
      onProgress?.({
        stage: "encoding-gif",
        percent,
        message: `Encoding GIF... ${Math.round(percent)}%`,
      });
    };
    ff.on("progress", progressHandler);

    const encodeArgs = buildGifEncodeArgs({
      width: options.width,
      height: options.height,
      fps: gifFps,
      inputPattern: options.framePattern,
      outputFile,
      maxWidth: options.maxWidth,
      dither: options.dither,
    });

    logger.info(`[ffmpeg-service] GIF Pass 2 (encode):`, encodeArgs.join(" "));
    exitCode = await ff.exec(encodeArgs);

    ff.off("progress", progressHandler);

    if (exitCode !== 0) {
      throw new Error(`GIF encoding failed with exit code ${exitCode}`);
    }

    onProgress?.({ stage: "encoding-gif", percent: 100, message: "Reading output..." });

    const outputData = await ff.readFile(outputFile);

    // Cleanup
    await Promise.all([
      ff.deleteFile(outputFile).catch(() => {}),
      ff.deleteFile("palette.png").catch(() => {}),
    ]);

    logger.info(`[ffmpeg-service] GIF encoding complete`);
    return fileDataToBlob(outputData, "image/gif");
  } catch (error) {
    ff.off("progress", progressHandler);
    await ff.deleteFile(outputFile).catch(() => {});
    await ff.deleteFile("palette.png").catch(() => {});
    throw error;
  }
}
