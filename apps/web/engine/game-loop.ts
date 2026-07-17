import { logger } from "#lib/client.logger.ts";
import type { TouchConfig } from "#config";
import type { Bounds, Point } from "#types/canvas.ts";
import { CanvasInputController, createDefaultGameLoopDeps } from "./canvas-input-controller.ts";
import type { DragSelectMode, GameLoopDeps, SpacePanMode } from "./canvas-input-controller.ts";
import { FrameLoop, type CanvasRendererPort } from "./frame-loop.ts";

export type RenderErrorHandler = (error: unknown) => boolean | void;

export class GameLoop {
  readonly #deps: GameLoopDeps;
  #logger = logger;
  readonly #input: CanvasInputController;
  readonly #frameLoop: FrameLoop;
  #onRenderError: RenderErrorHandler | null = null;

  constructor(deps?: Partial<GameLoopDeps>) {
    this.#deps = { ...createDefaultGameLoopDeps(), ...deps };
    this.#input = new CanvasInputController(this.#deps);
    this.#frameLoop = new FrameLoop(
      {
        scheduler: this.#deps.scheduler,
        perf: this.#deps.perf,
      },
      {
        processInput: () => this.#input.processInput(),
        getDragSelectBounds: () => this.#input.getDragSelectBounds(),
        getDragSelectRenderMode: () => this.#input.getDragSelectRenderMode(),
        getMultiSelectBounds: () => this.#input.getMultiSelectBounds(),
        getActionLayerRenderState: () => this.#deps.actionLayer.getRenderState(),
        getDragVisualRenderState: () => this.#deps.dragVisual.getRenderState(),
        getDisintegrationRenderState: (now) => this.#deps.disintegration.getRenderState(now),
        isPointerDragging: () => this.#input.isPointerDragging(),
        isDragSelectActive: () => this.#input.isDragSelectActive(),
        onAfterFrame: () => this.#input.flushPendingScrollMomentum(),
        onRenderError: (error) => this.#handleFrameRenderError(error),
      },
    );
  }

  setRenderer(renderer: CanvasRendererPort): void {
    this.#frameLoop.setRenderer(renderer);
  }

  setRenderErrorHandler(handler: RenderErrorHandler | null): void {
    this.#onRenderError = handler;
  }

  setContainer(container: HTMLElement): void {
    this.#input.setContainer(container);
  }

  setPerfElement(element: HTMLElement): void {
    this.#deps.perf.setElement(element);
  }

  setTouchConfig(config: Partial<TouchConfig>): void {
    this.#input.setTouchConfig(config);
  }

  setReadOnly(readOnly: boolean): void {
    this.#input.setReadOnly(readOnly);
  }

  getTouchConfig(): TouchConfig {
    return this.#input.getTouchConfig();
  }

  setSpaceHeld(held: boolean): void {
    this.#input.setSpaceHeld(held);
  }

  get spacePanMode(): SpacePanMode {
    return this.#input.spacePanMode;
  }

  start(): void {
    this.#frameLoop.start();
  }

  stop(): void {
    this.#frameLoop.stop();
    this.#input.stop();
  }

  #handleFrameRenderError(error: unknown): void {
    const handled = this.#onRenderError?.(error) === true;
    if (!handled) {
      this.#logger.error("[GameLoop] Render failed", error);
    }
  }

  stopMomentum(): void {
    this.#input.stopMomentum();
  }

  processInput(): void {
    this.#input.processInput();
  }

  handlePointerDown(screenPoint: Point, shiftKey: boolean = false): void {
    this.#input.handlePointerDown(screenPoint, shiftKey);
  }

  handlePointerMove(screenPoint: Point): void {
    this.#input.handlePointerMove(screenPoint);
  }

  handlePointerUp(screenPoint: Point): void {
    this.#input.handlePointerUp(screenPoint);
  }

  handleWheel(deltaX: number, deltaY: number, screenPoint: Point, ctrlKey: boolean): void {
    this.#input.handleWheel(deltaX, deltaY, screenPoint, ctrlKey);
  }

  handleContextMenu(screenPoint: Point): void {
    this.#input.handleContextMenu(screenPoint);
  }

  handleContextMenuClose(): void {
    this.#input.handleContextMenuClose();
  }

  getDragSelectBounds(): Bounds | null {
    return this.#input.getDragSelectBounds();
  }

  getDragSelectMode(): DragSelectMode | null {
    return this.#input.getDragSelectMode();
  }

  getMultiSelectBounds(): Bounds | null {
    return this.#input.getMultiSelectBounds();
  }

  handleTouchStart(touches: Point[], eventTime?: number): void {
    this.#input.handleTouchStart(touches, eventTime);
  }

  handleTouchMove(touches: Point[], eventTime?: number): void {
    this.#input.handleTouchMove(touches, eventTime);
  }

  handleTouchEnd(
    remainingTouches: { x: number; y: number }[],
    isCancelled: boolean = false,
    eventTime?: number,
  ): void {
    this.#input.handleTouchEnd(remainingTouches, isCancelled, eventTime);
  }

  isTouchActive(): boolean {
    return this.#input.isTouchActive();
  }
}

export const gameLoop = new GameLoop();
