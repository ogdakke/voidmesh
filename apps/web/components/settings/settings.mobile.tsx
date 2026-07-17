import { useHasEntities } from "#context/use-canvas.ts";
import { useStudioFile } from "#hooks/use-studio-file.ts";
import { WorkspaceActions } from "#components/workspace-actions/workspace-actions.tsx";
import { Button } from "#ui/button/index.tsx";
import { Drawer } from "#ui/drawer/index.tsx";
import { MoreVert } from "iconoir-react";
import { lazy, Suspense, useRef, useState } from "react";
import "#components/about/about.css";
import "./settings.mobile.css";
import {
  CanvasLensingSelect,
  FancyDeleteToggle,
  FeedbackLink,
  HapticsToggle,
  LinkItem,
  RedoOnboardingLink,
  ShareLink,
  SnapToGridToggle,
} from "./settings.shared.tsx";
import { MobileAccountDrawer } from "#components/hosted/mobile-account-drawer.tsx";
import { CarouselDots } from "#components/about/carousel-dots.tsx";
import { useHostedWorkspaceRuntime } from "#context/hosted-workspace-runtime.tsx";
import { useCarouselDots } from "#hooks/use-carousel-dots.ts";

const loadHostedWorkspaceSettings = () => import("./settings.workspace.mobile.tsx");
const HostedWorkspaceSettings = lazy(loadHostedWorkspaceSettings);

export default function SettingsDrawer() {
  const hosted = useHostedWorkspaceRuntime();
  const hasEntities = useHasEntities();
  const {
    exportStudioFile,
    importStudioFile,
    clearWorkspace,
    hasActiveWorkspaceFile,
    activeWorkspaceFileName,
    isExporting,
    isImporting,
  } = useStudioFile();
  const [open, setOpen] = useState(false);
  const carouselRef = useRef<HTMLDivElement>(null);
  const { activeIndex, count, progress, ids, scrollTo, attach } = useCarouselDots(carouselRef);

  const carouselContentRef = (element: HTMLDivElement | null) => {
    carouselRef.current = element;
    attach(element);
  };

  const setDrawerOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen && hosted) void loadHostedWorkspaceSettings();
    if (!nextOpen && location.hash.startsWith("#workspace-settings-")) {
      history.replaceState(null, "", location.pathname + location.search);
    }
  };

  const importAndClose = (onSuccess?: () => void) => {
    importStudioFile(() => {
      onSuccess?.();
      setOpen(false);
    });
  };

  return (
    <Drawer.Root open={open} onOpenChange={setDrawerOpen}>
      <Drawer.Trigger
        render={(props) => (
          <Button
            {...props}
            variant="secondary"
            className="settings-drawer-trigger"
            aria-label="Settings"
          >
            <MoreVert />
          </Button>
        )}
      ></Drawer.Trigger>
      <Drawer.Popup className="settings-drawer-popup">
        <div className="settings-drawer-header">
          <h3 className="settings-drawer-title">Settings</h3>
        </div>
        <Drawer.Content className="settings-drawer-content">
          <div ref={carouselContentRef} className="settings-carousel">
            <section id="workspace-settings-general" className="settings-drawer-inner">
              <div className="settings-drawer-account">
                <MobileAccountDrawer />
              </div>
              <hr className="divider" />
              <div className="settings-drawer-switch">
                <SnapToGridToggle />
              </div>
              <div className="settings-drawer-switch">
                <FancyDeleteToggle />
              </div>
              <div className="settings-drawer-switch">
                <HapticsToggle />
              </div>
              <div className="settings-drawer-switch">
                <CanvasLensingSelect />
              </div>
              <hr className="divider" />
              <div className="settings-drawer-ext-item field-label">
                <LinkItem>
                  <ShareLink />
                </LinkItem>
              </div>
              <div className="settings-drawer-ext-item field-label">
                <LinkItem>
                  <FeedbackLink className="settings-drawer-link" />
                </LinkItem>
              </div>
              <hr className="divider" />
              <div className="settings-drawer-ext-item field-label">
                <LinkItem>
                  <RedoOnboardingLink onDone={() => setDrawerOpen(false)} />
                </LinkItem>
              </div>
              <WorkspaceActions
                className="settings-drawer-workspace-actions"
                hasEntities={hasEntities}
                exportStudioFile={exportStudioFile}
                importStudioFile={importAndClose}
                clearWorkspace={clearWorkspace}
                hasActiveWorkspaceFile={hasActiveWorkspaceFile}
                activeWorkspaceFileName={activeWorkspaceFileName}
                isExporting={isExporting}
                isImporting={isImporting}
                moreActionsPresentation="sheet"
              />
            </section>
            {hosted && (
              <Suspense
                fallback={
                  <HostedSettingsSkeleton
                    role={hosted.workspace.role}
                    title={hosted.workspace.title}
                  />
                }
              >
                <HostedWorkspaceSettings runtime={hosted} />
              </Suspense>
            )}
          </div>
        </Drawer.Content>
        <CarouselDots
          activeIndex={activeIndex}
          count={count}
          progress={progress}
          ids={ids}
          scrollTo={scrollTo}
        />
      </Drawer.Popup>
    </Drawer.Root>
  );
}

function HostedSettingsSkeleton({ role, title }: { role: string; title: string }) {
  return (
    <>
      <section id="workspace-settings-workspace" className="settings-workspace-page">
        <span className="settings-page-kicker">Workspace</span>
        <h3>{title}</h3>
        <p className="settings-page-muted">Loading workspace controls…</p>
      </section>
      <section id="workspace-settings-sharing" className="settings-workspace-page">
        <span className="settings-page-kicker">Sharing</span>
        <h3>People and links</h3>
        <p className="settings-page-muted">Loading members…</p>
      </section>
      {role !== "viewer" && (
        <section id="workspace-settings-transfer" className="settings-workspace-page">
          <span className="settings-page-kicker">Transfer</span>
          <h3>Export and lifecycle</h3>
          <p className="settings-page-muted">Loading workspace actions…</p>
        </section>
      )}
    </>
  );
}
