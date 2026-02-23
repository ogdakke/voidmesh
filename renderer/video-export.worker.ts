/**
 * Video Export Worker - Handles video encoding and MP4 muxing off the main thread
 *
 * Receives pre-rendered ImageBitmaps from main thread, encodes via WebCodecs,
 * and muxes into MP4 via mp4box.js.
 */

import { createFile } from "mp4box";

// Message types from main thread
export type ToWorkerMessage =
  | {
      type: "init";
      width: number;
      height: number;
      fps: number;
      bitrate: number;
      totalFrames: number;
      // Encoder config
      codec: string;
      mp4Timescale: number;
      keyFrameIntervalSeconds: number;
      hardwareAcceleration: "no-preference" | "prefer-hardware" | "prefer-software";
      latencyMode: "quality" | "realtime";
      bitrateMode: "constant" | "variable" | "quantizer";
      debug?: boolean;
    }
  | { type: "frame"; bitmap: ImageBitmap; frameIndex: number; timestampUs: number }
  | { type: "finish" }
  | { type: "cancel" };

// Message types to main thread
export type FromWorkerMessage =
  | {
      type: "progress";
      frame: number;
      totalFrames: number;
      percent: number;
      stage: "extracting" | "encoding" | "muxing" | "done";
    }
  | { type: "done"; blob: Blob }
  | { type: "error"; message: string };

// Worker state
let encoder: VideoEncoder | null = null;
let mp4file: ReturnType<typeof createFile> | null = null;
let trackId: number | null = null;
let cancelled = false;

// Config state
let fps = 30;
let timescale = 90000;
let keyFrameInterval = 60; // frames between keyframes
let frameDurationTimescale = 3000;
let frameDurationUs = 33333;
let totalFrames = 0;
let pendingChunks: Array<{
  data: Uint8Array;
  frameIndex: number;
  isKeyFrame: boolean;
}> = [];
// Map from timestamp (microseconds) to frame index for accurate DTS derivation
let timestampToFrameIndex: Map<number, number> = new Map();
let debugLogging = false;

function sendMessage(msg: FromWorkerMessage): void {
  self.postMessage(msg);
}

function handleInit(msg: Extract<ToWorkerMessage, { type: "init" }>): void {
  const {
    width,
    height,
    bitrate,
    codec,
    mp4Timescale,
    keyFrameIntervalSeconds,
    hardwareAcceleration,
    latencyMode,
    bitrateMode,
  } = msg;
  fps = msg.fps;
  totalFrames = msg.totalFrames;
  cancelled = false;
  pendingChunks = [];
  timestampToFrameIndex = new Map();
  trackId = null;
  debugLogging = msg.debug ?? false;

  // Use provided timescale (default 90kHz is industry standard)
  timescale = mp4Timescale;
  keyFrameInterval = Math.floor(fps * keyFrameIntervalSeconds);
  frameDurationTimescale = Math.round(timescale / fps);
  frameDurationUs = Math.round(1_000_000 / fps);

  // Create mp4box file for muxing
  mp4file = createFile();

  // Create encoder
  encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);

      // On first chunk with decoder config, create the track
      if (trackId === null && metadata?.decoderConfig?.description) {
        const description = metadata.decoderConfig.description;
        const avcConfig = new Uint8Array(
          ArrayBuffer.isView(description)
            ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
            : new Uint8Array(description),
        ).buffer as ArrayBuffer;

        trackId = mp4file!.addTrack({
          width,
          height,
          timescale,
          avcDecoderConfigRecord: avcConfig,
        });

        // Flush pending chunks
        for (const pending of pendingChunks) {
          const dts = pending.frameIndex * frameDurationTimescale;
          mp4file!.addSample(
            trackId,
            new Uint8Array(pending.data.buffer) as Uint8Array<ArrayBuffer>,
            {
              duration: frameDurationTimescale,
              dts,
              cts: dts,
              is_sync: pending.isKeyFrame,
            },
          );
        }
        pendingChunks = [];
      }

      // Look up the exact frame index from the timestamp→index map
      // This avoids rounding errors from microsecond→timescale conversion
      const frameIdx =
        timestampToFrameIndex.get(chunk.timestamp) ?? Math.round(chunk.timestamp / frameDurationUs);
      const frameData = {
        data,
        frameIndex: frameIdx,
        isKeyFrame: chunk.type === "key",
      };

      if (trackId !== null) {
        const dts = frameData.frameIndex * frameDurationTimescale;
        mp4file!.addSample(
          trackId,
          new Uint8Array(frameData.data.buffer) as Uint8Array<ArrayBuffer>,
          {
            duration: frameDurationTimescale,
            dts,
            cts: dts,
            is_sync: frameData.isKeyFrame,
          },
        );
      } else {
        pendingChunks.push(frameData);
      }
    },
    error: (e) => {
      sendMessage({ type: "error", message: e.message });
    },
  });

  encoder.configure({
    codec, // H.264 High Profile @ Level 5.2
    width,
    height,
    bitrate,
    bitrateMode, // Variable bitrate for better compression
    framerate: fps,
    hardwareAcceleration,
    latencyMode,
    avc: { format: "avc" },
  } satisfies VideoEncoderConfig);
}

