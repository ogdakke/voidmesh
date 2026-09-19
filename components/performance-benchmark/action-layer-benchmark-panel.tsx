import { useState } from "react";
import type { ActionLayerBenchmarkResult } from "#application/canvas/action-layer-benchmark.ts";
import { useCanvasPerformance } from "#context/use-canvas.ts";
import { downloadBlob } from "#lib/download.ts";
import { closeOverlapBenchmarkMode } from "#lib/overlap-benchmark-mode.ts";
import "./action-layer-benchmark-panel.css";

function formatNumber(value: number, suffix = ""): string {
  return `${value.toFixed(1)}${suffix}`;
}

function resultFilename(result: ActionLayerBenchmarkResult): string {
  return `voidmesh-overlap-bench-${result.recordedAt.replaceAll(":", "-")}.json`;
}

export default function ActionLayerBenchmarkPanel() {
  const benchmark = useCanvasPerformance();
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ActionLayerBenchmarkResult | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <div className="action-benchmark__heading">Overlap benchmark</div>
      <p className="action-benchmark__copy">
        Long-press the exact test point once, release, then run. The selected entity or group and
        that point are replayed 120 times through the real touch path, for about 80 seconds total.
        Each press stays active until the overlap and blur transitions finish, then releases and
        starts the next press.
      </p>
      <div className="action-benchmark__actions">
        <button
          className="action-benchmark__button"
          type="button"
          disabled={running}
          onClick={() => void run()}
        >
          {running ? "Running…" : "Run benchmark"}
        </button>
        {running && (
          <button
            className="action-benchmark__button action-benchmark__button--secondary"
            type="button"
            onClick={benchmark.cancelActionLayerBenchmark}
          >
            Cancel
          </button>
        )}
        {result && (
          <button
            className="action-benchmark__button action-benchmark__button--secondary"
            type="button"
            onClick={() => void exportResult()}
          >
            Export JSON
          </button>
        )}
        {!running && (
          <button
            className="action-benchmark__button action-benchmark__button--secondary"
            type="button"
            onClick={closeOverlapBenchmarkMode}
          >
            Close
          </button>
        )}
      </div>
      {running && <p className="action-benchmark__status">Keep the app foregrounded.</p>}
      {error && <p className="action-benchmark__error">{error}</p>}
      {result && (
        <div className="action-benchmark__result">
          <div className="action-benchmark__result-line">
            <span>Toggle rendered FPS</span>
            <strong>{formatNumber(result.phases.toggling.rendered.fps)}</strong>
          </div>
          <div className="action-benchmark__result-line">
            <span>Toggle p95 interval</span>
            <strong>{formatNumber(result.phases.toggling.rendered.intervalMs.p95, " ms")}</strong>
          </div>
          <div className="action-benchmark__result-line">
            <span>Missed 120 Hz refreshes</span>
            <strong>
              {formatNumber(result.phases.toggling.rendered.missedRefreshPercent, "%")}
            </strong>
          </div>
          <div className="action-benchmark__result-line">
            <span>Run validity</span>
            <strong>{result.validity.accepted ? "Accepted" : "Reject"}</strong>
          </div>
          {!result.validity.accepted && (
            <p className="action-benchmark__error">{result.validity.reasons.join(". ")}</p>
          )}
        </div>
      )}
      <p className="action-benchmark__note">Recovery drift rejects unstable runs.</p>
    </aside>
  );
}
