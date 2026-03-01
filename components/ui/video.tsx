import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";

const codecType = {
  av1: "video/mp4; codecs=av01.0.05M.08",
  "av1/opus": "video/mp4; codecs=av01.0.05M.08,opus",
  h264: "video/mp4; codecs=avc1.4D401E",
  "h264/aac": "video/mp4; codecs=avc1.4D401E,mp4a.40.2",
  hevc: "video/mp4; codecs=hvc1",
} as const;

interface VideoSource {
  src: string;
  codec: keyof typeof codecType;
}

interface VideoProps extends Omit<ComponentProps<"video">, "src" | "preload" | "children"> {
  src: string | VideoSource[];
  /** Load immediately instead of waiting for viewport intersection. */
  eager?: boolean;
}

export function Video({ src, eager, autoPlay, muted, onClick, ...rest }: VideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const hasSources = typeof src !== "string";

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const activate = () => {
      if (hasSources) {
        setActive(true);
      } else {
        video.src = src;
      }
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
  }, [src, eager, autoPlay, hasSources]);

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
    >
      {active && hasSources
        ? src.map((s) => <source key={s.src} src={s.src} type={codecType[s.codec]} />)
        : null}
    </video>
  );
}
