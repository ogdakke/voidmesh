import { NavArrowRight } from "iconoir-react";
import { Checkbox } from "#ui/checkbox/index.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/native-select/index.ts";
import { useCanvasCommands, useCanvasPreferences } from "#context/use-canvas.ts";
import { useCollaborationMetrics } from "#hooks/use-collaboration.ts";
import { resetOnboardingProgress } from "#lib/onboarding-storage.ts";
import { shareOrCopyUrl } from "./share.ts";
import { CanvasLensing } from "#types/enums.ts";
import "#components/ui/field/field.css";
import "./settings.shared.css";

export function SnapToGridToggle() {
  const { snapToGrid } = useCanvasPreferences();
  const { setSnapToGrid } = useCanvasCommands();
  return (
    <Checkbox
      name="snap_to_grid"
      checked={snapToGrid}
      onChange={(e) => setSnapToGrid(e.target.checked)}
      switch
    >
      Snap to Grid
    </Checkbox>
  );
}

export function FancyDeleteToggle() {
  const { fancyDelete } = useCanvasPreferences();
  const { setFancyDelete } = useCanvasCommands();
  return (
    <Checkbox
      name="fancy_delete"
      checked={fancyDelete}
      onChange={(e) => setFancyDelete(e.target.checked)}
      switch
    >
      Fancy deletions
    </Checkbox>
  );
}

export function HapticsToggle() {
  const { haptics } = useCanvasPreferences();
  const { setHaptics } = useCanvasCommands();
  return (
    <Checkbox
      name="haptics"
      checked={haptics}
      onChange={(e) => setHaptics(e.target.checked)}
      switch
    >
      Haptic feedback
    </Checkbox>
  );
}

export function CanvasLensingSelect() {
  const { canvasLensing } = useCanvasPreferences();
  const { setCanvasLensing } = useCanvasCommands();

  return (
    <div className="native-select-field native-select-field--mobile">
      <label className="ui-field-label settings-label" htmlFor="canvas_lensing">
        Canvas lensing
      </label>
      <NativeSelect
        id="canvas_lensing"
        name="canvas_lensing"
        value={canvasLensing}
        size="sm"
        onChange={(event) => setCanvasLensing(event.target.value as CanvasLensing)}
        variant="quiet"
      >
        <NativeSelectOption value={CanvasLensing.off}>Off</NativeSelectOption>
        <NativeSelectOption value={CanvasLensing.subtle}>Subtle</NativeSelectOption>
        <NativeSelectOption value={CanvasLensing.extreme}>Extreme</NativeSelectOption>
      </NativeSelect>
    </div>
  );
}

export function ShareLink() {
  return (
    <button type="button" onClick={shareOrCopyUrl}>
      <span>Share</span>
    </button>
  );
}

export function CollaborationLink() {
  const { startCollaboration } = useCanvasCommands();
  const metrics = useCollaborationMetrics();

  const startOrShare = async () => {
    if (metrics.status === "idle" || metrics.status === "error") {
      await startCollaboration();
    }
    await shareOrCopyUrl();
  };

  const label =
    metrics.status === "connecting"
      ? "Multiplayer connecting…"
      : metrics.status === "connected"
        ? metrics.peerCount > 0
          ? `Multiplayer · ${metrics.peerCount + 1} here`
          : "Multiplayer · waiting for peers"
        : metrics.status === "error"
          ? "Retry multiplayer"
          : "Start multiplayer";

  return (
    <button
      type="button"
      onClick={() => void startOrShare()}
      disabled={metrics.status === "connecting"}
    >
      <span>{label}</span>
    </button>
  );
}

export function LeaveCollaborationLink() {
  const { stopCollaboration } = useCanvasCommands();
  const metrics = useCollaborationMetrics();
  if (metrics.status === "idle") return null;
  return (
    <button type="button" onClick={stopCollaboration}>
      <span>Leave multiplayer</span>
    </button>
  );
}

export function CollaborationMetrics() {
  const metrics = useCollaborationMetrics();
  if (metrics.status === "idle") return null;
  const lastTransfer = metrics.transfers.at(-1);
  return (
    <div className="collaboration-metrics" aria-label="Multiplayer diagnostics">
      {metrics.lastError && <p className="collaboration-metrics-error">{metrics.lastError}</p>}
      <dl>
        <Metric label="Peers" value={String(metrics.peerCount)} />
        <Metric label="RTT" value={formatDuration(metrics.lastRoundTripTimeMs)} />
        <Metric label="Sent" value={formatBytes(metrics.bytesSent)} />
        <Metric label="Received" value={formatBytes(metrics.bytesReceived)} />
        <Metric label="Hashing" value={formatDuration(metrics.assetHashDurationMs)} />
        <Metric label="Compression" value={formatDuration(metrics.assetCompressionDurationMs)} />
        <Metric label="Media decode" value={formatDuration(metrics.assetDecodeDurationMs)} />
        <Metric label="CRDT apply" value={formatDuration(metrics.documentApplyDurationMs)} />
        <Metric label="Reconcile" value={formatDuration(metrics.documentReconcileDurationMs)} />
        {lastTransfer && (
          <Metric
            label="Last asset"
            value={`${formatBytes(lastTransfer.transmittedBytes)} · ${formatBytes(lastTransfer.throughputBytesPerSecond)}/s · ${lastTransfer.compression}`}
          />
        )}
      </dl>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 1000) return `${durationMs.toFixed(1)} ms`;
  return `${(durationMs / 1000).toFixed(2)} s`;
}

export function FeedbackLink({ className }: { className?: string }) {
  return (
    <a
      href={`mailto:dw@danielwargh.com?subject=${encodeURIComponent("Feedback on voidmesh")}`}
      className={className}
    >
      <span>Send feedback</span>
    </a>
  );
}

export function RedoOnboardingLink({ onDone }: { onDone?: () => void }) {
  const { clearWorkspace } = useCanvasCommands();

  const redoOnboarding = () => {
    clearWorkspace();
    void resetOnboardingProgress();
    onDone?.();
  };

  return (
    <button type="button" onClick={redoOnboarding}>
      <span>Redo onboarding</span>
    </button>
  );
}

export function LinkItem({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <NavArrowRight />
    </>
  );
}
