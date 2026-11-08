import { loaderDitherGrid } from "./layout.ts";
import type { FromLoaderWorkerMessage, ToLoaderWorkerMessage } from "./app-loader.worker.ts";

/**
 * Initial app loader. index.html paints a brand-blue screen before any JS runs; this
 * module (the first script) hands a canvas to app-loader.worker.ts, which dithers a
 * white cloud in on top with a rotating pixel-text caption and, on dismiss, opens the
 * blue to reveal the app. The caption is decorative; the visually hidden
 * `.loader-status` carries the real loading status for assistive tech.
 */

const MIN_DISPLAY_MS = 800;
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
  const grid = loaderDitherGrid(innerWidth, innerHeight, devicePixelRatio);
  canvasEl.style.width = `${grid.cssWidth}px`;
  canvasEl.style.height = `${grid.cssHeight}px`;
}

function viewport() {
  return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
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
  // Once the canvas paints the blue itself, drop the CSS blue so the reveal shows the app.
  onWorkerMessage(instance, "painted", () => (el.dataset.painted = ""), true);
  addEventListener("resize", onResize);
  return instance;
}

function onResize() {
  sizeCanvas();
  post({ type: "resize", ...viewport() });
}

/** Plays the exit: the worker dithers the blue open; resolves once the app is visible. */
async function playExit() {
  if (!el) return;
  const exited = worker
    ? new Promise<void>((resolve) => onWorkerMessage(worker, "exited", () => resolve(), true))
    : Promise.resolve();
  post({ type: "exit" });
  el.dataset.state = "exit";
  await Promise.all([exited, ...el.getAnimations().map((animation) => animation.finished)]);
  el.hidden = true;
}

/** The worker releases its GL context, then closes itself. */
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
  dismiss() {
    if (!el || dismissed || isPreview) return;
    dismissed = true;
    const remaining = MIN_DISPLAY_MS - (Date.now() - startTime);
    setTimeout(() => void playExit().then(teardown), Math.max(0, remaining));
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
