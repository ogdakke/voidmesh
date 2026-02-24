import { useEffect, useRef, type ComponentProps } from "react";

const isCrawler =
  typeof window !== "undefined" &&
  (!("onscroll" in window) || /(?:gle|ing|ro)bot|crawl|spider/i.test(navigator.userAgent));

interface ImageProps extends Omit<ComponentProps<"img">, "src" | "srcSet"> {
  src: string;
  srcSet: string;
  thumbhash: string;
  /** Load immediately instead of waiting for viewport intersection. */
  preload?: boolean;
}

export function Image({
  src,
  srcSet,
  thumbhash,
  width,
  height,
  style,
  preload,
  alt,
  ...rest
}: ImageProps) {
  const ref = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (preload || isCrawler) {
      if (srcSet) el.srcset = srcSet;
      el.src = src;
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        if (srcSet) el.srcset = srcSet;
        el.src = src;
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [src, srcSet, preload]);

  return (
    <img
      ref={ref}
      src={isCrawler ? src : thumbhash}
      alt={alt}
      width={width}
      height={height}
      style={{ aspectRatio: `${width} / ${height}`, ...style }}
      loading="lazy"
      decoding="async"
      {...rest}
    />
  );
}
