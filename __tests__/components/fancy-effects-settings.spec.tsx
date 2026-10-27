import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FancyEffects } from "#types/fancy-effects.ts";

const setFancyEffects = vi.fn<(value: FancyEffects) => void>();
vi.mock("#context/use-canvas.ts", () => ({
  useCanvasPreferences: () => ({ fancyEffects: FancyEffects.deletions }),
  useCanvasCommands: () => ({ setFancyEffects }),
}));
const { FancyDeleteToggle, OverlapEffectToggle } =
  await import("#components/settings/settings.shared.tsx");
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Fancy Effects toggles", () => {
  test("fancy deletions can be disabled without enabling overlap effects", () => {
    render(<FancyDeleteToggle />);
    const toggle = screen.getByRole("checkbox", { name: "Fancy deletions" });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(setFancyEffects).toHaveBeenCalledWith(FancyEffects.none);
  });

  test("overlap effects can be enabled without disabling fancy deletions", () => {
    render(<OverlapEffectToggle />);
    const toggle = screen.getByRole("checkbox", { name: "Overlap effect" });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    expect(setFancyEffects).toHaveBeenCalledWith(FancyEffects.all);
  });
});
