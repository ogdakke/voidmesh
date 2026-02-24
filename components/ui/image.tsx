import { useEffect, useRef, type ComponentProps } from "react";

const isCrawler =
  typeof window !== "undefined" &&
  (!("onscroll" in window) || /(?:gle|ing|ro)bot|crawl|spider/i.test(navigator.userAgent));

interface ImageProps extends Omit<ComponentProps<"img">, "src" | "srcSet"> {
  src: string;
  sources: { srcSet: string; type: string }[];
  thumbhash: string;
  /** Load immediately instead of waiting for viewport intersection. */
  preload?: boolean;
}

export function Image({
  src,
  sources,
  thumbhash,
  width,
  height,
  style,
  preload,
  alt,
  className,
  ...rest
}: ImageProps) {
  const pictureRef = useRef<HTMLPictureElement>(null);

  useEffect(() => {
    const picture = pictureRef.current;
    if (!picture) return;

    const swap = () => {
      const sourceEls = picture.querySelectorAll("source[data-srcset]");
      for (const source of sourceEls) {
        source.setAttribute("srcset", source.getAttribute("data-srcset")!);
        source.removeAttribute("data-srcset");
      }
      const img = picture.querySelector("img");
      if (img) img.src = src;
    };

    if (preload || isCrawler) {
      swap();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        swap();
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );

    observer.observe(picture);
    return () => observer.disconnect();
  }, [src, sources, preload]);

  return (
    <picture ref={pictureRef}>
      {sources.map((s) => (
        <source key={s.type} data-srcset={s.srcSet} type={s.type} />
      ))}
      <img
        src={isCrawler ? src : thumbhash}
        alt={alt}
        width={width}
        height={height}
        className={className}
        style={{ aspectRatio: `${width} / ${height}`, ...style }}
        loading="lazy"
        decoding="async"
        {...rest}
      />
    </picture>
  );
}
