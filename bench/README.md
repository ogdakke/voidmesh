# Render Benchmark Harness

Browser-only benchmark page for real Voidmesh renderer scenarios. It uses
`InfiniteCanvasRenderer`, synthetic high-resolution images, and a canvas-backed
synthetic video element so it can run without manual file drops.

Interactive run:

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

Recorded run:

```bash
bun run bench:render:record
```

This starts Vite, launches Chrome through the DevTools protocol, runs the full
suite, and writes:

```text
bench/results/render-bench-<timestamp>-<commit>.json
bench/results/latest.json
```

Each record includes git branch/commit/dirty state, browser and WebGPU metadata,
`immediate_address_space` support, adapter limits, and per-sample timings.
`bench/results` is for local artifacts and is ignored by git except for
`.gitkeep`.

Run one scenario:

```bash
bun run bench:render:record -- --scenario image-flowing-glass-4k-continuous
```

Run multiple rounds and store a median aggregate:

```bash
bun run bench:render:record -- --scenario image-flowing-glass-4k-continuous --rounds 5
```

Show the browser while recording:

```bash
bun run bench:render:record -- --headed
```

Force the uniform-buffer path when comparing immediate experiments:

```bash
bun run bench:render:record -- --scenario image-flowing-glass-4k-continuous --disable-immediates
```

Compare two recorded runs:

```bash
bun run bench:render:compare -- bench/results/baseline.json bench/results/candidate.json
```

The compare command matches scenarios by id and reports deltas for `msPerFrame`
by default. It exits non-zero when a scenario regresses by at least 10% and at
least 0.1 ms/frame.

Other useful compare modes:

```bash
bun run bench:render:compare -- baseline.json candidate.json --metric queueDrainMsPerFrame
bun run bench:render:compare -- baseline.json candidate.json --warn-regression 3 --fail-regression 7
bun run bench:render:compare -- baseline.json candidate.json --min-regression-ms 0.25
bun run bench:render:compare -- baseline.json candidate.json --json
```

Useful environment overrides:

```bash
BENCH_CHROME="/path/to/Google Chrome" bun run bench:render:record
BENCH_OUT_DIR=bench/results/immediates bun run bench:render:record
BENCH_HEADLESS=0 bun run bench:render:record
BENCH_DISABLE_IMMEDIATES=1 bun run bench:render:record
```

Recommended local A/B loop:

```bash
BENCH_OUT_DIR=bench/results/baseline bun run bench:render:record -- --rounds 3
BENCH_OUT_DIR=bench/results/candidate bun run bench:render:record -- --rounds 3
bun run bench:render:compare -- bench/results/baseline/latest.json bench/results/candidate/latest.json
```

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
