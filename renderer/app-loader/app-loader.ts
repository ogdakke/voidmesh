import { loaderDitherGrid } from "./layout.ts";
import type { FromLoaderWorkerMessage, ToLoaderWorkerMessage } from "./app-loader.worker.ts";

/**
 * Initial app loader. index.html paints a brand-blue screen before any JS runs; this
 * module (the first script) hands a canvas to app-loader.worker.ts, which dithers a
 * white cloud in on top with a rotating pixel-text caption and, on dismiss, opens the
 * blue to reveal the app. The caption is decorative; the visually hidden
 * `.loader-status` carries the real loading status for assistive tech.
 */

const startTime = Date.now();
/** sRGB approximation of the loader blue, for `theme-color`. Matches index.html. */
const LOADER_THEME_COLOR = "#007fff";

const el = document.getElementById("app-loader") as HTMLElement | null;
const chromeEl = document.getElementById("app-loader-chrome") as HTMLElement | null;
/** How long the edge strips show the app colour before they are removed. */
const CHROME_HANDOFF_MS = 250;
const statusEl = el?.querySelector<HTMLElement>(".loader-status") ?? null;
const canvasEl = el?.querySelector<HTMLCanvasElement>(".loader-canvas") ?? null;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const themeColorMetas = [...document.querySelectorAll<HTMLMetaElement>("meta[data-app-color]")];

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
  const grid = loaderDitherGrid(width, height, dpr);
  canvasEl.style.width = `${grid.cssWidth}px`;
  canvasEl.style.height = `${grid.cssHeight}px`;
}

/** The loader is taller than the viewport (see app-loader.css); the canvas covers all of it. */
function viewport() {
  return {
    width: innerWidth,
    height: el ? el.getBoundingClientRect().height : innerHeight,
    viewHeight: innerHeight,
    dpr: devicePixelRatio,
  };
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
  // Without a WebGPU device the loader stays a static blue screen with a CSS fade exit.
  onWorkerMessage(instance, "failed", () => (el.dataset.static = ""), true);
  addEventListener("resize", onResize);
  return instance;
}

function onResize() {
  sizeCanvas();
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
/**
 * Browser chrome follows the loader: `theme-color` is the loader blue in index.html
 * while loading and switches to the app colour when the loader hides (the document
 * background does the same in app-loader.css, which is what iOS 26 samples).
 */
function setThemeColor(loading: boolean) {
  for (const meta of themeColorMetas) {
    meta.content = loading ? LOADER_THEME_COLOR : (meta.dataset.appColor ?? meta.content);
  }
}

/**
 * Hands the browser bars to the app: the edge strips switch to the app background
 * (which iOS keeps once sampled) and are removed shortly after. See app-loader.css.
 */
function handOffChrome() {
  if (!chromeEl) return;
  chromeEl.dataset.handoff = "";
  setTimeout(() => (chromeEl.hidden = true), CHROME_HANDOFF_MS);
}

async function playExit() {
  if (!el) return;
  const exiting = nextWorkerMessage("exiting");
  const exited = nextWorkerMessage("exited");
  post({ type: "exit" });
  await exiting;
  el.dataset.state = "exit";
  await Promise.all([exited, ...el.getAnimations().map((animation) => animation.finished)]);
  el.hidden = true;
  setThemeColor(false);
  handOffChrome();
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
  setThemeColor(true);
  if (chromeEl) {
    delete chromeEl.dataset.handoff;
    chromeEl.hidden = false;
  }
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
