import { Button } from "#ui/button/button.tsx";
import { MoreVert } from "iconoir-react";
import { lazy, Suspense, useState } from "react";
import "./settings.desktop.css";

const DesktopSettingsContent = lazy(() => import("./settings.desktop.content.tsx"));

export default function DesktopSettings() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="desktop-settings">
      <Button
        size="sm"
        variant="secondary"
        className="settings-trigger"
        onClick={() => setIsOpen(true)}
      >
        <MoreVert />
      </Button>
      {isOpen && (
        <Suspense>
          <DesktopSettingsContent isOpen={isOpen} onClose={() => setIsOpen(false)} />
        </Suspense>
      )}
    </div>
  );
}
