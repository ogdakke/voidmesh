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
    let cancelled = false;
    const preload = () => {
      // Prepare the closed drawer after load, including React mounting work.
      // This does not depend on requestIdleCallback, which is absent on some browsers.
      void loadMobileAboutContent()
        .then(() => {
          if (!cancelled) setMounted(true);
        })
        .catch((error: unknown) => console.error("Failed to prepare About drawer", error));
    };

    if (document.readyState === "complete") {
      preload();
    } else {
      window.addEventListener("load", preload, { once: true });
    }

    return () => {
      cancelled = true;
      window.removeEventListener("load", preload);
    };
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
        aria-label="About"
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
