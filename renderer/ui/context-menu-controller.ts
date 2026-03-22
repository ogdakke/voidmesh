// ---------------------------------------------------------------------------
// Context Menu Controller
// ---------------------------------------------------------------------------
//
// Pure state controller for the canvas-rendered context menu.
// No React, no GPU — just state management and snapshot logic.
// Singleton, like actionLayerController.
//

import type { ShaderCanvasEntity } from "#types/canvas.ts";
import { SubmenuController } from "./submenu.ts";

export interface FrozenSelectionState {
  entities: ShaderCanvasEntity[];
  count: number;
  isMultiple: boolean;
}

export interface ContextMenuState {
  isOpen: boolean;
  /** Click position in CSS pixels */
  screenX: number;
  screenY: number;
  /** World-space click position */
  worldX: number;
  worldY: number;
  frozenEntity: ShaderCanvasEntity | undefined;
  frozenSelection: FrozenSelectionState | null;
}

class ContextMenuController {
  #state: ContextMenuState = {
    isOpen: false,
    screenX: 0,
    screenY: 0,
    worldX: 0,
    worldY: 0,
    frozenEntity: undefined,
    frozenSelection: null,
  };

  /** Submenu controller — active while the context menu is open */
  readonly submenu = new SubmenuController();

  /** Active submenu identifier (e.g. "style", "palette", "save-as") */
  #activeSubmenuId: string | null = null;

  get state(): Readonly<ContextMenuState> {
    return this.#state;
  }

  get isOpen(): boolean {
    return this.#state.isOpen;
  }

  get activeSubmenuId(): string | null {
    return this.#activeSubmenuId;
  }

  set activeSubmenuId(id: string | null) {
    this.#activeSubmenuId = id;
  }

  open(
    screenPoint: { x: number; y: number },
    worldPoint: { x: number; y: number },
    entity: ShaderCanvasEntity | undefined,
    selectedEntities: ShaderCanvasEntity[],
  ): void {
    this.#state = {
      isOpen: true,
      screenX: screenPoint.x,
      screenY: screenPoint.y,
      worldX: worldPoint.x,
      worldY: worldPoint.y,
      frozenEntity: entity,
      frozenSelection: {
        entities: selectedEntities,
        count: selectedEntities.length,
        isMultiple: selectedEntities.length > 1,
      },
    };
  }

  close(): void {
    this.submenu.close();
    this.#activeSubmenuId = null;
    this.#state = {
      isOpen: false,
      screenX: 0,
      screenY: 0,
      worldX: 0,
      worldY: 0,
      frozenEntity: undefined,
      frozenSelection: null,
    };
  }
}

export const contextMenuController = new ContextMenuController();
