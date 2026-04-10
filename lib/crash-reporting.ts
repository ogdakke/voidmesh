import { analytics } from "#lib/analytics.ts";
import { logger } from "#lib/client.logger.ts";
import {
  DitheringKind,
  MediaType,
  ShaderType,
  isErrorDiffusion,
  type ShaderCanvasEntity,
} from "#types/canvas.ts";

const STORAGE_KEY = "studio:crash-report";
const MAX_BREADCRUMBS = 25;
const RECOVERY_WINDOW_MS = 30 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_STACK_LENGTH = 4_000;

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

type JsonRecord = { [key: string]: JsonValue };

interface RuntimeBreadcrumb {
  at: string;
  category: string;
  message: string;
  data?: JsonRecord;
}

interface RuntimeAction {
  at: string;
  name: string;
  data?: JsonRecord;
}

interface RuntimeSessionRecord {
  version: 1;
  sessionId: string;
  active: boolean;
  startedAt: string;
  lastUpdatedAt: string;
  lastHeartbeatAt: string;
  gracefulExitAt: string | null;
  gracefulExitReason: string | null;
  lastAction: RuntimeAction | null;
  breadcrumbs: RuntimeBreadcrumb[];
  canvas: JsonRecord | null;
  renderer: JsonRecord | null;
  environment: JsonRecord;
}

export interface EntityMemoryEstimate {
  bitmapBytes: number;
  sourceTextureBytes: number;
  processedTextureBytes: number;
  errorDiffusionBytes: number;
  totalBytes: number;
}

export interface EntitySummary {
  entityCount: number;
  selectedCount: number;
  mediaTypeCounts: Record<MediaType, number>;
  shaderTypeCounts: Record<ShaderType, number>;
  totalPixels: number;
  selectedPixels: number;
  maxWidth: number;
  maxHeight: number;
  memoryEstimate: EntityMemoryEstimate;
}

function createEmptySummary(): EntitySummary {
  return {
    entityCount: 0,
    selectedCount: 0,
    mediaTypeCounts: {
      [MediaType.image]: 0,
      [MediaType.video]: 0,
      [MediaType.gif]: 0,
      [MediaType.svg]: 0,
    },
    shaderTypeCounts: {
      [ShaderType.halftone]: 0,
      [ShaderType.blobs]: 0,
      [ShaderType.melt]: 0,
      [ShaderType.dithering]: 0,
      [ShaderType.ascii]: 0,
      [ShaderType.glass]: 0,
      [ShaderType.glitch]: 0,
    },
    totalPixels: 0,
    selectedPixels: 0,
    maxWidth: 0,
    maxHeight: 0,
    memoryEstimate: {
      bitmapBytes: 0,
      sourceTextureBytes: 0,
      processedTextureBytes: 0,
      errorDiffusionBytes: 0,
      totalBytes: 0,
    },
  };
}

export function summarizeEntities(
  entities: readonly ShaderCanvasEntity[],
  selectedIds?: ReadonlySet<string>,
): EntitySummary {
  const summary = createEmptySummary();

  for (const entity of entities) {
    const width = entity.originalSize.width;
    const height = entity.originalSize.height;
    const pixelCount = width * height;
    const isSelected = selectedIds?.has(entity.id) ?? false;

    summary.entityCount += 1;
    summary.mediaTypeCounts[entity.mediaSource.type] += 1;
    summary.shaderTypeCounts[entity.shaderType] += 1;
    summary.totalPixels += pixelCount;
    summary.maxWidth = Math.max(summary.maxWidth, width);
    summary.maxHeight = Math.max(summary.maxHeight, height);

    if (isSelected) {
      summary.selectedCount += 1;
      summary.selectedPixels += pixelCount;
    }

    summary.memoryEstimate.bitmapBytes += pixelCount * 4;
    summary.memoryEstimate.sourceTextureBytes += pixelCount * 4;
    summary.memoryEstimate.processedTextureBytes += pixelCount * 8;

    if (
      entity.shaderType === ShaderType.dithering &&
      isErrorDiffusion(entity.shaderParams.dithering?.kind ?? DitheringKind.bayer4x4)
    ) {
      summary.memoryEstimate.errorDiffusionBytes += pixelCount * 16;
    }
  }

  summary.memoryEstimate.totalBytes =
    summary.memoryEstimate.bitmapBytes +
    summary.memoryEstimate.sourceTextureBytes +
    summary.memoryEstimate.processedTextureBytes +
    summary.memoryEstimate.errorDiffusionBytes;

  return summary;
}

