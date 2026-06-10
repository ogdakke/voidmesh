import { config, getH264Codec } from "#config";
import { demuxAudio, type DemuxedAudio } from "#lib/audio-demux.ts";
import { decodeGif, getFrameAtTime, type GifDecodeResult } from "#lib/gif-decoder.ts";
import { floydSteinbergDither } from "#lib/floyd-steinberg.ts";
import { createFrameIterator, demuxVideo, type VideoDemuxHandle } from "#lib/video-demux.ts";
import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  MovOutputFormat,
  Mp4OutputFormat,
  Output,
  type IsobmffOutputFormatOptions,
} from "mediabunny";
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { HeadlessExportRenderer } from "./headless-export-renderer.ts";
import type { ExportJobSnapshot } from "./export-snapshot.ts";
import { defaultGifConfig } from "./export-formats.ts";
import type { ExportProgress } from "./video-exporter.ts";
import {
  getGifExportDimensions,
  getGifFrameDelayCentiseconds,
  getVideoExportBitrate,
  getVideoExportDimensions,
} from "./export-worker-utils.ts";

export type ToExportWorkerMessage =
  | { type: "start"; job: ExportJobSnapshot }
  | { type: "cancel" };

export type FromExportWorkerMessage =
  | { type: "progress"; progress: ExportProgress }
  | { type: "done"; blob: Blob }
  | { type: "error"; message: string; unsupported?: boolean };

let cancelled = false;

function post(msg: FromExportWorkerMessage): void {
  self.postMessage(msg);
}

function assertWorkerSupport(): void {
  if (!navigator.gpu) throw new Error("UNSUPPORTED_WORKER_EXPORT: Worker WebGPU is unavailable");
  if (typeof OffscreenCanvas === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: OffscreenCanvas is unavailable");
  }
  if (typeof VideoFrame === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoFrame is unavailable");
  }
}

function emitProgress(progress: ExportProgress): void {
  post({ type: "progress", progress });
}

function isCancelled(): boolean {
  return cancelled;
}

function createUnsupportedWorkerExportError(message: string): Error {
  return new Error(`UNSUPPORTED_WORKER_EXPORT: ${message}`);
}

async function selectCodec(
  width: number,
  height: number,
  fps: number,
  bitrate: number,
): Promise<string> {
  const codec = getH264Codec(width, height, fps);
  const support = await VideoEncoder.isConfigSupported({
    codec,
    width,
    height,
    bitrate,
    framerate: fps,
  });
  if (!support.supported) throw createUnsupportedWorkerExportError("H.264 codec not supported");
  return codec;
}

async function exportMp4Mov(job: ExportJobSnapshot): Promise<Blob> {
  if (typeof VideoDecoder === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoDecoder is unavailable");
  }
  if (typeof VideoEncoder === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoEncoder is unavailable");
  }
  if (job.entity.mediaSource.type !== "video") {
    throw new Error("MP4/MOV export requires a video source");
  }

  const source = job.entity.mediaSource;
  const demux = await demuxVideo(source.blob);
  try {
    const fps = job.options.fps ?? config.videoExporting.defaults.fps;
    const totalFrames = Math.round(demux.duration * fps);
    const dimensions = getVideoExportDimensions(demux.width, demux.height, job.options);
    const bitrate = getVideoExportBitrate(dimensions.width, dimensions.height, job.options);
    const codec = await selectCodec(dimensions.width, dimensions.height, fps, bitrate);
    const renderer = await HeadlessExportRenderer.create(dimensions.width, dimensions.height);
    try {
      if (job.colorConfig?.supportsP3 && !renderer.colorConfig.supportsP3) {
        throw createUnsupportedWorkerExportError(
          "Worker WebGPU display-p3 canvas is unavailable",
        );
      }
      const audioData =
        job.options.includeAudio && source.hasAudio ? await demuxAudio(source.blob) : null;
      return await encodeRenderedVideo({
        job,
        demux,
        renderer,
        width: dimensions.width,
        height: dimensions.height,
        fps,
        totalFrames,
        bitrate,
        codec,
        audioData,
      });
    } finally {
      renderer.destroy();
    }
  } finally {
    demux.dispose();
  }
}

