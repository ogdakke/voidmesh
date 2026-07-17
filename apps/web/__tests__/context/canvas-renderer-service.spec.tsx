import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { useCanvasRendererService } from "#context/use-canvas.ts";
import { canvasStore } from "#engine";
import type { InfiniteCanvasRenderer } from "#renderer/canvas-renderer.ts";
import { renderWithProviders } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { createTestEntity } from "../helpers/test-entity.ts";

const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

describe("CanvasRendererService", () => {
  let cleanup: () => void;

  beforeEach(() => {
    cleanup = setupCanvasTest();
  });

  afterEach(() => cleanup());

  test("keeps renderer registration stable while single-entity params sync to the URL", async () => {
    const registrations = new Set<(renderer: InfiniteCanvasRenderer) => void>();
    let urlUpdates = 0;

    function CaptureRendererService() {
      registrations.add(useCanvasRendererService().registerRenderer);
      return null;
    }

    renderWithProviders(<CaptureRendererService />, {
      skip: skipProviders,
      nuqsOptions: {
        onUrlUpdate: () => {
          urlUpdates++;
        },
      },
    });

    const entity = createTestEntity({ id: "single-param-url-sync" });
    act(() => {
      canvasStore.addEntities([entity]);
      canvasStore.replaceSelection([entity.id]);
    });
    await waitFor(() => expect(urlUpdates).toBeGreaterThan(0));

    act(() => {
      canvasStore.updateEntity(entity.id, {
        shaderParams: { ...entity.shaderParams, size: entity.shaderParams.size + 1 },
        textureDirty: true,
      });
    });
    await waitFor(() => expect(urlUpdates).toBeGreaterThan(1));

    expect(registrations.size).toBe(1);
  });
});
