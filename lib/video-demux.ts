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
    // Hold a canvas with the last decoded frame for repeat on null samples
    const repeatCanvas = new OffscreenCanvas(width, height);
    const repeatCtx = repeatCanvas.getContext("2d")!;
    let hasFrame = false;

    for await (const sample of sink.samplesAtTimestamps(timestamps)) {
      if (!sample) {
        // Timestamp has no frame (e.g. past the last frame) — repeat the last valid frame
        if (hasFrame) {
          yield await createImageBitmap(repeatCanvas);
        }
        continue;
      }
      const source = sample.toCanvasImageSource();
      const bitmap = await createImageBitmap(source);
      sample.close();

      // Stash a copy for potential repeat
      repeatCtx.drawImage(bitmap, 0, 0);
      hasFrame = true;

      yield bitmap;
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
