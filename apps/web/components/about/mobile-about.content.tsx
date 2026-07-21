import { useCarouselDots } from "#hooks/use-carousel-dots.ts";
import { Button } from "#ui/button/button.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
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

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Popup className="about-drawer">
        <Button
          variant="secondary"
          className="about-drawer__close"
          onClick={() => onOpenChange(false)}
        >
          <Xmark />
        </Button>
        <Drawer.Content>
          <div ref={contentRef} className="about-carousel about">
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
      </Drawer.Popup>
    </Drawer.Root>
  );
}
