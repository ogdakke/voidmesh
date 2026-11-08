/**
 * Initial loader renderer. Runs in a worker on an OffscreenCanvas so the animation
 * keeps its frame rate while the main thread parses modules and boots WebGPU. The
 * worker only advances the timeline and uploads uniforms; LoaderDitherRenderer does
 * the per-cell work on the GPU.
 */

import { LoaderDitherRenderer } from "./dither-renderer.ts";
import { layoutPixelText } from "./pixel-font.ts";
import { loaderDitherGrid } from "./layout.ts";

export type ToLoaderWorkerMessage =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      width: number;
      height: number;
      dpr: number;
      reducedMotion: boolean;
    }
  | { type: "resize"; width: number; height: number; dpr: number }
  /** Dev preview: move to the next caption now. */
  | { type: "advance" }
  | { type: "exit" }
  | { type: "replay" }
  | { type: "stats"; enabled: boolean }
  | { type: "dispose" };

export type FromLoaderWorkerMessage =
  | { type: "painted" }
  /** The exit has actually begun (it may be held back after an "exit" request). */
  | { type: "exiting" }
  | { type: "exited" }
  | { type: "stats"; avgMs: number; maxMs: number; fps: number; cells: number };

type Phase = "intro" | "idle" | "exit" | "done";

const INTRO_MS = 1000;
/** The caption dithers in over this window of the intro. */
const TEXT_IN_DELAY_MS = 250;
const TEXT_IN_MS = 700;
/** "voidmesh" stays fully visible at least this long before an exit may start. */
const OPENING_MIN_VISIBLE_MS = 800;
const EXIT_MS = 900;
/**
 * Frame pacing. Intro and reveal run at 60 fps so the transitions stay smooth; the idle
 * drift is slow and dither changes in discrete cell flips, so 30 fps reads the same.
 */
const TRANSITION_FRAME_MS = 1000 / 60 - 2;
const IDLE_FRAME_MS = 1000 / 30 - 2;
/** < 1 enlarges the cloud lobes relative to the viewport. */
const LOBE_SCALE = 0.85;
/** Brand blue: `--primary`, oklch(61% 0.23 253), in Display P3. Matches app-loader.css. */
const BACKGROUND = [0.098, 0.486, 0.996] as const;
const INK = [1, 1, 1] as const;

/** The first caption, held a little longer before the rotation starts. */
const OPENING_LINE = "voidmesh";
const OPENING_HOLD_MS = 2800;
/** Captions cycled in a random order after the opening line. Keep each under ~21 chars. */
const LINES = [
  "summoning shaders",
  "dithering the void",
  "scrying the canvas",
  "invoking the gpu",
  "bending photons",
  "transmuting light",
  "divining gradients",
  "awakening the mesh",
  "reading the noise",
  "tracing sacred grids",
  "chanting in hex",
  "casting halftones",
  "whispering to webgpu",
  "the void stares back",
];
const LINE_HOLD_MS = 1800;
const LINE_SWAP_MS = 450;
/** Target caption height in CSS px; font pixels snap to whole cells. */
const CAPTION_HEIGHT_CSS = 32;
/** Widest share of the viewport a caption may take. */
const CAPTION_MAX_WIDTH = 0.8;
/** Widest line at one cell per font pixel; sizes every line consistently. */
const WIDEST_LINE = Math.max(
  ...[OPENING_LINE, ...LINES].map((line) => layoutPixelText(line, 1, 0).width),
);

let renderer: LoaderDitherRenderer | null = null;
let width = 0;
let height = 0;
let dpr = 1;
let cell = 2; // dither cell size in CSS px
let cols = 0;
let rows = 0;
let reducedMotion = false;
let phase: Phase = "intro";
let phaseStart = 0;
let frame = 0;
let lastRender = 0;
let painted = false;

const lobes = new Float32Array(8);

// Caption rotation. The current line lives in the renderer's A slot; a swap uploads
// the next line to B and dissolves into it, then commits B as the new A.
const lineOrder = shuffle([...LINES]);
let lineCursor = 0;
let advanceRequested = false;
let currentLine = "";
let nextLine = "";
let swapStart = -1;
let lineShownAt = 0;
let lineHoldMs = LINE_HOLD_MS;

function shuffle<T>(items: T[]) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** One scale per viewport (not per line) so captions don't change size as they rotate. */
function layoutCaption(text: string) {
  const byHeight = Math.round(CAPTION_HEIGHT_CSS / (7 * cell));
  const byWidth = Math.floor((cols * CAPTION_MAX_WIDTH) / WIDEST_LINE);
  const scale = Math.max(1, Math.min(byHeight, byWidth));
  return layoutPixelText(text, scale, 1);
}

