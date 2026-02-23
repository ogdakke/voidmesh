import { useEffect, useRef } from "react";
import {
  SliderPicker,
  SliderPickerItem,
  SliderPickerOptions,
  useSliderPickerOptionsRef,
} from "../slider-picker";
import "./tick-slider.css";

export interface TickSliderProps {
  /** @default 0 */
  min?: number;
  /** @default 100 */
  max?: number;
  value?: number;
  /** Called when scrolling stops and value is committed */
  onValueCommit?: (value: number) => void;
  /** Called when user starts scrolling */
  onInteractionStart?: () => void;
  /** Debounce for onValueChange in ms @default 0 */
  changeDelay?: number;
  /** Debounce for onValueCommit in ms @default 150 */
  commitDelay?: number;
  onValueChange?: (value: number) => void;
}

export function TickSlider({
  min = 0,
  max = 100,
  value = 0,
  onValueChange,
  onValueCommit,
  onInteractionStart,
  changeDelay = 0,
  commitDelay = 150,
}: TickSliderProps) {
  const items = Array.from({ length: max - min + 1 }, (_, i) => min + i + "");
  const threshold = Array.from({ length: 25 + 1 }, (_, i) => i / 25);

  return (
    <SliderPicker
      className="tick-slider"
      value={value.toString()}
      onValueChange={(v) => {
        onValueChange?.(Number(v));
      }}
      onValueCommit={(v) => {
        onValueCommit?.(Number(v));
      }}
      onInteractionStart={onInteractionStart}
      threshold={threshold}
      rootMargin="0px -49% 0px -49%"
      changeDelay={changeDelay}
      commitDelay={commitDelay}
    >
      <SliderPickerOptions className="tick-slider__options" aria-label="Filter selection">
        <TickSliderItems items={items} />
      </SliderPickerOptions>
    </SliderPicker>
  );
}

interface TickScaleAnimatorOptions {
  falloff?: number;
  minScale?: number;
  maxScale?: number;
}

/** Animates tick scales based on pixel distance from viewport center */
function useTickScaleAnimator(
  containerRef: React.RefObject<HTMLElement | null>,
  itemSelector: string,
  { falloff = 0.02, minScale = 0.4, maxScale = 1.0 }: TickScaleAnimatorOptions = {},
): void {
  const rafId = useRef<number | null>(null);
  const lastScrollLeft = useRef<number>(-1);
  const itemCenters = useRef<number[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const cacheItemOffsets = () => {
      const items = container.querySelectorAll(itemSelector);
      itemCenters.current = Array.from(items).map((item) => {
        const el = item as HTMLElement;
        return el.offsetLeft + el.offsetWidth / 2;
      });
    };

    const updateScales = () => {
      const scrollLeft = container.scrollLeft;
      const viewportCenter = scrollLeft + container.clientWidth / 2;
      const items = container.querySelectorAll(itemSelector) as NodeListOf<HTMLElement>;

      let largestScale = -1;
      let largestItem: HTMLElement | null = null;

      items.forEach((item, i) => {
        const itemCenter = itemCenters.current[i];
        if (itemCenter === undefined) return;

        const isLeftOfCenter = itemCenter < viewportCenter;
        const pixelDistance = Math.abs(itemCenter - viewportCenter);
        const scale = isLeftOfCenter
          ? minScale + (maxScale - minScale) * Math.exp(-pixelDistance * falloff)
          : minScale;

        item.style.setProperty("--scale", scale.toFixed(3));
        item.style.removeProperty("background-color");

        if (scale > largestScale) {
          largestScale = scale;
          largestItem = item;
        }
      });

      if (largestItem!) {
        (largestItem as HTMLElement).style.setProperty("background-color", "var(--color)");
      }
    };

    const handleScroll = () => {
      if (rafId.current !== null) return;

      rafId.current = requestAnimationFrame(() => {
        rafId.current = null;
        const scrollLeft = container.scrollLeft;

        if (Math.abs(scrollLeft - lastScrollLeft.current) < 0.5) return;
        lastScrollLeft.current = scrollLeft;

        updateScales();
      });
    };

    // Initial setup
    cacheItemOffsets();
    updateScales();

    container.addEventListener("scroll", handleScroll, { passive: true });

    const resizeObserver = new ResizeObserver(() => {
      cacheItemOffsets();
      updateScales();
    });
    resizeObserver.observe(container);

    return () => {
      container.removeEventListener("scroll", handleScroll);
      resizeObserver.disconnect();
      if (rafId.current !== null) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [containerRef, itemSelector, falloff, minScale, maxScale]);
}

function TickSliderItems({ items }: { items: string[] }) {
  const optionsRef = useSliderPickerOptionsRef();

  useTickScaleAnimator(optionsRef, ".tick-slider__item", {
    falloff: 0.06,
    minScale: 0.4,
    maxScale: 1.0,
  });

  return items.map((item) => (
    <SliderPickerItem value={item} key={item} className="tick-slider__item" />
  ));
}
