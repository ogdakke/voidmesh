import { FancyEffects, isFancyEffects } from "#types/fancy-effects.ts";
import { Select, SelectItem } from "#ui/select/index.tsx";
import { NavArrowRight } from "iconoir-react";
import { Button } from "#ui/button/button.tsx";
import { Checkbox } from "#ui/checkbox/index.tsx";
import { useCanvasCommands, useCanvasPreferences } from "#context/use-canvas.ts";
import { resetOnboardingProgress } from "#lib/onboarding/onboarding-storage.ts";
import { shareOrCopyUrl } from "./share.ts";
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

const fancyEffectOptions = [
  { value: FancyEffects.none, label: "None" },
  { value: FancyEffects.all, label: "All" },
  { value: FancyEffects.deletions, label: "Deletions" },
  { value: FancyEffects.prismWake, label: "Prism wake" },
];

export function FancyEffectsMobileSelect() {
  const { fancyEffects } = useCanvasPreferences();
  const { setFancyEffects } = useCanvasCommands();
  return (
    <div className="native-select-field native-select-field--mobile">
      <label className="ui-field-label settings-label" htmlFor="fancy_effects">
        Fancy Effects
      </label>
      <NativeSelect
        id="fancy_effects"
        name="fancy_effects"
        value={fancyEffects}
        size="sm"
        variant="quiet"
        onChange={(event) => {
          if (isFancyEffects(event.target.value)) setFancyEffects(event.target.value);
        }}
      >
        {fancyEffectOptions.map(({ value, label }) => (
          <NativeSelectOption key={value} value={value}>
            {label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </div>
  );
}

export function FancyEffectsDesktopSelect() {
  const { fancyEffects } = useCanvasPreferences();
  const { setFancyEffects } = useCanvasCommands();
  return (
    <Select
      name="fancy_effects"
      label="Fancy Effects"
      value={fancyEffects}
      items={fancyEffectOptions}
      onValueChange={(value) => {
        if (isFancyEffects(value)) setFancyEffects(value);
      }}
    >
      {fancyEffectOptions.map(({ value, label }) => (
        <SelectItem key={value} value={value}>
          {label}
        </SelectItem>
      ))}
    </Select>
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

function useRedoOnboarding(onDone?: () => void) {
  const { clearWorkspace } = useCanvasCommands();

  return () => {
    clearWorkspace();
    void resetOnboardingProgress();
    onDone?.();
  };
}

export function RedoOnboardingLink({ onDone }: { onDone?: () => void }) {
  const redoOnboarding = useRedoOnboarding(onDone);

  return (
    <button type="button" onClick={redoOnboarding}>
      <span>Redo onboarding</span>
    </button>
  );
}

export function RedoOnboardingButton({ onDone }: { onDone?: () => void }) {
  const redoOnboarding = useRedoOnboarding(onDone);

  return (
    <Button type="button" size="sm" variant="quiet" onClick={redoOnboarding}>
      Redo onboarding
    </Button>
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
