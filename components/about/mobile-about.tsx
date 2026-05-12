import { Button } from "#ui/button/button.tsx";
import clsx from "clsx";
import { QuestionMark } from "iconoir-react";
import { type ComponentProps, lazy, Suspense, useEffect, useState } from "react";
import "./mobile-about.css";

const SECTION_IDS = new Set(["about", "features", "updates"]);

const loadMobileAboutContent = () => import("./mobile-about.content.tsx");
const MobileAboutContent = lazy(loadMobileAboutContent);

export interface MobileAboutProps extends ComponentProps<"div"> {}
export default function MobileAbout(props: MobileAboutProps) {
  const initiallyOpen = SECTION_IDS.has(location.hash.slice(1));
  const [open, setOpen] = useState(initiallyOpen);
  const [mounted, setMounted] = useState(initiallyOpen);

  useEffect(() => {
    const preload = () => {
      void loadMobileAboutContent();
    };

    if (document.readyState === "complete") {
      preload();
      return;
    }

    window.addEventListener("load", preload, { once: true });
    return () => window.removeEventListener("load", preload);
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);

    if (!nextOpen) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  };

  return (
    <div {...props} className={clsx("mobile-about", props.className)}>
      <Button
        variant="primary"
        size="md"
        onClick={() => {
          setMounted(true);
          handleOpenChange(true);
        }}
      >
        <QuestionMark />
      </Button>
      {mounted && (
        <Suspense>
          <MobileAboutContent open={open} onOpenChange={handleOpenChange} />
        </Suspense>
      )}
    </div>
  );
}
