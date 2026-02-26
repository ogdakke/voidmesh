import clsx from "clsx";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import "./slider-picker.css";
import { logger } from "#lib/client.logger.ts";
import { SliderPickerContext, useSliderPickerContext } from "./use-slider-picker.ts";

const DEFAULT_THRESHOLD = Array.from({ length: 20 }, (_, i) => i / 19);

export interface SliderPickerProps extends Omit<ComponentProps<"div">, "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  /** Called when scrolling stops and value is committed */
  onValueCommit?: (value: string) => void;
  /** Called when user starts scrolling (before first value change) */
  onInteractionStart?: () => void;
  /** Debounce delay for onValueChange in ms @default 0 */
  changeDelay?: number;
  /** Debounce delay for onValueCommit in ms @default 300 */
  commitDelay?: number;
  children: ReactNode;
  /**
   * @default Array.from({ length: 20 }, (_, i) => i / 19)
   */
  threshold?: number[];
  /**
   * @default "0px -48% 0px -48%"
   */
  rootMargin?: string;
}

export function SliderPicker({
  value,
  onValueChange,
  onValueCommit,
  onInteractionStart,
  changeDelay = 0,
  commitDelay = 300,
  children,
  className,
  threshold = DEFAULT_THRESHOLD,
  rootMargin = "0px -48% 0px -48%",
  ...props
}: SliderPickerProps) {
  const [centeredValue, setCenteredValue] = useState(value);
  const itemRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const optionsRef = useRef<HTMLDivElement>(null);
  const changeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCommittedValueRef = useRef<string | null>(null);
  const isInteractingRef = useRef(false);
  const prevCenteredValueRef = useRef<string>(value);
  const isInitialScrollRef = useRef(true);
  const isProgrammaticScrollRef = useRef(false);
  const isTouchingRef = useRef(false);
  const scrollSettledRef = useRef(true);
  const pendingCommitRef = useRef(false);
  const scrollFallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store callbacks in refs to avoid effect dependency issues
  const callbacksRef = useRef({ onValueChange, onValueCommit, onInteractionStart });
  // oxlint-disable-next-line react-hooks-js/refs -- callback ref pattern: only read in effects/event handlers, not during render output
  callbacksRef.current = { onValueChange, onValueCommit, onInteractionStart };

  // Sync centered value only when value changes externally (not from our own commit)
  useEffect(() => {
    // On mount (null) or external change (value differs from what we committed)
    if (lastCommittedValueRef.current === null || value !== lastCommittedValueRef.current) {
      setCenteredValue(value);
      prevCenteredValueRef.current = value;
      const el = itemRefs.current.get(value);
      const isInitial = isInitialScrollRef.current;
      if (el) {
        // Mark as programmatic scroll to prevent value commits during scroll
        isProgrammaticScrollRef.current = true;
        el.scrollIntoView({
          behavior: isInitial ? "instant" : "smooth",
          inline: "center",
          block: "nearest",
        });
        // Clear programmatic scroll flag after scroll completes
        // (~50ms for instant, ~500ms for smooth scroll)
        setTimeout(
          () => {
            isProgrammaticScrollRef.current = false;
          },
          isInitial ? 50 : 500,
        );
      }
      // Clear initial scroll flag
      if (isInitial) {
        isInitialScrollRef.current = false;
      }
    }
    lastCommittedValueRef.current = value;
  }, [value]);

  // IntersectionObserver to detect centered item
  useEffect(() => {
    const options = optionsRef.current;

    if (!options) {
      logger.warn("[SliderPicker] No options ref, skipping observer setup");
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the entry with the highest intersection ratio
        // This approach handles cross-browser differences in how rootMargin percentages
        // affect intersection calculations (Safari computes lower ratios than Chrome)
        let bestEntry: IntersectionObserverEntry | null = null;
        for (const entry of entries) {
          // Track the entry with highest intersection ratio (must be actually intersecting)
          // NOTE: safari will not report intersectionRatio for elements that are 1px wide.
          if (entry.isIntersecting && entry.intersectionRatio > 0) {
            if (!bestEntry || entry.intersectionRatio > bestEntry.intersectionRatio) {
              bestEntry = entry;
            }
          }
        }

        // Update centered value to the most visible item
        if (bestEntry) {
          const itemValue = (bestEntry.target as HTMLElement).dataset.value;
          if (itemValue !== undefined) {
            setCenteredValue(itemValue);
          }
        }
      },
      {
        root: options,
        threshold,
        // rootMargin: Shrinks the effective viewport used for intersection checks.
        // "-40%" on left and right means only the center ~20% of the scroll
        // container counts as the "visible" area. This creates a narrow detection
        // zone in the middle, so an item must be nearly centered to register as
        // intersecting. Format: "top right bottom left" (like CSS margin).
        rootMargin,
      },
    );

    // Store observer ref so dynamically registered items can be observed
    observerRef.current = observer;

    for (const el of itemRefs.current.values()) {
      observer.observe(el);
    }

    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, [threshold, rootMargin]);

  // Touch + scroll-end tracking for commit timing
  useEffect(() => {
    const options = optionsRef.current;
    if (!options) return;

    // Fire commit only when touch ended AND scroll settled.
    const attemptCommit = () => {
      if (isTouchingRef.current) return;
      if (!scrollSettledRef.current) return;
      if (!pendingCommitRef.current) return;

      pendingCommitRef.current = false;
      isInteractingRef.current = false;
      callbacksRef.current.onValueCommit?.(prevCenteredValueRef.current);
    };

    const ac = new AbortController();
    const listenOpts = { passive: true, signal: ac.signal } as const;
    const supportsScrollEnd = "onscrollend" in window;

    options.addEventListener(
      "touchstart",
      () => {
        isTouchingRef.current = true;
        scrollSettledRef.current = false;
      },
      listenOpts,
    );

    const onTouchEnd = () => {
      isTouchingRef.current = false;
      attemptCommit();
    };
    options.addEventListener("touchend", onTouchEnd, listenOpts);
    options.addEventListener("touchcancel", onTouchEnd, listenOpts);

    options.addEventListener(
      "scroll",
      () => {
        scrollSettledRef.current = false;
        // Fallback timer only when scrollend is not supported
        if (!supportsScrollEnd) {
          if (scrollFallbackTimerRef.current) clearTimeout(scrollFallbackTimerRef.current);
          scrollFallbackTimerRef.current = setTimeout(() => {
            scrollSettledRef.current = true;
            attemptCommit();
          }, commitDelay);
        }
      },
      listenOpts,
    );

    if (supportsScrollEnd) {
      options.addEventListener(
        "scrollend",
        () => {
          if (scrollFallbackTimerRef.current) {
            clearTimeout(scrollFallbackTimerRef.current);
            scrollFallbackTimerRef.current = null;
          }
          scrollSettledRef.current = true;
          attemptCommit();
        },
        listenOpts,
      );
    } else {
    }

    return () => {
      ac.abort();
      if (scrollFallbackTimerRef.current) clearTimeout(scrollFallbackTimerRef.current);
    };
  }, [commitDelay]);

  // Handle centeredValue changes - debounced value change + mark commit pending
  useEffect(() => {
    if (centeredValue === prevCenteredValueRef.current) return;

    // Skip emissions during initial scroll or programmatic scrolls (external value changes).
    // Don't update prevCenteredValueRef here — intermediate observer values during
    // programmatic scroll would overwrite it and cause spurious emissions after the flag clears.
    if (isInitialScrollRef.current || isProgrammaticScrollRef.current) return;

    prevCenteredValueRef.current = centeredValue;

    const { onValueChange, onInteractionStart } = callbacksRef.current;

    // Start interaction on first change
    if (!isInteractingRef.current) {
      isInteractingRef.current = true;
      onInteractionStart?.();
    }

    // Debounced value change
    // Set lastCommittedValueRef synchronously so the sync effect sees the latest
    // centeredValue and won't trigger unnecessary scrollIntoView from stale values.
    lastCommittedValueRef.current = centeredValue;
    if (changeTimeoutRef.current) clearTimeout(changeTimeoutRef.current);
    changeTimeoutRef.current = setTimeout(() => {
      onValueChange(centeredValue);
    }, changeDelay);

    // Mark commit pending — touch/scroll handlers will fire attemptCommit

    pendingCommitRef.current = true;
  }, [centeredValue, changeDelay]);

  const observerRef = useRef<IntersectionObserver | null>(null);

  const registerItem = (itemValue: string, element: HTMLDivElement) => {
    itemRefs.current.set(itemValue, element);
    observerRef.current?.observe(element);
  };

  const unregisterItem = (itemValue: string) => {
    const el = itemRefs.current.get(itemValue);
    if (el) observerRef.current?.unobserve(el);
    itemRefs.current.delete(itemValue);
  };

  const scrollToItem = (itemValue: string) => {
    const el = itemRefs.current.get(itemValue);
    if (el) {
      el.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    } else {
      console.warn("[SliderPicker] No element found for value:", itemValue);
    }
  };

  return (
    <SliderPickerContext.Provider
      value={{ value, centeredValue, registerItem, unregisterItem, scrollToItem, optionsRef }}
    >
      <div data-slot="slider-picker" className={clsx("slider-picker", className)} {...props}>
        {children}
      </div>
    </SliderPickerContext.Provider>
  );
}