async function encodeRenderedVideo(params: {
  job: ExportJobSnapshot;
  demux: VideoDemuxHandle;
  renderer: HeadlessExportRenderer;
  width: number;
  height: number;
  fps: number;
  totalFrames: number;
  bitrate: number;
  codec: string;
  audioData: DemuxedAudio | null;
}): Promise<Blob> {
  const { job, demux, renderer, width, height, fps, totalFrames, bitrate, codec, audioData } =
    params;
  const format = (job.options.format ?? "mp4") as "mp4" | "mov";
  const keyFrameInterval = Math.floor(fps * config.videoExporting.keyFrameIntervalSeconds);
  const frameDurationUs = Math.round(1_000_000 / fps);
  let encodeError: Error | null = null;
  const chunks: Array<{
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number;
    meta?: EncodedVideoChunkMetadata;
  }> = [];
  let resolveEncoderError: (error: Error) => void = () => {};
  const encoderErrorSignal = new Promise<Error>((resolve) => {
    resolveEncoderError = resolve;
  });

  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({
        data,
        type: chunk.type === "key" ? "key" : "delta",
        timestamp: chunk.timestamp / 1_000_000,
        duration: (chunk.duration ?? frameDurationUs) / 1_000_000,
        meta: metadata,
      });
    },
    error: (error) => {
      encodeError = error;
      resolveEncoderError(error);
    },
  });

  encoder.configure({
    codec,
    width,
    height,
    bitrate,
    bitrateMode: config.videoExporting.bitrateMode,
    framerate: fps,
    hardwareAcceleration: config.videoExporting.hardwareAcceleration,
    latencyMode: config.videoExporting.latencyMode,
    avc: codec.startsWith("avc") ? { format: "avc" } : undefined,
  } satisfies VideoEncoderConfig);

  const { iterator } = createFrameIterator(demux, fps);
  const initialShaderTime = job.entity.shaderParams.time ?? 0;
  const animateShaderTime = job.entity.shaderParams.timeAutoPlay !== false;
  const throwEncodeUnsupported = (error: Error): never => {
    throw createUnsupportedWorkerExportError(
      `Worker VideoEncoder cannot encode the WebGPU export canvas: ${error.message}`,
    );
  };
  const throwIfEncoderUnusable = (): void => {
    if (encodeError) throwEncodeUnsupported(encodeError);
    if (encoder.state !== "configured") {
      throwEncodeUnsupported(new Error(`VideoEncoder is ${encoder.state}`));
    }
  };
  const waitForEncoderBackpressure = async (): Promise<void> => {
    if (encoder.encodeQueueSize <= 4) return;
    const result = await Promise.race([
      new Promise<null>((resolve) =>
        encoder.addEventListener("dequeue", () => resolve(null), { once: true }),
      ),
      encoderErrorSignal,
    ]);
    if (result) throwEncodeUnsupported(result);
    if (encodeError) throwEncodeUnsupported(encodeError);
  };

  for (let i = 0; i < totalFrames; i++) {
    if (isCancelled()) throw new Error("Export cancelled");
    throwIfEncoderUnusable();

    const timestampSeconds = i / fps;
    const timestampUs = Math.floor(timestampSeconds * 1_000_000);
    const { value: bitmap, done } = await iterator.next();
    if (done || !bitmap) throw new Error("No more video frames");

    if (animateShaderTime) {
      job.entity.shaderParams.time = initialShaderTime + timestampSeconds;
    }

    await renderer.renderToCanvas(job.entity, bitmap, width, height);
    bitmap.close();

    const frame = new VideoFrame(renderer.canvas, {
      timestamp: timestampUs,
      duration: frameDurationUs,
      alpha: "discard",
    });
    try {
      encoder.encode(frame, { keyFrame: i % keyFrameInterval === 0 });
    } catch (error) {
      if (encodeError) throwEncodeUnsupported(encodeError);
      throwEncodeUnsupported(error instanceof Error ? error : new Error("VideoEncoder failed"));
    } finally {
      frame.close();
    }
    if (encodeError) throwEncodeUnsupported(encodeError);
    await waitForEncoderBackpressure();

    emitProgress({
      frame: i + 1,
      totalFrames,
      percent: ((i + 1) / totalFrames) * 0.8,
      stage: "extracting",
      message: `Rendering frame ${i + 1}/${totalFrames}`,
    });
  }

  try {
    await Promise.race([
      encoder.flush(),
      encoderErrorSignal.then((error) => {
        throw error;
      }),
    ]);
  } catch (error) {
    if (encodeError) throwEncodeUnsupported(encodeError);
    throwEncodeUnsupported(error instanceof Error ? error : new Error("VideoEncoder flush failed"));
  }
  if (encodeError) throwEncodeUnsupported(encodeError);
  encoder.close();

  emitProgress({
    frame: totalFrames,
    totalFrames,
    percent: 0.85,
    stage: "muxing",
    message: "Muxing video...",
  });

  return muxVideo({ format, fps, chunks, audioData, totalFrames });
}

