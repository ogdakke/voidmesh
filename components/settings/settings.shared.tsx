import { NavArrowRight } from "iconoir-react";
import { Checkbox } from "#ui/checkbox/index.tsx";
import { useCanvasCommands, useCanvasPreferences } from "#context/use-canvas.ts";
import { shareOrCopyUrl } from "./share.ts";

export function SnapToGridToggle() {
  const { snapToGrid } = useCanvasPreferences();
  const { setSnapToGrid } = useCanvasCommands();
  return (
    <Checkbox
      name="snap_to_grid"
      checked={snapToGrid}
      onChange={(e) => setSnapToGrid(e.target.checked)}
      switch
    >
      Snap to Grid
    </Checkbox>
  );
}

export function FancyDeleteToggle() {
  const { fancyDelete } = useCanvasPreferences();
  const { setFancyDelete } = useCanvasCommands();
  return (
    <Checkbox
      name="fancy_delete"
      checked={fancyDelete}
      onChange={(e) => setFancyDelete(e.target.checked)}
      switch
    >
      Fancy deletions
    </Checkbox>
  );
}

export function HapticsToggle() {
  const { haptics } = useCanvasPreferences();
  const { setHaptics } = useCanvasCommands();
  return (
    <Checkbox
      name="haptics"
      checked={haptics}
      onChange={(e) => setHaptics(e.target.checked)}
      switch
    >
      Haptic feedback
    </Checkbox>
  );
}

export function ShareLink() {
  return (
    <button type="button" onClick={shareOrCopyUrl}>
      <span>Share</span>
    </button>
  );
}

export function FeedbackLink({ className }: { className?: string }) {
  return (
    <a
      href={`mailto:dw@danielwargh.com?subject=${encodeURIComponent("Feedback on voidmesh")}`}
      className={className}
    >
      <span>Send feedback</span>
    </a>
  );
}

export function LinkItem({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <NavArrowRight />
    </>
  );
}
