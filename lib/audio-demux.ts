/**
 * Audio Demuxer - Extracts raw encoded audio packets from a video blob via mediabunny
 *
 * Used by the export pipeline to extract audio from the source video before
 * sending it to the worker for muxing alongside the processed video track.
 */

import {
  Input,
  BlobSource,
  EncodedPacketSink,
  ALL_FORMATS,
  AUDIO_CODECS,
  type AudioCodec,
} from "mediabunny";
import { logger } from "./client.logger.ts";

function isAudioCodec(codec: string): codec is AudioCodec {
  return (AUDIO_CODECS as readonly string[]).includes(codec);
}

export interface DemuxedAudio {
  /** Encoded audio packets in decode order */
  packets: Array<{
    data: Uint8Array;
    type: "key" | "delta";
    timestamp: number;
    duration: number;
  }>;
  /** WebCodecs codec string (e.g. "mp4a.40.2", "opus") */
  codec: string;
  /** Mediabunny packet codec identifier used when muxing encoded packets */
  packetCodec: AudioCodec;
  /** Audio sample rate in Hz */
  sampleRate: number;
  /** Number of audio channels */
  numberOfChannels: number;
  /** Codec-specific description bytes (e.g. AudioSpecificConfig for AAC) */
  description?: Uint8Array;
}

/**
 * Quick probe: does this blob contain an audio track?
 * Much cheaper than full demuxAudio — only reads container metadata.
 */
export async function hasAudioTrack(blob: Blob): Promise<boolean> {
  const startedAt = performance.now();
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    const hasAudio = track !== null;
    logger.info("[audio-demux] Audio track probe complete", {
      durationMs: Math.round(performance.now() - startedAt),
      hasAudio,
      sizeBytes: blob.size,
      mimeType: blob.type || "unknown",
    });
    return hasAudio;
  } finally {
    input.dispose();
  }
}

/**
 * Extract audio track from a video blob using mediabunny's demuxer.
 * Returns null if the video has no muxable encoded audio track.
 */
export async function demuxAudio(videoBlob: Blob): Promise<DemuxedAudio | null> {
  const startedAt = performance.now();
  const input = new Input({
    source: new BlobSource(videoBlob),
    formats: ALL_FORMATS,
  });

  try {
    const trackStartedAt = performance.now();
    const audioTrack = await input.getPrimaryAudioTrack();
    logger.info("[audio-demux] Primary audio track probe complete", {
      durationMs: Math.round(performance.now() - trackStartedAt),
      hasAudio: audioTrack !== null,
    });
    if (!audioTrack) {
      logger.debug("[audio-demux] No audio track found");
      return null;
    }

    const decoderConfigStartedAt = performance.now();
    const decoderConfig = await audioTrack.getDecoderConfig();
    logger.info("[audio-demux] Audio decoder config probe complete", {
      durationMs: Math.round(performance.now() - decoderConfigStartedAt),
      hasDecoderConfig: decoderConfig !== null,
    });
    if (!decoderConfig) {
      logger.warn("[audio-demux] Could not get decoder config for audio track");
      return null;
    }

    const codecStartedAt = performance.now();
    const packetCodec = await audioTrack.getCodec();
    logger.info("[audio-demux] Audio packet codec probe complete", {
      durationMs: Math.round(performance.now() - codecStartedAt),
      packetCodec,
    });
    if (!packetCodec || !isAudioCodec(packetCodec)) {
      logger.warn(
        `[audio-demux] Unsupported or unknown audio packet codec: ${packetCodec ?? "unknown"}`,
      );
      return null;
    }

    const codec = decoderConfig.codec;
    const formatStartedAt = performance.now();
    const [sampleRate, numberOfChannels] = await Promise.all([
      audioTrack.getSampleRate(),
      audioTrack.getNumberOfChannels(),
    ]);
    logger.info("[audio-demux] Audio format metadata probe complete", {
      durationMs: Math.round(performance.now() - formatStartedAt),
      sampleRate,
      numberOfChannels,
    });

    // Extract description bytes if present
    let description: Uint8Array | undefined;
    if (decoderConfig.description) {
      const desc = decoderConfig.description;
      description = ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : new Uint8Array(desc);
    }

    const packetSink = new EncodedPacketSink(audioTrack);
    const packets: DemuxedAudio["packets"] = [];

    const packetsStartedAt = performance.now();
    for await (const currentPacket of packetSink.packets()) {
      packets.push({
        data: currentPacket.data,
        type: currentPacket.type,
        timestamp: currentPacket.timestamp,
        duration: currentPacket.duration,
      });
    }
    const packetsDurationMs = Math.round(performance.now() - packetsStartedAt);

    logger.info(
      `[audio-demux] Extracted ${packets.length} audio packets, codec=${codec}, packetCodec=${packetCodec}, rate=${sampleRate}, ch=${numberOfChannels}`,
      {
        packetsDurationMs,
        totalDurationMs: Math.round(performance.now() - startedAt),
        sizeBytes: videoBlob.size,
        mimeType: videoBlob.type || "unknown",
      },
    );

    return { packets, codec, packetCodec, sampleRate, numberOfChannels, description };
  } finally {
    logger.info("[audio-demux] Audio demux complete", {
      durationMs: Math.round(performance.now() - startedAt),
      sizeBytes: videoBlob.size,
      mimeType: videoBlob.type || "unknown",
    });
    input.dispose();
  }
}
