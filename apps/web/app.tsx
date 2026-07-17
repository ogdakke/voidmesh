import { IconoirProvider } from "iconoir-react";
import { NuqsAdapter } from "nuqs/adapters/react";
import React, { lazy, Suspense, useEffect, useRef, useState, type PropsWithChildren } from "react";
import ReactDOM from "react-dom/client";
import { logger } from "#lib/client.logger.ts";
import { ToastProvider } from "#ui/toast/toast.tsx";
import { PwaUpdateManager } from "#components/pwa/pwa-update-manager.tsx";
import { CanvasProvider } from "#context/canvas-context.tsx";
import { ExportQueueProvider } from "#context/export-queue-context.tsx";
import { KeybindProvider } from "#context/keybind-provider.tsx";
import { LayoutProvider } from "#context/layout-context.tsx";
import { VideoExportProvider } from "#context/video-export-context.tsx";
import { useIsMobile, useIsTouch } from "#hooks/use-is-mobile.ts";
import useMediaQuery from "#hooks/use-media-query.ts";
import { PostHogProvider, usePostHog } from "@posthog/react";
import type { PostHogConfig } from "posthog-js";
import { analytics } from "#lib/analytics.ts";
import { PostHogAnalyticsProvider } from "#lib/analytics-posthog.ts";
import { HostedEntry } from "#components/hosted/hosted-entry.tsx";
import { HostedWorkspaceRuntime } from "#context/hosted-workspace-runtime.tsx";
import type { WorkspaceSummary } from "@voidmesh/api-contract";
import type { HostedApiClient } from "#lib/hosted-api-client.ts";
import { WorkspaceRole, type WorkspaceRole as WorkspaceRoleValue } from "@voidmesh/domain";
import type { CanvasAccessPolicy } from "#context/use-canvas.ts";

import "#styles/app.css";

const options: Partial<PostHogConfig> = {
  ui_host: import.meta.env.VITE_PUBLIC_POSTHOG_UI_HOST!,
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST!,
  defaults: "2026-01-30",
  capture_exceptions: true,
} as const;

const DesktopLayout = lazy(() => import("#components/desktop-layout.tsx"));
const MobileLayout = lazy(() => import("#components/mobile-layout.tsx"));

const HOSTED_CANVAS_ACCESS: Record<WorkspaceRoleValue, CanvasAccessPolicy> = {
  [WorkspaceRole.owner]: { canEdit: true, canExportWorkspace: true, hosted: true },
  [WorkspaceRole.editor]: { canEdit: true, canExportWorkspace: true, hosted: true },
  [WorkspaceRole.viewer]: { canEdit: false, canExportWorkspace: false, hosted: true },
};

export default function App() {
  if (
    location.pathname === "/cloud" ||
    location.pathname === "/login" ||
    location.pathname === "/signup" ||
    location.pathname === "/forgot-password" ||
    location.pathname === "/reset-password" ||
    location.pathname.startsWith("/w/") ||
    location.pathname.startsWith("/invite/")
  ) {
    return (
      <HostedEntry>
        {(api, workspace) => <CanvasApplication key={workspace.id} hosted={{ api, workspace }} />}
      </HostedEntry>
    );
  }
  return <CanvasApplication />;
}

function CanvasApplication({
  hosted,
}: {
  hosted?: { api: HostedApiClient; workspace: WorkspaceSummary };
}) {
  const isTouch = useIsTouch();
  const isMobile = useIsMobile();
  const isPrettyLargeScreen = useMediaQuery("(min-width: 830px)");
  const isSmallScreen = useMediaQuery("(max-width: 1100px)");

  const isMostProbablyTablet = isTouch && isPrettyLargeScreen;

  // small(ish) screen + not touch = desktop layout
  // probably tablet or mobile = mobile layout
  const showMobileLayout = (isSmallScreen && !isTouch) || isMostProbablyTablet || isMobile;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hostedRole, setHostedRole] = useState(hosted?.workspace.role);
  const panelToggleRef = useRef<(() => void) | null>(null);

  const effectiveHostedWorkspace =
    hosted && hostedRole ? { ...hosted.workspace, role: hostedRole } : hosted?.workspace;

  const registerPanelToggle = (toggle: (() => void) | null) => {
    panelToggleRef.current = toggle;
  };

  const toggleFullscreen = () => {
    if (panelToggleRef.current) {
      // Desktop: directly toggle panels; onResize will update isFullscreen
      panelToggleRef.current();
    } else {
      // Mobile: no panels, just toggle the flag
      setIsFullscreen((prev) => !prev);
    }
  };

  const setFullscreen = (value: boolean) => setIsFullscreen(value);

  const content = (
    <VideoExportProvider>
      <ExportQueueProvider>
        <LayoutProvider
          value={{ isFullscreen, toggleFullscreen, setFullscreen, registerPanelToggle }}
        >
          <Suspense fallback={null}>
            {showMobileLayout ? <MobileLayout /> : <DesktopLayout />}
          </Suspense>
        </LayoutProvider>
      </ExportQueueProvider>
    </VideoExportProvider>
  );

  return (
    <IconoirProvider
      iconProps={{ color: "currentColor", strokeWidth: 1.5, width: "1em", height: "1em" }}
    >
      <ToastProvider>
        <PwaUpdateManager />
        <CanvasProvider
          access={
            effectiveHostedWorkspace
              ? HOSTED_CANVAS_ACCESS[effectiveHostedWorkspace.role]
              : undefined
          }
        >
          {hosted && effectiveHostedWorkspace ? (
            <HostedWorkspaceRuntime
              api={hosted.api}
              onRoleChange={setHostedRole}
              workspace={effectiveHostedWorkspace}
            >
              {content}
            </HostedWorkspaceRuntime>
          ) : (
            content
          )}
        </CanvasProvider>
      </ToastProvider>
    </IconoirProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!, {
  onCaughtError(error, errorInfo) {
    logger.error("[ErrorBoundary]", error, errorInfo.componentStack);
  },
  onUncaughtError(error, errorInfo) {
    logger.error("[Uncaught]", error, errorInfo.componentStack);
  },
}).render(
  <React.StrictMode>
    <AnalyticsProvider>
      <NuqsAdapter>
        <KeybindProvider>
          <App />
        </KeybindProvider>
      </NuqsAdapter>
    </AnalyticsProvider>
    {/*{import.meta.env.DEV && <Agentation />}*/}
  </React.StrictMode>,
);

function PostHogBridge() {
  const posthog = usePostHog();
  useEffect(() => {
    const provider = new PostHogAnalyticsProvider(posthog);
    analytics.addProvider(provider);
    return () => analytics.removeProvider(provider);
  }, [posthog]);
  return null;
}

if (import.meta.env.DEV) {
  analytics.addProvider({
    track(event, properties) {
      console.log("[analytics]", event, properties);
    },
  });
}

function AnalyticsProvider({ children }: PropsWithChildren) {
  if (
    typeof window !== "undefined" &&
    window.location.hostname === "localhost" &&
    import.meta.env.DEV
  ) {
    return children;
  }
  return (
    <PostHogProvider apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_KEY!} options={options}>
      <PostHogBridge />
      {children}
    </PostHogProvider>
  );
}
