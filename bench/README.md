# Render Benchmark Harness

Browser-only benchmark page for real Voidmesh renderer scenarios. It uses
`InfiniteCanvasRenderer`, synthetic high-resolution images, and a canvas-backed
synthetic video element so it can run without manual file drops.

Run:

```bash
bun run bench:render
```

Then open:

```text
http://127.0.0.1:5175/bench/render.html?autorun=1
```

The page writes JSON results into the `#results` element and sets
`document.documentElement.dataset.benchComplete = "1"` when all scenarios have
finished. It also logs a `[voidmesh-render-bench]` JSON payload to the console.

The timings are queue-drain batch timings using `GPUQueue.onSubmittedWorkDone()`.
They are relative measurements, not exact per-pass GPU timestamps. They are meant
for A/B comparison of renderer and shader changes when WebGPU timestamp queries
are unavailable.

For deterministic flowing-glass visual comparisons, open:

```text
http://127.0.0.1:5175/bench/render.html?visual=flowing-glass
```

This renders one fixed frame with `timeAutoPlay: false` and `time = 1.75`, then
sets `document.documentElement.dataset.benchVisualComplete = "1"` so browser
automation can screenshot the canvas.
