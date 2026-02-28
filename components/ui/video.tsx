import { useCallback, useEffect, useRef, type ComponentProps } from "react";

interface VideoProps extends Omit<ComponentProps<"video">, "src" | "preload" | "children"> {
  src: string;
  /** Load immediately instead of waiting for viewport intersection. */
  eager?: boolean;
}

export function Video({ src, eager, autoPlay, muted, onClick, ...rest }: VideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const activate = () => {
      video.src = src;
      video.load();
      if (autoPlay) video.play();
    };

    if (eager) {
      activate();
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        activate();
        observer.disconnect();
      },
      { rootMargin: "200px" },
    );

    observer.observe(video);
    return () => observer.disconnect();
  }, [src, eager, autoPlay]);

  const handleClick = useCallback<React.MouseEventHandler<HTMLVideoElement>>(
    (e) => {
      const video = videoRef.current;
      if (video) {
        if (video.paused) video.play();
        else video.pause();
      }
      onClick?.(e);
    },
    [onClick],
  );

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- decorative video, no speech content
    <video
      ref={videoRef}
      preload="none"
      autoPlay={false}
      muted={muted}
      onClick={handleClick}
      {...rest}
    />
  );
}
