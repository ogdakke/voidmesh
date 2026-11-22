import { diagnosticMainClock, highRefreshEnabled } from "./high-refresh.ts";
import { countHud, startHud, stopHud } from "./high-refresh-hud.ts";

// iOS Safari caps requestAnimationFrame at 60 Hz on ProMotion displays, in
// workers too (measured). With ?hz120 one shared worker timer pulses the main
// thread at the display rate instead, and every frame consumer rides it.
// Pulses that arrive back-to-back after a main-thread stall are coalesced.
const TARGET_HZ = 120;
const MIN_PULSE_GAP_MS = 2;

const subscribers = new Set<() => void>();
const pending = new Map<number, FrameRequestCallback>();
let nextId = 1;
let worker: Worker | null = null;
let mainTimer: ReturnType<typeof setTimeout> | null = null;
let clockRunning = false;
let lastPulse = 0;

function onPulse(): void {
  const start = performance.now();
  if (start - lastPulse < MIN_PULSE_GAP_MS) {
    countHud("coalesced");
    return;
  }
  if (lastPulse > 0) {
    countHud("gapMs", start - lastPulse);
    if (start - lastPulse > 12) countHud("longGaps");
  }
  lastPulse = start;
  countHud("ticks");

  for (const subscriber of subscribers) subscriber();
  if (pending.size > 0) {
    const callbacks = [...pending.values()];
    pending.clear();
    for (const callback of callbacks) callback(start);
  }
  countHud("tickMs", performance.now() - start);
  releaseWorkerIfIdle();
}

function startMainTimer(): void {
  const interval = 1000 / TARGET_HZ;
  let next = performance.now();
  const pulse = (): void => {
    onPulse();
    if (!clockRunning) return;
    const now = performance.now();
    // Keep the cadence; after a stall, skip missed slots instead of bursting.
    next = Math.max(next + interval, now - interval);
    mainTimer = setTimeout(pulse, Math.max(0, next - now));
  };
  pulse();
}

function acquireWorker(): void {
  if (clockRunning) return;
  clockRunning = true;
  if (diagnosticMainClock) {
    startMainTimer();
  } else {
    worker = new Worker(new URL("./frame-pulse.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = onPulse;
    worker.onerror = (event) => {
      throw new Error(`Frame pulse worker failed: ${event.message}`);
    };
    worker.postMessage({ intervalMs: 1000 / TARGET_HZ });
  }
  startHud();
}

function releaseWorkerIfIdle(): void {
  if (!clockRunning || subscribers.size > 0 || pending.size > 0) return;
  clockRunning = false;
  worker?.terminate();
  worker = null;
  if (mainTimer !== null) clearTimeout(mainTimer);
  mainTimer = null;
  stopHud();
}

/** Calls `callback` on every display frame until the returned function runs. */
export function subscribeDisplayClock(callback: () => void): () => void {
  subscribers.add(callback);
  acquireWorker();
  return () => {
    subscribers.delete(callback);
    releaseWorkerIfIdle();
  };
}

/** requestAnimationFrame that runs at the display rate under ?hz120. */
export function requestDisplayFrame(callback: FrameRequestCallback): number {
  if (!highRefreshEnabled) return requestAnimationFrame(callback);
  const id = nextId++;
  pending.set(id, callback);
  acquireWorker();
  return id;
}

export function cancelDisplayFrame(id: number): void {
  if (!highRefreshEnabled) {
    cancelAnimationFrame(id);
    return;
  }
  pending.delete(id);
  releaseWorkerIfIdle();
}
