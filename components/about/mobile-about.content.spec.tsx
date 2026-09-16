import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import MobileAboutContent from "./mobile-about.content.tsx";

vi.mock("./about", () => ({
  AboutSection: () => <section />,
  FeatureSection: () => <section />,
  Footer: () => null,
}));
vi.mock("./updates", () => ({
  Updates: () => (
    <section>
      <video data-testid="playing" muted />
      <video data-testid="manually-paused" muted />
    </section>
  ),
}));
vi.mock("#hooks/use-carousel-dots.ts", () => ({
  useCarouselDots: () => ({
    activeIndex: 0,
    count: 0,
    progress: [],
    ids: [],
    scrollTo: () => {},
    attach: () => {},
  }),
}));

afterEach(() => vi.restoreAllMocks());

function Harness({ initiallyOpen = true }: { initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <>
      <button onClick={() => setOpen(true)}>Reopen</button>
      <MobileAboutContent open={open} onOpenChange={setOpen} />
    </>
  );
}

function mockPlayback(video: HTMLVideoElement, initiallyPaused: boolean) {
  let paused = initiallyPaused;
  vi.spyOn(video, "paused", "get").mockImplementation(() => paused);
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {
    paused = true;
  });
  const play = vi.spyOn(video, "play").mockImplementation(() => {
    paused = false;
    return Promise.resolve();
  });
  return { pause, play };
}

it("resumes previously playing videos over repeated closes without starting manually paused videos", () => {
  render(<Harness />);
  const video = screen.getByTestId("playing") as HTMLVideoElement;
  const playing = mockPlayback(video, false);
  const manual = mockPlayback(screen.getByTestId("manually-paused") as HTMLVideoElement, true);
  for (let cycle = 1; cycle <= 3; cycle++) {
    fireEvent.click(screen.getByRole("button", { name: "Close About" }));
    expect(video.paused).toBe(true);
    fireEvent.click(screen.getByText("Reopen"));
    expect(screen.getByTestId("playing")).toBe(video);
    expect(playing.play).toHaveBeenCalledTimes(cycle);
    expect(video.paused).toBe(false);
    expect(manual.play).not.toHaveBeenCalled();
  }
});

it("defers autoplay that arrives while hidden until the drawer opens", () => {
  render(<Harness initiallyOpen={false} />);
  const video = screen.getByTestId("playing") as HTMLVideoElement;
  const playback = mockPlayback(video, false);
  fireEvent.play(video);
  expect(playback.pause).toHaveBeenCalledOnce();
  expect(video.paused).toBe(true);
  fireEvent.click(screen.getByText("Reopen"));
  expect(playback.play).toHaveBeenCalledOnce();
  expect(video.paused).toBe(false);
});
