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

## Many-entity suite

The opt-in many-entity suite keeps the original core suite fast while covering
the canvas virtualization and texture-residency paths:

- 10,000 instances sharing one 1024px asset, both all-visible and culled;
- a viewport sweep across the 10,000-instance world;
- 4,096 unique thumbnail assets, both all-visible and swept through the cache;
- 2,048 identically processed instances sharing one source and processed result.

Run the whole suite headlessly:

```bash
bun run bench:render:record -- --suite many-entity
```

Run one large scenario without running the rest:

```bash
bun run bench:render:record -- --scenario many-10000-shared-original-all-visible
bun run bench:render:record -- --scenario many-4096-unique-thumbnails-pan
```

In the interactive page, use **Run Many Entity**, or open:

```text
http://127.0.0.1:5175/bench/render.html?suite=many-entity
```

Large-result records include more than timings. Each scenario reports:

- estimated decoded image bytes (unique assets, not entity count);
- current and peak resident GPU bytes;
- source, processed-output, processing-cache, and pooled texture counts and bytes;
- average/min/max rendered entities per frame;
- source uploads, source/processed allocations, and cache evictions.

The decoded-byte value is a deterministic RGBA estimate. GPU values come from
the renderer's own resource accounting and therefore cover persistent entity
textures and idle pooled textures, but not implementation-private browser/driver
memory.

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
bun run bench:render:compare -- baseline.json candidate.json --metric peakResidentBytes
bun run bench:render:compare -- baseline.json candidate.json --metric sourceUploads
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
BENCH_SUITE=many-entity bun run bench:render:record
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
