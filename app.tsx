import { IconoirProvider } from "iconoir-react";
import { NuqsAdapter } from "nuqs/adapters/react";
import React, { lazy, Suspense, useState, type PropsWithChildren } from "react";
import ReactDOM from "react-dom/client";
import { logger } from "#lib/client.logger.ts";
import { ToastProvider } from "#ui/toast/toast.tsx";
import { CanvasProvider } from "./context/canvas-context.tsx";
import { ExportQueueProvider } from "./context/export-queue-context.tsx";
import { KeybindProvider } from "./context/keybind-provider.tsx";
import { LayoutProvider } from "./context/layout-context.tsx";
import { VideoExportProvider } from "./context/video-export-context.tsx";
import { useIsMobile, useIsTouch } from "./hooks/use-is-mobile.ts";
import useMediaQuery from "./hooks/use-media-query";
import { PostHogProvider } from "@posthog/react";
import type { PostHogConfig } from "posthog-js";
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
  const toggleFullscreen = () => setIsFullscreen((prev) => !prev);
  const setFullscreen = (value: boolean) => setIsFullscreen(value);

  return (
    <IconoirProvider
      iconProps={{ color: "currentColor", strokeWidth: 1.5, width: "1em", height: "1em" }}
    >
      <ToastProvider>
        <CanvasProvider>
          <VideoExportProvider>
            <ExportQueueProvider>
              <LayoutProvider value={{ isFullscreen, toggleFullscreen, setFullscreen }}>
                <Suspense fallback={null}>
                  {showMobileLayout ? <MobileLayout /> : <DesktopLayout />}
                </Suspense>
              </LayoutProvider>
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
  </React.StrictMode>,
);

function AnalyticsProvider({ children }: PropsWithChildren) {
  if (typeof window !== "undefined" && window.location.hostname === "localhost") {
    return children;
  }
  return (
    <PostHogProvider apiKey={import.meta.env.VITE_PUBLIC_POSTHOG_KEY!} options={options}>
      {children}
    </PostHogProvider>
  );
}
