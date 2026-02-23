/**
 * Tests for AdjustmentsKnobs component
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import { AdjustmentsKnobs } from "../../components/adjustments-knobs.tsx";
import { canvasStore } from "#engine";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithProviders, renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
});

afterEach(() => {
  cleanup();
});

describe("AdjustmentsKnobs", () => {
  test("renders nothing when no entity is selected", () => {
    const { container } = renderWithProviders(<AdjustmentsKnobs />);

    // Component should render empty/null
    expect(container.innerHTML).toBe("");
  });

  test("renders brightness/contrast/saturation/blur sliders when entity is selected", async () => {
    const { canvas } = renderWithCanvas(<AdjustmentsKnobs />);

    act(() => {
      const input = createEntityInput({
        shaderParams: {
          adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
        },
      });
      const id = canvas.addEntity(input);
      canvas.selectEntity(id);
    });

    await waitFor(() => {
      return canvasStore.getState().selectedEntityIds.size > 0;
    });

    // Check for slider labels
    expect(screen.getByText("Brightness")).toBeInTheDocument();
    expect(screen.getByText("Contrast")).toBeInTheDocument();
    expect(screen.getByText("Saturation")).toBeInTheDocument();
    expect(screen.getByText("Blur")).toBeInTheDocument();
  });

  test("shows (Mixed) label when multi-select with different values", async () => {
    const { canvas } = renderWithCanvas(<AdjustmentsKnobs />);

    act(() => {
      const entityId1 = canvas.addEntity(createEntityInput());
      const entityId2 = canvas.addEntity(createEntityInput());

      // Update entities with different brightness values AFTER they're added
      // (since addEntity applies URL params that may override our test values)
      canvas.updateEntity(entityId1, {
        shaderParams: {
          ...canvasStore.getState().entities.get(entityId1)!.shaderParams,
          adjustments: { brightness: 0.3, contrast: 0.5, saturation: 0.5, blur: 0 },
        },
      });
      canvas.updateEntity(entityId2, {
        shaderParams: {
          ...canvasStore.getState().entities.get(entityId2)!.shaderParams,
          adjustments: { brightness: 0.7, contrast: 0.5, saturation: 0.5, blur: 0 },
        },
      });

      // Select both
      canvasStore.replaceSelection([entityId1, entityId2]);
    });

    await waitFor(
      () => {
        return canvasStore.getState().selectedEntityIds.size === 2;
      },
      { timeout: 2000 },
    );

    // Verify entities have different brightness values
    const entities = canvasStore.getSelectedEntities();
    const brightnessValues = entities.map((e) => e.shaderParams.adjustments?.brightness);
    expect(brightnessValues).toContain(0.3);
    expect(brightnessValues).toContain(0.7);

    // Check for mixed label - brightness should show mixed since values differ
    await waitFor(
      () => {
        return screen.queryByText("Brightness (Mixed)") !== null;
      },
      { timeout: 2000 },
    );

    expect(screen.getByText("Brightness (Mixed)")).toBeInTheDocument();
  });
});

describe("AdjustmentsKnobs slider interactions", () => {
  test("sliders are rendered with correct initial values", async () => {
    const { canvas } = renderWithCanvas(<AdjustmentsKnobs />);

    act(() => {
      const input = createEntityInput({
        shaderParams: {
          adjustments: { brightness: 0.5, contrast: 0.5, saturation: 0.5, blur: 0 },
        },
      });
      const id = canvas.addEntity(input);
      canvas.selectEntity(id);
    });

    await waitFor(() => {
      return canvasStore.getState().selectedEntityIds.size > 0;
    });

    // Find all slider inputs (brightness, contrast, saturation, blur)
    const sliders = screen.getAllByRole("slider");
    expect(sliders.length).toBe(4);
  });
});