async function muxVideo(params: {
  format: "mp4" | "mov";
  fps: number;
  chunks: Array<{
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number;
    meta?: EncodedVideoChunkMetadata;
  }>;
  audioData: DemuxedAudio | null;
  totalFrames: number;
}): Promise<Blob> {
  const { format, fps, chunks, audioData, totalFrames } = params;
  const options: IsobmffOutputFormatOptions = { fastStart: "in-memory" };
  const outputFormat = format === "mov" ? new MovOutputFormat(options) : new Mp4OutputFormat(options);
  const target = new BufferTarget();
  const output = new Output({ format: outputFormat, target });
  const videoSource = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioSource: EncodedAudioPacketSource | null = null;
  if (audioData) {
    audioSource = new EncodedAudioPacketSource("aac");
    output.addAudioTrack(audioSource);
  }

  await output.start();

  let firstVideoPacket = true;
  for (const chunk of chunks) {
    if (isCancelled()) throw new Error("Export cancelled");
    const packet = new EncodedPacket(chunk.data, chunk.type, chunk.timestamp, chunk.duration);
    if (firstVideoPacket && chunk.meta) {
      await videoSource.add(packet, chunk.meta);
      firstVideoPacket = false;
    } else {
      await videoSource.add(packet);
    }
  }
  videoSource.close();

  if (audioData && audioSource) {
    const videoDuration = totalFrames / fps;
    let firstAudioPacket = true;
    for (const packetData of audioData.packets) {
      if (isCancelled()) throw new Error("Export cancelled");
      if (packetData.timestamp < 0) continue;
      if (packetData.timestamp > videoDuration) break;

      const packet = new EncodedPacket(
        packetData.data,
        packetData.type,
        packetData.timestamp,
        packetData.duration,
      );
      if (firstAudioPacket) {
        await audioSource.add(packet, {
          decoderConfig: {
            codec: audioData.codec,
            sampleRate: audioData.sampleRate,
            numberOfChannels: audioData.numberOfChannels,
            description: audioData.description,
          },
        });
        firstAudioPacket = false;
      } else {
        await audioSource.add(packet);
      }
    }
    audioSource.close();
  }

  await output.finalize();
  const buffer = target.buffer;
  if (!buffer) throw new Error("Output buffer is null after finalize");
  return new Blob([buffer], { type: output.format.mimeType });
}

