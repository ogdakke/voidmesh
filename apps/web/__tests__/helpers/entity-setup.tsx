/**
 * Multi-select scenario factory and entity setup utilities for testing
 */
import React, { useEffect, useState, type ReactNode } from "react";
import { useCanvasCommands } from "#context/use-canvas.ts";
import { canvasStore } from "#engine";
import { createTestEntity, createEntityInput, type CreateEntityOptions } from "./test-entity.ts";

/**
 * Setup multiple entities with optional selection
 *
 * @example
 * const { entityIds, cleanup } = setupMultiSelect([
 *   { shaderType: "halftone" },
 *   { shaderType: "dithering" },
 * ], true); // select all
 */
export function setupMultiSelect(
  configs: CreateEntityOptions[],
  selectAll?: boolean,
): { entityIds: string[]; cleanup: () => void } {
  const entities = configs.map((cfg) => createTestEntity(cfg));
  const entityIds = entities.map((e) => e.id);

  // Add entities to store
  for (const entity of entities) {
    canvasStore.addEntity(entity);
  }

  // Select all if requested
  if (selectAll) {
    canvasStore.replaceSelection(entityIds);
  }

  return {
    entityIds,
    cleanup: () => {
      canvasStore.clearSelection();
      for (const id of entityIds) {
        canvasStore.removeEntity(id);
      }
    },
  };
}

/**
 * React component for test setup - adds entities and optionally selects them
 *
 * @example
 * function TestComponent() {
 *   return (
 *     <EntitySetup
 *       entities={[{ shaderType: "halftone" }, { shaderType: "dithering" }]}
 *       select="all"
 *       onReady={(ids) => console.log("Entities ready:", ids)}
 *     >
 *       <YourComponent />
 *     </EntitySetup>
 *   );
 * }
 */
export function EntitySetup({
  entities: entityConfigs,
  select = "none",
  onReady,
  children,
  useStoreDirectly = false,
}: {
  entities: CreateEntityOptions[];
  select?: "all" | "first" | "none" | number[];
  onReady?: (ids: string[]) => void;
  children?: ReactNode;
  /**
   * When true, uses canvasStore.addEntity directly instead of context's addEntity.
   * This allows tests to specify exact shaderTypes without them being overridden
   * by the context's renderState.shader.
   *
   * Use this when testing multi-select scenarios with different shader types.
   */
  useStoreDirectly?: boolean;
}): ReactNode {
  const { addEntity, selectEntity } = useCanvasCommands();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (ready) return;

    const ids: string[] = [];
    for (const cfg of entityConfigs) {
      if (useStoreDirectly) {
        // Use store directly to preserve exact shaderType from config
        const entity = createTestEntity(cfg);
        canvasStore.addEntity(entity);
        ids.push(entity.id);
      } else {
        // Use context's addEntity (inherits renderState.shader)
        const id = addEntity(createEntityInput(cfg));
        ids.push(id);
      }
    }

    // Handle selection
    if (select === "all" && ids.length > 0) {
      canvasStore.replaceSelection(ids);
    } else if (select === "first" && ids.length > 0) {
      selectEntity(ids[0]!);
    } else if (Array.isArray(select)) {
      const selectedIds = select.map((i) => ids[i]).filter((id): id is string => id !== undefined);
      canvasStore.replaceSelection(selectedIds);
    }

    setReady(true);
    onReady?.(ids);
  }, [addEntity, selectEntity, entityConfigs, select, onReady, ready, useStoreDirectly]);

  return <>{children}</>;
}
