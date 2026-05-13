type TraceData = Record<string, unknown>;

interface TraceEvent {
  t: number;
  name: string;
  data: TraceData;
}

interface TraceDump {
  traceVersion: number;
  buildTag: string;
  createdAt: string;
  userAgent: string;
  devicePixelRatio: number;
  visualViewport: {
    width: number;
    height: number;
    scale: number;
    offsetLeft: number;
    offsetTop: number;
  } | null;
  events: TraceEvent[];
}

const STORAGE_KEY = "voidmesh:pan-trace";
const MAX_EVENTS = 2400;
const TRACE_VERSION = 2;
const BUILD_TAG = "momentum-queued-in-game-loop";

class PanTrace {
  #events: TraceEvent[] = [];
  #enabled = false;
  #panel: HTMLDivElement | null = null;
  #countNode: HTMLSpanElement | null = null;

  constructor() {
    if (typeof window === "undefined") return;

    const params = new URLSearchParams(window.location.search);
    this.#enabled = params.has("panTrace") || window.localStorage.getItem(STORAGE_KEY) === "1";

    window.voidmeshPanTrace = {
      enable: () => this.enable(),
      disable: () => this.disable(),
      clear: () => this.clear(),
      dump: () => this.dump(),
      copy: () => this.copy(),
    };

    if (this.#enabled) {
      this.#mountPanelSoon();
    }
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  enable(): void {
    this.#enabled = true;
    window.localStorage.setItem(STORAGE_KEY, "1");
    this.#mountPanelSoon();
  }

  disable(): void {
    this.#enabled = false;
    window.localStorage.removeItem(STORAGE_KEY);
    this.#panel?.remove();
    this.#panel = null;
    this.#countNode = null;
  }

  clear(): void {
    this.#events.length = 0;
    this.#updateCount();
  }

  record(name: string, data: TraceData = {}): void {
    if (!this.#enabled) return;

    const vv = window.visualViewport;
    this.#events.push({
      t: performance.now(),
      name,
      data: {
        ...data,
        env: {
          scrollX: window.scrollX,
          scrollY: window.scrollY,
          visualViewport: vv
            ? {
                width: vv.width,
                height: vv.height,
                scale: vv.scale,
                offsetLeft: vv.offsetLeft,
                offsetTop: vv.offsetTop,
              }
            : null,
        },
      },
    });

    if (this.#events.length > MAX_EVENTS) {
      this.#events.splice(0, this.#events.length - MAX_EVENTS);
    }

    this.#updateCount();
  }

  dump(): TraceDump {
    const vv = window.visualViewport;
    return {
      traceVersion: TRACE_VERSION,
      buildTag: BUILD_TAG,
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      devicePixelRatio: window.devicePixelRatio || 1,
      visualViewport: vv
        ? {
            width: vv.width,
            height: vv.height,
            scale: vv.scale,
            offsetLeft: vv.offsetLeft,
            offsetTop: vv.offsetTop,
          }
        : null,
      events: this.#events.slice(),
    };
  }

  async copy(): Promise<void> {
    const text = JSON.stringify(this.dump(), null, 2);
    await navigator.clipboard.writeText(text);
  }

  #mountPanelSoon(): void {
    if (this.#panel) return;
    window.setTimeout(() => this.#mountPanel(), 0);
  }

  #mountPanel(): void {
    if (this.#panel || !document.body) return;

    const panel = document.createElement("div");
    panel.style.cssText = [
      "position:fixed",
      "z-index:2147483647",
      "top:calc(env(safe-area-inset-top, 0px) + 8px)",
      "right:8px",
      "display:flex",
      "gap:6px",
      "align-items:center",
      "padding:6px",
      "border:1px solid rgba(0,0,0,.18)",
      "border-radius:8px",
      "background:rgba(255,255,255,.92)",
      "color:#111",
      "font:12px system-ui,sans-serif",
      "box-shadow:0 4px 18px rgba(0,0,0,.18)",
    ].join(";");

    const count = document.createElement("span");
    count.textContent = "0";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copy pan trace";
    copy.onclick = () => {
      this.copy()
        .then(() => {
          copy.textContent = "Copied";
          window.setTimeout(() => {
            copy.textContent = "Copy pan trace";
          }, 900);
        })
        .catch(() => {
          copy.textContent = "Copy failed";
        });
    };

    const clear = document.createElement("button");
    clear.type = "button";
    clear.textContent = "Clear";
    clear.onclick = () => this.clear();

    panel.append(copy, clear, count);
    document.body.append(panel);
    this.#panel = panel;
    this.#countNode = count;
    this.#updateCount();
  }

  #updateCount(): void {
    if (this.#countNode) {
      this.#countNode.textContent = String(this.#events.length);
    }
  }
}

declare global {
  interface Window {
    voidmeshPanTrace?: {
      enable: () => void;
      disable: () => void;
      clear: () => void;
      dump: () => TraceDump;
      copy: () => Promise<void>;
    };
  }
}

export const panTrace = new PanTrace();
