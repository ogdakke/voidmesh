import { Button } from "#ui/button/button.tsx";
import clsx from "clsx";
import { QuestionMark } from "iconoir-react";
import { type ComponentProps, lazy, Suspense, useState } from "react";
import "./mobile-about.css";

const SECTION_IDS = new Set(["about", "features", "updates"]);

const MobileAboutContent = lazy(() => import("./mobile-about.content.tsx"));

export interface MobileAboutProps extends ComponentProps<"div"> {}
export default function MobileAbout(props: MobileAboutProps) {
  const initiallyOpen = SECTION_IDS.has(location.hash.slice(1));
  const [open, setOpen] = useState(initiallyOpen);
  const [mounted, setMounted] = useState(initiallyOpen);

  const handleClose = () => {
    setOpen(false);
    history.replaceState(null, "", location.pathname + location.search);
  };

  return (
    <div {...props} className={clsx("mobile-about", props.className)}>
      <Button
        variant="primary"
        size="md"
        onClick={() => {
          setMounted(true);
          setOpen(true);
        }}
      >
        <QuestionMark />
      </Button>
      {mounted && (
        <Suspense>
          <MobileAboutContent open={open} onClose={handleClose} />
        </Suspense>
      )}
    </div>
  );
}