function nowIso(): string {
  return new Date().toISOString();
}

function createSessionId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function truncate(value: string | null | undefined, maxLength: number): string | undefined {
  if (!value) return undefined;
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}

function normalizeValue(value: unknown): JsonValue | undefined {
  if (value == null) return null;
  if (typeof value === "string") return truncate(value, MAX_STACK_LENGTH);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeValue(entry))
      .filter((entry): entry is JsonValue => entry !== undefined);
  }
  if (value instanceof Error) {
    return normalizeError(value);
  }
  if (typeof value === "object") {
    const record: JsonRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      const normalized = normalizeValue(entry);
      if (normalized !== undefined) {
        record[key] = normalized;
      }
    }
    return record;
  }
  return String(value);
}

function normalizeRecord(value: Record<string, unknown> | undefined): JsonRecord | undefined {
  if (!value) return undefined;
  const normalized = normalizeValue(value);
  return normalized && !Array.isArray(normalized) && typeof normalized === "object"
    ? normalized
    : undefined;
}

function normalizeError(error: Error): JsonRecord {
  return {
    name: error.name,
    message: truncate(error.message, 1_000) ?? "Unknown error",
    stack: truncate(error.stack, MAX_STACK_LENGTH) ?? null,
  };
}

function coerceError(error: unknown, fallback = "Unknown error"): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : fallback);
}

function getEnvironmentSnapshot(userAgentSpecificMemory: JsonRecord | null = null): JsonRecord {
  const performanceWithExtensions = performance as Performance & {
    memory?: {
      jsHeapSizeLimit?: number;
      totalJSHeapSize?: number;
      usedJSHeapSize?: number;
    };
    measureUserAgentSpecificMemory?: () => Promise<{
      bytes: number;
      breakdown?: Array<{ bytes?: number }>;
    }>;
  };
  const memory = (
    performanceWithExtensions as Performance & {
      memory?: {
        jsHeapSizeLimit?: number;
        totalJSHeapSize?: number;
        usedJSHeapSize?: number;
      };
    }
  ).memory;

  return {
    url: typeof location !== "undefined" ? location.href : null,
    userAgent: typeof navigator !== "undefined" ? navigator.userAgent : null,
    language: typeof navigator !== "undefined" ? navigator.language : null,
    platform:
      typeof navigator !== "undefined" && "platform" in navigator ? navigator.platform : null,
    deviceMemory:
      typeof navigator !== "undefined" && "deviceMemory" in navigator
        ? ((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null)
        : null,
    viewport:
      typeof window !== "undefined"
        ? {
            width: window.innerWidth,
            height: window.innerHeight,
            devicePixelRatio: window.devicePixelRatio,
            screenWidth: window.screen.width,
            screenHeight: window.screen.height,
          }
        : null,
    visibilityState: typeof document !== "undefined" ? document.visibilityState : null,
    wasDiscarded:
      typeof document !== "undefined" && "wasDiscarded" in document
        ? ((document as Document & { wasDiscarded?: boolean }).wasDiscarded ?? null)
        : null,
    memoryApiSupport: {
      performanceMemory: memory != null,
      measureUserAgentSpecificMemory:
        typeof performanceWithExtensions.measureUserAgentSpecificMemory === "function",
    },
    jsHeap:
      memory && memory.usedJSHeapSize != null
        ? {
            usedJSHeapSize: memory.usedJSHeapSize ?? null,
            totalJSHeapSize: memory.totalJSHeapSize ?? null,
            jsHeapSizeLimit: memory.jsHeapSizeLimit ?? null,
          }
        : null,
    userAgentSpecificMemory,
  };
}

function safeRead(): RuntimeSessionRecord | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as RuntimeSessionRecord;
  } catch (error) {
    logger.warn("[crash-reporting] Failed to read persisted session", error);
    return null;
  }
}

function safeWrite(value: RuntimeSessionRecord): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch (error) {
    logger.warn("[crash-reporting] Failed to persist session", error);
  }
}

class CrashReporter {
  #initialized = false;
  #record: RuntimeSessionRecord | null = null;
  #canvasSnapshotProvider: (() => Record<string, unknown> | null) | null = null;
  #rendererSnapshotProvider: (() => Record<string, unknown> | null) | null = null;
  #memorySnapshot: JsonRecord | null = null;
  #memoryRefreshInFlight = false;

