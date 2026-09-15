import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FancyEffects } from "#types/fancy-effects.ts";

const setFancyEffects = vi.fn<(value: FancyEffects) => void>();
vi.mock("#context/use-canvas.ts", () => ({
  useCanvasPreferences: () => ({ fancyEffects: FancyEffects.deletions }),
  useCanvasCommands: () => ({ setFancyEffects }),
}));
const { FancyEffectsMobileSelect, FancyEffectsDesktopSelect } =
  await import("#components/settings/settings.shared.tsx");
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Fancy Effects selects", () => {
  test("mobile uses the native select with four persisted choices", () => {
    render(<FancyEffectsMobileSelect />);
    const select = screen.getByRole("combobox", { name: "Fancy Effects" });
    expect(select.tagName).toBe("SELECT");
    expect((select as HTMLSelectElement).value).toBe(FancyEffects.deletions);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "None",
      "All",
      "Deletions",
      "Prism wake",
    ]);
    fireEvent.change(select, { target: { value: FancyEffects.prismWake } });
    expect(setFancyEffects).toHaveBeenCalledWith(FancyEffects.prismWake);
  });
  test("desktop uses the custom select trigger", async () => {
    render(<FancyEffectsDesktopSelect />);
    const trigger = screen.getByRole("combobox", { name: "Fancy Effects" });
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    fireEvent.keyDown(await screen.findByRole("option", { name: "None" }), { key: "Enter" });
    expect(setFancyEffects).toHaveBeenCalledWith(FancyEffects.none);
  });
});