async function exportGif(job: ExportJobSnapshot): Promise<Blob> {
  const fps = Math.min(job.options.fps ?? 30, defaultGifConfig.maxFps);
  const maxWidth = job.options.advanced?.gifMaxWidth ?? defaultGifConfig.maxWidth;
  const useDither = (job.options.advanced?.gifDither ?? "floyd_steinberg") !== "none";
  const sourceInfo = await getAnimatedSourceInfo(job);
  const totalFrames = Math.ceil(sourceInfo.duration * fps);
  const dimensions = getGifExportDimensions(sourceInfo.width, sourceInfo.height, maxWidth);
  const renderer = await HeadlessExportRenderer.create(dimensions.width, dimensions.height);

  try {
    const palette = await buildGifPalette({
      job,
      renderer,
      sourceInfo,
      fps,
      totalFrames,
      width: dimensions.width,
      height: dimensions.height,
    });
    const gif = GIFEncoder();
    let accumulatedError = 0;
    const initialShaderTime = job.entity.shaderParams.time ?? 0;
    const timestamps = Array.from({ length: totalFrames }, (_, i) => i / fps);
    let i = 0;

    for await (const source of iterateFrameSources(job, sourceInfo, timestamps)) {
      if (isCancelled()) throw new Error("Export cancelled");

      const timestampSeconds = i / fps;
      const pixels = await renderFramePixels({
        job,
        renderer,
        source,
        timestampSeconds,
        initialShaderTime,
        width: dimensions.width,
        height: dimensions.height,
      });
      closeFrameSource(sourceInfo, source);

      if (useDither) floydSteinbergDither(pixels, dimensions.width, dimensions.height, palette);
      const indexed = applyPalette(pixels, palette);
      const delay = getGifFrameDelayCentiseconds(fps, accumulatedError);
      accumulatedError = delay.nextAccumulatedError;

      gif.writeFrame(indexed, dimensions.width, dimensions.height, {
        palette,
        repeat: 0,
        delay: delay.delayCentiseconds * 10,
      });

      emitProgress({
        frame: i + 1,
        totalFrames,
        percent: 0.15 + ((i + 1) / totalFrames) * 0.85,
        stage: "encoding",
        message: `Encoding frame ${i + 1}/${totalFrames}`,
      });
      i++;
    }

    gif.finish();
    const bytes = gif.bytes();
    return new Blob([bytes], { type: "image/gif" });
  } finally {
    sourceInfo.dispose();
    renderer.destroy();
  }
}

type AnimatedSourceInfo =
  | {
      type: "video";
      width: number;
      height: number;
      duration: number;
      demux: VideoDemuxHandle;
      dispose(): void;
    }
  | {
      type: "gif";
      width: number;
      height: number;
      duration: number;
      gif: GifDecodeResult;
      dispose(): void;
    };

async function getAnimatedSourceInfo(job: ExportJobSnapshot): Promise<AnimatedSourceInfo> {
  if (job.entity.mediaSource.type === "video") {
    if (typeof VideoDecoder === "undefined") {
      throw new Error("UNSUPPORTED_WORKER_EXPORT: VideoDecoder is unavailable");
    }
    const demux = await demuxVideo(job.entity.mediaSource.blob);
    return {
      type: "video",
      width: demux.width,
      height: demux.height,
      duration: demux.duration,
      demux,
      dispose: () => demux.dispose(),
    };
  }

  if (typeof ImageDecoder === "undefined") {
    throw new Error("UNSUPPORTED_WORKER_EXPORT: ImageDecoder is unavailable");
  }
  const gif = await decodeGif(job.entity.mediaSource.blob);
  return {
    type: "gif",
    width: gif.width,
    height: gif.height,
    duration: gif.duration,
    gif,
    dispose: () => {
      for (const frame of gif.frames) frame.bitmap.close();
    },
  };
}

