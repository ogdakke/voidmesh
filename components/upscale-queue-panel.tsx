/**
 * Upscale Queue Panel — Shows queued upscale jobs with progress.
 */

import { Xmark, WarningCircle, NavArrowRight, ScaleFrameEnlarge } from "iconoir-react";
import { useSelectedEntityIds } from "#context/use-canvas.ts";
import { useUpscaleQueue } from "#context/use-upscale-queue.ts";
import type { UpscaleJob, UpscaleJobStatus } from "#context/upscale-queue-context.tsx";
import type { ModelSize, ContentVariant } from "#renderer/upscale/upscale-types.ts";
import { Button } from "#ui/button/index.tsx";
import { Select, SelectItem } from "#ui/select/index.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#ui/collapsible/collapsible.tsx";
import "#styles/sidebar.css";

const MODEL_SIZE_OPTIONS = [
  { value: "s", label: "Fast" },
  { value: "m", label: "Balanced" },
  { value: "l", label: "Quality" },
];

const CONTENT_VARIANT_OPTIONS = [
  { value: "rl", label: "Photo" },
  { value: "an", label: "Anime" },
  { value: "3d", label: "3D Render" },
];

function StatusIcon({ status }: { status: UpscaleJobStatus }) {
  switch (status) {
    case "failed":
    case "cancelled":
      return <WarningCircle className="export-progress__icon export-progress__icon--failed" />;
    default:
      return null;
  }
}

function getStatusLabel(job: UpscaleJob): string {
  switch (job.status) {
    case "queued":
      return "Queued";
    case "processing":
      if (job.progress?.stage === "upscaling") {
        if (job.progress.totalFrames > 1) {
          return `Upscaling ${job.progress.frame}/${job.progress.totalFrames}`;
        }
        return "Upscaling...";
      }
      if (job.progress?.stage === "encoding") {
        return "Encoding...";
      }
      if (job.progress?.stage === "loading") {
        return "Loading...";
      }
      return "Processing...";
    case "completed":
      return "Added to canvas";
    case "failed":
      return job.error || "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}

function UpscaleJobItem({ job }: { job: UpscaleJob }) {
  const { cancelJob } = useUpscaleQueue();

  const isActive = job.status === "processing";
  const canCancel = job.status === "queued" || job.status === "processing";
  const percent = job.progress?.percent ?? 0;

  return (
    <div className="export-progress" style={{ viewTransitionName: `upscale-${job.id}` }}>
      <div className="export-progress__header">
        <StatusIcon status={job.status} />
        <span className="export-progress__label" title={job.entityName}>
          {job.entityName}
        </span>
        {canCancel && (
          <Button
            variant="quiet"
            className="export-progress__cancel"
            onClick={() => cancelJob(job.id)}
            aria-label="Cancel upscale"
          >
            <Xmark />
          </Button>
        )}
      </div>

      {isActive && (
        <progress
          className="export-progress__bar"
          value={percent}
          max={1}
          aria-label={`Upscaling ${job.entityName}`}
        />
      )}

      <span className="export-progress__status">{getStatusLabel(job)}</span>
    </div>
  );
}

export function UpscaleQueuePanel() {
  const selectedEntityIds = useSelectedEntityIds();
  const {
    state,
    addToUpscaleQueue,
    isUpscaling,
    clearCompleted,
    getQueueStats,
    upscaleSettings,
    setUpscaleSettings,
  } = useUpscaleQueue();

  const stats = getQueueStats();
  const hasJobs = state.jobs.length > 0;
  const hasFailedOrCancelled = stats.failed > 0;

  const handleUpscale = () => {
    const selectedIds = [...selectedEntityIds];
    if (selectedIds.length > 0) {
      addToUpscaleQueue(selectedIds);
    }
  };

  const queueCount = stats.queued + stats.processing;
  const title = queueCount > 0 ? `Upscale (${queueCount})` : "Upscale";

  return (
    <Collapsible defaultOpen={false}>
      <CollapsibleTrigger className="sidebar-collapsible-trigger">
        <NavArrowRight />
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="sidebar-row">
          <Select
            label="Model"
            value={upscaleSettings.size}
            onValueChange={(value) => setUpscaleSettings({ size: value as ModelSize })}
            name="upscale-model-size"
            items={MODEL_SIZE_OPTIONS}
          >
            {MODEL_SIZE_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </Select>
          <p className="hint-text">Higher quality produces sharper details but takes longer</p>
        </div>
        <div className="sidebar-row">
          <Select
            label="Content"
            value={upscaleSettings.variant}
            onValueChange={(value) => setUpscaleSettings({ variant: value as ContentVariant })}
            name="upscale-content-variant"
            items={CONTENT_VARIANT_OPTIONS}
          >
            {CONTENT_VARIANT_OPTIONS.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </Select>
          <p className="hint-text">Match this to your source material</p>
        </div>
        <div className="sidebar-row upscale-empty" hidden={hasJobs || undefined}>
          <p className="sidebar-text">Upscale selected images and videos to 2× resolution</p>
          <Button variant="secondary" onClick={handleUpscale} disabled={isUpscaling}>
            <ScaleFrameEnlarge /> <span>Upscale 2×</span>
          </Button>
        </div>
        <div className="upscale-jobs" hidden={!hasJobs || undefined}>
          {hasFailedOrCancelled && (
            <div className="export-queue-header">
              <Button variant="quiet" size="sm" onClick={clearCompleted}>
                Clear
              </Button>
            </div>
          )}
          <div className="export-queue-list">
            {state.jobs.toReversed().map((job) => (
              <UpscaleJobItem key={job.id} job={job} />
            ))}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
