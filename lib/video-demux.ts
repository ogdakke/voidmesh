/**
 * Video Demuxer - Decodes video frames from a blob via mediabunny + WebCodecs
 *
 * Uses mediabunny's VideoSampleSink which wraps WebCodecs VideoDecoder internally.
 * Provides frame-accurate decoding at exact timestamps — no HTMLVideoElement seeking,
 * no DOM dependency, no keyframe guessing.
 *
 * Parallel to audio-demux.ts: same mediabunny Input + BlobSource pattern.
 */

import { Input, BlobSource, VideoSampleSink, ALL_FORMATS } from "mediabunny";
import { logger } from "./client.logger.ts";

export const enum VideoFrameStartPolicy {
  /** Export from composition time 0 and freeze the first decoded frame over any leading media gap. */
  freezeLeadingGap = "freeze-leading-gap",
}

export interface VideoDemuxHandle {
  /** Decode frames at the given timestamps (seconds). Caller must close each yielded ImageBitmap. */
  frames(timestamps: Iterable<number>): AsyncGenerator<ImageBitmap>;
  /** Display width in pixels (after rotation) */
  width: number;
  /** Display height in pixels (after rotation) */
  height: number;
  /** Duration in seconds */
  duration: number;
  /** Start timestamp of the first video packet in seconds. Can be positive or negative. */
  firstTimestamp: number;
  /** Policy used by frame iterators for timestamps before the first decoded frame. */
  frameStartPolicy: VideoFrameStartPolicy;
  /** Dispose the demuxer and free resources */
  dispose(): void;
}

/**
 * Create an async frame iterator for uniform-interval decoding.
 * Computes evenly-spaced timestamps from duration and fps, then yields decoded frames.
 */
export function createFrameIterator(
  demux: VideoDemuxHandle,
  fps: number,
): { iterator: AsyncIterator<ImageBitmap>; totalFrames: number } {
  const totalFrames = Math.round(demux.duration * fps);
  const timestamps = Array.from({ length: totalFrames }, (_, i) => i / fps);
  return {
    iterator: demux.frames(timestamps)[Symbol.asyncIterator](),
    totalFrames,
  };
}

/**
 * Open a video blob for frame-accurate decoding.
 * Returns a handle with lazy frame iteration — frames are decoded on demand.
 * Caller must call `dispose()` when done to free demuxer resources.
 */
export async function demuxVideo(videoBlob: Blob): Promise<VideoDemuxHandle> {
  const openedAt = performance.now();
  const input = new Input({
    source: new BlobSource(videoBlob),
    formats: ALL_FORMATS,
  });

  const trackStartedAt = performance.now();
  const videoTrack = await input.getPrimaryVideoTrack();
  logger.info("[video-demux] Primary video track probe complete", {
    durationMs: Math.round(performance.now() - trackStartedAt),
    hasVideo: videoTrack !== null,
  });
  if (!videoTrack) {
    input.dispose();
    throw new Error("No video track found in source");
  }

  const canDecodeStartedAt = performance.now();
  const canDecode = await videoTrack.canDecode();
  logger.info("[video-demux] Video decode support probe complete", {
    durationMs: Math.round(performance.now() - canDecodeStartedAt),
    canDecode,
  });
  if (!canDecode) {
    input.dispose();
    throw new Error("Video track codec is not supported by this browser");
  }

  const metadataStartedAt = performance.now();
  const [width, height, duration, firstTimestamp] = await Promise.all([
    videoTrack.getDisplayWidth(),
    videoTrack.getDisplayHeight(),
    videoTrack.computeDuration(),
    videoTrack.getFirstTimestamp(),
  ]);
  const metadataDurationMs = Math.round(performance.now() - metadataStartedAt);

  logger.info(
    `[video-demux] Opened video: ${width}x${height}, duration=${duration.toFixed(2)}s, firstTimestamp=${firstTimestamp.toFixed(3)}s`,
    {
      metadataDurationMs,
      openDurationMs: Math.round(performance.now() - openedAt),
      sizeBytes: videoBlob.size,
      mimeType: videoBlob.type || "unknown",
    },
  );

  const sink = new VideoSampleSink(videoTrack);

  async function* frames(timestamps: Iterable<number>): AsyncGenerator<ImageBitmap> {
    const framesStartedAt = performance.now();
    // Hold a display-oriented copy of the last decoded frame for repeats and
    // for videos whose encoded frame dimensions differ from display dimensions.
    const repeatCanvas = new OffscreenCanvas(width, height);
    const repeatCtx = repeatCanvas.getContext("2d")!;
    let hasFrame = false;

    // Count expected outputs to pad if the sink yields fewer samples
    const timestampArray = Array.isArray(timestamps) ? timestamps : [...timestamps];
    let yieldCount = 0;
    // Explicit start policy: exports are driven from composition time 0. When
    // the video track starts later, freeze the first decoded frame over that gap.
    let leadingNulls = 0;

    try {
      for await (const sample of sink.samplesAtTimestamps(timestampArray)) {
        if (!sample) {
          if (!hasFrame) {
            // Buffer leading nulls — we'll backfill once the first frame arrives
            leadingNulls++;
            continue;
          }
          yield await createImageBitmap(repeatCanvas);
          yieldCount++;
          continue;
        }
        repeatCtx.clearRect(0, 0, width, height);
        try {
          sample.draw(repeatCtx, 0, 0, width, height);
        } finally {
          sample.close();
        }

        if (!hasFrame) {
          hasFrame = true;
          logger.info("[video-demux] First decoded video frame ready", {
            durationMs: Math.round(performance.now() - framesStartedAt),
            leadingNulls,
            requestedTimestamps: timestampArray.length,
          });
          // Backfill leading nulls with the first decoded frame
          for (let i = 0; i < leadingNulls; i++) {
            yield await createImageBitmap(repeatCanvas);
            yieldCount++;
          }
        }

        yield await createImageBitmap(repeatCanvas);
        yieldCount++;
      }

      if (!hasFrame) {
        throw new Error("No decodable frames found in video");
      }

      // Pad remaining frames if sink yielded fewer samples than timestamps
      while (yieldCount < timestampArray.length) {
        yield await createImageBitmap(repeatCanvas);
        yieldCount++;
      }
    } finally {
      logger.info("[video-demux] Video frame iteration complete", {
        durationMs: Math.round(performance.now() - framesStartedAt),
        requestedTimestamps: timestampArray.length,
        yieldedFrames: yieldCount,
        leadingNulls,
      });
    }
  }

  return {
    frames,
    width,
    height,
    duration,
    firstTimestamp,
    frameStartPolicy: VideoFrameStartPolicy.freezeLeadingGap,
    dispose: () => input.dispose(),
  };
}
