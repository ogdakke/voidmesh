/**
 * Export Queue Context - Manages concurrent video exports with queue system
 *
 * Key features:
 * - Queue multiple exports that process sequentially (avoids GPU contention)
 * - WebCodecs-based frame decoding via mediabunny (no HTMLVideoElement seeking)
 * - Non-blocking exports that allow continued canvas editing
 * - Auto-download on completion
 * - Audio demuxed from source and sent to worker for muxing (no FFmpeg needed)
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
import type { DemuxedAudio } from "#lib/audio-demux.ts";
import { createFrameIterator, type VideoDemuxHandle } from "#lib/video-demux.ts";
import { logger } from "#lib/client.logger.ts";
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

  /** Sync export FPS with the selected entity's native frame rate */
  syncFpsWithEntity: (entity: ShaderCanvasEntity | null) => void;
}

/** Generate unique job ID */
function generateJobId(): string {
  return `export-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
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
  const currentDemuxRef = useRef<VideoDemuxHandle | null>(null);
  const isProcessingRef = useRef(false);
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

      // Drive shader time externally during export
      const initialShaderTime = entitySnapshot.shaderParams.time ?? 0;
      const shouldAnimateShaderTime = entitySnapshot.shaderParams.timeAutoPlay !== false;
      entitySnapshot.shaderParams.timeAutoPlay = false;

      let animatedSource: AnimatedSource;
      let renderFrame: (timestampSeconds: number) => Promise<ImageBitmap>;

      if (entity.mediaSource.type === MediaType.video) {
        // Video path: decode frames via WebCodecs (mediabunny)
        const { demuxVideo } = await import("#lib/video-demux.ts");
        const demux = await demuxVideo(entity.mediaSource.blob);
        currentDemuxRef.current = demux;

        // Use demux duration for consistent frame counts between decoder and encoder
        animatedSource = {
          width: entity.originalSize.width,
          height: entity.originalSize.height,
          duration: demux.duration,
        };

        const fps = nextJob.options.fps ?? 30;
        const { iterator: frameIterator } = createFrameIterator(demux, fps);

        renderFrame = async (timestampSeconds: number): Promise<ImageBitmap> => {
          if (shouldAnimateShaderTime) {
            entitySnapshot.shaderParams.time = initialShaderTime + timestampSeconds;
          }
          const { value: frameBitmap, done } = await frameIterator.next();
          if (done || !frameBitmap) throw new Error("No more video frames");
          const bitmap = await renderer.renderFrameWithShader(
            entitySnapshot,
            frameBitmap,
            entity.originalSize.width,
            entity.originalSize.height,
          );
          frameBitmap.close();
          if (!bitmap) throw new Error("Failed to render frame");
          return bitmap;
        };
      } else {
        // GIF path: frames are pre-decoded, no demuxing needed
        animatedSource = {
          width: entity.originalSize.width,
          height: entity.originalSize.height,
          duration: entity.mediaSource.duration,
        };

        renderFrame = async (timestampSeconds: number): Promise<ImageBitmap> => {
          if (shouldAnimateShaderTime) {
            entitySnapshot.shaderParams.time = initialShaderTime + timestampSeconds;
          }
          const bitmap = await renderer.renderGifFrameAtTime(entitySnapshot, timestampSeconds);
          if (!bitmap) throw new Error("Failed to render GIF frame");
          return bitmap;
        };
      }

      // Demux audio from source video if needed (before starting export)
      // Audio is sent to the worker and muxed inline — no post-processing needed
      const format = nextJob.options.format ?? "mp4";
      const needsAudio =
        entity.mediaSource.type === MediaType.video &&
        nextJob.options.includeAudio &&
        formatSupportsAudio(format) &&
        format !== "gif";

      let audioData: DemuxedAudio | null = null;

      if (needsAudio && entity.mediaSource.type === MediaType.video) {
        updateJob(nextJob.id, {
          progress: {
            frame: 0,
            totalFrames: 0,
            percent: 0,
            stage: "extracting-audio",
            message: "Extracting audio from source...",
          },
        });

        const { demuxAudio } = await import("#lib/audio-demux.ts");
        audioData = await demuxAudio(entity.mediaSource.blob);
        if (!audioData) {
          throw new Error("Audio extraction returned no audio track from source video");
        }
      }

      if (cancelledJobIdRef.current === nextJob.id) throw new Error("Export cancelled");

      // Start export — audio data is passed directly so it's sent to the worker
      // right after init, guaranteeing correct message ordering
      const handle = exportVideo(animatedSource, renderFrame, nextJob.options, audioData);
      currentHandleRef.current = handle;

      // Prevent unhandled rejection when cancelled
      handle.result.catch(() => {});

      // Consume progress
      for await (const progress of handle.progress) {
        updateJob(nextJob.id, { progress });
      }

      // Wait for result
      const videoBlob = await handle.result;

      if (cancelledJobIdRef.current === nextJob.id) throw new Error("Export cancelled");

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

      if (message !== "Export cancelled") {
        logger.error(`Export failed: ${nextJob.outputFileName}`, err);
        updateJob(nextJob.id, {
          status: "failed",
          error: message,
        });
      }
    } finally {
      currentHandleRef.current = null;
      if (currentDemuxRef.current) {
        currentDemuxRef.current.dispose();
        currentDemuxRef.current = null;
      }
      isProcessingRef.current = false;
      cancelledJobIdRef.current = null;
      jobEntityRefs.current.delete(nextJob.id);

      setState((prev) => ({ ...prev, currentJobId: null }));
    }
  };

  // Store entity/renderer references for jobs
  const jobEntityRefs = useRef<
    Map<
      string,
      {
        entity: ShaderCanvasEntity;
        entitySnapshot: ShaderCanvasEntity;
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
          bitrate: exportOptions.advanced.bitrate,
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

    const entitySnapshot: ShaderCanvasEntity = {
      ...entity,
      shaderParams: structuredClone(entity.shaderParams),
    };

    jobEntityRefs.current.set(jobId, { entity, entitySnapshot, renderer });

    setState((prev) => ({
      ...prev,
      jobs: [...prev.jobs, job],
    }));

    logger.info(`Export queued: ${outputFileName}`);

    return jobId;
  };

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
      removeJob(jobId);
      jobEntityRefs.current.delete(jobId);
    } else if (job.status === "processing") {
      cancelledJobIdRef.current = jobId;
      if (currentHandleRef.current) {
        currentHandleRef.current.cancel();
      }
      updateJob(jobId, { status: "cancelled" });
    }
  };

  /** Cancel all jobs */
  const cancelAll = () => {
    if (currentHandleRef.current) {
      currentHandleRef.current.cancel();
    }

    isProcessingRef.current = false;
    cancelledJobIdRef.current = null;

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
      if (currentDemuxRef.current) {
        currentDemuxRef.current.dispose();
      }
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
        syncFpsWithEntity,
      }}
    >
      {children}
    </ExportQueueContext.Provider>
  );
}
