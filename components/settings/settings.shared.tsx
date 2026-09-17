import { NavArrowRight } from "iconoir-react";
import { Checkbox } from "#ui/checkbox/index.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/native-select/index.ts";
import { useCanvasCommands, useCanvasPreferences } from "#context/use-canvas.ts";
import { resetOnboardingProgress } from "#lib/onboarding/onboarding-storage.ts";
import { shareOrCopyUrl } from "./share.ts";
import { CanvasLensing } from "#types/enums.ts";
import "#components/ui/field/field.css";
import "./settings.shared.css";

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

export function MinimapToggle() {
  const { minimap } = useCanvasPreferences();
  const { setMinimap } = useCanvasCommands();
  return (
    <Checkbox
      name="minimap"
      checked={minimap}
      onChange={(e) => setMinimap(e.target.checked)}
      switch
    >
      Minimap
    </Checkbox>
  );
}

export function CanvasLensingSelect() {
  const { canvasLensing } = useCanvasPreferences();
  const { setCanvasLensing } = useCanvasCommands();

  return (
    <div className="native-select-field native-select-field--mobile">
      <label className="ui-field-label settings-label" htmlFor="canvas_lensing">
        Canvas lensing
      </label>
      <NativeSelect
        id="canvas_lensing"
        name="canvas_lensing"
        value={canvasLensing}
        size="sm"
        onChange={(event) => setCanvasLensing(event.target.value as CanvasLensing)}
        variant="quiet"
      >
        <NativeSelectOption value={CanvasLensing.off}>Off</NativeSelectOption>
        <NativeSelectOption value={CanvasLensing.subtle}>Subtle</NativeSelectOption>
        <NativeSelectOption value={CanvasLensing.extreme}>Extreme</NativeSelectOption>
      </NativeSelect>
    </div>
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

export function RedoOnboardingLink({ onDone }: { onDone?: () => void }) {
  const { clearWorkspace } = useCanvasCommands();

  const redoOnboarding = () => {
    clearWorkspace();
    void resetOnboardingProgress();
    onDone?.();
  };

  return (
    <button type="button" onClick={redoOnboarding}>
      <span>Redo onboarding</span>
    </button>
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
