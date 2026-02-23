/**
 * Tests for canvas-context-menu component
 * Tests the context menu with multi-select support
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React, { useRef } from "react";
import { CanvasContextMenu } from "../../components/infinite-canvas/canvas-context-menu.tsx";
import { canvasStore } from "#engine";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithProviders, renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { ShaderType } from "#types/canvas.ts";
import { mockClipboard } from "../mocks/clipboard.mock.ts";
import type { ClipboardMock } from "../mocks/clipboard.mock.ts";

let cleanup: () => void;
let clipboardMock: ClipboardMock;

beforeEach(() => {
  cleanup = setupCanvasTest();
  clipboardMock = mockClipboard();
});

afterEach(() => {
  clipboardMock.cleanup();
  cleanup();
});

// CanvasContextMenu uses useExportQueue, which needs ExportQueueProvider and VideoExportProvider
// So we can't skip those. Only skip providers the component doesn't use.
const skipProviders = {};

// Helper wrapper component for context menu tests
// When the menu opens, automatically sets contextOpenEntity to the first selected entity
function ContextMenuTestWrapper({
  onOpenChange: onOpenChangeProp,
  children,
}: {
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Set contextOpenEntityId when menu opens, using first selected entity
  const onOpenChange = (open: boolean) => {
    if (open) {
      const selectedIds = canvasStore.getState().selectedEntityIds;
      const firstSelected = selectedIds.values().next().value;
      if (firstSelected) {
        canvasStore.setContextOpenEntity(firstSelected);
      }
    }
    onOpenChangeProp?.(open);
  };

  return (
    <div ref={containerRef} data-testid="canvas-container">
      <CanvasContextMenu onOpenChange={onOpenChange} containerRef={containerRef}>
        <div data-testid="trigger-area" style={{ width: 500, height: 500 }}>
          {children}
        </div>
      </CanvasContextMenu>
    </div>
  );
}

describe("CanvasContextMenu", () => {
  describe("no entity selected", () => {
    test("shows only paste option when no entity is under cursor", async () => {
      const user = userEvent.setup();

      renderWithProviders(<ContextMenuTestWrapper />, { skip: skipProviders });

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/paste/i) !== null;
      });

      // Should show paste option
      expect(screen.getByText(/paste/i)).toBeInTheDocument();

      // Should NOT show other options like Style, Copy, Delete
      expect(screen.queryByText(/^style$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^copy$/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/^delete$/i)).not.toBeInTheDocument();
    });
  });

  describe("single entity selected", () => {
    test("shows shader type submenu when entity selected", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const id = canvas.addEntity(createEntityInput({ shaderType: ShaderType.halftone }));
        canvas.selectEntity(id);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 1);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/^style$/i) !== null;
      });

      // Style submenu trigger should be present
      expect(screen.getByText(/^style$/i)).toBeInTheDocument();
    });

    test("shows copy option for single entity", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const id = canvas.addEntity(createEntityInput());
        canvas.selectEntity(id);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 1);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/copy image/i) !== null;
      });

      // Copy Image option should be present for single static image entity
      expect(screen.getByText(/copy image/i)).toBeInTheDocument();
    });

    test("shows save option for single entity", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const id = canvas.addEntity(createEntityInput());
        canvas.selectEntity(id);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 1);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/save/i) !== null;
      });

      // Save option should be present
      expect(screen.getByText(/save/i)).toBeInTheDocument();
    });
  });

  describe("multi-select state", () => {
    test("shows selection count header", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [
          canvas.addEntity(createEntityInput()),
          canvas.addEntity(createEntityInput()),
          canvas.addEntity(createEntityInput()),
        ];
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 3);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/3 items selected/i) !== null;
      });

      expect(screen.getByText(/3 items selected/i)).toBeInTheDocument();
    });

    test("hides copy option for multi-select (clipboard limitation)", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/2 items selected/i) !== null;
      });

      // Copy option should NOT show "Copy Image" for multi-select
      // The only copy shown is in the Copy/Paste as... submenu
      const copyItems = screen.queryAllByText(/^copy image$/i);
      expect(copyItems.length).toBe(0);
    });

    test("shows delete count in label", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/delete.*\(2\)/i) !== null;
      });

      expect(screen.getByText(/delete.*\(2\)/i)).toBeInTheDocument();
    });
  });

  describe("checkboxes with mixed state", () => {
    test("shows (Mixed) suffix for showOriginal when mixed", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        // Set different showOriginal values directly via store (addEntity ignores input params)
        const e0 = canvasStore.getState().entities.get(ids[0]!)!;
        const e1 = canvasStore.getState().entities.get(ids[1]!)!;
        canvasStore.updateEntity(ids[0]!, {
          shaderParams: { ...e0.shaderParams, showOriginal: true },
        });
        canvasStore.updateEntity(ids[1]!, {
          shaderParams: { ...e1.shaderParams, showOriginal: false },
        });
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/show original.*mixed/i) !== null;
      });

      expect(screen.getByText(/show original.*mixed/i)).toBeInTheDocument();
    });

    test("shows (Mixed) suffix for preserveColors when mixed", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        // Set different preserveColors values directly via store (addEntity ignores input params)
        const e0 = canvasStore.getState().entities.get(ids[0]!)!;
        const e1 = canvasStore.getState().entities.get(ids[1]!)!;
        canvasStore.updateEntity(ids[0]!, {
          shaderParams: { ...e0.shaderParams, preserveColors: true },
        });
        canvasStore.updateEntity(ids[1]!, {
          shaderParams: { ...e1.shaderParams, preserveColors: false },
        });
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/preserve colors.*mixed/i) !== null;
      });

      expect(screen.getByText(/preserve colors.*mixed/i)).toBeInTheDocument();
    });
  });

  describe("shader type submenu", () => {
    test("shows current types when mixed", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });
      let entityIds: string[] = [];

      act(() => {
        entityIds = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        // Set different shader types directly via store (addEntity ignores input shaderType)
        // Default is dithering, so set one to halftone and one to ascii for clear difference
        canvasStore.updateEntity(entityIds[0]!, { shaderType: ShaderType.halftone });
        canvasStore.updateEntity(entityIds[1]!, { shaderType: ShaderType.ascii });
        canvasStore.replaceSelection(entityIds);
      });

      // Wait for selection and verify entities have different shader types
      await waitFor(() => {
        const snapshot = canvasStore.getState();
        if (snapshot.selectedEntityIds.size !== 2) return false;
        const e0 = snapshot.entities.get(entityIds[0]!);
        const e1 = snapshot.entities.get(entityIds[1]!);
        return e0?.shaderType === ShaderType.halftone && e1?.shaderType === ShaderType.ascii;
      });

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/^style$/i) !== null;
      });

      // Press ArrowRight to open the Style submenu (Style is the first focusable item after header)
      await user.keyboard("{ArrowDown}"); // Move to Style (skips header)
      await user.keyboard("{ArrowRight}"); // Open submenu

      await waitFor(() => {
        return screen.queryByText(/selection styles/i) !== null;
      });

      // Should show "Selection styles" header with the current types
      expect(screen.getByText(/selection styles/i)).toBeInTheDocument();
    });
  });

  describe("layer ordering", () => {
    test("shows bring to front with count for multi-select", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/bring to front.*\(2\)/i) !== null;
      });

      expect(screen.getByText(/bring to front.*\(2\)/i)).toBeInTheDocument();
    });

    test("shows send to back with count for multi-select", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/send to back.*\(2\)/i) !== null;
      });

      expect(screen.getByText(/send to back.*\(2\)/i)).toBeInTheDocument();
    });
  });

  describe("reset option", () => {
    test("shows reset with count for multi-select", async () => {
      const user = userEvent.setup();
      const { canvas } = renderWithCanvas(<ContextMenuTestWrapper />, { skip: skipProviders });

      act(() => {
        const ids = [canvas.addEntity(createEntityInput()), canvas.addEntity(createEntityInput())];
        canvasStore.replaceSelection(ids);
      });

      await waitFor(() => canvasStore.getState().selectedEntityIds.size === 2);

      const trigger = screen.getByTestId("trigger-area");
      await user.pointer({ keys: "[MouseRight]", target: trigger });

      await waitFor(() => {
        return screen.queryByText(/reset.*\(2\)/i) !== null;
      });

      expect(screen.getByText(/reset.*\(2\)/i)).toBeInTheDocument();
    });
  });
});
