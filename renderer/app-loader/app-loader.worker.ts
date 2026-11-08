/**
 * Initial loader renderer. Runs in a worker on an OffscreenCanvas so the animation
 * keeps its frame rate while the main thread parses modules and boots WebGPU. The
 * worker only advances the timeline and uploads uniforms; LoaderDitherRenderer does
 * the per-cell work on the GPU.
 */

import { LoaderDitherRenderer } from "./dither-renderer.ts";
import { LINES, OPENING_LINE } from "./captions.ts";
import {
  layoutLoaderCaption,
  loaderCenter,
  loaderViewportGrid,
  type LoaderGrid,
  type LoaderViewport,
} from "./layout.ts";

export type ToLoaderWorkerMessage =
  | ({
      type: "init";
      canvas: OffscreenCanvas;
      reducedMotion: boolean;
    } & LoaderViewport)
  | ({ type: "resize" } & LoaderViewport)
  /** Dev preview: move to the next caption now. */
  | { type: "advance" }
  | { type: "exit" }
  | { type: "replay" }
  | { type: "stats"; enabled: boolean }
  | { type: "dispose" };

export type FromLoaderWorkerMessage =
  /** No WebGPU device; the worker has closed and the loader stays static. */
  | { type: "failed" }
  /** The exit has actually begun (it may be held back after an "exit" request). */
  | { type: "exiting" }
  | { type: "exited" }
  | { type: "stats"; avgMs: number; maxMs: number; fps: number; cells: number };

type Phase = "intro" | "idle" | "exit" | "done";

const INTRO_MS = 1000;
/** The bloomed cloud holds this long before an exit may start. */
const BLOOM_HOLD_MS = 300;
const EXIT_MS = 900;
/**
 * Frame pacing. Intro and reveal run at 60 fps so the transitions stay smooth; the idle
 * drift is slow and dither changes in discrete cell flips, so 30 fps reads the same.
 */
const TRANSITION_FRAME_MS = 1000 / 60 - 2;
const IDLE_FRAME_MS = 1000 / 30 - 2;
/** < 1 enlarges the cloud lobes relative to the viewport. */
const LOBE_SCALE = 0.85;
/** Brand blue clipped to sRGB, #007eff. Matches app-loader.css and the splash images. */
const BACKGROUND = [0, 126 / 255, 1] as const;
const INK = [1, 1, 1] as const;

/** The opening line is held a little longer before the rotation starts. */
const OPENING_HOLD_MS = 2800;
const LINE_HOLD_MS = 1800;
const LINE_SWAP_MS = 450;

let renderer: LoaderDitherRenderer | null = null;
let viewport: LoaderViewport = { width: 0, height: 0, coverHeight: 0, dpr: 1 };
let grid: LoaderGrid | null = null;
let reducedMotion = false;
let phase: Phase = "intro";
let phaseStart = 0;
let frame = 0;
let lastRender = 0;

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

function takeNextLine() {
  return lineOrder[lineCursor++ % lineOrder.length]!;
}

/** Replaces the current caption immediately (opening line, resize). */
function setCaptionNow(text: string, holdMs = lineHoldMs) {
  if (!renderer || !grid) return;
  currentLine = text;
  swapStart = -1;
  lineShownAt = performance.now();
  lineHoldMs = holdMs;
  renderer.setNextCaption(layoutLoaderCaption(text, grid));
  renderer.commitCaption();
}

/** Advances the caption rotation; returns the dissolve progress towards the next line. */
function updateCaption(now: number) {
  if (!renderer || !grid || reducedMotion) return 0;
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
  // No new line once an exit is scheduled: it would dissolve in only to dissolve out.
  const leaving = phase === "exit" || phase === "done" || exitTimer !== undefined;
  if (!leaving && (advanceRequested || now - lineShownAt > lineHoldMs)) {
    advanceRequested = false;
    nextLine = takeNextLine();
    if (nextLine !== currentLine) {
      renderer.setNextCaption(layoutLoaderCaption(nextLine, grid));
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
    // The wordmark is already on screen (first paint, PWA splash); the cloud dithers
    // in around it, cells switching on in Bayer order as intensity rises.
    const k = Math.min(1, t / INTRO_MS);
    if (k >= 1) phase = "idle";
    return {
      amp: easeInOutSine(k),
      radius: 0.85 + 0.15 * easeOutCubic(k),
      reveal: 0,
      textAmp: 1,
    };
  }
  if (phase === "exit" || phase === "done") {
    const k = Math.min(1, t / EXIT_MS);
    if (k >= 1 && phase === "exit") {
      phase = "done";
      self.postMessage({ type: "exited" } satisfies FromLoaderWorkerMessage);
    }
    // The caption dissolves first; then the blue opens from the centre while the
    // cloud pushes outward, like a zoom-in. The push eases in with the reveal: the
    // idle cloud is at rest, so a fast start would read as a jolt.
    const opening = easeInOutCubic(k);
    return {
      amp: 1,
      radius: 1 + 0.12 * opening,
      reveal: opening,
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

function configure() {
  grid = loaderViewportGrid(viewport);
  renderer?.resize(grid.cols, grid.rows);
  // Cell size may have changed; re-lay out the caption at the new scale.
  if (currentLine) setCaptionNow(currentLine);
}

function render(now: number) {
  if (!renderer || !grid) return;
  const { amp, radius, reveal, textAmp } = timeline(now);
  const textMix = updateCaption(now);
  const s = now * 0.001;
  updateLobes(s);
  // The cloud fills an ellipse fitted to the viewport; lobes only get sqrt(aspect) of
  // that stretch so they stay cloud-shaped on wide and tall screens.
  const [cx, cy] = loaderCenter(viewport, grid);
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
    // To the farthest corner, which is in the bleed below the visible region.
    viewReach: Math.hypot(cx, Math.max(cy, grid.rows - cy)),
    reveal,
    ink: INK,
    background: BACKGROUND,
    textCenter: [cx, cy],
    textMix,
    textAmp,
  });
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
    cells: grid ? grid.cols * grid.rows : 0,
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

// Earliest time an exit may begin, so the cloud has bloomed; set per intro.
let exitReadyAt = 0;
let exitTimer: ReturnType<typeof setTimeout> | undefined;

// An exit can arrive while the WebGPU device is still being created; it is replayed
// once the intro starts.
let exitPending = false;

function requestExit() {
  if (!renderer) {
    exitPending = true;
    return;
  }
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
    // Reduced motion shows the bloomed cloud at once.
    exitReadyAt = performance.now() + (reducedMotion ? 0 : INTRO_MS + BLOOM_HOLD_MS);
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
      viewport = msg;
      reducedMotion = msg.reducedMotion;
      LoaderDitherRenderer.create(msg.canvas).then(
        (created) => {
          renderer = created;
          configure();
          setCaptionNow(OPENING_LINE, OPENING_HOLD_MS);
          start("intro");
          if (exitPending) {
            exitPending = false;
            requestExit();
          }
        },
        (error: unknown) => {
          // The loader must never hold the app back: report and step aside.
          console.error("[app-loader] WebGPU unavailable, showing a static loader", error);
          self.postMessage({ type: "failed" } satisfies FromLoaderWorkerMessage);
          self.close();
        },
      );
      break;
    case "resize":
      viewport = msg;
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
