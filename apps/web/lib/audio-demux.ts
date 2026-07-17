/**
 * Audio Demuxer - Extracts raw encoded audio packets from a video blob via mediabunny
 *
 * Used by the export pipeline to extract audio from the source video before
 * sending it to the worker for muxing alongside the processed video track.
 */

import { Input, BlobSource, EncodedPacketSink, ALL_FORMATS } from "mediabunny";
import { logger } from "./client.logger.ts";

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
  const input = new Input({
    source: new BlobSource(blob),
    formats: ALL_FORMATS,
  });
  try {
    const track = await input.getPrimaryAudioTrack();
    return track !== null;
  } finally {
    input.dispose();
  }
}

/**
 * Extract audio track from a video blob using mediabunny's demuxer.
 * Returns null if the video has no audio track.
 */
export async function demuxAudio(videoBlob: Blob): Promise<DemuxedAudio | null> {
  const input = new Input({
    source: new BlobSource(videoBlob),
    formats: ALL_FORMATS,
  });

  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    if (!audioTrack) {
      logger.debug("[audio-demux] No audio track found");
      return null;
    }

    const decoderConfig = await audioTrack.getDecoderConfig();
    if (!decoderConfig) {
      logger.warn("[audio-demux] Could not get decoder config for audio track");
      return null;
    }

    const codec = decoderConfig.codec;
    const sampleRate = audioTrack.sampleRate;
    const numberOfChannels = audioTrack.numberOfChannels;

    // Extract description bytes if present
    let description: Uint8Array | undefined;
    if (decoderConfig.description) {
      const desc = decoderConfig.description;
      description = ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : new Uint8Array(desc);
    }

    // Read all encoded audio packets
    const packetSink = new EncodedPacketSink(audioTrack);
    const packets: DemuxedAudio["packets"] = [];

    let currentPacket = await packetSink.getFirstPacket();
    while (currentPacket) {
      packets.push({
        data: currentPacket.data,
        type: currentPacket.type,
        timestamp: currentPacket.timestamp,
        duration: currentPacket.duration,
      });
      currentPacket = await packetSink.getNextPacket(currentPacket);
    }

    logger.debug(
      `[audio-demux] Extracted ${packets.length} audio packets, codec=${codec}, rate=${sampleRate}, ch=${numberOfChannels}`,
    );

    return { packets, codec, sampleRate, numberOfChannels, description };
  } finally {
    input.dispose();
  }
}
