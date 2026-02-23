/**
 * Export Queue Panel - Shows queued exports with progress
 */

import { Xmark, WarningCircle, NavArrowRight } from "iconoir-react";
import { useExportQueue } from "../context/use-export-queue.ts";
import type { ExportJob, ExportJobStatus } from "../context/export-queue-context.tsx";
import { Button } from "./ui/button/index.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible/collapsible.tsx";
import "../styles/sidebar.css";

/** Status icon component */
function StatusIcon({ status }: { status: ExportJobStatus }) {
  switch (status) {
    case "failed":
    case "cancelled":
      return <WarningCircle className="export-progress__icon export-progress__icon--failed" />;
    default:
      return null;
  }
}

/** Get status label for display */
function getStatusLabel(job: ExportJob): string {
  switch (job.status) {
    case "queued":
      return "Queued";
    case "processing":
      if (job.progress?.stage === "extracting") {
        return `Rendering ${job.progress.frame}/${job.progress.totalFrames}`;
      }
      if (job.progress?.stage === "encoding") {
        return "Encoding...";
      }
      if (job.progress?.stage === "muxing") {
        return "Creating file...";
      }
      if (job.progress?.stage === "extracting-audio") {
        return "Extracting audio...";
      }
      if (job.progress?.stage === "adding-audio") {
        return "Adding audio...";
      }
      return "Processing...";
    case "completed":
      return "Downloaded";
    case "failed":
      return job.error || "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Unknown";
  }
}

/** Individual job item in the queue */
function ExportJobItem({ job }: { job: ExportJob }) {
  const { cancelJob } = useExportQueue();

  const isActive = job.status === "processing";
  const canCancel = job.status === "queued" || job.status === "processing";
  const percent = job.progress?.percent ?? 0;

  return (
    <div className="export-progress">
      <div className="export-progress__header">
        <StatusIcon status={job.status} />
        <span className="export-progress__label" title={job.outputFileName}>
          {job.entityName}
        </span>
        {canCancel && (
          <Button
            variant="quiet"
            className="export-progress__cancel"
            onClick={() => cancelJob(job.id)}
            aria-label="Cancel export"
          >
            <Xmark />
          </Button>
        )}
      </div>

      {isActive && (
        <div className="export-progress__bar">
          <div className="export-progress__fill" style={{ width: `${percent * 100}%` }} />
        </div>
      )}

      <span className="export-progress__status">{getStatusLabel(job)}</span>
    </div>
  );
}

/** Export queue panel showing all jobs */
export function ExportQueuePanel() {
  const { state, clearCompleted, getQueueStats } = useExportQueue();

  const stats = getQueueStats();
  const hasJobs = state.jobs.length > 0;
  const hasFailedOrCancelled = stats.failed > 0;

  if (!hasJobs) {
    return null;
  }

  const queueCount = stats.queued + stats.processing;
  const title = queueCount > 0 ? `Export Queue (${queueCount})` : "Export Queue";

  return (
    <Collapsible defaultOpen className="export-queue-collapsible">
      <div className="export-queue-header">
        <CollapsibleTrigger className="sidebar-collapsible-trigger">
          <NavArrowRight />
          {title}
        </CollapsibleTrigger>
        {hasFailedOrCancelled && (
          <Button variant="quiet" size="sm" onClick={clearCompleted}>
            Clear
          </Button>
        )}
      </div>
      <CollapsibleContent>
        <div className="export-queue-list">
          {[...state.jobs].reverse().map((job) => (
            <ExportJobItem key={job.id} job={job} />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
