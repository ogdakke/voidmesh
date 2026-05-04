import { Modal } from "#ui/modal/modal.tsx";
import {
  FancyDeleteToggle,
  FeedbackLink,
  LinkItem,
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
    <Modal.Root open={isOpen} onClose={onClose}>
      <Modal.Content className="desktop-settings-modal">
        <h3 className="desktop-settings-title">Settings</h3>
        <hr className="divider" />
        <div className="desktop-settings-switch">
          <SnapToGridToggle />
        </div>
        <div className="desktop-settings-switch">
          <FancyDeleteToggle />
        </div>
        <hr className="divider" />
        <div className="desktop-settings-ext-item field-label">
          <LinkItem>
            <ShareLink />
          </LinkItem>
        </div>
        <div className="desktop-settings-ext-item field-label">
          <LinkItem>
            <FeedbackLink className="desktop-settings-link" />
          </LinkItem>
        </div>
      </Modal.Content>
    </Modal.Root>
  );
}