function takeNextLine() {
  return lineOrder[lineCursor++ % lineOrder.length]!;
}

/** Replaces the current caption immediately (opening line, resize). */
function setCaptionNow(text: string, holdMs = lineHoldMs) {
  if (!renderer) return;
  currentLine = text;
  swapStart = -1;
  lineShownAt = performance.now();
  lineHoldMs = holdMs;
  renderer.setNextCaption(layoutCaption(text));
  renderer.commitCaption();
}

/** Advances the caption rotation; returns the dissolve progress towards the next line. */
function updateCaption(now: number) {
  if (!renderer || reducedMotion) return 0;
  if (swapStart >= 0) {
    const k = (now - swapStart) / LINE_SWAP_MS;
    if (k < 1) return easeInOutSine(k);
    renderer.commitCaption();
    currentLine = nextLine;
    swapStart = -1;
    lineShownAt = now;
    lineHoldMs = LINE_HOLD_MS;
    return 0;
  }
  const leaving = phase === "exit" || phase === "done";
  if (!leaving && (advanceRequested || now - lineShownAt > lineHoldMs)) {
    advanceRequested = false;
    nextLine = takeNextLine();
    if (nextLine !== currentLine) {
      renderer.setNextCaption(layoutCaption(nextLine));
      swapStart = now;
    }
  }
  return 0;
}

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeInOutSine = (t: number) => (1 - Math.cos(Math.PI * t)) / 2;

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/** Cloud intensity/size, caption visibility, and reveal progress for the current phase. */
function timeline(now: number) {
  const t = now - phaseStart;
  if (phase === "intro") {
    // The cloud dithers in: cells switch on in Bayer order as intensity rises. The
    // caption follows a beat later.
    const k = Math.min(1, t / INTRO_MS);
    if (k >= 1) phase = "idle";
    return {
      amp: easeInOutSine(k),
      radius: 0.85 + 0.15 * easeOutCubic(k),
      reveal: 0,
      textAmp: easeInOutSine(clamp01((t - TEXT_IN_DELAY_MS) / TEXT_IN_MS)),
    };
  }
  if (phase === "exit" || phase === "done") {
    const k = Math.min(1, t / EXIT_MS);
    if (k >= 1 && phase === "exit") {
      phase = "done";
      self.postMessage({ type: "exited" } satisfies FromLoaderWorkerMessage);
    }
    // The caption dissolves first; then the blue opens from the centre while the
    // cloud pushes outward, like a zoom-in.
    return {
      amp: 1,
      radius: 1 + 0.12 * easeOutCubic(k),
      reveal: easeInOutCubic(k),
      textAmp: 1 - clamp01(k * 3),
    };
  }
  return { amp: 1, radius: 1, reveal: 0, textAmp: 1 };
}

/** Lobe centres drift on independent orbits. */
function updateLobes(s: number) {
  lobes[0] = 0.42 * Math.cos(s * 0.45);
  lobes[1] = 0.3 * Math.sin(s * 0.6 + 0.5);
  lobes[2] = -0.46 * Math.cos(s * 0.38 + 2);
  lobes[3] = -0.36 * Math.sin(s * 0.52 + 1);
  lobes[4] = 0.28 * Math.sin(s * 0.8 + 4);
  lobes[5] = -0.44 * Math.cos(s * 0.58);
  lobes[6] = -0.12 * Math.cos(s * 1.1);
  lobes[7] = 0.12 * Math.sin(s * 0.95);
}

function configure(canvas?: OffscreenCanvas) {
  if (canvas) renderer = new LoaderDitherRenderer(canvas);
  const grid = loaderDitherGrid(width, height, dpr);
  cell = grid.cell;
  cols = grid.cols;
  rows = grid.rows;
  renderer?.resize(cols, rows);
  // Cell size may have changed; re-lay out the caption at the new scale.
  if (currentLine) setCaptionNow(currentLine);
}

