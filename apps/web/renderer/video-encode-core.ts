import { getH264Codec } from "#config";
import type { DemuxedAudio } from "#lib/audio-demux.ts";
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

export interface EncodedVideoChunkData {
  data: Uint8Array;
  type: "key" | "delta";
  timestamp: number;
  duration: number;
  meta?: EncodedVideoChunkMetadata;
}

export interface VideoEncoderSessionOptions {
  codec: string;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  keyFrameIntervalSeconds: number;
  hardwareAcceleration: "no-preference" | "prefer-hardware" | "prefer-software";
  latencyMode: "quality" | "realtime";
  bitrateMode: "constant" | "variable" | "quantizer";
  onError?: (error: Error) => void;
}

export interface MuxEncodedVideoOptions {
  format: "mp4" | "mov";
  fps: number;
  chunks: readonly EncodedVideoChunkData[];
  audioData: DemuxedAudio | null;
  totalFrames: number;
  isCancelled?: () => boolean;
}

export async function selectH264Codec(
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
  if (!support.supported) throw new Error("H.264 codec not supported");
  return codec;
}

export class VideoEncoderSession {
  #encoder: VideoEncoder | null = null;
  #chunks: EncodedVideoChunkData[] = [];
  #frameDurationUs: number;
  #keyFrameInterval: number;
  #encodeError: Error | null = null;
  #resolveEncoderError: (error: Error) => void = () => {};
  #encoderErrorSignal: Promise<Error>;

  constructor(options: VideoEncoderSessionOptions) {
    this.#frameDurationUs = Math.round(1_000_000 / options.fps);
    this.#keyFrameInterval = Math.floor(options.fps * options.keyFrameIntervalSeconds);
    this.#encoderErrorSignal = new Promise<Error>((resolve) => {
      this.#resolveEncoderError = resolve;
    });

    this.#encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        this.#chunks.push({
          data,
          type: chunk.type === "key" ? "key" : "delta",
          timestamp: chunk.timestamp / 1_000_000,
          duration: (chunk.duration ?? this.#frameDurationUs) / 1_000_000,
          meta: metadata,
        });
      },
      error: (error) => {
        this.#encodeError = error;
        this.#resolveEncoderError(error);
        options.onError?.(error);
      },
    });

    this.#encoder.configure({
      codec: options.codec,
      width: options.width,
      height: options.height,
      bitrate: options.bitrate,
      bitrateMode: options.bitrateMode,
      framerate: options.fps,
      hardwareAcceleration: options.hardwareAcceleration,
      latencyMode: options.latencyMode,
      avc: options.codec.startsWith("avc") ? { format: "avc" } : undefined,
    } satisfies VideoEncoderConfig);
  }

  get frameDurationUs(): number {
    return this.#frameDurationUs;
  }

  get encodeQueueSize(): number {
    return this.#encoder?.encodeQueueSize ?? 0;
  }

  encodeFrame(frame: VideoFrame, frameIndex: number): void {
    const encoder = this.#encoder;
    this.#throwIfUnusable();
    if (!encoder) throw new Error("VideoEncoder is closed");
    encoder.encode(frame, { keyFrame: frameIndex % this.#keyFrameInterval === 0 });
  }

  async waitForBackpressure(maxQueueSize = 4): Promise<void> {
    const encoder = this.#encoder;
    if (!encoder || encoder.encodeQueueSize <= maxQueueSize) return;

    const result = await Promise.race([
      new Promise<null>((resolve) =>
        encoder.addEventListener("dequeue", () => resolve(null), { once: true }),
      ),
      this.#encoderErrorSignal,
    ]);
    if (result) throw result;
    this.#throwIfUnusable();
  }

  async flush(): Promise<readonly EncodedVideoChunkData[]> {
    const encoder = this.#encoder;
    this.#throwIfUnusable();
    if (!encoder) throw new Error("VideoEncoder is closed");

    await Promise.race([
      encoder.flush(),
      this.#encoderErrorSignal.then((error) => {
        throw error;
      }),
    ]);
    if (this.#encodeError) throw this.#encodeError;
    this.close();
    return this.#chunks;
  }

  close(): void {
    const encoder = this.#encoder;
    if (!encoder) return;
    this.#encoder = null;
    if (encoder.state === "closed") return;
    try {
      encoder.close();
    } catch (error) {
      if (error instanceof DOMException && error.name === "InvalidStateError") return;
      throw error;
    }
  }

  #throwIfUnusable(): void {
    if (this.#encodeError) throw this.#encodeError;
    if (this.#encoder && this.#encoder.state !== "configured") {
      throw new Error(`VideoEncoder is ${this.#encoder.state}`);
    }
  }
}

export async function muxEncodedVideo(options: MuxEncodedVideoOptions): Promise<Blob> {
  const { format, fps, chunks, audioData, totalFrames, isCancelled = () => false } = options;
  const isobmffOptions: IsobmffOutputFormatOptions = { fastStart: "in-memory" };
  const outputFormat =
    format === "mov" ? new MovOutputFormat(isobmffOptions) : new Mp4OutputFormat(isobmffOptions);
  const target = new BufferTarget();
  const output = new Output({ format: outputFormat, target });
  const videoSource = new EncodedVideoPacketSource("avc");
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioSource: EncodedAudioPacketSource | null = null;
  if (audioData) {
    audioSource = new EncodedAudioPacketSource("aac");
    output.addAudioTrack(audioSource);
  }

  try {
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
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}
