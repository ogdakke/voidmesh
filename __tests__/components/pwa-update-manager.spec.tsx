import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ToastProvider } from "#ui/toast/toast.tsx";
import { PwaUpdateManager } from "#components/pwa/pwa-update-manager.tsx";
import { logger } from "#lib/client.logger.ts";
import { mockPwaState, resetMockPwaState } from "../mocks/virtual-pwa-register-react.ts";

vi.mock("#lib/client.logger.ts", () => ({
  logger: {
    error: vi.fn(),
  },
}));

describe("PwaUpdateManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-05T12:00:00.000Z"));
    resetMockPwaState();
    mockPwaState.updateServiceWorker = vi.fn(async () => {});
    setVisibilityState("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("shows a single persistent update toast when refresh is needed", async () => {
    renderWithToastProvider();

    await act(async () => {
      mockPwaState.setNeedRefresh(true);
    });

    expect(screen.getByText("Update available")).toBeInTheDocument();
    expect(
      screen.getByText("A new version of Voidmesh is ready. Reload to update."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update now" })).toBeInTheDocument();
    expect(screen.getAllByText("Update available")).toHaveLength(1);
  });

  test("clicking the update action reloads through the service worker", async () => {
    renderWithToastProvider();

    await act(async () => {
      mockPwaState.setNeedRefresh(true);
    });

    fireEvent.click(screen.getByRole("button", { name: "Update now" }));

    expect(mockPwaState.updateServiceWorker).toHaveBeenCalledWith(true);
  });

  test("dismissing the toast clears the visible prompt without forcing update", async () => {
    renderWithToastProvider();

    await act(async () => {
      mockPwaState.setNeedRefresh(true);
    });

    const closeButton = document.querySelector<HTMLButtonElement>(".toast_close");
    expect(closeButton).not.toBeNull();
    fireEvent.click(closeButton!);

    expect(screen.queryByText("Update available")).not.toBeInTheDocument();
    expect(mockPwaState.updateServiceWorker).not.toHaveBeenCalled();
  });

  test("visibilitychange to visible triggers an update check", async () => {
    const registration = createRegistration();
    mockPwaState.registration = registration;
    renderWithToastProvider();

    setVisibilityState("hidden");
    setVisibilityState("visible");
    document.dispatchEvent(new Event("visibilitychange"));

    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  test("focus while visible triggers an update check", async () => {
    const registration = createRegistration();
    mockPwaState.registration = registration;
    renderWithToastProvider();

    window.dispatchEvent(new Event("focus"));

    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  test("focus and visibilitychange within the throttle window only check once", async () => {
    const registration = createRegistration();
    mockPwaState.registration = registration;
    renderWithToastProvider();

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(registration.update).toHaveBeenCalledTimes(1);
  });

  test("hidden tabs do not trigger update checks", async () => {
    const registration = createRegistration();
    mockPwaState.registration = registration;
    setVisibilityState("hidden");
    renderWithToastProvider();

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(registration.update).not.toHaveBeenCalled();
  });

  test("missing registration safely skips foreground checks", async () => {
    renderWithToastProvider();

    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(mockPwaState.updateServiceWorker).not.toHaveBeenCalled();
  });

  test("registration errors are logged without showing a toast", async () => {
    mockPwaState.error = new Error("registration failed");
    renderWithToastProvider();

    expect(logger.error).toHaveBeenCalledWith(
      "[PWA] Service worker registration failed",
      mockPwaState.error,
    );
    expect(screen.queryByText("Update available")).not.toBeInTheDocument();
  });
});

function renderWithToastProvider() {
  return render(
    <ToastProvider>
      <PwaUpdateManager />
    </ToastProvider>,
  );
}

function createRegistration() {
  return {
    update: vi.fn(async () => {}),
  } as unknown as ServiceWorkerRegistration;
}

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
}
