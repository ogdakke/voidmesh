import { Button } from "#ui/button/button.tsx";
import { Modal } from "#ui/modal/modal.tsx";
import { Xmark } from "iconoir-react";
import { CanvasLensingPreviews } from "./canvas-lensing-previews.tsx";
import {
  FancyDeleteToggle,
  FeedbackLink,
  LinkItem,
  OpenOverlapBenchmarkButton,
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
                  <OpenOverlapBenchmarkButton onOpen={onClose} />
                </LinkItem>
              </div>
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
