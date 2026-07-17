import type { useCarouselDots } from "#hooks/use-carousel-dots.ts";
import { ArrowLeft, ArrowRight } from "iconoir-react";

type CarouselDotsData = Pick<
  ReturnType<typeof useCarouselDots>,
  "activeIndex" | "count" | "progress" | "ids" | "scrollTo"
>;

export function CarouselDots({ activeIndex, count, progress, ids, scrollTo }: CarouselDotsData) {
  if (count === 0) return null;

  const isFirst = activeIndex === 0;
  const isLast = activeIndex === count - 1;
  return (
    <div className="nav-carousel-container" data-last={activeIndex}>
      <button
        onClick={() => (isFirst ? undefined : scrollTo(activeIndex - 1))}
        data-show={!isFirst || undefined}
        className="carousel-arrow"
        disabled={isFirst}
      >
        <ArrowLeft strokeWidth={2} />
      </button>
      <nav className="carousel-dots" aria-label="Carousel navigation">
        {Array.from({ length: count }, (_, i) => (
          <a
            key={i}
            href={ids[i] ? `#${ids[i]}` : undefined}
            className="carousel-dot"
            aria-label={`Go to section ${i + 1}`}
            aria-current={i === activeIndex}
            style={{ "--dot-progress": progress[i] ?? 0 } as React.CSSProperties}
            onClick={(e) => {
              e.preventDefault();
              scrollTo(i);
              if (ids[i]) history.replaceState(null, "", `#${ids[i]}`);
            }}
          />
        ))}
      </nav>
      <button
        onClick={() => (isLast ? undefined : scrollTo(activeIndex + 1))}
        data-show={!isLast || undefined}
        className="carousel-arrow"
        disabled={isLast}
      >
        <ArrowRight strokeWidth={2} />
      </button>
    </div>
  );
}
