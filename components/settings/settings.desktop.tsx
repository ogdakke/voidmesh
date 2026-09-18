import { Button } from "#ui/button/button.tsx";
import { MoreVert } from "iconoir-react";
import { lazy, Suspense, useState } from "react";
import "./settings.desktop.css";

const DesktopSettingsContent = lazy(() => import("./settings.desktop.content.tsx"));

export default function DesktopSettings() {
  const [isOpen, setIsOpen] = useState(location.hash.slice(1) === "settings");

  const handleOpen = () => {
    setIsOpen(true);
    history.replaceState(null, "", `${location.pathname}${location.search}#settings`);
  };

  const handleClose = () => {
    setIsOpen(false);
    history.replaceState(null, "", location.pathname + location.search);
  };

  return (
    <div className="desktop-settings">
      <Button size="sm" variant="secondary" className="settings-trigger" onClick={handleOpen}>
        <MoreVert />
      </Button>
      {isOpen && (
        <Suspense>
          <DesktopSettingsContent isOpen={isOpen} onClose={handleClose} />
        </Suspense>
      )}
    </div>
  );
}
