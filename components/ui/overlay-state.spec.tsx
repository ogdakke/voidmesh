import { render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useDocumentOverlayState } from "./overlay-state.ts";

function Overlay({ open }: { open: boolean }) {
  useDocumentOverlayState(open);
  return null;
}

afterEach(() => {
  document.documentElement.removeAttribute("data-overlay-open");
});

it("retains document overlay state until every open overlay closes", () => {
  const view = render(
    <>
      <Overlay open />
      <Overlay open />
    </>,
  );

  expect(document.documentElement.hasAttribute("data-overlay-open")).toBe(true);

  view.rerender(
    <>
      <Overlay open={false} />
      <Overlay open />
    </>,
  );
  expect(document.documentElement.hasAttribute("data-overlay-open")).toBe(true);

  view.rerender(
    <>
      <Overlay open={false} />
      <Overlay open={false} />
    </>,
  );
  expect(document.documentElement.hasAttribute("data-overlay-open")).toBe(false);
});
