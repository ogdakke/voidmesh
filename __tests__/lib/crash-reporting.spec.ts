import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DitheringKind, MediaType, ShaderType, type ShaderCanvasEntity } from "#types/canvas.ts";

function createEntity(
  overrides: Partial<ShaderCanvasEntity> & {
    id: string;
    mediaSource: ShaderCanvasEntity["mediaSource"];
  },
): ShaderCanvasEntity {
  const { id, mediaSource, ...rest } = overrides;

  return {
    id,
    assetId: overrides.assetId ?? `asset-${id}`,
    name: overrides.name ?? id,
    position: { x: 0, y: 0 },
    size: overrides.size ?? { width: 100, height: 100 },
    zIndex: 1,
    rotation: 0,
    imageBitmap: {} as ImageBitmap,
    originalSize: overrides.originalSize ?? { width: 100, height: 100 },
    shaderType: overrides.shaderType ?? ShaderType.halftone,
    shaderParams:
      overrides.shaderParams ??
      ({
        dithering: { kind: DitheringKind.bayer4x4 },
      } as ShaderCanvasEntity["shaderParams"]),
    edited: false,
    ...rest,
    mediaSource,
  } as ShaderCanvasEntity;
}

describe("crash-reporting", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  test("reports an unexpected previous session exit on next boot", async () => {
    localStorage.setItem(
      "studio:crash-report",
      JSON.stringify({
        version: 1,
        sessionId: "previous-session",
        active: true,
        startedAt: "2026-04-10T10:00:00.000Z",
        lastUpdatedAt: "2026-04-10T10:01:00.000Z",
        lastHeartbeatAt: "2026-04-10T10:01:00.000Z",
        gracefulExitAt: null,
        gracefulExitReason: null,
        lastAction: {
          at: "2026-04-10T10:00:59.000Z",
          name: "entity.duplicate.requested",
          data: { entity_count: 29 },
        },
        breadcrumbs: [
          {
            at: "2026-04-10T10:00:59.000Z",
            category: "action",
            message: "entity.duplicate.requested",
          },
        ],
        canvas: { entityCount: 29 },
        renderer: { entityCount: 29 },
        environment: { userAgent: "test" },
      }),
    );

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T10:02:00.000Z"));

    const { provideMockAnalytics } = await import("#lib/analytics.ts");
    const { crashReporter } = await import("#lib/crash-reporting.ts");
    const { mock, cleanup } = provideMockAnalytics();

    crashReporter.initialize();

    expect(mock.calls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "app.crash_recovered",
          properties: expect.objectContaining({
            previous_session_id: "previous-session",
            previous_last_action: "entity.duplicate.requested",
          }),
        }),
      ]),
    );

    cleanup();
    vi.useRealTimers();
  });

  test("summarizes entity counts and estimated memory", async () => {
    const { summarizeEntities } = await import("#lib/crash-reporting.ts");

    const entities: ShaderCanvasEntity[] = [
      createEntity({
        id: "image-1",
        originalSize: { width: 400, height: 200 },
        shaderType: ShaderType.halftone,
        mediaSource: {
          type: MediaType.image,
          blob: new Blob(),
          assetId: "asset-image-1",
        },
      }),
      createEntity({
        id: "image-2",
        originalSize: { width: 300, height: 300 },
        shaderType: ShaderType.dithering,
        shaderParams: {
          dithering: { kind: DitheringKind.floydSteinberg },
        } as ShaderCanvasEntity["shaderParams"],
        mediaSource: {
          type: MediaType.image,
          blob: new Blob(),
          assetId: "asset-image-2",
        },
      }),
    ];

    const summary = summarizeEntities(entities, new Set(["image-2"]));

    expect(summary.entityCount).toBe(2);
    expect(summary.selectedCount).toBe(1);
    expect(summary.mediaTypeCounts.image).toBe(2);
    expect(summary.shaderTypeCounts.dithering).toBe(1);
    expect(summary.totalPixels).toBe(170000);
    expect(summary.selectedPixels).toBe(90000);
    expect(summary.memoryEstimate.bitmapBytes).toBe(680000);
    expect(summary.memoryEstimate.sourceTextureBytes).toBe(680000);
    expect(summary.memoryEstimate.processedTextureBytes).toBe(1360000);
    expect(summary.memoryEstimate.errorDiffusionBytes).toBe(1440000);
    expect(summary.memoryEstimate.totalBytes).toBe(4160000);
  });
});
