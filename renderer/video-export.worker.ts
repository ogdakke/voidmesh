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

import {
  Output,
  Mp4OutputFormat,
  MovOutputFormat,
  BufferTarget,
  EncodedVideoPacketSource,
  EncodedAudioPacketSource,
  EncodedPacket,
  type IsobmffOutputFormatOptions,
} from "mediabunny";
import type { ExportFormat } from "./export-formats.ts";

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
let encoder: VideoEncoder | null = null;
let output: Output | null = null;
let videoSource: EncodedVideoPacketSource | null = null;
let cancelled = false;

// Config state
let fps = 30;
let keyFrameInterval = 60;
let frameDurationUs = 33333;
let totalFrames = 0;
let debugLogging = false;

// Buffered encoded video chunks (fed to mediabunny during finish)
let bufferedVideoChunks: Array<{
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  meta?: EncodedVideoChunkMetadata;
}> = [];

// Audio data received from main thread
let pendingAudioData: (ToWorkerMessage & { type: "audio-track" }) | null = null;

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
  bufferedVideoChunks = [];
  debugLogging = msg.debug ?? false;

  keyFrameInterval = Math.floor(fps * keyFrameIntervalSeconds);
  frameDurationUs = Math.round(1_000_000 / fps);

  // MP4 and MOV both use ISOBMFF but with different codec support
  const isobmffOptions: IsobmffOutputFormatOptions = { fastStart: "in-memory" };
  const outputFormat =
    msg.format === "mov"
      ? new MovOutputFormat(isobmffOptions)
      : new Mp4OutputFormat(isobmffOptions);

  // Create mediabunny output and video source
  const target = new BufferTarget();
  output = new Output({ format: outputFormat, target });
  videoSource = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(videoSource, { frameRate: fps });

  // Audio track is added during finish when we know if audio data was sent
  // output.start() is also deferred to finish

  // Create encoder
  encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);

      bufferedVideoChunks.push({
        data,
        type: chunk.type === "key" ? "key" : "delta",
        timestamp: chunk.timestamp / 1_000_000,
        duration: (chunk.duration ?? frameDurationUs) / 1_000_000,
        meta: metadata,
      });
    },
    error: (e) => {
      sendMessage({ type: "error", message: e.message });
    },
  });

  encoder.configure({
    codec,
    width,
    height,
    bitrate,
    bitrateMode,
    framerate: fps,
    hardwareAcceleration,
    latencyMode,
    avc: codec.startsWith("avc") ? { format: "avc" } : undefined,
  } satisfies VideoEncoderConfig);
}

function handleFrame(msg: Extract<ToWorkerMessage, { type: "frame" }>): void {
  if (cancelled || !encoder) return;

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
    duration: frameDurationUs,
  });

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

function handleAudioTrack(msg: Extract<ToWorkerMessage, { type: "audio-track" }>): void {
  // MP4/MOV use AAC natively — no transcoding needed, just store for muxing
  pendingAudioData = msg;
}

async function handleFinish(): Promise<void> {
  if (cancelled || !encoder || !output || !videoSource) return;

  try {
    // 1. Flush the WebCodecs encoder
    if (debugLogging) console.debug(`[export-worker] flushing encoder...`);
    await encoder.flush();
    encoder.close();
    encoder = null;
    if (debugLogging)
      console.debug(
        `[export-worker] encoder flushed, ${bufferedVideoChunks.length} chunks buffered`,
      );

    sendMessage({
      type: "progress",
      frame: totalFrames,
      totalFrames,
      percent: 0.85,
      stage: "muxing",
    });

    // 2. Add audio track if audio data was sent
    let audioSource: EncodedAudioPacketSource | null = null;
    if (pendingAudioData) {
      audioSource = new EncodedAudioPacketSource("aac");
      output.addAudioTrack(audioSource);
    }

    // 3. Start the output (all tracks must be added before this)
    await output.start();

    // 4. Feed all buffered video chunks
    let firstVideoPacket = true;
    for (const chunk of bufferedVideoChunks) {
      if (cancelled) break;
      const packet = new EncodedPacket(chunk.data, chunk.type, chunk.timestamp, chunk.duration);

      if (firstVideoPacket && chunk.meta) {
        await videoSource.add(packet, chunk.meta);
        firstVideoPacket = false;
      } else {
        await videoSource.add(packet);
      }
    }
    videoSource.close();

    // 5. Feed audio data if present
    if (pendingAudioData && audioSource) {
      const audio = pendingAudioData;
      const videoDuration = totalFrames / fps;
      let isFirstAudioPacket = true;

      for (const pkt of audio.packets) {
        if (cancelled) break;
        // Skip negative-timestamp pre-roll packets (AAC decoder priming frames)
        if (pkt.timestamp < 0) continue;
        // Trim audio to video duration
        if (pkt.timestamp > videoDuration) break;

        const packet = new EncodedPacket(pkt.data, pkt.type, pkt.timestamp, pkt.duration);

        if (isFirstAudioPacket) {
          await audioSource.add(packet, {
            decoderConfig: {
              codec: audio.codec,
              sampleRate: audio.sampleRate,
              numberOfChannels: audio.numberOfChannels,
              description: audio.description,
            },
          });
          isFirstAudioPacket = false;
        } else {
          await audioSource.add(packet);
        }
      }
      audioSource.close();
    }

    // 6. Finalize the output
    await output.finalize();
    if (debugLogging) console.debug(`[export-worker] output finalized`);

    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer) throw new Error("Output buffer is null after finalize");

    const mimeType = output.format.mimeType;
    const blob = new Blob([buffer], { type: mimeType });
    if (debugLogging)
      console.debug(`[export-worker] built: ${(blob.size / 1024 / 1024).toFixed(2)} MB`);

    sendMessage({ type: "progress", frame: totalFrames, totalFrames, percent: 1, stage: "done" });
    sendMessage({ type: "done", blob });
  } catch (e) {
    sendMessage({ type: "error", message: e instanceof Error ? e.message : "Muxing failed" });
  } finally {
    output = null;
    videoSource = null;
    bufferedVideoChunks = [];
    pendingAudioData = null;
  }
}

function handleCancel(): void {
  cancelled = true;
  if (encoder) {
    try {
      encoder.close();
    } catch {
      // Ignore
    }
    encoder = null;
  }
  if (output) {
    output.cancel().catch(() => {});
    output = null;
  }
  videoSource = null;
  bufferedVideoChunks = [];
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
