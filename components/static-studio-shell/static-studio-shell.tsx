import { SidebarLeft } from "#components/sidebar-left.tsx";
import type { CSSProperties } from "react";
import "#styles/sidebar.css";
import "./static-studio-shell.css";
import { Button } from "#ui/button/button.tsx";
import { MediaImagePlus } from "iconoir-react";

export function StaticStudioShell() {
  return (
    <div className="static-studio-shell" aria-busy="true">
      <aside className="static-studio-shell__left">
        <SidebarLeft />
      </aside>
      <div className="resize-handle resize-handle--left static-studio-shell__handle" />
      <main className="static-studio-shell__center">
        <div className="content">
          <StaticCanvasPlaceholder />
        </div>
      </main>
      <div className="resize-handle resize-handle--right static-studio-shell__handle" />
      <aside className="static-studio-shell__right">
        <StaticRightSidebar />
      </aside>
    </div>
  );
}

function StaticCanvasPlaceholder() {
  return (
    <div className="canvas">
      <div className="static-canvas-placeholder">
        <div className="static-canvas-placeholder__grid" />
      </div>
    </div>
  );
}

function StaticRightSidebar() {
  return (
    <div className="app-sidebar sidebar--right">
      <form className="controls">
        <div
          className="sidebar-controls-overflow fade-mask-y"
          style={{ "--box-padding": "80px" } as CSSProperties}
        >
          <div>
            <div className="sidebar-row upload-row">
              <Button variant="primary">
                <MediaImagePlus />
                <span>Add Images/Videos</span>
              </Button>
            </div>
            <hr className="divider" />
            <div className="sidebar-row no-selection-message">
              <p>Drop or paste images, videos and links for editing</p>
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
