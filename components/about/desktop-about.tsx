import { useKeybind } from "#context/keybind-context.ts";
import { Button } from "#ui/button/button.tsx";
import clsx from "clsx";
import { QuestionMark } from "iconoir-react";
import { type ComponentProps, lazy, Suspense, useState } from "react";
import "./desktop-about.css";

const SECTION_IDS = new Set(["about", "shortcuts", "updates"]);

const DesktopAboutContent = lazy(() => import("./desktop-about.content.tsx"));

export default function DesktopAbout({ ...props }: ComponentProps<"div">) {
  const initiallyOpen = SECTION_IDS.has(location.hash.slice(1));
  const [showModal, setShowModal] = useState(initiallyOpen);
  const [mounted, setMounted] = useState(initiallyOpen);

  const handleClose = () => {
    setShowModal(false);
    history.replaceState(null, "", location.pathname + location.search);
  };

  useKeybind("global", {
    label: "See keybinds",
    group: "global",
    bind: "?",
    action: function seeKeybindsShortcutHandler() {
      setMounted(true);
      setShowModal(true);
    },
  });

  return (
    <div {...props} className={clsx("desktop-about-container", props.className)}>
      <Button
        onClick={() => {
          setMounted(true);
          setShowModal(true);
        }}
        variant="secondary"
        size="sm"
      >
        <QuestionMark />
      </Button>
      {mounted && (
        <Suspense>
          <DesktopAboutContent showModal={showModal} onClose={handleClose} />
        </Suspense>
      )}
    </div>
  );
}
