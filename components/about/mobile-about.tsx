import { useCarouselDots } from "#hooks/use-carousel-dots.ts";
import { Modal } from "#ui/modal/modal.tsx";
import clsx from "clsx";
import { QuestionMark, Xmark } from "iconoir-react";
import { type ComponentProps, useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Updates } from "./updates";
import { Button } from "#ui/button/button.tsx";
import { AboutSection, Footer, FeatureSection } from "./about";
import "./mobile-about.css";

export interface MobileAboutProps extends ComponentProps<"div"> {}
export default function MobileAbout(props: MobileAboutProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, count, progress, scrollTo, attach } = useCarouselDots(containerRef);

  const contentRef = (el: HTMLDivElement | null) => {
    containerRef.current = el;
    attach(el);
  };

  return (
    <div {...props} className={clsx("mobile-about", props.className)}>
      <Button variant="primary" size="md" onClick={() => setOpen(true)}>
        <QuestionMark />
      </Button>
      {createPortal(
        <Modal.Root open={open} onClose={() => setOpen(false)} className="about-modal">
          <Button variant="secondary" className="about-modal__close" onClick={() => setOpen(false)}>
            <Xmark />
          </Button>
          <div ref={contentRef} className="about-drawer-content about">
            <AboutSection>
              <br />
              <Footer />
            </AboutSection>
            <FeatureSection />
            <Updates />
          </div>
          {count > 0 && (
            <nav className="carousel-dots" aria-label="Carousel navigation">
              {Array.from({ length: count }, (_, i) => (
                <button
                  key={i}
                  className="carousel-dot"
                  aria-label={`Go to section ${i + 1}`}
                  aria-current={i === activeIndex}
                  style={{ "--dot-progress": progress[i] ?? 0 } as React.CSSProperties}
                  onClick={() => scrollTo(i)}
                />
              ))}
            </nav>
          )}
        </Modal.Root>,
        document.body,
      )}
    </div>
  );
}
