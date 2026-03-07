import { describe, expect, test, vi, beforeEach } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { renderMinimal } from "../helpers/render-with-providers.tsx";
import { Root } from "#components/ui/color-picker/color-picker-context.tsx";
import { ValueInput } from "#components/ui/color-picker/color-value-input.tsx";
import { ColorSpace } from "#types/enums.ts";
import { cssColorToRGBAInColorSpace, rgbaToCss } from "#lib/color-utils.ts";

const mockUseIsMobile = vi.fn<() => boolean>(() => false);

vi.mock("#hooks/use-is-mobile.ts", () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

function renderValueInput({
  value,
  colorSpace = ColorSpace.displayP3,
  onChange = vi.fn(),
}: {
  value: string;
  colorSpace?: ColorSpace;
  onChange?: (color: string) => void;
}) {
  const result = renderMinimal(
    <Root value={value} onChange={onChange} colorSpace={colorSpace}>
      <ValueInput />
    </Root>,
  );

  return {
    ...result,
    onChange,
  };
}

function ControlledP3RoundTripValueInput({ value }: { value: string }) {
  const [rgba, setRgba] = useState(() => cssColorToRGBAInColorSpace(value, ColorSpace.displayP3));

  return (
    <Root
      value={rgbaToCss(rgba, ColorSpace.displayP3)}
      onChange={(color) => setRgba(cssColorToRGBAInColorSpace(color, ColorSpace.displayP3))}
      colorSpace={ColorSpace.displayP3}
    >
      <ValueInput />
    </Root>
  );
}

describe("ColorPicker ValueInput", () => {
  beforeEach(() => {
    mockUseIsMobile.mockReturnValue(false);
  });

  test("renders no format selector when P3 is unsupported", () => {
    const { container } = renderValueInput({
      value: "#ff0000",
      colorSpace: ColorSpace.srgb,
    });

    expect(container.querySelector(".color-picker__format-select")).toBeNull();
    expect(container.querySelector(".color-picker__format-native-select")).toBeNull();
  });

  test("renders the shared select on desktop when P3 is supported", () => {
    const { container } = renderValueInput({
      value: "color(display-p3 1 0 0)",
    });

    expect(container.querySelector(".color-picker__format-select .select-select")).not.toBeNull();
    expect(container.querySelector(".color-picker__format-native-select")).toBeNull();
  });

  test("renders the native select on mobile when P3 is supported", () => {
    mockUseIsMobile.mockReturnValue(true);

    const { container } = renderValueInput({
      value: "color(display-p3 1 0 0)",
    });

    expect(container.querySelector(".color-picker__format-native-select select")).not.toBeNull();
    expect(container.querySelector(".color-picker__format-select")).toBeNull();
  });

  test("reflects the incoming value format when P3 is supported", () => {
    const { container } = renderValueInput({
      value: "#ff0000",
    });

    expect(
      container.querySelector(".color-picker__format-select .select-value_primary")?.textContent,
    ).toBe("Hex");
  });

  test("defaults to P3 when the incoming value format is not detectable", () => {
    const { container } = renderValueInput({
      value: "",
    });

    expect(
      container.querySelector(".color-picker__format-select .select-value_primary")?.textContent,
    ).toBe("P3");
  });

  test("changing the mobile selector converts the current color and emits the new format", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderValueInput({
      value: "color(display-p3 1 0 0)",
      onChange,
    });

    await user.selectOptions(screen.getByLabelText("Color format"), "hex");

    await waitFor(() => {
      expect(onChange).toHaveBeenCalled();
      expect(onChange.mock.lastCall?.[0]).toMatch(/^#/);
    });
  });

  test("changing the selector while the input is focused does not revert to the old format", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderValueInput({
      value: "color(display-p3 0.8314 0.5011 0.4028)",
      onChange,
    });

    const input = screen.getByLabelText("Color value");
    const formatSelect = screen.getByLabelText("Color format") as HTMLSelectElement;

    await user.click(input);
    await user.selectOptions(formatSelect, "hex");

    await waitFor(() => {
      expect(formatSelect.value).toBe("hex");
      expect(onChange.mock.lastCall?.[0]).toMatch(/^#/);
    });
  });

  test("changing the desktop selector while the input is focused does not revert to P3", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { container } = renderValueInput({
      value: "color(display-p3 0.8314 0.5011 0.4028)",
      onChange,
    });

    const input = screen.getByLabelText("Color value");
    const trigger = container.querySelector(
      ".color-picker__format-select .select-select",
    ) as HTMLElement | null;

    expect(trigger).not.toBeNull();

    await user.click(input);
    await user.click(trigger!);
    await user.click(screen.getByText("Hex"));

    await waitFor(() => {
      expect(
        container.querySelector(".color-picker__format-select .select-value_primary")?.textContent,
      ).toBe("Hex");
      expect(onChange.mock.lastCall?.[0]).toMatch(/^#/);
    });
  });

  test("typing a valid hex color switches the selector to Hex", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderValueInput({
      value: "color(display-p3 1 0 0)",
      onChange,
    });

    const input = screen.getByLabelText("Color value");
    const formatSelect = screen.getByLabelText("Color format") as HTMLSelectElement;

    await user.click(input);
    await user.clear(input);
    await user.type(input, "112233");

    await waitFor(() => {
      expect(formatSelect.value).toBe("hex");
      expect(onChange).toHaveBeenLastCalledWith("#112233");
    });
  });

  test("pasting a valid P3 color switches the selector to P3", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderValueInput({
      value: "#ff0000",
      onChange,
    });

    const input = screen.getByLabelText("Color value");
    const formatSelect = screen.getByLabelText("Color format") as HTMLSelectElement;

    await user.click(input);
    await user.clear(input);
    fireEvent.paste(input, {
      clipboardData: {
        getData: () => "color(display-p3 0 1 0)",
      },
    });

    await waitFor(() => {
      expect(formatSelect.value).toBe("p3");
      expect(onChange.mock.lastCall?.[0]).toMatch(/^color\(display-p3 /);
    });
  });

  test("format toggles do not keep drifting for the same in-memory color", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderValueInput({
      value: "color(display-p3 0.8314 0.5011 0.4028)",
      onChange,
    });

    const formatSelect = screen.getByLabelText("Color format") as HTMLSelectElement;

    await user.selectOptions(formatSelect, "hex");
    await waitFor(() => {
      expect(formatSelect.value).toBe("hex");
      expect(onChange.mock.lastCall?.[0]).toMatch(/^#/);
    });
    const firstHex = onChange.mock.lastCall?.[0];

    await user.selectOptions(formatSelect, "p3");
    await waitFor(() => {
      expect(formatSelect.value).toBe("p3");
      expect(onChange.mock.lastCall?.[0]).toMatch(/^color\(display-p3 /);
    });
    const firstP3 = onChange.mock.lastCall?.[0];

    await user.selectOptions(formatSelect, "hex");
    await waitFor(() => {
      expect(onChange.mock.lastCall?.[0]).toBe(firstHex);
    });

    await user.selectOptions(formatSelect, "p3");
    await waitFor(() => {
      expect(onChange.mock.lastCall?.[0]).toBe(firstP3);
    });
  });

  test("mobile format switch stays on hex through a controlled P3 round-trip parent", async () => {
    mockUseIsMobile.mockReturnValue(true);
    const user = userEvent.setup();

    renderMinimal(
      <ControlledP3RoundTripValueInput value="color(display-p3 0.9993 0.8163 0.8365)" />,
    );

    const input = screen.getByLabelText("Color value");
    const formatSelect = screen.getByLabelText("Color format") as HTMLSelectElement;

    await user.click(input);
    await user.selectOptions(formatSelect, "hex");

    await waitFor(() => {
      expect(formatSelect.value).toBe("hex");
      expect((screen.getByLabelText("Color value") as HTMLInputElement).value).toMatch(/^#/);
    });
  });
});
