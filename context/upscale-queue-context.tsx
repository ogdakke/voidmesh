/**
 * Upscale Queue Context — Manages background upscaling jobs.
 *
 * Queues upscale requests, processes sequentially (GPU is single-threaded),
 * and creates new canvas entities from upscaled results.
 *
 * Supports image, GIF, and video entities. Jobs are sorted by padded
 * dimensions before processing to maximize GPU network cache hits.
 */

import { useState, useRef, useEffect, useEffectEvent, type PropsWithChildren } from "react";
import { flushSync } from "react-dom";
import { UpscaleQueueContext } from "./use-upscale-queue.ts";
import { useCanvasCommands, useCanvasInteraction, useCanvasRendererService } from "./use-canvas.ts";
import { MediaType, type ShaderCanvasEntity } from "#types/canvas.ts";
import { UpscaleService } from "#renderer/upscale/upscale-service.ts";
import type { ModelSize, ContentVariant } from "#renderer/upscale/upscale-types.ts";
import {
  createImageEntityData,
  createGifEntityData,
  createVideoEntityData,
  loadVideo,
} from "#lib/media-loader.ts";
import { encodeGifFromFrames } from "#lib/gif-encoder.ts";
import { logger } from "#lib/client.logger.ts";
import { toastManager } from "#application/notifications.ts";
import type { FrameEncoderHandle } from "#renderer/frame-encoder.ts";

// ============================================================================
// Types
// ============================================================================

export interface UpscaleSettings {
  size: ModelSize;
  variant: ContentVariant;
}

const DEFAULT_UPSCALE_SETTINGS: UpscaleSettings = { size: "m", variant: "rl" };

export type UpscaleJobType = "image" | "gif" | "video";
export type UpscaleJobStatus = "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface UpscaleProgress {
  frame: number;
  totalFrames: number;
  percent: number;
  stage: "upscaling" | "encoding" | "loading" | "done";
}

export interface UpscaleJob {
  id: string;
  entityId: string;
  entityName: string;
  type: UpscaleJobType;
  status: UpscaleJobStatus;
  progress: UpscaleProgress | null;
  error: string | null;
  resultEntityId: string | null;
  createdAt: number;
}

interface UpscaleQueueState {
  jobs: UpscaleJob[];
  currentJobId: string | null;
}

export interface QueueStats {
  queued: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
}

export interface UpscaleQueueContextValue {
  state: UpscaleQueueState;
  addToUpscaleQueue: (entityIds: string[]) => void;
  cancelJob: (jobId: string) => void;
  clearCompleted: () => void;
  getQueueStats: () => QueueStats;
  isUpscaling: boolean;
  upscaleSettings: UpscaleSettings;
  setUpscaleSettings: (updates: Partial<UpscaleSettings>) => void;
}

// ============================================================================
// Helpers
// ============================================================================

const ENTITY_GAP = 30;

