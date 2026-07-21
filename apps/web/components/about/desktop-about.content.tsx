import { KeyboardShortcuts } from "#components/keyboard-shortcuts/keyboard-shortcuts.tsx";
import { useCarouselDots } from "#hooks/use-carousel-dots.ts";
import { Button } from "#ui/button/button.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import { Xmark } from "iconoir-react";
import { useRef } from "react";
import { AboutSection, FeatureSection, Footer } from "./about";
import { CarouselDots } from "./carousel-dots.tsx";
import { Updates } from "./updates";

export default function DesktopAboutContent({
  showModal,
  onClose,
}: {
  showModal: boolean;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, count, progress, ids, scrollTo, attach } = useCarouselDots(containerRef);

  const contentRef = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    attach(el);
  };

  return (
    <Modal.Root open={showModal} onClose={onClose} className="desktop-about-modal">
      <Button variant="secondary" className="desktop-about-modal__close" onClick={onClose}>
        <Xmark />
      </Button>
      <div ref={contentRef} className="about-carousel about">
        <section id="about">
          <AboutSection />
          <FeatureSection />
          <br />
          <Footer />
        </section>
        <section id="shortcuts">
          <h1>Keyboard shortcuts</h1>
          <KeyboardShortcuts />
        </section>
        <Updates id="updates" />
      </div>
      <CarouselDots
        activeIndex={activeIndex}
        count={count}
        progress={progress}
        ids={ids}
        scrollTo={scrollTo}
      />
    </Modal.Root>
  );
}
