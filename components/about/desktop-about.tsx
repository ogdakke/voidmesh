import { KeyboardShortcuts } from "#components/keyboard-shortcuts/keyboard-shortcuts.tsx";
import { useKeybind } from "#context/keybind-context.ts";
import { Button } from "#ui/button/button.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import clsx from "clsx";
import { QuestionMark } from "iconoir-react";
import { type ComponentProps, useState } from "react";
import { AboutSection, FeatureSection, Footer } from "./about";
import "./desktop-about.css";

export default function DesktopAbout({ ...props }: ComponentProps<"div">) {
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

      <Modal.Root
        open={showModal}
        onClose={() => setShowModal(false)}
        onScroll={(e) => e.stopPropagation()}
        className="desktop-about-modal"
      >
        <Modal.Content className="about desktop-about">
          <section>
            <AboutSection />
            <FeatureSection />
            <br />
            <Footer />
          </section>
          <KeyboardShortcuts />
        </Modal.Content>
      </Modal.Root>
    </div>
  );
}
