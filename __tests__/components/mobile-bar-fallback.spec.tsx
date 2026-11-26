/**
 * Mobile bottom bar: when the active tab becomes unavailable for the new selection, the bar
 * falls back to the first enabled tab, and that switch sticks.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { act, fireEvent, screen } from "@testing-library/react";
import { BottomBarItem, MobileBottomBar } from "#components/mobile-bottom/mobile-bottom-bar.tsx";
import { items } from "#components/mobile-bottom/bar-items.ts";
import {
  useMobileBarItems,
  type MobileBarItem,
} from "#components/mobile-bottom/use-mobile-bar-items.ts";
import { ShaderType } from "#types/canvas.ts";
import { createEntityInput } from "../helpers/test-entity.ts";
import { renderWithCanvas } from "../helpers/render-with-providers.tsx";
import { setupCanvasTest } from "../helpers/test-setup.ts";

let cleanup: () => void;

beforeEach(() => {
  cleanup = setupCanvasTest();
});

afterEach(() => {
  cleanup();
});

/** The bar as `MobileFloat` wires it, without the heavy panels. */
function Bar() {
  const { activeItem, disabledByItem, setActiveItem } = useMobileBarItems();
  return (
    <MobileBottomBar
      items={items}
      value={activeItem}
      onChange={(item) => setActiveItem(item as MobileBarItem | null)}
    >
      {items.map((item) => (
        <BottomBarItem key={item} label={item} disabled={disabledByItem[item]} />
      ))}
    </MobileBottomBar>
  );
}

const tab = (label: string) => screen.getByRole("button", { name: label });
const isActive = (label: string) => tab(label).hasAttribute("data-active");

describe("mobile bottom bar tab fallback", () => {
  test("switches from colors to the first tab when the selection has no palette, and stays", () => {
    const { canvas } = renderWithCanvas(<Bar />);

    let withPalette = "";
    let withoutPalette = "";
    act(() => {
      withPalette = canvas.addEntity(createEntityInput());
      withoutPalette = canvas.addEntity(createEntityInput());
      canvas.selectEntity(withoutPalette);
      canvas.changeShaderType(ShaderType.glass);
      canvas.selectEntity(withPalette);
    });

    fireEvent.click(tab("colors"));
    expect(isActive("colors")).toBe(true);

    act(() => canvas.selectEntity(withoutPalette));
    expect(tab("colors").getAttribute("aria-disabled")).toBe("true");
    expect(isActive("style")).toBe(true);
    expect(isActive("colors")).toBe(false);

    act(() => canvas.selectEntity(withPalette));
    expect(isActive("style")).toBe(true);
    expect(isActive("colors")).toBe(false);
  });

  test("keeps colors when the selection still supports it", () => {
    const { canvas } = renderWithCanvas(<Bar />);

    let first = "";
    let second = "";
    act(() => {
      first = canvas.addEntity(createEntityInput());
      second = canvas.addEntity(createEntityInput());
      canvas.selectEntity(second);
      canvas.changeShaderType(ShaderType.halftone);
      canvas.selectEntity(first);
    });

    fireEvent.click(tab("colors"));
    act(() => canvas.selectEntity(second));
    expect(isActive("colors")).toBe(true);
  });
});
