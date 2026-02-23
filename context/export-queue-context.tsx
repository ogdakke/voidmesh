/**
 * Export Queue Context - Manages concurrent video exports with queue system
 *
 * Key features:
 * - Queue multiple exports that process sequentially (avoids GPU contention)
 * - Video element cloning to isolate export from preview playback
 * - Non-blocking exports that allow continued canvas editing
 * - Auto-download on completion
 */

import { useState, useRef, useEffect, type PropsWithChildren } from "react";
import { ExportQueueContext } from "./use-export-queue.ts";
import {
  exportVideo,
  type ExportProgress,
  type VideoExportHandle,
  type VideoExportOptions,
  type AnimatedSource,
  getFormatExtension,
  formatSupportsAudio,
} from "#renderer/video-exporter.ts";
import { isAnimatedEntity, MediaType, type ShaderCanvasEntity } from "#types/canvas.ts";
import type { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import { logger } from "#lib/client.logger.ts";
import { addAudioToProcessedVideo, preloadFFmpeg, terminateFFmpeg } from "#lib/ffmpeg-service.ts";
import { useVideoExportContext } from "./use-video-export.ts";
import type { ExportOptionsState, ExportOptionsUpdate } from "./video-export-context.tsx";

/** Export job status */
export type ExportJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

/** Individual export job in the queue */
export interface ExportJob {
  id: string;
  entityId: string;
  entityName: string;
  outputFileName: string;
  options: VideoExportOptions;
  status: ExportJobStatus;
  progress: ExportProgress | null;
  error: string | null;
  result: Blob | null;
  createdAt: number;
}

/** Queue state */
export interface ExportQueueState {
  jobs: ExportJob[];
  currentJobId: string | null;
}

/** Queue statistics */
export interface QueueStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

export interface ExportQueueContextValue {
  /** Current queue state */
  state: ExportQueueState;

  /** Export options (shared with video-export-context) */
  exportOptions: ExportOptionsState;
  updateExportOptions: (options: ExportOptionsUpdate) => void;

  /** Add export to queue. Returns job ID. */
  addToQueue: (entity: ShaderCanvasEntity, renderer: InfiniteCanvasRenderer) => string;

  /** Cancel specific job (removes if queued, stops if processing) */
  cancelJob: (jobId: string) => void;

  /** Cancel all jobs */
  cancelAll: () => void;

  /** Clear completed/failed jobs from queue */
  clearCompleted: () => void;

  /** Get queue statistics */
  getQueueStats: () => QueueStats;

  /** Check if there are any active exports */
  isExporting: boolean;

  /** Preload FFmpeg in background */
  preloadFFmpeg: () => void;

  /** Sync export FPS with the selected entity's native frame rate */
  syncFpsWithEntity: (entity: ShaderCanvasEntity | null) => void;
}

/** Generate unique job ID */
function generateJobId(): string {
  return `export-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Create a cloned video element for export.
 * This isolates export seeking from the preview playback.
 */
async function createVideoClone(videoElement: HTMLVideoElement): Promise<HTMLVideoElement> {
  const clone = document.createElement("video");
  clone.src = videoElement.src;
  clone.muted = true;
  clone.playsInline = true;
  clone.preload = "auto";

  await new Promise<void>((resolve, reject) => {
    const onLoaded = () => {
      clone.removeEventListener("loadeddata", onLoaded);
      clone.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      clone.removeEventListener("loadeddata", onLoaded);
      clone.removeEventListener("error", onError);
      reject(new Error("Failed to load video clone"));
    };
    clone.addEventListener("loadeddata", onLoaded);
    clone.addEventListener("error", onError);
    clone.load();
  });

  return clone;
}

export function ExportQueueProvider({ children }: PropsWithChildren) {
  const [state, setState] = useState<ExportQueueState>({
    jobs: [],
    currentJobId: null,
  });

  // Delegate export options to the existing video-export-context
  const { exportOptions, updateExportOptions, syncFpsWithEntity } = useVideoExportContext();

  // Track current export handle for cancellation
  const currentHandleRef = useRef<VideoExportHandle | null>(null);
  const currentVideoCloneRef = useRef<HTMLVideoElement | null>(null);
  const isProcessingRef = useRef(false);
  // Track if current job was cancelled (to abort FFmpeg operations)
  const cancelledJobIdRef = useRef<string | null>(null);

  /** Update a specific job in the queue */
  const updateJob = (jobId: string, updates: Partial<ExportJob>) => {
    setState((prev) => ({
      ...prev,
      jobs: prev.jobs.map((job) => (job.id === jobId ? { ...job, ...updates } : job)),
    }));
  };

  /** Remove a job from the queue */
  const removeJob = (jobId: string) => {
    setState((prev) => ({
      ...prev,
      jobs: prev.jobs.filter((job) => job.id !== jobId),
      currentJobId: prev.currentJobId === jobId ? null : prev.currentJobId,
    }));
  };

  /** Process the next job in the queue */
  const processNextJob = async () => {
    // Prevent concurrent processing
    if (isProcessingRef.current) return;

    // Find next queued job
    const nextJob = state.jobs.find((job) => job.status === "queued");
    if (!nextJob) {
      setState((prev) => ({ ...prev, currentJobId: null }));
      return;
    }

    isProcessingRef.current = true;
    setState((prev) => ({ ...prev, currentJobId: nextJob.id }));
    updateJob(nextJob.id, { status: "processing" });

    try {
      // Get entity, snapshot, and renderer from stored references
      const { entity, entitySnapshot, renderer } = jobEntityRefs.current.get(nextJob.id) ?? {};
      if (!entity || !entitySnapshot || !renderer) {
        throw new Error("Entity or renderer not found");
      }

      if (!isAnimatedEntity(entity)) {
        throw new Error("Entity is not a video or animated GIF");
      }

      // Drive shader time externally during export: if the shader was
      // animating at queue time, advance time in sync with export frame
      // timestamps instead of relying on the shader's performance.now() deltas.
      const initialShaderTime = entitySnapshot.shaderParams.time ?? 0;
      const shouldAnimateShaderTime = entitySnapshot.shaderParams.timeAutoPlay !== false;
      entitySnapshot.shaderParams.timeAutoPlay = false;

      // Build AnimatedSource and renderFrame based on entity type
      let animatedSource: AnimatedSource;
      let renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>;

      if (entity.mediaSource.type === MediaType.video) {
        // Video path: clone video element for export isolation
        const videoClone = await createVideoClone(entity.mediaSource.videoElement);
        currentVideoCloneRef.current = videoClone;

        animatedSource = {
          width: entity.originalSize.width,
          height: entity.originalSize.height,
          duration: entity.mediaSource.duration,
          videoElement: videoClone,
        };

        renderFrame = async (timestampSeconds: number): Promise<ImageBitmap> => {
          if (shouldAnimateShaderTime) {
            entitySnapshot.shaderParams.time = initialShaderTime + timestampSeconds;
          }
          // If the video is playing (playback-based export via RVFC), capture
          // the current frame directly without seeking. Otherwise fall back to
          // seek-based capture (used for browsers without RVFC).
          const bitmap = videoClone.paused
            ? await renderer.renderVideoFrameAtTime(entitySnapshot, timestampSeconds, videoClone)
            : await renderer.renderCurrentVideoFrame(entitySnapshot, videoClone);
          if (!bitmap) {
            throw new Error("Failed to render frame");
          }
          return bitmap;
        };
      } else {
        // GIF path: no video clone needed, use GIF frame lookup
        animatedSource = {
          width: entity.originalSize.width,
          height: entity.originalSize.height,
          duration: entity.mediaSource.duration,
          videoElement: null,
        };

        renderFrame = async (timestampSeconds: number): Promise<ImageBitmap> => {
          if (shouldAnimateShaderTime) {
            entitySnapshot.shaderParams.time = initialShaderTime + timestampSeconds;
          }
          const bitmap = await renderer.renderGifFrameAtTime(entitySnapshot, timestampSeconds);
          if (!bitmap) {
            throw new Error("Failed to render GIF frame");
          }
          return bitmap;
        };
      }

      // Start export with the animated source
      const handle = exportVideo(animatedSource, renderFrame, nextJob.options);
      currentHandleRef.current = handle;

      // Prevent unhandled rejection when cancelled
      handle.result.catch(() => {});

      // Consume progress
      for await (const progress of handle.progress) {
        updateJob(nextJob.id, { progress });
      }

      // Wait for result
      let videoBlob = await handle.result;

      // Check if cancelled during video export
      if (cancelledJobIdRef.current === nextJob.id) {
        throw new Error("Export cancelled");
      }

      // Handle audio muxing for MP4 format (only for video entities with audio)
      const needsManualAudioMux =
        entity.mediaSource.type === MediaType.video &&
        nextJob.options.format === "mp4" &&
        nextJob.options.includeAudio &&
        formatSupportsAudio(nextJob.options.format ?? "mp4");

      if (needsManualAudioMux && entity.mediaSource.type === MediaType.video) {
        const totalFrames = Math.ceil(
          entity.mediaSource.videoElement.duration * (nextJob.options.fps ?? 30),
        );

        updateJob(nextJob.id, {
          progress: {
            frame: totalFrames,
            totalFrames,
            percent: 0,
            stage: "extracting-audio",
            message: "Extracting audio from original video...",
          },
        });

        // Fetch original video for audio extraction
        const response = await fetch(entity.mediaSource.videoElement.src);
        const originalVideoBlob = await response.blob();

        // Mux audio into processed video
        videoBlob = await addAudioToProcessedVideo(
          originalVideoBlob,
          videoBlob,
          (ffmpegProgress) => {
            updateJob(nextJob.id, {
              progress: {
                frame: totalFrames,
                totalFrames,
                percent: ffmpegProgress.percent,
                stage: ffmpegProgress.stage === "muxing" ? "adding-audio" : "extracting-audio",
                message: ffmpegProgress.message,
              },
            });
          },
        );

        // Check if cancelled during FFmpeg muxing
        if (cancelledJobIdRef.current === nextJob.id) {
          throw new Error("Export cancelled");
        }
      }

      // Auto-download the result
      const url = URL.createObjectURL(videoBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = nextJob.outputFileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      logger.info(`Export completed: ${nextJob.outputFileName}`);

      // Remove from queue after successful download
      removeJob(nextJob.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Export failed";

      // Only mark as failed if not cancelled
      if (message !== "Export cancelled") {
        logger.error(`Export failed: ${nextJob.outputFileName}`, err);
        updateJob(nextJob.id, {
          status: "failed",
          error: message,
        });
      }
    } finally {
      // Cleanup
      currentHandleRef.current = null;
      if (currentVideoCloneRef.current) {
        currentVideoCloneRef.current.src = "";
        currentVideoCloneRef.current = null;
      }
      isProcessingRef.current = false;
      cancelledJobIdRef.current = null;
      jobEntityRefs.current.delete(nextJob.id);

      // Clear currentJobId - useEffect will trigger next job processing
      setState((prev) => ({ ...prev, currentJobId: null }));
    }
  };

  // Store entity/renderer references for jobs (not in state to avoid serialization issues)
  // entitySnapshot contains frozen shaderParams from queue time to prevent mid-export changes
  const jobEntityRefs = useRef<
    Map<
      string,
      {
        entity: ShaderCanvasEntity; // Original reference (for video source/audio)
        entitySnapshot: ShaderCanvasEntity; // Frozen copy (for rendering with snapshotted params)
        renderer: InfiniteCanvasRenderer;
      }
    >
  >(new Map());

  /** Add export to queue */
  const addToQueue = (entity: ShaderCanvasEntity, renderer: InfiniteCanvasRenderer): string => {
    if (!isAnimatedEntity(entity)) {
      throw new Error("Entity is not a video or animated GIF");
    }

    const jobId = generateJobId();
    const hash = Date.now().toString(32);
    const extension = getFormatExtension(exportOptions.format);
    const baseName = entity.name.replace(/\.[^/.]+$/, "");
    const outputFileName = `${hash}-${baseName}-processed.${extension}`;

    const job: ExportJob = {
      id: jobId,
      entityId: entity.id,
      entityName: entity.name,
      outputFileName,
      options: {
        fps: exportOptions.fps,
        format: exportOptions.format,
        quality: exportOptions.quality,
        includeAudio: formatSupportsAudio(exportOptions.format) && exportOptions.includeAudio,
        advanced: {
          resolution: exportOptions.advanced.resolution,
          crf: exportOptions.advanced.crf,
          bitrate: exportOptions.advanced.bitrate,
          twoPass: exportOptions.advanced.twoPass,
          gifDither: exportOptions.advanced.gifDither,
          gifMaxWidth: exportOptions.advanced.gifMaxWidth,
        },
      },
      status: "queued",
      progress: null,
      error: null,
      result: null,
      createdAt: Date.now(),
    };

    // Deep clone the entity for export (freeze shaderParams at queue time)
    // This prevents mid-export parameter changes from affecting the render
    const entitySnapshot: ShaderCanvasEntity = {
      ...entity,
      shaderParams: structuredClone(entity.shaderParams),
      // Note: mediaSource stays as reference (we clone the video element separately)
    };

    // Store entity reference (for video src/audio) and snapshot (for rendering params)
    jobEntityRefs.current.set(jobId, { entity, entitySnapshot, renderer });

    setState((prev) => ({
      ...prev,
      jobs: [...prev.jobs, job],
    }));

    logger.info(`Export queued: ${outputFileName}`);

    return jobId;
  };

  // Ref so the auto-start effect always calls the latest closure without
  // needing the function itself in the dep array (it changes every render).
  const processNextJobRef = useRef(processNextJob);
  processNextJobRef.current = processNextJob;

  // Auto-start processing when jobs are added and nothing is processing
  useEffect(() => {
    const hasQueuedJobs = state.jobs.some((job) => job.status === "queued");
    const isProcessing = state.currentJobId !== null;

    if (hasQueuedJobs && !isProcessing && !isProcessingRef.current) {
      void processNextJobRef.current();
    }
  }, [state.jobs, state.currentJobId]);

  /** Cancel specific job */
  const cancelJob = (jobId: string) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return;

    if (job.status === "queued") {
      // Just remove from queue
      removeJob(jobId);
      jobEntityRefs.current.delete(jobId);
    } else if (job.status === "processing") {
      // Mark this job as cancelled so processNextJob knows to abort
      cancelledJobIdRef.current = jobId;

      // Cancel current video export handle
      if (currentHandleRef.current) {
        currentHandleRef.current.cancel();
      }

      // Terminate FFmpeg to abort any ongoing audio muxing operations
      // This will cause addAudioToProcessedVideo to throw, triggering cleanup
      terminateFFmpeg();

      updateJob(jobId, { status: "cancelled" });
    }
  };

  /** Cancel all jobs */
  const cancelAll = () => {
    // Cancel current processing job
    if (currentHandleRef.current) {
      currentHandleRef.current.cancel();
    }

    // Terminate FFmpeg to abort any ongoing operations
    terminateFFmpeg();

    // Reset processing state
    isProcessingRef.current = false;
    cancelledJobIdRef.current = null;

    // Clear all jobs
    setState({ jobs: [], currentJobId: null });
    jobEntityRefs.current.clear();
  };

  /** Clear completed/failed jobs */
  const clearCompleted = () => {
    setState((prev) => {
      const remainingJobs = prev.jobs.filter(
        (job) =>
          job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled",
      );
      // Also clear currentJobId if the current job was removed
      const currentJobRemoved =
        prev.currentJobId !== null && !remainingJobs.some((job) => job.id === prev.currentJobId);

      return {
        ...prev,
        jobs: remainingJobs,
        currentJobId: currentJobRemoved ? null : prev.currentJobId,
      };
    });
  };

  /** Get queue statistics */
  const getQueueStats = (): QueueStats => {
    const stats: QueueStats = {
      queued: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: state.jobs.length,
    };

    for (const job of state.jobs) {
      switch (job.status) {
        case "queued":
          stats.queued++;
          break;
        case "processing":
          stats.processing++;
          break;
        case "completed":
          stats.completed++;
          break;
        case "failed":
        case "cancelled":
          stats.failed++;
          break;
      }
    }

    return stats;
  };

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (currentHandleRef.current) {
        currentHandleRef.current.cancel();
      }
      if (currentVideoCloneRef.current) {
        currentVideoCloneRef.current.src = "";
      }
      // Terminate FFmpeg to clean up any ongoing operations
      terminateFFmpeg();
    };
  }, []);

  const isExporting = state.currentJobId !== null;

  return (
    <ExportQueueContext.Provider
      value={{
        state,
        exportOptions,
        updateExportOptions,
        addToQueue,
        cancelJob,
        cancelAll,
        clearCompleted,
        getQueueStats,
        isExporting,
        preloadFFmpeg,
        syncFpsWithEntity,
      }}
    >
      {children}
    </ExportQueueContext.Provider>
  );
}
