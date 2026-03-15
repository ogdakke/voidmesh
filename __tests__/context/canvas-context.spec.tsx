/**
 * Tests for canvas-context
 * Tests the CanvasProvider and useCanvas hook with the actual canvasStore
 */
import { describe, test, expect, beforeEach, afterEach } from "vite-plus/test";
import { screen, waitFor } from "@testing-library/react";
import React, { useEffect, useRef, useState } from "react";
import { useCanvas } from "#context/use-canvas.ts";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";
import type { CanvasContextValue } from "#context/canvas-context.tsx";
import { canvasStore } from "#engine";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithProviders } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";
import { ShaderType, Shape } from "#types/canvas.ts";
import { undo } from "#lib/undo.ts";
import { performUndo, performRedo, clearUndoHistory } from "../helpers/undo-helpers.ts";
import {
  assertEntityExists,
  assertEntityNotExists,
  assertEntityParam,
  assertAllSelectedHave,
} from "../helpers/assertions.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
  clearUndoHistory();
});

afterEach(() => {
  clearUndoHistory();
  cleanup();
});

// Skip providers we don't need for canvas-context tests
const skipProviders = {
  iconoir: true,
  toast: true,
  keybind: true,
  videoExport: true,
  exportQueue: true,
};

describe("CanvasProvider", () => {
  test("provides canvas context to children", () => {
    let contextValue: CanvasContextValue | null = null;

    function TestComponent() {
      contextValue = useCanvas();
      return <div data-testid="test">Rendered</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    expect(screen.getByTestId("test")).toBeInTheDocument();
    expect(contextValue).not.toBeNull();
    expect(typeof contextValue!.addEntity).toBe("function");
    expect(typeof contextValue!.removeEntity).toBe("function");
    expect(typeof contextValue!.selectEntity).toBe("function");
  });

  test("addEntity creates entity with unique ID", () => {
    let addedEntityId: string = "";

    function TestComponent() {
      const { addEntity, entities } = useCanvas();
      const didAdd = useRef(false);

      useEffect(() => {
        if (didAdd.current) return;
        didAdd.current = true;
        addedEntityId = addEntity(createEntityInput(), "test-image.png");
      });

      return <div data-testid="test">Entity count: {entities.length}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    // Entity should have been added
    expect(addedEntityId).toMatch(/^entity-\d+$/);

    // Store should contain the entity
    const snapshot = canvasStore.getState();
    expect(snapshot.entities.has(addedEntityId)).toBe(true);
  });

  test("selectEntity updates selectedEntityIds", async () => {
    let entityId: string = "";

    function TestComponent() {
      const { addEntity, selectEntity, selectedEntityIds } = useCanvas();
      const phase = useRef<"add" | "select" | "done">("add");

      useEffect(() => {
        if (phase.current === "add") {
          entityId = addEntity(createEntityInput());
          phase.current = "select";
        } else if (phase.current === "select" && entityId) {
          selectEntity(entityId);
          phase.current = "done";
        }
      });

      return <div data-testid="test">Selected: {[...selectedEntityIds].join(",")}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    // Wait for selection to be reflected
    await waitFor(() => {
      const snapshot = canvasStore.getState();
      return snapshot.selectedEntityIds.has(entityId);
    });

    expect(canvasStore.getState().selectedEntityIds.has(entityId)).toBe(true);
  });

  test("removeEntity removes from canvas", async () => {
    let entityId: string = "";

    function TestComponent() {
      const { addEntity, removeEntity, entities } = useCanvas();
      const [phase, setPhase] = useState<"add" | "remove" | "done">("add");

      useEffect(() => {
        if (phase === "add") {
          entityId = addEntity(createEntityInput());
          setPhase("remove");
        } else if (phase === "remove" && entityId) {
          removeEntity(entityId);
          setPhase("done");
        }
      }, [addEntity, removeEntity, phase]);

      return (
        <div data-testid="test">
          Entities: {entities.length}, Phase: {phase}
        </div>
      );
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    // Wait for removal to complete
    await waitFor(() => {
      return !canvasStore.getState().entities.has(entityId);
    });

    expect(canvasStore.getState().entities.has(entityId)).toBe(false);
  });

  test("updateSelectedEntityParams updates shader params", async () => {
    let entityId: string = "";

    function TestComponent() {
      const { addEntity, selectEntity, updateSelectedEntityParams, selectedEntityParams } =
        useCanvas();
      const [phase, setPhase] = useState<"add" | "select" | "update" | "done">("add");

      useEffect(() => {
        if (phase === "add") {
          entityId = addEntity(createEntityInput({ shaderType: ShaderType.halftone }));
          setPhase("select");
        } else if (phase === "select") {
          selectEntity(entityId);
          setPhase("update");
        } else if (phase === "update") {
          updateSelectedEntityParams({ size: 25 });
          setPhase("done");
        }
      }, [addEntity, selectEntity, updateSelectedEntityParams, phase]);

      return <div data-testid="test">CellSize: {selectedEntityParams?.size ?? "none"}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    // Wait for update to complete
    await waitFor(() => {
      const entity = canvasStore.getState().entities.get(entityId);
      return entity?.shaderParams.size === 25;
    });

    const entity = canvasStore.getState().entities.get(entityId);
    expect(entity?.shaderParams.size).toBe(25);
  });
});

describe("Multi-selection", () => {
  test("can select multiple entities", async () => {
    const entityIds: string[] = [];

    function TestComponent() {
      const { addEntity, selectedEntityIds } = useCanvas();
      const [ready, setReady] = useState(false);

      useEffect(() => {
        if (!ready) {
          // Add two entities
          for (let i = 0; i < 2; i++) {
            entityIds.push(addEntity(createEntityInput()));
          }
          setReady(true);
        }
      }, [addEntity, ready]);

      useEffect(() => {
        if (ready && entityIds.length === 2) {
          // Select both via canvasStore directly
          canvasStore.replaceSelection(entityIds);
        }
      }, [ready]);

      return <div data-testid="test">Selected count: {selectedEntityIds.size}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => {
      return canvasStore.getState().selectedEntityIds.size === 2;
    });

    const snapshot = canvasStore.getState();
    expect(snapshot.selectedEntityIds.size).toBe(2);
    expect(snapshot.selectedEntityIds.has(entityIds[0]!)).toBe(true);
    expect(snapshot.selectedEntityIds.has(entityIds[1]!)).toBe(true);
  });

  test("clearSelection removes all selections", async () => {
    function TestComponent() {
      const { addEntity, selectedEntityIds } = useCanvas();
      const [phase, setPhase] = useState<"add" | "select" | "clear" | "done">("add");

      useEffect(() => {
        if (phase === "add") {
          const entityId = addEntity(createEntityInput());
          canvasStore.replaceSelection([entityId]);
          setPhase("select");
        } else if (phase === "select") {
          // Verify selection happened
          if (canvasStore.getState().selectedEntityIds.size > 0) {
            canvasStore.clearSelection();
            setPhase("done");
          }
        }
      }, [addEntity, phase]);

      return <div data-testid="test">Selected: {selectedEntityIds.size}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => {
      return canvasStore.getState().selectedEntityIds.size === 0;
    });

    expect(canvasStore.getState().selectedEntityIds.size).toBe(0);
  });
});

describe("Undo/Redo", () => {
  describe("addEntity undo", () => {
    test("removes entity on undo", async () => {
      let addedEntityId: string = "";

      function TestComponent() {
        const { addEntity } = useCanvas();
        const [done, setDone] = useState(false);

        useEffect(() => {
          if (!done) {
            addedEntityId = addEntity(createEntityInput(), "test.png");
            setDone(true);
          }
        }, [addEntity, done]);

        return <div data-testid="test">Done: {String(done)}</div>;
      }

      renderWithProviders(<TestComponent />, { skip: skipProviders });

      await waitFor(() => canvasStore.getState().entities.has(addedEntityId));

      // Entity exists
      assertEntityExists(addedEntityId);

      // Undo should remove it
      performUndo();
      assertEntityNotExists(addedEntityId);
    });

    test("restores entity on redo", async () => {
      let addedEntityId: string = "";

      function TestComponent() {
        const { addEntity } = useCanvas();
        const [done, setDone] = useState(false);

        useEffect(() => {
          if (!done) {
            addedEntityId = addEntity(createEntityInput(), "test.png");
            setDone(true);
          }
        }, [addEntity, done]);

        return <div data-testid="test">Done: {String(done)}</div>;
      }

      renderWithProviders(<TestComponent />, { skip: skipProviders });

      await waitFor(() => canvasStore.getState().entities.has(addedEntityId));

      // Undo then redo
      performUndo();
      assertEntityNotExists(addedEntityId);

      performRedo();
      assertEntityExists(addedEntityId);
    });
  });

  describe("removeEntity undo", () => {
    test("restores entity with all properties on undo", async () => {
      let entityId: string = "";
      const testCellSize = 42;

      function TestComponent() {
        const { addEntity, selectEntity, updateSelectedEntityParams, removeEntity } = useCanvas();
        const [phase, setPhase] = useState<"add" | "update" | "remove" | "done">("add");

        useEffect(() => {
          if (phase === "add") {
            entityId = addEntity(
              createEntityInput({ shaderType: ShaderType.halftone }),
              "test.png",
            );
            selectEntity(entityId);
            setPhase("update");
          } else if (phase === "update") {
            updateSelectedEntityParams({ size: testCellSize });
            setPhase("remove");
          } else if (phase === "remove") {
            removeEntity(entityId);
            setPhase("done");
          }
        }, [addEntity, selectEntity, updateSelectedEntityParams, removeEntity, phase]);

        return <div data-testid="test">Phase: {phase}</div>;
      }

      renderWithProviders(<TestComponent />, { skip: skipProviders });

      await waitFor(() => !canvasStore.getState().entities.has(entityId));

      // Entity removed
      assertEntityNotExists(entityId);

      // Undo should restore it with original properties
      performUndo();
      assertEntityExists(entityId);

      const entity = canvasStore.getState().entities.get(entityId);
      expect(entity?.shaderParams.size).toBe(testCellSize);
    });
  });

  describe("updateEntity undo", () => {
    test("restores only changed fields on undo", async () => {
      let entityId: string = "";
      const originalCellSize = 10;
      const newCellSize = 30;

      function TestComponent() {
        const { addEntity, selectEntity, updateSelectedEntityParams } = useCanvas();
        const [phase, setPhase] = useState<"add" | "setup" | "select" | "update" | "done">("add");

        useEffect(() => {
          if (phase === "add") {
            entityId = addEntity(createEntityInput(), "test.png");
            setPhase("setup");
          } else if (phase === "setup") {
            // Set up initial state directly via store (no undo entry)
            const entity = canvasStore.getState().entities.get(entityId);
            if (entity) {
              canvasStore.updateEntity(entityId, {
                shaderParams: { ...entity.shaderParams, size: originalCellSize },
              });
            }
            setPhase("select");
          } else if (phase === "select") {
            selectEntity(entityId);
            setPhase("update");
          } else if (phase === "update") {
            // This creates an undo entry
            updateSelectedEntityParams({ size: newCellSize });
            setPhase("done");
          }
        }, [addEntity, selectEntity, updateSelectedEntityParams, phase]);

        return <div data-testid="test">Phase: {phase}</div>;
      }

      renderWithProviders(<TestComponent />, { skip: skipProviders });

      await waitFor(() => {
        const entity = canvasStore.getState().entities.get(entityId);
        return entity?.shaderParams.size === newCellSize;
      });

      // Verify new value
      assertEntityParam(entityId, "size", newCellSize);

      // Undo should restore original (the value we set up via canvasStore)
      performUndo();
      assertEntityParam(entityId, "size", originalCellSize);
    });

    test("handles deep nested param changes", async () => {
      let entityId: string = "";

      function TestComponent() {
        const { addEntity, selectEntity, updateSelectedEntityParams } = useCanvas();
        const [phase, setPhase] = useState<"add" | "select" | "update" | "done">("add");

        useEffect(() => {
          if (phase === "add") {
            entityId = addEntity(
              createEntityInput({ shaderType: ShaderType.halftone }),
              "test.png",
            );
            setPhase("select");
          } else if (phase === "select") {
            selectEntity(entityId);
            setPhase("update");
          } else if (phase === "update") {
            updateSelectedEntityParams({
              postProcess: {
                enabled: true,
                grain: { enabled: true, intensity: 0.5, size: 2 },
              },
            });
            setPhase("done");
          }
        }, [addEntity, selectEntity, updateSelectedEntityParams, phase]);

        return <div data-testid="test">Phase: {phase}</div>;
      }

      renderWithProviders(<TestComponent />, { skip: skipProviders });

      await waitFor(() => {
        const entity = canvasStore.getState().entities.get(entityId);
        return entity?.shaderParams.postProcess?.grain?.intensity === 0.5;
      });

      // Verify nested update applied
      const entityAfterUpdate = canvasStore.getState().entities.get(entityId);
      expect(entityAfterUpdate?.shaderParams.postProcess?.enabled).toBe(true);
      expect(entityAfterUpdate?.shaderParams.postProcess?.grain?.intensity).toBe(0.5);

      // Undo should restore
      performUndo();
      const entityAfterUndo = canvasStore.getState().entities.get(entityId);
      expect(entityAfterUndo?.shaderParams.postProcess?.grain?.intensity).not.toBe(0.5);
    });
  });

  describe("transactions", () => {
    test("groups multi-entity updates into single undo step", async () => {
      const entityIds: string[] = [];
      const originalCellSize = 10;
      const newCellSize = 50;

      function TestComponent() {
        const { addEntity, updateEntity } = useCanvas();
        const [phase, setPhase] = useState<"add" | "setup" | "update" | "done">("add");

        useEffect(() => {
          if (phase === "add") {
            // Add 3 entities (they get URL default params)
            for (let i = 0; i < 3; i++) {
              entityIds.push(addEntity(createEntityInput()));
            }
            setPhase("setup");
          } else if (phase === "setup" && entityIds.length === 3) {
            // Set up initial state directly via store (no undo entries)
            for (const id of entityIds) {
              const entity = canvasStore.getState().entities.get(id);
              if (entity) {
                canvasStore.updateEntity(id, {
                  shaderParams: { ...entity.shaderParams, size: originalCellSize },
                });
              }
            }
            setPhase("update");
          } else if (phase === "update" && entityIds.length === 3) {
            // Update all in a transaction using context.updateEntity (adds undo commands)
            undo.beginTransaction();
            for (const id of entityIds) {
              updateEntity(id, {
                shaderParams: {
                  ...canvasStore.getState().entities.get(id)!.shaderParams,
                  size: newCellSize,
                },
              });
            }
            undo.commitTransaction("Update all entities");
            setPhase("done");
          }
        }, [addEntity, updateEntity, phase]);

        return <div data-testid="test">Phase: {phase}</div>;
      }

      renderWithProviders(<TestComponent />, { skip: skipProviders });

      await waitFor(() => {
        return entityIds.every((id) => {
          const entity = canvasStore.getState().entities.get(id);
          return entity?.shaderParams.size === newCellSize;
        });
      });

      // All should be updated
      for (const id of entityIds) {
        assertEntityParam(id, "size", newCellSize);
      }

      // Single undo should revert all entities back to original size
      performUndo();

      // All entities should still exist and have original size
      for (const id of entityIds) {
        assertEntityExists(id);
        assertEntityParam(id, "size", originalCellSize);
      }
    });
  });
});

describe("Multi-select operations", () => {
  test("handleShaderTypeChange updates all selected entities", async () => {
    const entityIds: string[] = [];

    function TestComponent() {
      const { addEntity } = useCanvas();
      const { handleShaderTypeChange } = useCanvasActions();
      const [phase, setPhase] = useState<"add" | "select" | "update" | "done">("add");

      useEffect(() => {
        if (phase === "add") {
          // Add entities with different shader types
          entityIds.push(
            addEntity(createEntityInput({ shaderType: ShaderType.halftone })),
            addEntity(createEntityInput({ shaderType: ShaderType.dithering })),
            addEntity(createEntityInput({ shaderType: ShaderType.blobs })),
          );
          setPhase("select");
        } else if (phase === "select" && entityIds.length === 3) {
          canvasStore.replaceSelection(entityIds);
          setPhase("update");
        } else if (phase === "update") {
          handleShaderTypeChange(ShaderType.ascii);
          setPhase("done");
        }
      }, [addEntity, handleShaderTypeChange, phase]);

      return <div data-testid="test">Phase: {phase}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => {
      return entityIds.every((id) => {
        const entity = canvasStore.getState().entities.get(id);
        return entity?.shaderType === ShaderType.ascii;
      });
    });

    // All should have the new shader type
    for (const id of entityIds) {
      const entity = canvasStore.getState().entities.get(id);
      expect(entity?.shaderType).toBe(ShaderType.ascii);
    }
  });

  test("updateSelectedEntityParams deep merges nested params", async () => {
    const entityIds: string[] = [];

    function TestComponent() {
      const { addEntity, updateSelectedEntityParams } = useCanvas();
      const [phase, setPhase] = useState<"add" | "setup" | "select" | "update" | "done">("add");

      useEffect(() => {
        if (phase === "add") {
          // Add entities (they get URL default params)
          entityIds.push(addEntity(createEntityInput()), addEntity(createEntityInput()));
          setPhase("setup");
        } else if (phase === "setup" && entityIds.length === 2) {
          // Set up initial state directly via store (no undo entries)
          // Entity 1: size=10, shape=circle
          const entity1 = canvasStore.getState().entities.get(entityIds[0]!);
          if (entity1) {
            canvasStore.updateEntity(entityIds[0]!, {
              shaderParams: { ...entity1.shaderParams, size: 10, shape: Shape.circle },
            });
          }
          // Entity 2: size=20, shape=square
          const entity2 = canvasStore.getState().entities.get(entityIds[1]!);
          if (entity2) {
            canvasStore.updateEntity(entityIds[1]!, {
              shaderParams: { ...entity2.shaderParams, size: 20, shape: Shape.square },
            });
          }
          setPhase("select");
        } else if (phase === "select") {
          canvasStore.replaceSelection(entityIds);
          setPhase("update");
        } else if (phase === "update") {
          // Update only size, shape should remain unchanged
          updateSelectedEntityParams({ size: 35 });
          setPhase("done");
        }
      }, [addEntity, updateSelectedEntityParams, phase]);

      return <div data-testid="test">Phase: {phase}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => {
      return entityIds.every((id) => {
        const entity = canvasStore.getState().entities.get(id);
        return entity?.shaderParams.size === 35;
      });
    });

    // size should be updated for all
    assertAllSelectedHave("size", 35);

    // shape should be preserved (different for each)
    const entity1 = canvasStore.getState().entities.get(entityIds[0]!);
    const entity2 = canvasStore.getState().entities.get(entityIds[1]!);
    expect(entity1?.shaderParams.shape).toBe(Shape.circle);
    expect(entity2?.shaderParams.shape).toBe(Shape.square);
  });

  test("creates transaction for grouped undo on multi-select update", async () => {
    const entityIds: string[] = [];
    const originalCellSize = 10;
    const newCellSize = 50;

    function TestComponent() {
      const { addEntity, updateSelectedEntityParams } = useCanvas();
      const [phase, setPhase] = useState<"add" | "setup" | "select" | "update" | "done">("add");

      useEffect(() => {
        if (phase === "add") {
          entityIds.push(addEntity(createEntityInput()), addEntity(createEntityInput()));
          setPhase("setup");
        } else if (phase === "setup" && entityIds.length === 2) {
          // Set up initial state directly via store (no undo entries)
          for (const id of entityIds) {
            const entity = canvasStore.getState().entities.get(id);
            if (entity) {
              canvasStore.updateEntity(id, {
                shaderParams: { ...entity.shaderParams, size: originalCellSize },
              });
            }
          }
          setPhase("select");
        } else if (phase === "select") {
          canvasStore.replaceSelection(entityIds);
          setPhase("update");
        } else if (phase === "update") {
          updateSelectedEntityParams({ size: newCellSize });
          setPhase("done");
        }
      }, [addEntity, updateSelectedEntityParams, phase]);

      return <div data-testid="test">Phase: {phase}</div>;
    }

    renderWithProviders(<TestComponent />, { skip: skipProviders });

    await waitFor(() => {
      return entityIds.every((id) => {
        const entity = canvasStore.getState().entities.get(id);
        return entity?.shaderParams.size === newCellSize;
      });
    });

    // Both should be 50
    assertEntityParam(entityIds[0]!, "size", newCellSize);
    assertEntityParam(entityIds[1]!, "size", newCellSize);

    // Single undo should revert both (transaction)
    performUndo();

    assertEntityParam(entityIds[0]!, "size", originalCellSize);
    assertEntityParam(entityIds[1]!, "size", originalCellSize);
  });
});
