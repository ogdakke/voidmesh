import { memo, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Button } from "../ui/button";
import { QuestionMark, Xmark } from "iconoir-react";
import { KeyboardShortcuts } from "../keyboard-shortcuts/keyboard-shortcuts";
import { Modal } from "../ui/modal/modal";
import { useKeybind } from "#context/keybind-context.ts";
import { useIsMobile } from "#hooks/use-is-mobile.ts";
import "./about.css";
import { Updates } from "./updates";
import { useCarouselDots } from "#hooks/use-carousel-dots.ts";
import { Image } from "#ui/image.tsx";
import houseBurning from "../../media/house_burning_ascii.webp?img";

export interface AboutProps extends ComponentProps<"div"> {}
export const About = memo(function About(props: AboutProps) {
  const isMobile = useIsMobile();
  if (isMobile) {
    return <MobileAbout {...props} />;
  }
  return <DesktopAbout {...props} />;
});

export interface MobileAboutProps extends ComponentProps<"div"> {}
function MobileAbout(props: MobileAboutProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const { activeIndex, count, scrollTo, attach } = useCarouselDots(containerRef);

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
        <Modal open={open} onClose={() => setOpen(false)} className="about-modal">
          <Button variant="secondary" className="about-modal__close" onClick={() => setOpen(false)}>
            <Xmark />
          </Button>
          <div ref={contentRef} className="about-drawer-content about">
            <AboutSection>
              <br />
              <footer>
                <p>
                  Made by <a href="https://x.com/ogdakke">Daniel</a>.
                </p>
              </footer>
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
                  onClick={() => scrollTo(i)}
                />
              ))}
            </nav>
          )}
        </Modal>,
        document.body,
      )}
    </div>
  );
}

function DesktopAbout({ ...props }: ComponentProps<"div">) {
  const [showModal, setShowModal] = useState(false);

  useKeybind("global", {
    label: "See keybinds",
    group: "global",
    bind: "?",
    action: function seeKeybindsShortcutHandler() {
      setShowModal(true);
    },
  });

  return (
    <div {...props} className={clsx("desktop-about-container", props.className)}>
      <Button onClick={() => setShowModal(true)} variant="secondary" size="sm">
        <QuestionMark />
      </Button>

      <Modal
        open={showModal}
        onClose={() => setShowModal(false)}
        onScroll={(e) => e.stopPropagation()}
      >
        <div className="modal-content about desktop-about">
          <section>
            <AboutSection />
            <FeatureSection />
            <br />
            <footer>
              <p>
                Made by <a href="https://x.com/ogdakke">Daniel</a>.
              </p>
            </footer>
          </section>
          <KeyboardShortcuts />
        </div>
      </Modal>
    </div>
  );
}

function AboutSection({ children }: { children?: ReactNode }) {
  return (
    <section className="about-section">
      <h1>Voidmesh</h1>
      <p>
        Apply dithering, halftone, and ASCII effects to videos, GIFs, and images. Everything runs
        locally in your browser—nothing gets uploaded.
      </p>
      <Image {...houseBurning} alt="Burning house ASCII" />
      <h2>Effects</h2>
      <dl className="about__effects">
        <div>
          <dt>Dithering</dt>
          <dd>Retro pixel patterns with limited colors</dd>
        </div>
        <div>
          <dt>Halftone</dt>
          <dd>Dot patterns like comic books or newsprint</dd>
        </div>
        <div>
          <dt>ASCII</dt>
          <dd>Convert to text characters</dd>
        </div>
        <div>
          <dt>Blobs</dt>
          <dd>Liquid, organic shapes</dd>
        </div>
        <div>
          <dt>Melt</dt>
          <dd>Dripping, melted look</dd>
        </div>
        <div>
          <dt>Fluted Glass</dt>
          <dd>Lines with refraction and caustics</dd>
        </div>
        <div>
          <dt>Frosted Glass</dt>
          <dd>Frosty, blurred glass</dd>
        </div>
        <div>
          <dt>Flowing Glass</dt>
          <dd>(experimental) A living, breathing, turbulent glass</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}

function FeatureSection() {
  return (
    <section className="about-section">
      <h1>Features</h1>
      <ul>
        <li>Works on video, GIFs, and images</li>
        <li>
          Color palettes—Game Boy, CGA, sepia, or extract from any image. Custom palettes are saved
          locally in your browser.
        </li>
        <li>Post-processing—film grain, bloom, chromatic aberration</li>
        <li>Export to MP4, MOV, or GIF</li>
        <li>Save your work to a file, and continue later</li>
      </ul>
    </section>
  );
}
