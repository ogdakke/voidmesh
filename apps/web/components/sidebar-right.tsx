import { SidebarRightControls } from "./sidebar-right-controls";
import "#styles/sidebar.css";

export const SidebarRight = () => {
  return (
    <div className="app-sidebar sidebar--right">
      <SidebarRightControls className="controls" />
    </div>
  );
};