// --- SliderPickerWindow ---

export interface SliderPickerWindowProps extends ComponentProps<"div"> {}

export function SliderPickerWindow({ className, children, ...props }: SliderPickerWindowProps) {
  return (
    <div
      data-slot="slider-picker-window"
      className={clsx("slider-picker-window", className)}
      {...props}
    >
      {children}
    </div>
  );
}

// --- SliderPickerOptions ---

export interface SliderPickerOptionsProps extends ComponentProps<"div"> {}

export function SliderPickerOptions({ className, children, ...props }: SliderPickerOptionsProps) {
  const { optionsRef } = useSliderPickerContext();

  return (
    <div
      ref={optionsRef}
      data-slot="slider-picker-options"
      className={clsx("slider-picker-options", className)}
      role="listbox"
      {...props}
    >
      {children}
    </div>
  );
}

// --- SliderPickerItem ---

export interface SliderPickerItemProps extends ComponentProps<"div"> {
  value: string;
  /** Toggle state (like a checkbox) - only used when item is selected */
  checked?: boolean;
  /** Called when selected item is clicked - toggles the checked state */
  onCheckedChange?: (checked: boolean) => void;
}

export function SliderPickerItem({
  value: itemValue,
  className,
  children,
  checked,
  onCheckedChange,
  ...props
}: SliderPickerItemProps) {
  const { centeredValue, registerItem, unregisterItem, scrollToItem } = useSliderPickerContext();
  const ref = useRef<HTMLDivElement>(null);
  const isSelected = centeredValue === itemValue;

  useEffect(() => {
    const el = ref.current;
    if (el) {
      registerItem(itemValue, el);
      return () => unregisterItem(itemValue);
    }
  }, [itemValue, registerItem, unregisterItem]);

  const handleClick = () => {
    if (isSelected && onCheckedChange !== undefined) {
      // Selected item with toggle: fire toggle callback
      onCheckedChange(!checked);
    } else {
      // Non-selected item OR no toggle prop: navigate as usual
      scrollToItem(itemValue);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (isSelected && onCheckedChange !== undefined) {
        onCheckedChange(!checked);
      } else {
        scrollToItem(itemValue);
      }
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const current = e.currentTarget as HTMLElement;
      const sibling =
        e.key === "ArrowRight" ? current.nextElementSibling : current.previousElementSibling;
      if (sibling instanceof HTMLElement && sibling.dataset.value != null) {
        scrollToItem(sibling.dataset.value);
        sibling.focus();
      }
    }
  };

  const hasToggle = onCheckedChange !== undefined;

  return (
    <div
      ref={ref}
      data-slot="slider-picker-item"
      data-value={itemValue}
      data-selected={isSelected || undefined}
      data-toggleable={hasToggle || undefined}
      data-checked={checked || undefined}
      className={clsx("slider-picker-item", className)}
      role="option"
      aria-selected={isSelected}
      tabIndex={isSelected ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}

// --- SliderPickerMixedItem ---

export interface SliderPickerMixedItemProps extends ComponentProps<"div"> {
  /** Value to register with. @default "" */
  value?: string;
  /** Toggle state (like a checkbox) - only used when item is selected */
  checked?: boolean;
  /** Called when selected item is clicked - toggles the checked state */
  onCheckedChange?: (checked: boolean) => void;
}

/** Non-interactive scroll target shown when the controlled value is mixed across a multi-selection. */
export function SliderPickerMixedItem({
  value: itemValue = "",
  className,
  children,
  checked,
  onCheckedChange,
  ...props
}: SliderPickerMixedItemProps) {
  const { centeredValue, registerItem, unregisterItem } = useSliderPickerContext();
  const ref = useRef<HTMLDivElement>(null);
  const isSelected = centeredValue === itemValue;

  useEffect(() => {
    const el = ref.current;
    if (el) {
      registerItem(itemValue, el);
      return () => unregisterItem(itemValue);
    }
  }, [itemValue, registerItem, unregisterItem]);

  const handleClick = () => {
    if (isSelected && onCheckedChange !== undefined) {
      onCheckedChange(!checked);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.key === "Enter" || e.key === " ") && isSelected && onCheckedChange !== undefined) {
      e.preventDefault();
      onCheckedChange(!checked);
    }
  };

  const hasToggle = onCheckedChange !== undefined;

  return (
    <div
      ref={ref}
      data-slot="slider-picker-mixed-item"
      data-value={itemValue}
      data-selected={isSelected || undefined}
      data-toggleable={hasToggle || undefined}
      data-checked={checked || undefined}
      className={clsx("slider-picker-item", className)}
      role="option"
      aria-selected={isSelected}
      tabIndex={-1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...props}
    >
      {children}
    </div>
  );
}