function handleFrame(msg: Extract<ToWorkerMessage, { type: "frame" }>): void {
  if (cancelled || !encoder) return;

  const { bitmap, frameIndex, timestampUs } = msg;

  // Send progress
  sendMessage({
    type: "progress",
    frame: frameIndex + 1,
    totalFrames,
    percent: (frameIndex + 1) / totalFrames,
    stage: "extracting",
  });

  // Register the exact frame index for this timestamp so the encoder
  // output callback can derive perfectly uniform DTS values
  timestampToFrameIndex.set(timestampUs, frameIndex);

  // Create VideoFrame from bitmap
  const frame = new VideoFrame(bitmap, {
    timestamp: timestampUs,
    duration: frameDurationUs,
  });

  // Key frame at configured interval
  const isKeyFrame = frameIndex % keyFrameInterval === 0;

  encoder.encode(frame, { keyFrame: isKeyFrame });
  frame.close();
  bitmap.close();

  if (debugLogging && frameIndex % 10 === 0) {
    console.debug(
      `[export-worker] encoded frame ${frameIndex}/${totalFrames}${isKeyFrame ? " (keyframe)" : ""}, encoder queue: ${encoder.encodeQueueSize}`,
    );
  }
}

async function handleFinish(): Promise<void> {
  if (cancelled || !encoder || !mp4file) return;

  try {
    if (debugLogging) console.debug(`[export-worker] flushing encoder...`);
    // Flush encoder
    await encoder.flush();
    if (debugLogging) console.debug(`[export-worker] encoder flushed, closing`);
    encoder.close();
    encoder = null;

    sendMessage({
      type: "progress",
      frame: totalFrames,
      totalFrames,
      percent: 1,
      stage: "muxing",
    });

    if (debugLogging) console.debug(`[export-worker] building MP4 buffer...`);
    // Get the MP4 data
    const stream = mp4file.getBuffer();
    const blob = new Blob([stream.buffer], { type: "video/mp4" });
    if (debugLogging)
      console.debug(`[export-worker] MP4 built: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

    sendMessage({
      type: "progress",
      frame: totalFrames,
      totalFrames,
      percent: 1,
      stage: "done",
    });

    sendMessage({ type: "done", blob });
  } catch (e) {
    sendMessage({ type: "error", message: e instanceof Error ? e.message : "Muxing failed" });
  } finally {
    mp4file = null;
    pendingChunks = [];
    timestampToFrameIndex = new Map();
  }
}

function handleCancel(): void {
  cancelled = true;
  if (encoder) {
    try {
      encoder.close();
    } catch {
      // Ignore close errors
    }
    encoder = null;
  }
  mp4file = null;
  pendingChunks = [];
  timestampToFrameIndex = new Map();
}

self.onmessage = async (event: MessageEvent<ToWorkerMessage>) => {
  const msg = event.data;

  switch (msg.type) {
    case "init":
      handleInit(msg);
      break;
    case "frame":
      handleFrame(msg);
      break;
    case "finish":
      await handleFinish();
      break;
    case "cancel":
      handleCancel();
      break;
  }
};
