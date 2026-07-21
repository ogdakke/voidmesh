import type {
  UpdateWorkspaceViewStateRequest,
  WorkspaceViewStateResponse,
} from "@voidmesh/api-contract";
import type { Viewport } from "#types/canvas.ts";
import { clampZoom } from "#lib/canvas-math.ts";

const SAVE_DELAY_MS = 600;
const MAX_PERSISTED_OFFSET = 100_000_000;

export interface HostedViewportStore {
  getViewport(): Viewport;
  setViewport(viewport: Viewport): void;
  subscribeViewport(listener: () => void): () => void;
  whenViewportInitialized(): Promise<void>;
}

export interface HostedViewportRemote {
  load(): Promise<WorkspaceViewStateResponse>;
  save(state: UpdateWorkspaceViewStateRequest, keepalive: boolean): Promise<unknown>;
}

export interface HostedViewportSyncOptions {
  onError(error: unknown): void;
  remote: HostedViewportRemote;
  store: HostedViewportStore;
}

/** Persists a user's private camera without publishing it to collaborators. */
export class HostedViewportSync {
  readonly #onError: (error: unknown) => void;
  readonly #remote: HostedViewportRemote;
  readonly #store: HostedViewportStore;
  #destroyed = false;
  #saveTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;

  constructor(options: HostedViewportSyncOptions) {
    this.#onError = options.onError;
    this.#remote = options.remote;
    this.#store = options.store;
  }

  async start(): Promise<void> {
    try {
      const [{ viewState }] = await Promise.all([
        this.#remote.load(),
        this.#store.whenViewportInitialized(),
      ]);
      if (this.#destroyed) return;
      if (viewState) {
        this.#store.setViewport(
          normalizeViewport({
            offset: { ...viewState.offset },
            zoom: viewState.zoom,
          }),
        );
      }
    } catch (error) {
      this.#onError(error);
    }
    if (this.#destroyed) return;
    this.#unsubscribe = this.#store.subscribeViewport(() => this.#scheduleSave());
  }

  flush(keepalive = false): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = null;
    const viewport = normalizeViewport(this.#store.getViewport());
    void this.#remote
      .save({ offset: { ...viewport.offset }, zoom: viewport.zoom }, keepalive)
      .catch(this.#onError);
  }

  destroy(): void {
    if (this.#destroyed) return;
    if (this.#saveTimer) this.flush();
    this.#destroyed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
  }

  #scheduleSave(): void {
    if (this.#saveTimer) clearTimeout(this.#saveTimer);
    this.#saveTimer = setTimeout(() => this.flush(), SAVE_DELAY_MS);
  }
}

function normalizeViewport(viewport: Viewport): Viewport {
  return {
    offset: {
      x: Math.max(-MAX_PERSISTED_OFFSET, Math.min(MAX_PERSISTED_OFFSET, viewport.offset.x)),
      y: Math.max(-MAX_PERSISTED_OFFSET, Math.min(MAX_PERSISTED_OFFSET, viewport.offset.y)),
    },
    zoom: clampZoom(viewport.zoom),
  };
}
