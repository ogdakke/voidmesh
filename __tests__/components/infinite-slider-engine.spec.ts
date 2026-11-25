import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SliderEngine } from "#ui/infinite-slider/slider-engine.ts";

function createEngine() {
  const onValueChange = vi.fn<(value: number) => void>();
  const onValueCommit = vi.fn<(value: number) => void>();
  const onInteractionStart = vi.fn<() => void>();
  const engine = new SliderEngine({
    min: 0,
    max: 100,
    initialValue: 50,
    onFrame: () => {},
    onValueChange,
    onValueCommit,
    onInteractionStart,
  });
  return { engine, onValueChange, onValueCommit, onInteractionStart };
}

describe("SliderEngine.destroy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("commits an interaction that is still in flight", () => {
    const { engine, onValueCommit, onInteractionStart } = createEngine();

    engine.handlePointerDown(200);
    engine.handlePointerMove(150);
    engine.handlePointerUp();
    expect(onInteractionStart).toHaveBeenCalledTimes(1);

    engine.destroy();
    expect(onValueCommit).toHaveBeenCalledTimes(1);
    expect(onValueCommit).toHaveBeenCalledWith(engine.getValue());

    vi.runAllTimers();
    expect(onValueCommit).toHaveBeenCalledTimes(1);
  });

  it("commits a keyboard step whose snap and commit are still pending", () => {
    const { engine, onValueCommit } = createEngine();

    engine.stepBy(3);
    expect(onValueCommit).not.toHaveBeenCalled();

    engine.destroy();
    expect(onValueCommit).toHaveBeenCalledTimes(1);
    expect(onValueCommit).toHaveBeenCalledWith(53);

    vi.runAllTimers();
    expect(onValueCommit).toHaveBeenCalledTimes(1);
  });

  it("does not commit when nothing was interacted with", () => {
    const { engine, onValueCommit } = createEngine();
    engine.destroy();
    expect(onValueCommit).not.toHaveBeenCalled();
  });
});