async function buildGifPalette(params: {
  job: ExportJobSnapshot;
  renderer: HeadlessExportRenderer;
  sourceInfo: AnimatedSourceInfo;
  fps: number;
  totalFrames: number;
  width: number;
  height: number;
}): Promise<[number, number, number][]> {
  const { job, renderer, sourceInfo, fps, totalFrames, width, height } = params;
  const sampleInterval = Math.max(1, Math.floor(totalFrames / 20));
  const initialShaderTime = job.entity.shaderParams.time ?? 0;
  const sampleFrameIndexes: number[] = [];
  for (let i = 0; i < totalFrames; i += sampleInterval) {
    sampleFrameIndexes.push(i);
  }
  const sampleTimestamps = sampleFrameIndexes.map((frameIndex) => frameIndex / fps);
  const sampledPixels: Uint8ClampedArray<ArrayBuffer>[] = [];
  let sampleIndex = 0;

  for await (const source of iterateFrameSources(job, sourceInfo, sampleTimestamps)) {
    if (isCancelled()) throw new Error("Export cancelled");

    const frameIndex = sampleFrameIndexes[sampleIndex]!;
    const timestampSeconds = sampleTimestamps[sampleIndex]!;
    sampledPixels.push(
      await renderFramePixels({
        job,
        renderer,
        source,
        timestampSeconds,
        initialShaderTime,
        width,
        height,
      }),
    );
    closeFrameSource(sourceInfo, source);

    emitProgress({
      frame: frameIndex + 1,
      totalFrames,
      percent: ((frameIndex + 1) / totalFrames) * 0.15,
      stage: "encoding",
      message: `Sampling frame ${frameIndex + 1}/${totalFrames}`,
    });
    sampleIndex++;
  }

  const byteLength = sampledPixels.reduce((sum, pixels) => sum + pixels.byteLength, 0);
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const pixels of sampledPixels) {
    combined.set(pixels, offset);
    offset += pixels.byteLength;
  }
  return quantize(combined, defaultGifConfig.maxColors);
}

async function* iterateFrameSources(
  job: ExportJobSnapshot,
  sourceInfo: AnimatedSourceInfo,
  timestamps: readonly number[],
): AsyncGenerator<ImageBitmap> {
  if (sourceInfo.type === "gif") {
    for (const timestampSeconds of timestamps) {
      yield getFrameAtTime(sourceInfo.gif.frames, timestampSeconds, true).bitmap;
    }
    return;
  }

  const demux = await demuxVideo(job.entity.mediaSource.blob);
  try {
    for await (const bitmap of demux.frames(timestamps)) {
      yield bitmap;
    }
  } finally {
    demux.dispose();
  }
}

async function renderFramePixels(params: {
  job: ExportJobSnapshot;
  renderer: HeadlessExportRenderer;
  source: ImageBitmap;
  timestampSeconds: number;
  initialShaderTime: number;
  width: number;
  height: number;
}): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { job, renderer, source, timestampSeconds, initialShaderTime, width, height } = params;
  if (job.entity.shaderParams.timeAutoPlay !== false) {
    job.entity.shaderParams.time = initialShaderTime + timestampSeconds;
  }
  return renderer.renderToPixels(job.entity, source, width, height);
}

function closeFrameSource(sourceInfo: AnimatedSourceInfo, source: ImageBitmap): void {
  if (sourceInfo.type === "video") source.close();
}

async function handleStart(job: ExportJobSnapshot): Promise<void> {
  assertWorkerSupport();
  cancelled = false;

  const format = job.options.format ?? "mp4";
  const blob = format === "gif" ? await exportGif(job) : await exportMp4Mov(job);

  emitProgress({
    frame: 1,
    totalFrames: 1,
    percent: 1,
    stage: "done",
    message: "Export complete",
  });
  post({ type: "done", blob });
}

self.onmessage = async (event: MessageEvent<ToExportWorkerMessage>) => {
  try {
    if (event.data.type === "cancel") {
      cancelled = true;
      return;
    }
    await handleStart(event.data.job);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Export failed";
    post({
      type: "error",
      message,
      unsupported: message.startsWith("UNSUPPORTED_WORKER_EXPORT:"),
    });
  }
};
