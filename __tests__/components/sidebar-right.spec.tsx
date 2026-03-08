/**
 * Tests for sidebar-right component
 * Tests the sidebar with shader parameter controls and multi-select support
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import React from "react";
import { SidebarRight } from "../../components/sidebar-right.tsx";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithProviders, renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { EntitySetup } from "../helpers/entity-setup.tsx";
import { ShaderType } from "#types/canvas.ts";
import { config } from "#config";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
});

afterEach(() => {
  cleanup();
});

// SidebarRight needs exportQueue which needs videoExport - don't skip either
const skipProviders = {};

describe("SidebarRight", () => {
  describe("no selection state", () => {
    test("shows upload button", () => {
      renderWithProviders(<SidebarRight />, { skip: skipProviders });

      const uploadButton = screen.getByRole("button", { name: /add images\/videos/i });
      expect(uploadButton).toBeInTheDocument();
    });

    test("shows 'drop or paste' message when no entities", () => {
      renderWithProviders(<SidebarRight />, { skip: skipProviders });

      expect(screen.getByText(/drop or paste images/i)).toBeInTheDocument();
    });

    test("shows 'select an image' message when entities exist but none selected", async () => {
      const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

      act(() => {
        canvas.addEntity(createEntityInput());
        // Don't select the entity
      });

      await waitFor(() => screen.queryByText(/select an image or video/i) !== null);

      expect(screen.getByText(/select an image or video/i)).toBeInTheDocument();
    });

    test("does not show shader controls when nothing selected", () => {
      renderWithProviders(<SidebarRight />, { skip: skipProviders });

      // Shader type select should not be present (use exact match to avoid "Style Parameters")
      expect(screen.queryByLabelText(/^style$/i)).not.toBeInTheDocument();
      // Reset button should not be present
      expect(screen.queryByRole("button", { name: /reset/i })).not.toBeInTheDocument();
    });
  });

  describe("single selection state", () => {
    test("shows shader type select", async () => {
      const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

      act(() => {
        const id = canvas.addEntity(createEntityInput());
        canvas.selectEntity(id);
      });

      await waitFor(() => screen.queryByLabelText(/^style$/i) !== null);

      expect(screen.getByLabelText(/^style$/i)).toBeInTheDocument();
    });

    test("shows reset button", async () => {
      const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

      act(() => {
        const id = canvas.addEntity(createEntityInput());
        canvas.selectEntity(id);
      });

      await waitFor(() => screen.queryByRole("button", { name: /reset/i }) !== null);

      expect(screen.getByRole("button", { name: /reset/i })).toBeInTheDocument();
    });

    test("shows show original toggle", async () => {
      const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

      act(() => {
        const id = canvas.addEntity(createEntityInput());
        canvas.selectEntity(id);
      });

      await waitFor(() => screen.queryByTitle(/show original/i) !== null);

      expect(screen.getByTitle(/show original/i)).toBeInTheDocument();
    });
  });

  describe("multi-selection state", () => {
    test("shows 'Mixed' in shader select when types differ", async () => {
      renderWithProviders(
        <EntitySetup
          entities={[{ shaderType: ShaderType.halftone }, { shaderType: ShaderType.dithering }]}
          select="all"
          useStoreDirectly
        >
          <SidebarRight />
        </EntitySetup>,
        { skip: skipProviders },
      );

      await waitFor(() => {
        return screen.queryByText(/mixed/i) !== null;
      });

      // Should show "Mixed" indicator
      expect(screen.getByText(/mixed/i)).toBeInTheDocument();
    });

    test("shows uniform value when all have same shader type", async () => {
      renderWithProviders(
        <EntitySetup
          entities={[{ shaderType: ShaderType.halftone }, { shaderType: ShaderType.halftone }]}
          select="all"
        >
          <SidebarRight />
        </EntitySetup>,
        { skip: skipProviders },
      );

      await waitFor(() => {
        return screen.queryByLabelText(/^style$/i) !== null;
      });

      // Should show the shader type, not "Mixed"
      expect(screen.queryByText(/^mixed$/i)).not.toBeInTheDocument();
    });
  });
});

describe("BlobParams", () => {
  test("renders nothing when blobs shader not selected", async () => {
    const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput());
      canvas.selectEntity(id);
      // Default shader from URL is dithering, not blobs
    });

    await waitFor(() => screen.queryByLabelText(/^style$/i) !== null);

    // Eagerness slider should not be present for dithering
    expect(screen.queryByText(/eagerness/i)).not.toBeInTheDocument();
  });

  test("renders eagerness slider when blobs shader selected", async () => {
    const { canvas, actions } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput());
      canvas.selectEntity(id);
    });

    // Change to blobs shader using hook
    act(() => {
      actions.handleShaderTypeChange(ShaderType.blobs);
    });

    await waitFor(() => screen.queryByText(/eagerness/i) !== null);

    expect(screen.getByText(/eagerness/i)).toBeInTheDocument();
  });

  test("shows (Mixed) label when eagerness values differ", async () => {
    renderWithProviders(
      <EntitySetup
        entities={[
          { shaderType: ShaderType.blobs, shaderParams: { blobs: { eagerness: 0.2 } } },
          { shaderType: ShaderType.blobs, shaderParams: { blobs: { eagerness: 0.8 } } },
        ]}
        select="all"
        useStoreDirectly
      >
        <SidebarRight />
      </EntitySetup>,
      { skip: skipProviders },
    );

    await waitFor(() => {
      return screen.queryByText(/eagerness.*mixed/i) !== null;
    });

    expect(screen.getByText(/eagerness.*mixed/i)).toBeInTheDocument();
  });
});

describe("EntityParams", () => {
  test("shows 'Mixed palettes' when palette values differ", async () => {
    renderWithProviders(
      <EntitySetup
        entities={[
          { shaderParams: { palette: config.palettes.gameboy } },
          { shaderParams: { palette: config.palettes.cga } },
        ]}
        select="all"
        useStoreDirectly
      >
        <SidebarRight />
      </EntitySetup>,
      { skip: skipProviders },
    );

    await waitFor(() => {
      return screen.queryByText(/mixed palettes/i) !== null;
    });

    expect(screen.getByText(/mixed palettes/i)).toBeInTheDocument();
  });

  test("shows 'Mixed' label for mixed size", async () => {
    renderWithProviders(
      <EntitySetup
        entities={[{ shaderParams: { size: 10 } }, { shaderParams: { size: 30 } }]}
        select="all"
        useStoreDirectly
      >
        <SidebarRight />
      </EntitySetup>,
      { skip: skipProviders },
    );

    await waitFor(() => {
      return screen.queryByText(/size.*mixed/i) !== null;
    });

    expect(screen.getByText(/size.*mixed/i)).toBeInTheDocument();
  });

  test("shows preserve colors toggle for mixed preserveColors", async () => {
    renderWithProviders(
      <EntitySetup
        entities={[
          { shaderParams: { preserveColors: true } },
          { shaderParams: { preserveColors: false } },
        ]}
        select="all"
        useStoreDirectly
      >
        <SidebarRight />
      </EntitySetup>,
      { skip: skipProviders },
    );

    await waitFor(() => {
      return screen.queryByTitle(/preserve colors/i) !== null;
    });

    expect(screen.getByTitle(/preserve colors/i)).toBeInTheDocument();
  });
});

describe("Collapsible sections", () => {
  test("shows adjustments section when entity selected", async () => {
    const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput());
      canvas.selectEntity(id);
    });

    await waitFor(() => screen.queryByText(/adjustments/i) !== null);

    expect(screen.getByText(/adjustments/i)).toBeInTheDocument();
  });

  test("shows style parameters section when entity selected", async () => {
    const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput());
      canvas.selectEntity(id);
    });

    await waitFor(() => screen.queryByText(/style parameters/i) !== null);

    expect(screen.getByText(/style parameters/i)).toBeInTheDocument();
  });

  test("shows post processing section when entity selected", async () => {
    const { canvas } = renderWithCanvas(<SidebarRight />, { skip: skipProviders });

    act(() => {
      const id = canvas.addEntity(createEntityInput());
      canvas.selectEntity(id);
    });

    await waitFor(() => screen.queryByText(/post processing/i) !== null);

    expect(screen.getByText(/post processing/i)).toBeInTheDocument();
  });
});
