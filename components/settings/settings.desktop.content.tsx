import { Button } from "#ui/button/button.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import { useCanvasCommands, useCanvasPreferences } from "#context/use-canvas.ts";
import lensingSpriteDark from "#media/lensing-preview-sprite-grain.png?img";
import lensingSpriteLight from "#media/lensing-preview-sprite-light-grain.png?img";
import { CanvasLensing } from "#types/enums.ts";
import { Xmark } from "iconoir-react";
import { useState } from "react";
import lensingSpriteDarkLqip from "./assets/lensing-preview-sprite-grain-lqip.webp?inline";
import lensingSpriteLightLqip from "./assets/lensing-preview-sprite-light-grain-lqip.webp?inline";
import {
  FancyDeleteToggle,
  FeedbackLink,
  LinkItem,
  RedoOnboardingButton,
  ShareLink,
  SnapToGridToggle,
} from "./settings.shared.tsx";

export default function DesktopSettingsContent({
  isOpen,
  onClose,
}: {
  isOpen: boolean;
  onClose: () => void;
}) {
  return (
    <Modal.Root
      open={isOpen}
      onClose={onClose}
      aria-label="Settings"
      className="desktop-settings-modal"
    >
      <Modal.Close
        render={
          <Button
            aria-label="Close Settings"
            variant="secondary"
            className="desktop-settings-modal__close"
          />
        }
      >
        <Xmark />
      </Modal.Close>
      <div className="desktop-settings-content">
        <main className="desktop-settings-main">
          <h1>Settings</h1>
          <section className="desktop-settings-section" aria-label="Canvas settings">
            <CanvasLensingPreviews />
            <div className="desktop-settings-group">
              <div className="desktop-settings-row">
                <SnapToGridToggle />
              </div>
              <div className="desktop-settings-row">
                <FancyDeleteToggle />
              </div>
            </div>
          </section>
          <section className="desktop-settings-section" aria-labelledby="voidmesh-settings-title">
            <h2 id="voidmesh-settings-title">Voidmesh</h2>
            <div className="desktop-settings-group">
              <div className="desktop-settings-action field-label">
                <LinkItem>
                  <ShareLink />
                </LinkItem>
              </div>
              <div className="desktop-settings-action field-label">
                <LinkItem>
                  <FeedbackLink className="desktop-settings-link" />
                </LinkItem>
              </div>
            </div>
          </section>
          <section className="desktop-settings-section" aria-labelledby="onboarding-settings-title">
            <h2 id="onboarding-settings-title">Onboarding</h2>
            <div className="desktop-settings-group">
              <div className="desktop-settings-onboarding">
                <div>
                  <span className="desktop-settings-option-label">Start over</span>
                  <p className="desktop-settings-option-description">
                    Clears the canvas and shows the introduction again.
                  </p>
                </div>
                <RedoOnboardingButton onDone={onClose} />
              </div>
            </div>
          </section>
        </main>
      </div>
    </Modal.Root>
  );
}

const LENSING_OPTIONS = [
  { value: CanvasLensing.off, label: "Off" },
  { value: CanvasLensing.subtle, label: "Subtle" },
  { value: CanvasLensing.extreme, label: "Extreme" },
] as const;

function CanvasLensingPreviews() {
  const { canvasLensing } = useCanvasPreferences();
  const { setCanvasLensing } = useCanvasCommands();
  const [isSpriteLoaded, setIsSpriteLoaded] = useState(false);

  return (
    <fieldset className="desktop-settings-previews">
      <legend>Canvas lensing</legend>
      <span className="desktop-settings-sprite-preloader" aria-hidden="true">
        <LensingSpritePicture full onLoad={() => setIsSpriteLoaded(true)} />
      </span>
      <div className="desktop-settings-preview-grid">
        {LENSING_OPTIONS.map(({ value, label }) => (
          <label
            className="desktop-settings-preview-option"
            key={value}
            data-selected={canvasLensing === value || undefined}
          >
            <input
              className="desktop-settings-preview-input"
              type="radio"
              name="canvas-lensing"
              value={value}
              checked={canvasLensing === value}
              onChange={() => setCanvasLensing(value)}
            />
            <div className="desktop-settings-preview" data-lensing={value}>
              <div
                className="desktop-settings-preview-surface"
                data-loaded={isSpriteLoaded || undefined}
              >
                <LensingSpritePicture full={isSpriteLoaded} />
              </div>
            </div>
            <span className="desktop-settings-preview-label">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function LensingSpritePicture({ full, onLoad }: { full: boolean; onLoad?: () => void }) {
  if (!full) {
    return (
      <picture>
        <source media="(prefers-color-scheme: light)" srcSet={lensingSpriteLightLqip} />
        <img src={lensingSpriteDarkLqip} width={93} height={20} alt="" />
      </picture>
    );
  }

  return (
    <picture>
      {lensingSpriteLight.sources.map((source) => (
        <source
          key={source.type}
          media="(prefers-color-scheme: light)"
          srcSet={source.srcSet}
          sizes="768px"
          type={source.type}
        />
      ))}
      <source media="(prefers-color-scheme: light)" srcSet={lensingSpriteLight.src} />
      {lensingSpriteDark.sources.map((source) => (
        <source key={source.type} srcSet={source.srcSet} sizes="768px" type={source.type} />
      ))}
      <img
        src={lensingSpriteDark.src}
        width={lensingSpriteDark.width}
        height={lensingSpriteDark.height}
        sizes="768px"
        alt=""
        decoding="async"
        onLoad={onLoad}
      />
    </picture>
  );
}