  initialize(): void {
    if (this.#initialized || typeof window === "undefined") return;
    this.#initialized = true;

    const previous = safeRead();
    if (previous && this.#looksLikeCrash(previous)) {
      const recoveredProperties = {
        previous_session_id: previous.sessionId,
        previous_started_at: previous.startedAt,
        previous_last_updated_at: previous.lastUpdatedAt,
        previous_last_action: previous.lastAction?.name ?? null,
        previous_last_action_at: previous.lastAction?.at ?? null,
        previous_environment: previous.environment,
        previous_canvas: previous.canvas,
        previous_renderer: previous.renderer,
        previous_breadcrumbs: previous.breadcrumbs.slice(-10),
      };
      analytics.track("app.crash_recovered", recoveredProperties);
      logger.warn(
        "[crash-reporting] Recovered unexpected previous session exit",
        recoveredProperties,
      );
    }

    const now = nowIso();
    this.#record = {
      version: 1,
      sessionId: createSessionId(),
      active: true,
      startedAt: now,
      lastUpdatedAt: now,
      lastHeartbeatAt: now,
      gracefulExitAt: null,
      gracefulExitReason: null,
      lastAction: null,
      breadcrumbs: [],
      canvas: null,
      renderer: null,
      environment: this.#getEnvironmentSnapshot(),
    };

    this.addBreadcrumb("app", "session.started");
    this.#persist();
    void this.#refreshMemorySnapshot();
    window.setInterval(() => this.#heartbeat(), HEARTBEAT_INTERVAL_MS);

    window.addEventListener("error", this.#handleWindowError);
    window.addEventListener("unhandledrejection", this.#handleUnhandledRejection);
    window.addEventListener("pagehide", this.#handlePageHide);
    window.addEventListener("beforeunload", this.#handleBeforeUnload);
    document.addEventListener("visibilitychange", this.#handleVisibilityChange);
  }

  setCanvasSnapshotProvider(provider: (() => Record<string, unknown> | null) | null): void {
    this.#canvasSnapshotProvider = provider;
    this.#persist();
  }

  setRendererSnapshotProvider(provider: (() => Record<string, unknown> | null) | null): void {
    this.#rendererSnapshotProvider = provider;
    this.#persist();
  }

  addBreadcrumb(category: string, message: string, data?: Record<string, unknown>): void {
    if (!this.#record) return;

    this.#record.breadcrumbs.push({
      at: nowIso(),
      category,
      message,
      data: normalizeRecord(data),
    });
    if (this.#record.breadcrumbs.length > MAX_BREADCRUMBS) {
      this.#record.breadcrumbs.splice(0, this.#record.breadcrumbs.length - MAX_BREADCRUMBS);
    }
    this.#persist();
  }

  recordAction(name: string, data?: Record<string, unknown>): void {
    if (!this.#record) return;

    this.#record.lastAction = {
      at: nowIso(),
      name,
      data: normalizeRecord(data),
    };
    this.addBreadcrumb("action", name, data);
  }

  captureException(kind: string, error: unknown, extra?: Record<string, unknown>): void {
    const normalizedError = coerceError(error);
    const properties = {
      kind,
      session_id: this.#record?.sessionId ?? null,
      error: normalizeError(normalizedError),
      extra: normalizeRecord(extra),
      canvas: this.#snapshotCanvas(),
      renderer: this.#snapshotRenderer(),
      environment: this.#getEnvironmentSnapshot(),
      last_action: this.#record?.lastAction,
    };

    analytics.track("app.error", properties);
    this.addBreadcrumb("error", kind, {
      error: normalizeError(normalizedError),
      extra: normalizeRecord(extra),
    });
    logger.error(`[crash-reporting] ${kind}`, normalizedError, extra);
  }

  captureGpuDeviceLost(
    info: { reason: string; message: string },
    extra?: Record<string, unknown>,
  ): void {
    const properties = {
      session_id: this.#record?.sessionId ?? null,
      reason: info.reason,
      message: truncate(info.message, 1_000) ?? null,
      extra: normalizeRecord(extra),
      canvas: this.#snapshotCanvas(),
      renderer: this.#snapshotRenderer(),
      environment: this.#getEnvironmentSnapshot(),
      last_action: this.#record?.lastAction,
    };

    analytics.track("gpu.device_lost", properties);
    this.addBreadcrumb("gpu", "device.lost", {
      reason: info.reason,
      message: info.message,
      extra: normalizeRecord(extra),
    });
    logger.error("[crash-reporting] GPU device lost", info, extra);
  }

  captureGpuUncapturedError(
    error: { name?: string; message?: string } | null,
    extra?: Record<string, unknown>,
  ): void {
    const properties = {
      session_id: this.#record?.sessionId ?? null,
      error: normalizeRecord({
        name: error?.name ?? "GPUError",
        message: error?.message ?? "Unknown GPU error",
      }),
      extra: normalizeRecord(extra),
      canvas: this.#snapshotCanvas(),
      renderer: this.#snapshotRenderer(),
      environment: this.#getEnvironmentSnapshot(),
      last_action: this.#record?.lastAction,
    };

    analytics.track("gpu.uncaptured_error", properties);
    this.addBreadcrumb("gpu", "uncaptured.error", {
      error: properties.error,
      extra: normalizeRecord(extra),
    });
    logger.warn("[crash-reporting] GPU uncaptured error", error, extra);
  }

  #looksLikeCrash(previous: RuntimeSessionRecord): boolean {
    if (!previous.active || previous.gracefulExitAt) return false;
    const elapsed = Date.now() - new Date(previous.lastUpdatedAt).getTime();
    return Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= RECOVERY_WINDOW_MS;
  }

  #snapshotCanvas(): JsonRecord | null {
    try {
      return normalizeRecord(this.#canvasSnapshotProvider?.() ?? undefined) ?? null;
    } catch (error) {
      logger.warn("[crash-reporting] Canvas snapshot provider failed", error);
      return null;
    }
  }

  #snapshotRenderer(): JsonRecord | null {
    try {
      return normalizeRecord(this.#rendererSnapshotProvider?.() ?? undefined) ?? null;
    } catch (error) {
      logger.warn("[crash-reporting] Renderer snapshot provider failed", error);
      return null;
    }
  }

  #heartbeat(): void {
    if (!this.#record) return;
    this.#record.lastHeartbeatAt = nowIso();
    void this.#refreshMemorySnapshot();
    this.#persist();
  }

  #persist(): void {
    if (!this.#record) return;
    this.#record.lastUpdatedAt = nowIso();
    this.#record.environment = this.#getEnvironmentSnapshot();
    this.#record.canvas = this.#snapshotCanvas();
    this.#record.renderer = this.#snapshotRenderer();
    safeWrite(this.#record);
  }

  #getEnvironmentSnapshot(): JsonRecord {
    return getEnvironmentSnapshot(this.#memorySnapshot);
  }

  async #refreshMemorySnapshot(): Promise<void> {
    if (this.#memoryRefreshInFlight) return;

    const measurementFn = (
      performance as Performance & {
        measureUserAgentSpecificMemory?: () => Promise<{
          bytes: number;
          breakdown?: Array<{ bytes?: number }>;
        }>;
      }
    ).measureUserAgentSpecificMemory;

    if (!measurementFn) {
      this.#memorySnapshot = null;
      return;
    }

    this.#memoryRefreshInFlight = true;

    try {
      const measurement = await measurementFn.call(performance);
      this.#memorySnapshot = {
        bytes: measurement.bytes,
        breakdownCount: measurement.breakdown?.length ?? 0,
      };
      this.#persist();
    } catch (error) {
      this.#memorySnapshot = {
        error: coerceError(error, "measureUserAgentSpecificMemory failed").message,
      };
      logger.warn("[crash-reporting] measureUserAgentSpecificMemory failed", error);
      this.#persist();
    } finally {
      this.#memoryRefreshInFlight = false;
    }
  }

  #markGracefulExit(reason: string): void {
    if (!this.#record || !this.#record.active) return;
    this.#record.active = false;
    this.#record.gracefulExitAt = nowIso();
    this.#record.gracefulExitReason = reason;
    this.addBreadcrumb("app", "session.ended", { reason });
  }

  #handleWindowError = (event: ErrorEvent) => {
    const error = event.error ?? new Error(event.message || "Unhandled window error");
    this.captureException("window.error", error, {
      filename: event.filename || null,
      lineno: event.lineno || null,
      colno: event.colno || null,
    });
  };

  #handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    this.captureException("window.unhandledrejection", event.reason, {
      reason:
        event.reason instanceof Error
          ? normalizeError(event.reason)
          : (normalizeValue(event.reason) ?? null),
    });
  };

  #handleVisibilityChange = () => {
    this.addBreadcrumb("app", "visibility.changed", {
      visibilityState: document.visibilityState,
    });
  };

  #handlePageHide = () => {
    this.#markGracefulExit("pagehide");
  };

  #handleBeforeUnload = () => {
    this.#markGracefulExit("beforeunload");
  };
}

export const crashReporter = new CrashReporter();
