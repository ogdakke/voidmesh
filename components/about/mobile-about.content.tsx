import { useCarouselDots } from "#hooks/use-carousel-dots.ts";
import { Button } from "#ui/button/button.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import { Xmark } from "iconoir-react";
import { useRef } from "react";
import { createPortal } from "react-dom";
import { AboutSection, Footer, FeatureSection } from "./about";
import { CarouselDots } from "./carousel-dots.tsx";
import { Updates } from "./updates";

export default function MobileAboutContent({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, count, progress, ids, scrollTo, attach } = useCarouselDots(containerRef);

  const contentRef = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    attach(el);
  };

  return createPortal(
    <Modal.Root open={open} onClose={onClose} className="about-modal">
      <Button variant="secondary" className="about-modal__close" onClick={onClose}>
        <Xmark />
      </Button>
      <div ref={contentRef} className="about-carousel about">
        <AboutSection id="about">
          <br />
          <Footer />
        </AboutSection>
        <FeatureSection id="features" />
        <Updates id="updates" />
      </div>
      <CarouselDots
        activeIndex={activeIndex}
        count={count}
        progress={progress}
        ids={ids}
        scrollTo={scrollTo}
      />
    </Modal.Root>,
    document.body,
  );
}
