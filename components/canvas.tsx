import { memo } from "react";
import { InfiniteCanvas } from "./infinite-canvas";

export const Canvas = memo(function Canvas() {
  return (
    <div className="canvas">
      <InfiniteCanvas />
    </div>
  );
});
