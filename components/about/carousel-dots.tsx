import type { useCarouselDots } from "#hooks/use-carousel-dots.ts";

type CarouselDotsData = Pick<
  ReturnType<typeof useCarouselDots>,
  "activeIndex" | "count" | "progress" | "ids" | "scrollTo"
>;

export function CarouselDots({ activeIndex, count, progress, ids, scrollTo }: CarouselDotsData) {
  if (count === 0) return null;

  return (
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
  );
}
