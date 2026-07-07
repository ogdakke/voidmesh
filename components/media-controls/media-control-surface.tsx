import type { ReactNode } from "react";

export function MediaControlSurface({
  hidden = false,
  children,
}: {
  hidden?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="media-controls" hidden={hidden}>
      <div className="media-controls__container">{children}</div>
    </div>
  );
}
