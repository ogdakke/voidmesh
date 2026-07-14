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
- 262,144 identically processed instances panned at overview zoom with no,
  single, half, and full selection, plus half-selection debug mode;
- the same 262,144-instance overview with half the entities translated through
  the transient selected-group drag uniform;
- a 61-source mixed image/video canvas zoomed from one detailed entity out to
  the full overview and back, both original and default-effect variants.

Run the whole suite headlessly:

```bash
bun run bench:render:record -- --suite many-entity
```

Run one large scenario without running the rest:

```bash
bun run bench:render:record -- --scenario many-10000-shared-original-all-visible
bun run bench:render:record -- --scenario many-4096-unique-thumbnails-pan
bun run bench:render:record -- --scenario many-262144-shared-processed-overview-pan-half-selected
bun run bench:render:record -- --scenario many-262144-shared-processed-overview-pan-half-selected-debug
bun run bench:render:record -- --scenario many-262144-shared-processed-overview-drag-half-selected
bun run bench:render:record -- --scenario zoom-61-unique-mixed-round-trip
bun run bench:render:record -- --scenario zoom-61-unique-mixed-processed-round-trip
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
- persistent full-scene batch rebuild count and full-scene/normal instance upload bytes.

The decoded-byte value is a deterministic RGBA estimate. GPU values come from
the renderer's own resource accounting and therefore cover persistent entity
textures and idle pooled textures, but not implementation-private browser/driver
memory.

Run the opt-in CPU benchmark for Command-A aggregation and the one-time drag
commit separately:

```bash
bun run --bun vitest bench bench/large-selection-operations.bench.ts --run
```

### Mixed-media zoom regression

The zoom scenarios model the reported interactive workspace rather than a
steady-state render loop:

- 45 unique 2048×1365 images and 16 unique 1280×720 canvas-backed videos;
- a world grid that starts with one target in detail, zooms out until all 61
  entities are visible, holds the overview, then zooms back into that target;
- three independent runs with renderer-owned entity textures cleared before
  each gesture;
- actual `requestAnimationFrame` pacing, with the GPU queue drained only after
  the gesture, so browser/GPU backpressure remains visible.

`zoom-61-unique-mixed-round-trip` uses `showOriginal: true` to isolate image LOD
and external-video composition. The `processed` variant uses the application
defaults (dithering, grain, and bloom) and therefore also measures screen-space
video processing without pausing playback or media timeline progression.

Each recorded frame contains its phase, zoom, rAF interval, renderer CPU time,
renderer setup/preparation/admission/query/encode/submit phase timings,
rendered entity count, resident bytes, texture counts, and per-frame
allocation/upload/eviction deltas. Synthetic video source drawing is excluded
from renderer timing and reported separately as `sourceUpdateMs`.

For this regression, compare `rafIntervalP95Ms` for visible stutter and
`cpuRenderP95Ms` for the same CPU duration shown by the in-app performance
overlay:

```bash
bun run bench:render:compare -- baseline.json candidate.json --metric rafIntervalP95Ms
bun run bench:render:compare -- baseline.json candidate.json --metric cpuRenderP95Ms
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

Most scenarios use queue-drain batch timings through
`GPUQueue.onSubmittedWorkDone()`. The mixed-media zoom scenarios instead use
real rAF pacing and drain once after each gesture; per-frame GPU-complete timing
is intentionally omitted there because synchronizing every frame removes the
queue backpressure being measured. These are relative measurements, not exact
per-pass GPU timestamps, and are intended for A/B comparison when WebGPU
timestamp queries are unavailable.

For deterministic flowing-glass visual comparisons, open:

```text
http://127.0.0.1:5175/bench/render.html?visual=flowing-glass
```

This renders one fixed frame with `timeAutoPlay: false` and `time = 1.75`, then
sets `document.documentElement.dataset.benchVisualComplete = "1"` so browser
automation can screenshot the canvas.
