import { useEffect, useState } from "react";
import type { ActionLayerBenchmarkResult } from "#application/canvas/action-layer-benchmark.ts";
import {
  useCanvasInteraction,
  useCanvasPerformance,
  useCanvasRendererService,
} from "#context/use-canvas.ts";
import { downloadBlob } from "#lib/download.ts";
import { closeOverlapBenchmarkMode } from "#lib/overlap-benchmark-mode.ts";
import { Button } from "#ui/button/button.tsx";
import "./action-layer-benchmark-panel.css";

function formatNumber(value: number, suffix = ""): string {
  return `${value.toFixed(1)}${suffix}`;
}

function resultFilename(result: ActionLayerBenchmarkResult): string {
  return `voidmesh-overlap-bench-${result.recordedAt.replaceAll(":", "-")}.json`;
}

export default function ActionLayerBenchmarkPanel() {
  const benchmark = useCanvasPerformance();
  const interaction = useCanvasInteraction();
  const { renderer } = useCanvasRendererService();
  const [running, setRunning] = useState(false);
  const [showBounds, setShowBounds] = useState(false);
  const [result, setResult] = useState<ActionLayerBenchmarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!showBounds) return;
    renderer?.setWlurInvalidationDebug(true);
    interaction.markContainerDirty();
    return () => {
      renderer?.setWlurInvalidationDebug(false);
      interaction.markContainerDirty();
    };
  }, [interaction, renderer, showBounds]);

  const run = async () => {
    setRunning(true);
    setResult(null);
    setError(null);
    try {
      setResult(await benchmark.runActionLayerBenchmark());
    } catch (runError) {
      if (runError instanceof DOMException && runError.name === "AbortError") return;
      setError(runError instanceof Error ? runError.message : "Benchmark failed");
    } finally {
      setRunning(false);
    }
  };

  const exportResult = async () => {
    if (!result) return;
    const json = JSON.stringify(result, null, 2);
    const filename = resultFilename(result);
    const file = new File([json], filename, { type: "application/json" });
    try {
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: "Voidmesh overlap benchmark", files: [file] });
        return;
      }
      downloadBlob(file, filename);
    } catch (shareError) {
      if (shareError instanceof DOMException && shareError.name === "AbortError") return;
      setError(shareError instanceof Error ? shareError.message : "Could not export result");
    }
  };

  return (
    <aside className="action-benchmark" aria-label="Overlap benchmark">
      <div className="action-benchmark__actions">
        {running ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={benchmark.cancelActionLayerBenchmark}
          >
            Cancel
          </Button>
        ) : (
          <>
            <Button type="button" size="sm" onClick={() => void run()}>
              Run benchmark
            </Button>
            {result && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => void exportResult()}
              >
                Export JSON
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant={showBounds ? "secondary" : "quiet"}
              aria-pressed={showBounds}
              title="Debug overlay changes benchmark timings"
              onClick={() => setShowBounds((visible) => !visible)}
            >
              Bounds
            </Button>
            <Button type="button" size="sm" variant="quiet" onClick={closeOverlapBenchmarkMode}>
              Close
            </Button>
          </>
        )}
      </div>
      {showBounds && (
        <div className="action-benchmark__legend" aria-label="Invalidation bounds legend">
          <span data-color="source">Wlur source</span>
          <span data-color="global">Global</span>
          <span data-color="lens">Lens source</span>
          <span data-color="animated">Animated</span>
          <span data-color="action">Action</span>
          <span data-color="drag">Drag</span>
          <span data-color="label">Label</span>
        </div>
      )}
      {running && <p className="action-benchmark__status">Running. Keep foregrounded.</p>}
      {error && <p className="action-benchmark__error">{error}</p>}
      {result && (
        <div className="action-benchmark__result">
          <div className="action-benchmark__result-line">
            <span>FPS</span>
            <strong>{formatNumber(result.phases.toggling.rendered.fps)}</strong>
          </div>
          <div className="action-benchmark__result-line">
            <span>p95</span>
            <strong>{formatNumber(result.phases.toggling.rendered.intervalMs.p95, " ms")}</strong>
          </div>
          <div className="action-benchmark__result-line">
            <span>Missed</span>
            <strong>
              {formatNumber(result.phases.toggling.rendered.missedRefreshPercent, "%")}
            </strong>
          </div>
          <div className="action-benchmark__result-line">
            <span>Validity</span>
            <strong>{result.validity.accepted ? "Accepted" : "Reject"}</strong>
          </div>
        </div>
      )}
    </aside>
  );
}
