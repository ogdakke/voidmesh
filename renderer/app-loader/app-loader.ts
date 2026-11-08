import { fitLoaderGrid, loaderDitherGrid, readLoaderViewport } from "./layout.ts";
import { placeLoaderWordmark } from "./wordmark.ts";
import type { FromLoaderWorkerMessage, ToLoaderWorkerMessage } from "./app-loader.worker.ts";

/**
 * Initial app loader. index.html paints the brand blue and the pixel wordmark before
 * any module runs (first-paint.ts, matching the PWA splash images); this module hands
 * a canvas to app-loader.worker.ts, which takes over the identical frame, dithers a
 * white cloud in around the wordmark, rotates pixel-text captions and, on dismiss,
 * opens the blue to reveal the app. The caption is decorative; the visually hidden
 * `.loader-status` carries the real loading status for assistive tech.
 */

const startTime = Date.now();

const el = document.getElementById("app-loader") as HTMLElement | null;
const statusEl = el?.querySelector<HTMLElement>(".loader-status") ?? null;
const canvasEl = el?.querySelector<HTMLCanvasElement>(".loader-canvas") ?? null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const isPreview = import.meta.env.DEV && new URLSearchParams(location.search).has("loader-preview");

type WorkerMessage<T extends FromLoaderWorkerMessage["type"]> = Extract<
  FromLoaderWorkerMessage,
  { type: T }
>;

let dismissed = false;

const worker = startWorker();

function post(message: ToLoaderWorkerMessage) {
  worker?.postMessage(message);
}

function onWorkerMessage<T extends FromLoaderWorkerMessage["type"]>(
  target: Worker,
  type: T,
  listener: (message: WorkerMessage<T>) => void,
  once = false,
) {
  const handler = (event: MessageEvent<FromLoaderWorkerMessage>) => {
    if (event.data.type !== type) return;
    if (once) target.removeEventListener("message", handler);
    listener(event.data as WorkerMessage<T>);
  };
  target.addEventListener("message", handler);
}

/** Pins the canvas to a whole number of device pixels per dither cell. */
function sizeCanvas() {
  if (!canvasEl) return;
  const { width, height, dpr } = viewport();
  fitLoaderGrid(canvasEl, loaderDitherGrid(width, height, dpr));
}

function viewport() {
  return el
    ? readLoaderViewport(el)
    : { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
}

/** Boots the effect worker; it owns the canvas from here on. */
function startWorker() {
  if (!el || !canvasEl) return null;
  sizeCanvas();
  const instance = new Worker(new URL("./app-loader.worker.ts", import.meta.url), {
    type: "module",
    name: "app-loader",
  });
  const canvas = canvasEl.transferControlToOffscreen();
  instance.postMessage(
    {
      type: "init",
      canvas,
      ...viewport(),
      reducedMotion: reducedMotion.matches,
    } satisfies ToLoaderWorkerMessage,
    [canvas],
  );
  // Without a WebGPU device the loader stays a static blue screen with a CSS fade exit.
  onWorkerMessage(instance, "failed", () => (el.dataset.static = ""), true);
  addEventListener("resize", onResize);
  return instance;
}

function onResize() {
  sizeCanvas();
  if (el) placeLoaderWordmark(el);
  post({ type: "resize", ...viewport() });
}

/** Resolves on `type`, or straight away once the worker has failed (it sends nothing more). */
function nextWorkerMessage(type: "exiting" | "exited") {
  if (!worker || el?.hasAttribute("data-static")) return Promise.resolve();
  return new Promise<void>((resolve) => {
    onWorkerMessage(worker, type, () => resolve(), true);
    onWorkerMessage(worker, "failed", () => resolve(), true);
  });
}

/**
 * Plays the exit: the worker dithers the blue open; resolves once the app is visible.
 * The worker may hold the exit back so the opening line is readable, so the CSS state
 * (which drives the reduced-motion fade) flips only once it reports "exiting".
 */
async function playExit() {
  if (!el) return;
  const exiting = nextWorkerMessage("exiting");
  const exited = nextWorkerMessage("exited");
  post({ type: "exit" });
  await exiting;
  // The canvas has been drawing the same blue and wordmark on top for a while by now;
  // the CSS layer goes with the first reveal frame (app-loader.css).
  el.dataset.state = "exit";
  await Promise.all([exited, ...el.getAnimations().map((animation) => animation.finished)]);
  el.hidden = true;
}

/** The worker destroys its WebGPU device, then closes itself. */
function teardown() {
  post({ type: "dispose" });
  removeEventListener("resize", onResize);
}

/** Shows the loader again from its entrance (used by the dev preview). */
function replay() {
  if (!el) return;
  el.hidden = true;
  delete el.dataset.state;
  // Hidden → visible restarts every CSS animation in the subtree.
  void el.offsetWidth;
  el.hidden = false;
  post({ type: "replay" });
}

export const appLoader = {
  /** Reports a real loading stage to assistive tech. */
  setText(text: string) {
    if (statusEl && statusEl.textContent !== text) statusEl.textContent = text;
  },
  /** Starts the handoff; the worker holds it until the opening line has been readable. */
  dismiss() {
    if (!el || dismissed || isPreview) return;
    dismissed = true;
    void playExit().then(teardown);
  },
  startTime,
} as const;

export type LoaderStats = WorkerMessage<"stats">;

export interface AppLoaderPreviewControls {
  nextLine(): void;
  playExit(): Promise<void>;
  replay(): void;
  onStats(listener: (stats: LoaderStats) => void): void;
}

if (isPreview && el && worker) {
  const controls: AppLoaderPreviewControls = {
    nextLine: () => post({ type: "advance" }),
    playExit,
    replay,
    onStats(listener) {
      onWorkerMessage(worker, "stats", listener);
      post({ type: "stats", enabled: true });
    },
  };
  void import("./preview.ts").then(({ mountAppLoaderPreview }) => mountAppLoaderPreview(controls));
}