function generateJobId(): string {
  return `upscale-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function getJobType(entity: ShaderCanvasEntity): UpscaleJobType {
  switch (entity.mediaSource.type) {
    case MediaType.video:
      return "video";
    case MediaType.gif:
      return "gif";
    default:
      return "image";
  }
}

function getMediaLabel(type: UpscaleJobType): string {
  switch (type) {
    case "video":
      return "video";
    case "gif":
      return "GIF";
    case "image":
      return "image";
  }
}

/** Convert ImageBitmap to PNG Blob via OffscreenCanvas */
async function bitmapToBlob(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/png" });
}

// ============================================================================
// Provider
// ============================================================================

export function UpscaleQueueProvider({ children }: PropsWithChildren) {
  const interaction = useCanvasInteraction();
  const { addEntity } = useCanvasCommands();
  const { renderer } = useCanvasRendererService();

  const [state, setState] = useState<UpscaleQueueState>({
    jobs: [],
    currentJobId: null,
  });

  const [upscaleSettings, setUpscaleSettingsState] =
    useState<UpscaleSettings>(DEFAULT_UPSCALE_SETTINGS);

  const setUpscaleSettings = (updates: Partial<UpscaleSettings>) => {
    setUpscaleSettingsState((prev) => ({ ...prev, ...updates }));
  };

  const isProcessingRef = useRef(false);
  const cancelledJobIdRef = useRef<string | null>(null);
  const currentVideoHandleRef = useRef<FrameEncoderHandle | null>(null);
  const upscaleServiceRef = useRef<UpscaleService | null>(null);

  // Store entity snapshots for pending jobs (entity may be modified/deleted while queued)
  const jobEntitySnapshotsRef = useRef<Map<string, ShaderCanvasEntity>>(new Map());
  // Toast IDs for progress updates (jobId → toastId)
  const jobToastIdsRef = useRef<Map<string, string>>(new Map());
  // Auto-removal timeouts (cleared on unmount)
  const removalTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  /** Get or create upscale service (lazy, persists across jobs for GPU cache) */
  const getUpscaleService = (): UpscaleService | null => {
    if (upscaleServiceRef.current) return upscaleServiceRef.current;
    const device = renderer?.device;
    if (!device) return null;
    upscaleServiceRef.current = new UpscaleService(device);
    return upscaleServiceRef.current;
  };

  const updateJob = (jobId: string, updates: Partial<UpscaleJob>) => {
    setState((prev) => ({
      ...prev,
      jobs: prev.jobs.map((job) => (job.id === jobId ? { ...job, ...updates } : job)),
    }));
  };

  const removeJob = (jobId: string) => {
    const remove = () => {
      flushSync(() => {
        setState((prev) => ({
          ...prev,
          jobs: prev.jobs.filter((job) => job.id !== jobId),
          currentJobId: prev.currentJobId === jobId ? null : prev.currentJobId,
        }));
      });
      jobEntitySnapshotsRef.current.delete(jobId);
    };
    if ("startViewTransition" in document) {
      document.startViewTransition(remove);
    } else {
      remove();
    }
  };

  // --------------------------------------------------------------------------
  // Processing pipeline
  // --------------------------------------------------------------------------

  /** Update toast description for a job (throttled naturally by frame callbacks) */
  const updateToastProgress = (jobId: string, description: string) => {
    const tid = jobToastIdsRef.current.get(jobId);
    if (tid) toastManager.update(tid, { description });
  };

  // -- Image upscale --

  async function processImageUpscale(
    job: UpscaleJob,
    entity: ShaderCanvasEntity,
    service: UpscaleService,
  ): Promise<string> {
    updateJob(job.id, {
      progress: { frame: 0, totalFrames: 1, percent: 0, stage: "upscaling" },
    });

    const upscaledBitmap = await service.upscale(entity.imageBitmap, upscaleSettings);

    if (cancelledJobIdRef.current === job.id) {
      upscaledBitmap.close();
      throw new Error("Upscale cancelled");
    }

    updateJob(job.id, {
      progress: { frame: 1, totalFrames: 1, percent: 0.9, stage: "encoding" },
    });

    const blob = await bitmapToBlob(upscaledBitmap);
    const position = {
      x: entity.position.x + entity.size.width + ENTITY_GAP,
      y: entity.position.y,
    };

    const entityData = createImageEntityData(upscaledBitmap, blob, position);
    return addEntity(
      {
        ...entityData,
        shaderType: entity.shaderType,
        shaderParams: structuredClone(entity.shaderParams),
      },
      `${entity.name} (2×)`,
    );
  }

  // -- GIF upscale --

  async function processGifUpscale(
    job: UpscaleJob,
    entity: ShaderCanvasEntity,
    service: UpscaleService,
  ): Promise<string> {
    if (entity.mediaSource.type !== MediaType.gif) throw new Error("Entity is not a GIF");

    const sourceFrames = entity.mediaSource.frames;
    const totalFrames = sourceFrames.length;

    // Clone frames so we don't close the source entity's bitmaps
    const clonedFrames = await Promise.all(
      sourceFrames.map(async (frame) => ({
        bitmap: await createImageBitmap(frame.bitmap),
        delay: frame.delay,
        timestamp: frame.timestamp,
      })),
    );

    const upscaledFrames = await service.upscaleGif(
      clonedFrames,
      upscaleSettings,
      (frame, total) => {
        if (cancelledJobIdRef.current === job.id) return true;
        updateJob(job.id, {
          progress: {
            frame,
            totalFrames: total,
            percent: (frame / total) * 0.7,
            stage: "upscaling",
          },
        });
        updateToastProgress(job.id, `Upscaling frame ${frame}/${total}`);
      },
    );

    updateJob(job.id, {
      progress: { frame: totalFrames, totalFrames, percent: 0.7, stage: "encoding" },
    });
    updateToastProgress(job.id, "Encoding GIF...");

    const outW = upscaledFrames[0]!.bitmap.width;
    const outH = upscaledFrames[0]!.bitmap.height;
    const gifBlob = await encodeGifFromFrames(upscaledFrames, outW, outH, (frame, total) => {
      updateJob(job.id, {
        progress: {
          frame,
          totalFrames: total,
          percent: 0.7 + (frame / total) * 0.25,
          stage: "encoding",
        },
      });
    });

    // Calculate duration/fps from frames
    const totalDurationMs = upscaledFrames.reduce((sum, f) => sum + f.delay, 0);
    const duration = totalDurationMs / 1000;
    const fps = totalFrames / Math.max(duration, 0.001);

    const position = {
      x: entity.position.x + entity.size.width + ENTITY_GAP,
      y: entity.position.y,
    };

    const entityData = createGifEntityData(
      { frames: upscaledFrames, width: outW, height: outH, duration, fps },
      gifBlob,
      position,
    );

    return addEntity(
      {
        ...entityData,
        shaderType: entity.shaderType,
        shaderParams: structuredClone(entity.shaderParams),
      },
      `${entity.name} (2×)`,
    );
  }

  // -- Video upscale --

  async function processVideoUpscale(
    job: UpscaleJob,
    entity: ShaderCanvasEntity,
    service: UpscaleService,
  ): Promise<string> {
    if (entity.mediaSource.type !== MediaType.video) throw new Error("Entity is not a video");

    updateJob(job.id, {
      progress: { frame: 0, totalFrames: 0, percent: 0, stage: "upscaling" },
    });

    const sourceBlob = entity.mediaSource.blob;
    const handle = service.upscaleVideo(sourceBlob, {
      size: upscaleSettings.size,
      variant: upscaleSettings.variant,
    });
    currentVideoHandleRef.current = handle;

    // Prevent unhandled rejection if cancelled
    handle.result.catch(() => {});

    // Consume progress
    for await (const p of handle.progress) {
      if (cancelledJobIdRef.current === job.id) break;
      const stage = p.stage === "muxing" ? "encoding" : "upscaling";
      updateJob(job.id, {
        progress: {
          frame: p.frame,
          totalFrames: p.totalFrames,
          percent: p.percent * 0.85,
          stage,
        },
      });
      const pct = Math.round(p.percent * 100);
      updateToastProgress(
        job.id,
        stage === "encoding"
          ? `Encoding video... ${pct}%`
          : `Upscaling frame ${p.frame}/${p.totalFrames}`,
      );
    }

    if (cancelledJobIdRef.current === job.id) {
      handle.cancel();
      throw new Error("Upscale cancelled");
    }

    const videoBlob = await handle.result;

    updateJob(job.id, {
      progress: { frame: 0, totalFrames: 0, percent: 0.9, stage: "loading" },
    });
    updateToastProgress(job.id, "Loading video...");

    // Load the upscaled video to create a playable entity
    const videoResult = await loadVideo(videoBlob);
    const position = {
      x: entity.position.x + entity.size.width + ENTITY_GAP,
      y: entity.position.y,
    };

    const entityData = createVideoEntityData(videoResult, videoBlob, position);

    return addEntity(
      {
        ...entityData,
        shaderType: entity.shaderType,
        shaderParams: structuredClone(entity.shaderParams),
      },
      `${entity.name} (2×)`,
    );
  }

  const processNextJob = useEffectEvent(async () => {
    if (isProcessingRef.current) return;

    // Read latest jobs via setState callback to avoid stale closure
    const nextJob = await new Promise<UpscaleJob | null>((resolve) => {
      setState((prev) => {
        const found = prev.jobs.find((job) => job.status === "queued");
        if (!found) {
          resolve(null);
          return { ...prev, currentJobId: null };
        }
        resolve(found);
        return { ...prev, currentJobId: found.id };
      });
    });
    if (!nextJob) return;

    isProcessingRef.current = true;
    updateJob(nextJob.id, { status: "processing" });

    // Show progress toast (persistent until done, with cancel action)
    let toastId!: string;
    const cancelFromToast = () => {
      cancelledJobIdRef.current = nextJob.id;
      if (currentVideoHandleRef.current) {
        currentVideoHandleRef.current.cancel();
      }
      updateJob(nextJob.id, { status: "cancelled" });
      toastManager.close(toastId);
    };
    toastId = toastManager.add({
      title: `Upscaling ${nextJob.entityName}`,
      description: getMediaLabel(nextJob.type) === "image" ? "Processing..." : "Starting...",
      timeout: 0,
      actionProps: {
        children: "Cancel",
        onClick: cancelFromToast,
      },
    });
    jobToastIdsRef.current.set(nextJob.id, toastId);

    try {
      const entity = jobEntitySnapshotsRef.current.get(nextJob.id);
      if (!entity) throw new Error("Entity snapshot not found for job");

      const service = getUpscaleService();
      if (!service) throw new Error("GPU device not available for upscaling");

      if (cancelledJobIdRef.current === nextJob.id) throw new Error("Upscale cancelled");

      let resultEntityId: string;

      switch (nextJob.type) {
        case "image":
          resultEntityId = await processImageUpscale(nextJob, entity, service);
          break;
        case "gif":
          resultEntityId = await processGifUpscale(nextJob, entity, service);
          break;
        case "video":
          resultEntityId = await processVideoUpscale(nextJob, entity, service);
          break;
      }

      updateJob(nextJob.id, {
        status: "completed",
        resultEntityId,
        progress: { frame: 1, totalFrames: 1, percent: 1, stage: "done" },
      });

      logger.info(`Upscale completed: ${entity.name} → ${resultEntityId}`);

      // Update toast to show completion
      const doneToastId = jobToastIdsRef.current.get(nextJob.id);
      if (doneToastId) {
        toastManager.update(doneToastId, {
          title: `Upscaled ${nextJob.entityName}`,
          description: "Added to canvas",
          timeout: 4000,
          actionProps: { children: null },
        });
      }

      // Auto-remove completed job after a short delay
      const completedJobId = nextJob.id;
      const timer = setTimeout(() => {
        removalTimersRef.current.delete(completedJobId);
        removeJob(completedJobId);
      }, 3000);
      removalTimersRef.current.set(completedJobId, timer);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Upscale failed";
      const errToastId = jobToastIdsRef.current.get(nextJob.id);
      if (message !== "Upscale cancelled") {
        logger.error(`Upscale failed: ${nextJob.entityName}`, err);
        updateJob(nextJob.id, { status: "failed", error: message });
        if (errToastId) {
          toastManager.update(errToastId, {
            title: `Upscale failed`,
            description: message,
            timeout: 5000,
          });
        }
      } else if (errToastId) {
        toastManager.close(errToastId);
      }
    } finally {
      jobToastIdsRef.current.delete(nextJob.id);
      currentVideoHandleRef.current = null;
      isProcessingRef.current = false;
      cancelledJobIdRef.current = null;
      jobEntitySnapshotsRef.current.delete(nextJob.id);
      setState((prev) => ({ ...prev, currentJobId: null }));
    }
  });

  // --------------------------------------------------------------------------
  // Queue management
  // --------------------------------------------------------------------------

  // Auto-start processing when jobs are added
  useEffect(() => {
    const hasQueuedJobs = state.jobs.some((job) => job.status === "queued");
    const isProcessing = state.currentJobId !== null;

    if (hasQueuedJobs && !isProcessing && !isProcessingRef.current) {
      void processNextJob();
    }
  }, [state.jobs, state.currentJobId]);

  const addToUpscaleQueue = (entityIds: string[]) => {
    const entities = interaction.getEntities(entityIds);

    if (entities.length === 0) return;

    // Sort by padded dimensions to maximize GPU cache hits
    const WORKGROUP = 8;
    entities.sort((a, b) => {
      const padA =
        Math.ceil(a.originalSize.width / WORKGROUP) * WORKGROUP * 1000 +
        Math.ceil(a.originalSize.height / WORKGROUP) * WORKGROUP;
      const padB =
        Math.ceil(b.originalSize.width / WORKGROUP) * WORKGROUP * 1000 +
        Math.ceil(b.originalSize.height / WORKGROUP) * WORKGROUP;
      return padA - padB;
    });

    const newJobs: UpscaleJob[] = [];

    for (const entity of entities) {
      const jobId = generateJobId();
      const type = getJobType(entity);

      newJobs.push({
        id: jobId,
        entityId: entity.id,
        entityName: entity.name,
        type,
        status: "queued",
        progress: null,
        error: null,
        resultEntityId: null,
        createdAt: Date.now(),
      });

      // Snapshot entity state at queue time — clone ImageBitmap so it survives
      // if the source entity is deleted while the job is queued
      const snapshot: ShaderCanvasEntity = {
        ...entity,
        imageBitmap: entity.imageBitmap,
        shaderParams: structuredClone(entity.shaderParams),
      };
      if (type === "image") {
        // Clone bitmap asynchronously — store a placeholder and replace
        void createImageBitmap(entity.imageBitmap).then((cloned) => {
          const existing = jobEntitySnapshotsRef.current.get(jobId);
          if (existing) existing.imageBitmap = cloned;
        });
      }
      jobEntitySnapshotsRef.current.set(jobId, snapshot);
    }

    setState((prev) => ({
      ...prev,
      jobs: [...prev.jobs, ...newJobs],
    }));

    const label =
      entities.length === 1 ? getMediaLabel(newJobs[0]!.type) : `${entities.length} files`;
    logger.info(`Upscale queued: ${label}`);
  };

  const cancelJob = (jobId: string) => {
    const job = state.jobs.find((j) => j.id === jobId);
    if (!job) return;

    if (job.status === "queued") {
      removeJob(jobId);
    } else if (job.status === "processing") {
      cancelledJobIdRef.current = jobId;
      if (currentVideoHandleRef.current) {
        currentVideoHandleRef.current.cancel();
      }
      updateJob(jobId, { status: "cancelled" });
    }
  };

  const clearCompleted = () => {
    const clear = () => {
      flushSync(() => {
        setState((prev) => ({
          ...prev,
          jobs: prev.jobs.filter(
            (job) =>
              job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled",
          ),
        }));
      });
    };
    if ("startViewTransition" in document) {
      document.startViewTransition(clear);
    } else {
      clear();
    }
  };

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
    const videoHandle = currentVideoHandleRef;
    const timers = removalTimersRef;
    const service = upscaleServiceRef;
    return () => {
      videoHandle.current?.cancel();
      for (const timer of timers.current.values()) {
        clearTimeout(timer);
      }
      timers.current.clear();
      service.current?.destroy();
    };
  }, []);

  return (
    <UpscaleQueueContext.Provider
      value={{
        state,
        addToUpscaleQueue,
        cancelJob,
        clearCompleted,
        getQueueStats,
        isUpscaling: state.currentJobId !== null,
        upscaleSettings,
        setUpscaleSettings,
      }}
    >
      {children}
    </UpscaleQueueContext.Provider>
  );
}
