/**
 * Video Export Worker - Handles video encoding and muxing off the main thread
 *
 * Receives pre-rendered ImageBitmaps from main thread, encodes via WebCodecs,
 * and muxes into MP4/MOV via mediabunny.
 *
 * Architecture:
 * 1. Init: create VideoEncoder + mediabunny Output (don't start yet)
 * 2. Frames: encode via WebCodecs, buffer encoded chunks
 * 3. Audio (optional): buffer pre-extracted audio packets from main thread
 * 4. Finish: flush encoder → add audio track if needed → start output →
 *    feed all video/audio chunks → finalize → send blob
 *
 * All encoded data is buffered until finish, matching mp4box's in-memory approach.
 * mediabunny requires all tracks added before start(), and start() before add().
 */

import type { ExportFormat } from "./export-formats.ts";
import type { DemuxedAudio } from "#lib/audio-demux.ts";
import { VideoEncoderSession, muxEncodedVideo } from "./video-encode-core.ts";

// Message types from main thread
export type ToWorkerMessage =
  | {
      type: "init";
      width: number;
      height: number;
      fps: number;
      bitrate: number;
      totalFrames: number;
      format: ExportFormat;
      // Encoder config
      codec: string;
      keyFrameIntervalSeconds: number;
      hardwareAcceleration: "no-preference" | "prefer-hardware" | "prefer-software";
      latencyMode: "quality" | "realtime";
      bitrateMode: "constant" | "variable" | "quantizer";
      debug?: boolean;
    }
  | { type: "frame"; bitmap: ImageBitmap; frameIndex: number; timestampUs: number }
  | {
      type: "audio-track";
      packets: Array<{
        data: Uint8Array;
        type: "key" | "delta";
        timestamp: number;
        duration: number;
      }>;
      codec: string;
      sampleRate: number;
      numberOfChannels: number;
      description?: Uint8Array;
    }
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
let encodeSession: VideoEncoderSession | null = null;
let cancelled = false;

// Config state
let fps = 30;
let totalFrames = 0;
let debugLogging = false;
let format: "mp4" | "mov" = "mp4";

// Audio data received from main thread
let pendingAudioData: DemuxedAudio | null = null;

function sendMessage(msg: FromWorkerMessage): void {
  self.postMessage(msg);
}

function handleInit(msg: Extract<ToWorkerMessage, { type: "init" }>): void {
  const {
    width,
    height,
    bitrate,
    codec,
    keyFrameIntervalSeconds,
    hardwareAcceleration,
    latencyMode,
    bitrateMode,
  } = msg;
  fps = msg.fps;
  totalFrames = msg.totalFrames;
  cancelled = false;
  debugLogging = msg.debug ?? false;
  format = msg.format === "mov" ? "mov" : "mp4";

  encodeSession?.close();
  encodeSession = new VideoEncoderSession({
    codec,
    width,
    height,
    fps,
    bitrate,
    keyFrameIntervalSeconds,
    hardwareAcceleration,
    latencyMode,
    bitrateMode,
    onError: (error) => sendMessage({ type: "error", message: error.message }),
  });
}

function handleFrame(msg: Extract<ToWorkerMessage, { type: "frame" }>): void {
  if (cancelled || !encodeSession) return;

  const { bitmap, frameIndex, timestampUs } = msg;

  sendMessage({
    type: "progress",
    frame: frameIndex + 1,
    totalFrames,
    percent: (frameIndex + 1) / totalFrames,
    stage: "extracting",
  });

  const frame = new VideoFrame(bitmap, {
    timestamp: timestampUs,
    duration: encodeSession.frameDurationUs,
  });

  try {
    encodeSession.encodeFrame(frame, frameIndex);
    if (debugLogging && frameIndex % 10 === 0) {
      console.debug(
        `[export-worker] encoded frame ${frameIndex}/${totalFrames}, encoder queue: ${encodeSession.encodeQueueSize}`,
      );
    }
  } finally {
    frame.close();
    bitmap.close();
  }
}

function handleAudioTrack(msg: Extract<ToWorkerMessage, { type: "audio-track" }>): void {
  // MP4/MOV use AAC natively — no transcoding needed, just store for muxing
  pendingAudioData = {
    packets: msg.packets,
    codec: msg.codec,
    sampleRate: msg.sampleRate,
    numberOfChannels: msg.numberOfChannels,
    description: msg.description,
  };
}

async function handleFinish(): Promise<void> {
  if (cancelled || !encodeSession) return;

  try {
    // 1. Flush the WebCodecs encoder
    if (debugLogging) console.debug(`[export-worker] flushing encoder...`);
    const chunks = await encodeSession.flush();
    encodeSession = null;
    if (debugLogging)
      console.debug(`[export-worker] encoder flushed, ${chunks.length} chunks buffered`);

    sendMessage({
      type: "progress",
      frame: totalFrames,
      totalFrames,
      percent: 0.85,
      stage: "muxing",
    });

    const blob = await muxEncodedVideo({
      format,
      fps,
      chunks,
      audioData: pendingAudioData,
      totalFrames,
      isCancelled: () => cancelled,
    });
    if (debugLogging) console.debug(`[export-worker] output finalized`);
    if (debugLogging)
      console.debug(`[export-worker] built: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

    sendMessage({ type: "progress", frame: totalFrames, totalFrames, percent: 1, stage: "done" });
    sendMessage({ type: "done", blob });
  } catch (e) {
    sendMessage({ type: "error", message: e instanceof Error ? e.message : "Muxing failed" });
  } finally {
    encodeSession = null;
    pendingAudioData = null;
  }
}

function handleCancel(): void {
  cancelled = true;
  encodeSession?.close();
  encodeSession = null;
  pendingAudioData = null;
}

self.onmessage = async (event: MessageEvent<ToWorkerMessage>) => {
  const msg = event.data;

  try {
    switch (msg.type) {
      case "init":
        handleInit(msg);
        break;
      case "frame":
        handleFrame(msg);
        break;
      case "audio-track":
        handleAudioTrack(msg);
        break;
      case "finish":
        await handleFinish();
        break;
      case "cancel":
        handleCancel();
        break;
    }
  } catch (e) {
    sendMessage({ type: "error", message: e instanceof Error ? e.message : "Worker error" });
  }
};
