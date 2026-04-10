import { IconoirProvider } from "iconoir-react";
import { NuqsAdapter } from "nuqs/adapters/react";
import React, { lazy, Suspense, useEffect, useRef, useState, type PropsWithChildren } from "react";
import ReactDOM from "react-dom/client";
import { logger } from "#lib/client.logger.ts";
import { ToastProvider } from "#ui/toast/toast.tsx";
import { PwaUpdateManager } from "#components/pwa/pwa-update-manager.tsx";
import { CanvasProvider } from "./context/canvas-context.tsx";
import { ExportQueueProvider } from "./context/export-queue-context.tsx";
import { UpscaleQueueProvider } from "./context/upscale-queue-context.tsx";
import { KeybindProvider } from "./context/keybind-provider.tsx";
import { LayoutProvider } from "./context/layout-context.tsx";
import { VideoExportProvider } from "./context/video-export-context.tsx";
import { useIsMobile, useIsTouch } from "./hooks/use-is-mobile.ts";
import useMediaQuery from "./hooks/use-media-query";
import { PostHogProvider, usePostHog } from "@posthog/react";
import type { PostHogConfig } from "posthog-js";
import { analytics } from "#lib/analytics.ts";
import { PostHogAnalyticsProvider } from "#lib/analytics-posthog.ts";
import { crashReporter } from "#lib/crash-reporting.ts";
import { Agentation } from "agentation";

import "./styles/app.css";

const options: Partial<PostHogConfig> = {
  ui_host: import.meta.env.VITE_PUBLIC_POSTHOG_UI_HOST!,
  api_host: import.meta.env.VITE_PUBLIC_POSTHOG_HOST!,
  defaults: "2026-01-30",
  capture_exceptions: true,
} as const;

const DesktopLayout = lazy(() => import("./components/desktop-layout.tsx"));
const MobileLayout = lazy(() => import("./components/mobile-layout.tsx"));

export default function App() {
  const isTouch = useIsTouch();
  const isMobile = useIsMobile();
  const isPrettyLargeScreen = useMediaQuery("(min-width: 830px)");
  const isSmallScreen = useMediaQuery("(max-width: 1100px)");

  const isMostProbablyTablet = isTouch && isPrettyLargeScreen;

  // small(ish) screen + not touch = desktop layout
  // probably tablet or mobile = mobile layout
  const showMobileLayout = (isSmallScreen && !isTouch) || isMostProbablyTablet || isMobile;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const panelToggleRef = useRef<(() => void) | null>(null);

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

  return (
    <IconoirProvider
      iconProps={{
        color: "currentColor",
        strokeWidth: 1.5,
        width: "1em",
        height: "1em",
      }}
    >
      <ToastProvider>
        <PwaUpdateManager />
        <CanvasProvider>
          <VideoExportProvider>
            <ExportQueueProvider>
              <UpscaleQueueProvider>
                <LayoutProvider
                  value={{
                    isFullscreen,
                    toggleFullscreen,
                    setFullscreen,
                    registerPanelToggle,
                  }}
                >
                  <Suspense fallback={null}>
                    {showMobileLayout ? <MobileLayout /> : <DesktopLayout />}
                  </Suspense>
                </LayoutProvider>
              </UpscaleQueueProvider>
            </ExportQueueProvider>
          </VideoExportProvider>
        </CanvasProvider>
      </ToastProvider>
    </IconoirProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!, {
  onCaughtError(error, errorInfo) {
    logger.error("[ErrorBoundary]", error, errorInfo.componentStack);
    crashReporter.captureException("react.caught", error, {
      componentStack: errorInfo.componentStack,
    });
  },
  onUncaughtError(error, errorInfo) {
    logger.error("[Uncaught]", error, errorInfo.componentStack);
    crashReporter.captureException("react.uncaught", error, {
      componentStack: errorInfo.componentStack,
    });
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
    {import.meta.env.DEV && <Agentation />}
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

function CrashReporterBridge() {
  useEffect(() => {
    crashReporter.initialize();
  }, []);
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
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return (
      <>
        <CrashReporterBridge />
        {children}
      </>
    );
  }
  return (
    <PostHogProvider apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_KEY!} options={options}>
      <PostHogBridge />
      <CrashReporterBridge />
      {children}
    </PostHogProvider>
  );
}
