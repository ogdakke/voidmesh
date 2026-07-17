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

export interface VideoDemuxHandle {
  /** Decode frames at the given timestamps (seconds). Caller must close each yielded ImageBitmap. */
  frames(timestamps: Iterable<number>): AsyncGenerator<ImageBitmap>;
  /** Display width in pixels (after rotation) */
  width: number;
  /** Display height in pixels (after rotation) */
  height: number;
  /** Duration in seconds */
  duration: number;
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
  const input = new Input({
    source: new BlobSource(videoBlob),
    formats: ALL_FORMATS,
  });

  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    input.dispose();
    throw new Error("No video track found in source");
  }

  const canDecode = await videoTrack.canDecode();
  if (!canDecode) {
    input.dispose();
    throw new Error("Video track codec is not supported by this browser");
  }

  const width = videoTrack.displayWidth;
  const height = videoTrack.displayHeight;
  const duration = await videoTrack.computeDuration();

  logger.debug(`[video-demux] Opened video: ${width}x${height}, duration=${duration.toFixed(2)}s`);

  const sink = new VideoSampleSink(videoTrack);

  async function* frames(timestamps: Iterable<number>): AsyncGenerator<ImageBitmap> {
    // Hold a display-oriented copy of the last decoded frame for repeats and
    // for videos whose encoded frame dimensions differ from display dimensions.
    const repeatCanvas = new OffscreenCanvas(width, height);
    const repeatCtx = repeatCanvas.getContext("2d")!;
    let hasFrame = false;

    // Count expected outputs to pad if the sink yields fewer samples
    const timestampArray = Array.isArray(timestamps) ? timestamps : [...timestamps];
    let yieldCount = 0;
    // Buffer leading nulls — timestamps before the first decodable frame
    // (e.g. video with start_time > 0) will produce nulls that we backfill
    // once the first real frame arrives.
    let leadingNulls = 0;

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
  }

  return {
    frames,
    width,
    height,
    duration,
    dispose: () => input.dispose(),
  };
}
