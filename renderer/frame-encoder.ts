/**
 * Frame Encoder — Shared core for encoding ImageBitmap sequences into video blobs.
 *
 * Encapsulates: Web Worker lifecycle, WebCodecs init, mediabunny muxing,
 * progress async generator, cancel handling, audio passthrough.
 *
 * Used by both the video export pipeline (for seek-based export) and
 * the upscale pipeline (for re-encoding upscaled frames).
 *
 * The worker (`video-export.worker.ts`) is shared and unchanged.
 */

import type { ToWorkerMessage, FromWorkerMessage } from "./video-export.worker.ts";
import { config, calculateVideoBitrate, getH264Codec } from "#config";
import { logger, LogLevel } from "#lib/client.logger.ts";
import { type QualityPreset, qualityConfigs } from "./export-formats.ts";
import type { DemuxedAudio } from "#lib/audio-demux.ts";
import { createProgressChannel } from "./progress-channel.ts";

export interface FrameEncoderOptions {
  width: number;
  height: number;
  fps: number;
  duration: number;
  format: "mp4" | "mov";
  quality?: QualityPreset;
  /** Explicit bitrate in bps. Overrides auto-calculation. */
  bitrate?: number;
  audioData?: DemuxedAudio | null;
}

export interface EncodeProgress {
  frame: number;
  totalFrames: number;
  percent: number;
  stage: "encoding" | "muxing" | "done";
  message?: string;
}

export interface FrameEncoderHandle {
  /** Async iterable for progress updates */
  progress: AsyncIterable<EncodeProgress>;
  /** Promise that resolves to the final video blob */
  result: Promise<Blob>;
  /** Cancel the encoding */
  cancel: () => void;
}

/** Select appropriate H.264 codec string for the resolution/fps */
export async function selectCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<string> {
  const codec = getH264Codec(width, height, fps);
  const codecSupport = await VideoEncoder.isConfigSupported({
    codec,
    width,
    height,
    bitrate,
    framerate: fps,
  });
  if (!codecSupport.supported) {
    throw new Error("H.264 codec not supported");
  }
  return codec;
}

/**
 * Encode a sequence of frames into a video blob.
 *
 * The caller provides a `renderFrame` callback that produces an ImageBitmap
 * for each timestamp. This function handles worker lifecycle, WebCodecs init,
 * frame feeding, audio passthrough, and muxing.
 */
export function encodeFrames(
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>,
  options: FrameEncoderOptions,
): FrameEncoderHandle {
  const { width, height, fps, duration, format } = options;
  const totalFrames = Math.round(duration * fps);

  const qualityFactor = qualityConfigs[options.quality ?? "high"].bitrateFactor;
  const bitrate =
    options.bitrate ?? Math.round(calculateVideoBitrate(width, height) * qualityFactor);

  let cancelled = false;
  let resolveResult: (blob: Blob) => void;
  let rejectResult: (error: Error) => void;

  const resultPromise = new Promise<Blob>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  const progress = createProgressChannel<EncodeProgress>(
    (p) => p.stage === "done",
    () => cancelled,
  );

  // Create worker
  const worker = new Worker(new URL("./video-export.worker.ts", import.meta.url), {
    type: "module",
  });

  worker.onmessage = (event: MessageEvent<FromWorkerMessage>) => {
    const msg = event.data;

    switch (msg.type) {
      case "progress":
        progress.emit({
          frame: msg.frame,
          totalFrames: msg.totalFrames,
          percent: msg.percent,
          stage: msg.stage === "done" ? "done" : msg.stage === "muxing" ? "muxing" : "encoding",
        });
        break;
      case "done":
        progress.emit({ frame: totalFrames, totalFrames, percent: 1, stage: "done" });
        resolveResult!(msg.blob);
        worker.terminate();
        break;
      case "error":
        cancelled = true;
        rejectResult!(new Error(msg.message));
        progress.wake();
        worker.terminate();
        break;
    }
  };

  worker.onerror = (event) => {
    cancelled = true;
    rejectResult!(new Error(event.message || "Worker error"));
    progress.wake();
    worker.terminate();
  };

  // Run the encode pipeline
  runEncode({
    renderFrame,
    totalFrames,
    fps,
    bitrate,
    width,
    height,
    format,
    worker,
    isCancelled: () => cancelled,
    audioData: options.audioData ?? null,
  }).catch((err) => {
    cancelled = true;
    rejectResult!(err);
    progress.wake();
    worker.terminate();
  });

  return {
    progress: progress.generator(),
    result: resultPromise,
    cancel: () => {
      cancelled = true;
      worker.terminate();
      progress.wake();
      rejectResult(new Error("Encoding cancelled"));
    },
  };
}

interface RunEncodeParams {
  renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>;
  totalFrames: number;
  fps: number;
  bitrate: number;
  width: number;
  height: number;
  format: "mp4" | "mov";
  worker: Worker;
  isCancelled: () => boolean;
  audioData: DemuxedAudio | null;
}

async function runEncode(params: RunEncodeParams): Promise<void> {
  const {
    renderFrame,
    totalFrames,
    fps,
    bitrate,
    width,
    height,
    format,
    worker,
    isCancelled,
    audioData,
  } = params;
  if (typeof VideoEncoder === "undefined") {
    throw new Error("WebCodecs API not supported in this browser");
  }

  const { videoExporting } = config;
  const codec = await selectCodec(width, height, fps, bitrate);

  // Initialize worker
  const initMsg: ToWorkerMessage = {
    type: "init",
    width,
    height,
    fps,
    bitrate,
    totalFrames,
    format,
    codec,
    keyFrameIntervalSeconds: videoExporting.keyFrameIntervalSeconds,
    hardwareAcceleration: videoExporting.hardwareAcceleration,
    latencyMode: videoExporting.latencyMode,
    bitrateMode: videoExporting.bitrateMode,
    debug: logger.level <= LogLevel.DEBUG,
  };
  worker.postMessage(initMsg);

  // Send audio data
  if (audioData) {
    const audioMsg: ToWorkerMessage = {
      type: "audio-track",
      packets: audioData.packets,
      codec: audioData.codec,
      packetCodec: audioData.packetCodec,
      sampleRate: audioData.sampleRate,
      numberOfChannels: audioData.numberOfChannels,
      description: audioData.description,
    };
    worker.postMessage(audioMsg);
  }

  logger.debug(
    `[frame-encoder] Starting ${format} encode: ${totalFrames} frames at ${fps}fps, ${width}x${height}, codec=${codec}`,
  );
  const startTime = performance.now();

  // Feed frames sequentially
  for (let i = 0; i < totalFrames; i++) {
    if (isCancelled()) throw new Error("Encoding cancelled");

    const timestampSeconds = i / fps;
    const timestampUs = Math.floor(timestampSeconds * 1_000_000);

    const bitmap = await renderFrame(timestampSeconds);

    const frameMsg: ToWorkerMessage = {
      type: "frame",
      bitmap,
      frameIndex: i,
      timestampUs,
    };
    worker.postMessage(frameMsg, [bitmap]);

    if (i % 10 === 0) {
      logger.debug(`[frame-encoder] frame ${i}/${totalFrames}`);
    }

    // Yield to main thread periodically
    if (i % 5 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  logger.debug(
    `[frame-encoder] All frames encoded in ${((performance.now() - startTime) / 1000).toFixed(1)}s`,
  );

  const finishMsg: ToWorkerMessage = { type: "finish" };
  worker.postMessage(finishMsg);
}
