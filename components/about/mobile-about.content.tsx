import { useCarouselDots } from "#hooks/use-carousel-dots.ts";
import { Button } from "#ui/button/button.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { Drawer as BaseDrawer } from "@base-ui/react/drawer";
import { Xmark } from "iconoir-react";
import { useRef } from "react";
import { AboutSection, Footer, FeatureSection } from "./about";
import { CarouselDots } from "./carousel-dots.tsx";
import { Updates } from "./updates";

export default function MobileAboutContent({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, count, progress, ids, scrollTo, attach } = useCarouselDots(containerRef);

  const contentRef = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    attach(el);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      // Retained media must stop when the drawer closes, just as unmounted media did.
      containerRef.current?.querySelectorAll("video").forEach((video) => video.pause());
    }
    onOpenChange(nextOpen);
  };

  return (
    <Drawer.Root open={open} onOpenChange={handleOpenChange}>
      <BaseDrawer.Portal keepMounted>
        <BaseDrawer.Backdrop className="drawer-overlay" />
        <BaseDrawer.Viewport className="drawer-viewport about-drawer-viewport">
          <BaseDrawer.Popup className="drawer-popup about-drawer">
            <div className="drawer-handle" />
            <Button
              variant="secondary"
              className="about-drawer__close"
              aria-label="Close About"
              onClick={() => handleOpenChange(false)}
            >
              <Xmark />
            </Button>
            <Drawer.Content>
              <div
                ref={contentRef}
                className="about-carousel about"
                onPlayCapture={(event) => {
                  if (!open && event.target instanceof HTMLMediaElement) event.target.pause();
                }}
              >
                <AboutSection id="about">
                  <br />
                  <Footer />
                </AboutSection>
                <FeatureSection id="features" />
                <Updates id="updates" />
              </div>
            </Drawer.Content>
            <CarouselDots
              activeIndex={activeIndex}
              count={count}
              progress={progress}
              ids={ids}
              scrollTo={scrollTo}
            />
          </BaseDrawer.Popup>
        </BaseDrawer.Viewport>
      </BaseDrawer.Portal>
    </Drawer.Root>
  );
}
