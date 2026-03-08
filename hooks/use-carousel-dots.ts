import { useEffect, useRef, useState, type RefObject } from "react";

export function useCarouselDots(containerRef: RefObject<HTMLElement | null>) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [count, setCount] = useState(0);
  const [progress, setProgress] = useState<number[]>([]);
  const [ids, setIds] = useState<string[]>([]);
  const cleanupRef = useRef<(() => void) | null>(null);

  const attach = (container: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;

    if (!container) {
      setCount(0);
      setProgress([]);
      setIds([]);
      return;
    }

    const sections = container.querySelectorAll<HTMLElement>(":scope > section");
    const sectionIds = Array.from(sections, (s) => s.id);
    setCount(sections.length);
    setIds(sectionIds);
    setProgress(Array.from({ length: sections.length }, (_, i) => (i === 0 ? 1 : 0)));

    // Scroll to hash on open
    const hash = window.location.hash.slice(1);
    if (hash) {
      const idx = sectionIds.indexOf(hash);
      if (idx !== -1) {
        requestAnimationFrame(() => {
          sections[idx]?.scrollIntoView({
            behavior: "instant",
            inline: "center",
            block: "nearest",
          });
        });
      }
    }

    let rafId = 0;
    let lastActiveIdx = 0;
    const onScroll = () => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const containerWidth = container.clientWidth;
        if (containerWidth === 0) return;

        const scrollLeft = container.scrollLeft;
        const newProgress: number[] = [];
        let bestIdx = 0;
        let bestVal = 0;

        for (let i = 0; i < sections.length; i++) {
          const section = sections[i]!;
          const sectionLeft = section.offsetLeft - container.offsetLeft;
          const sectionWidth = section.offsetWidth;

          const visibleStart = Math.max(sectionLeft, scrollLeft);
          const visibleEnd = Math.min(sectionLeft + sectionWidth, scrollLeft + containerWidth);
          const visible = Math.max(0, visibleEnd - visibleStart);
          const ratio = visible / containerWidth;

          newProgress.push(ratio);
          if (ratio > bestVal) {
            bestVal = ratio;
            bestIdx = i;
          }
        }

        setProgress(newProgress);
        setActiveIndex(bestIdx);

        if (bestIdx !== lastActiveIdx) {
          lastActiveIdx = bestIdx;
          const id = sectionIds[bestIdx];
          if (id) history.replaceState(null, "", `#${id}`);
        }
      });
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    cleanupRef.current = () => {
      cancelAnimationFrame(rafId);
      container.removeEventListener("scroll", onScroll);
    };
  };

  useEffect(() => () => cleanupRef.current?.(), []);

  const scrollTo = (index: number) => {
    const container = containerRef.current;
    if (!container) return;
    const sections = container.querySelectorAll<HTMLElement>(":scope > section");
    sections[index]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  };

  return { activeIndex, count, progress, ids, scrollTo, attach };
}
