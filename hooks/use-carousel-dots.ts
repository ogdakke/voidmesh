import { useEffect, useRef, useState, type RefObject } from "react";

const THRESHOLD = Array.from({ length: 6 }, (_, i) => i / 5);

export function useCarouselDots(containerRef: RefObject<HTMLElement | null>) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [count, setCount] = useState(0);
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Set up observer. Uses a ref-callback style: the parent calls `attach(el)`
  // once the DOM element is available (e.g. after a portal mounts).
  const attach = (container: HTMLElement | null) => {
    // Tear down previous observer
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!container) {
      setCount(0);
      return;
    }

    const sections = container.querySelectorAll<HTMLElement>(":scope > section");
    setCount(sections.length);

    const observer = new IntersectionObserver(
      (entries) => {
        let bestEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            if (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio) {
              bestEntry = entry;
            }
          }
        }
        if (bestEntry) {
          const idx = Array.from(sections).indexOf(bestEntry.target as HTMLElement);
          if (idx !== -1) setActiveIndex(idx);
        }
      },
      {
        root: container,
        rootMargin: "0px -40% 0px -40%",
        threshold: THRESHOLD,
      },
    );

    for (const section of sections) observer.observe(section);
    observerRef.current = observer;
  };

  // Clean up on unmount
  useEffect(() => () => observerRef.current?.disconnect(), []);

  const scrollTo = (index: number) => {
    const container = containerRef.current;
    if (!container) return;
    const sections = container.querySelectorAll<HTMLElement>(":scope > section");
    sections[index]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };

  return { activeIndex, count, scrollTo, attach };
}