function render(now: number) {
  if (!renderer) return;
  const { amp, radius, reveal, textAmp } = timeline(now);
  const textMix = updateCaption(now);
  const s = now * 0.001;
  updateLobes(s);
  // The cloud fills an ellipse fitted to the viewport; lobes only get sqrt(aspect) of
  // that stretch so they stay cloud-shaped on wide and tall screens.
  const cx = width / cell / 2;
  const cy = height / cell / 2;
  const halfW = cx * 0.94;
  const halfH = cy * 0.94;
  const k = Math.sqrt(halfW / halfH);
  renderer.draw({
    fieldCenter: [cx, cy],
    fieldHalf: [halfW, halfH],
    lobeScale: [k * LOBE_SCALE, LOBE_SCALE / k],
    lobes,
    time: s,
    radius,
    amp,
    viewCenter: [cx, cy],
    viewReach: Math.hypot(cx, cy),
    reveal,
    ink: INK,
    background: BACKGROUND,
    textCenter: [cx, cy],
    textMix,
    textAmp,
  });
  if (!painted) {
    painted = true;
    self.postMessage({ type: "painted" } satisfies FromLoaderWorkerMessage);
  }
}

// Dev-only render timing, reported to the preview harness when enabled.
let statsEnabled = false;
let statsTotal = 0;
let statsMax = 0;
let statsFrames = 0;
let statsSince = 0;

function reportStats(now: number, cost: number) {
  statsTotal += cost;
  statsMax = Math.max(statsMax, cost);
  statsFrames++;
  if (now - statsSince < 500) return;
  self.postMessage({
    type: "stats",
    avgMs: statsTotal / statsFrames,
    maxMs: statsMax,
    fps: (statsFrames * 1000) / (now - statsSince),
    cells: cols * rows,
  } satisfies FromLoaderWorkerMessage);
  statsTotal = statsMax = statsFrames = 0;
  statsSince = now;
}

function tick(now: number) {
  frame = requestAnimationFrame(tick);
  if (now - lastRender < (phase === "idle" ? IDLE_FRAME_MS : TRANSITION_FRAME_MS)) return;
  lastRender = now;
  if (statsEnabled) {
    const t0 = performance.now();
    render(now);
    reportStats(now, performance.now() - t0);
  } else {
    render(now);
  }
  if (phase === "done") cancelAnimationFrame(frame);
}

// Earliest time an exit may begin, so the opening line is readable; set per intro.
let exitReadyAt = 0;
let exitTimer: ReturnType<typeof setTimeout> | undefined;

function requestExit() {
  if (phase === "exit" || phase === "done" || exitTimer !== undefined) return;
  exitTimer = setTimeout(
    () => {
      exitTimer = undefined;
      start("exit");
    },
    Math.max(0, exitReadyAt - performance.now()),
  );
}

function start(nextPhase: Phase) {
  cancelAnimationFrame(frame);
  if (nextPhase === "intro") {
    clearTimeout(exitTimer);
    exitTimer = undefined;
    // Reduced motion shows the caption at once; otherwise it finishes dithering in first.
    const captionVisibleIn = reducedMotion ? 0 : TEXT_IN_DELAY_MS + TEXT_IN_MS;
    exitReadyAt = performance.now() + captionVisibleIn + OPENING_MIN_VISIBLE_MS;
  }
  if (nextPhase === "exit") self.postMessage({ type: "exiting" } satisfies FromLoaderWorkerMessage);
  phase = nextPhase;
  phaseStart = performance.now();
  lastRender = 0;
  if (reducedMotion) {
    // A still, fully dithered-in frame; the exit is a plain CSS fade of .app-loader.
    if (nextPhase === "exit") {
      phase = "done";
      self.postMessage({ type: "exited" } satisfies FromLoaderWorkerMessage);
      return;
    }
    phase = "idle";
    render(performance.now());
    return;
  }
  frame = requestAnimationFrame(tick);
}

self.onmessage = (event: MessageEvent<ToLoaderWorkerMessage>) => {
  const msg = event.data;
  switch (msg.type) {
    case "init":
      width = msg.width;
      height = msg.height;
      dpr = msg.dpr;
      reducedMotion = msg.reducedMotion;
      configure(msg.canvas);
      setCaptionNow(OPENING_LINE, OPENING_HOLD_MS);
      start("intro");
      break;
    case "resize":
      width = msg.width;
      height = msg.height;
      dpr = msg.dpr;
      configure();
      if (phase === "done" || reducedMotion) render(performance.now());
      break;
    case "advance":
      advanceRequested = true;
      break;
    case "exit":
      requestExit();
      break;
    case "replay":
      setCaptionNow(OPENING_LINE, OPENING_HOLD_MS);
      start("intro");
      break;
    case "dispose":
      cancelAnimationFrame(frame);
      clearTimeout(exitTimer);
      renderer?.dispose();
      renderer = null;
      self.close();
      break;
    case "stats":
      statsEnabled = msg.enabled;
      statsTotal = statsMax = statsFrames = 0;
      statsSince = performance.now();
      break;
  }
};
