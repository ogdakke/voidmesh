/**
 * Test helper that wraps components with necessary providers
 */
import React, { type ReactNode } from "react";
import { render, type RenderOptions, type RenderResult } from "@testing-library/react";
import { withNuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing";
import { IconoirProvider } from "iconoir-react";
import { ToastProvider } from "#components/ui/toast/toast.tsx";
import { CanvasProvider, type CanvasContextValue } from "#context/canvas-context.tsx";
import { useCanvas } from "#context/use-canvas.ts";
import { VideoExportProvider } from "#context/video-export-context.tsx";
import { ExportQueueProvider } from "#context/export-queue-context.tsx";
import { KeybindProvider } from "#context/keybind-provider.tsx";
import { useCanvasActions } from "#hooks/use-canvas-actions.ts";

export interface NuqsTestingOptions {
  /**
   * Initial URL search params for testing
   */
  searchParams?: string | URLSearchParams | Record<string, string>;
  /**
   * Callback when URL is updated (for assertions)
   */
  onUrlUpdate?: (event: UrlUpdateEvent) => void;
}

export interface RenderWithProvidersOptions extends Omit<RenderOptions, "wrapper"> {
  /**
   * Skip specific providers for isolated testing
   */
  skip?: {
    nuqs?: boolean;
    iconoir?: boolean;
    toast?: boolean;
    canvas?: boolean;
    videoExport?: boolean;
    exportQueue?: boolean;
    keybind?: boolean;
  };
  /**
   * Options for nuqs testing adapter
   */
  nuqsOptions?: NuqsTestingOptions;
}

/**
 * Create providers wrapper with configurable nuqs testing adapter
 */
function createAllProvidersWrapper(options: RenderWithProvidersOptions = {}) {
  const { skip = {}, nuqsOptions = {} } = options;

  // Create nuqs testing adapter
  // Note: hasMemory was causing "Cannot update component while rendering" warnings
  const NuqsTestingWrapper = withNuqsTestingAdapter({
    searchParams: nuqsOptions.searchParams ?? {},
    onUrlUpdate: nuqsOptions.onUrlUpdate,
  });

  return function AllProviders({ children }: { children: ReactNode }) {
    let wrapped = children;

    // Wrap from innermost to outermost (reverse order of App)
    if (!skip.exportQueue) {
      wrapped = <ExportQueueProvider>{wrapped}</ExportQueueProvider>;
    }

    if (!skip.videoExport) {
      wrapped = <VideoExportProvider>{wrapped}</VideoExportProvider>;
    }

    if (!skip.canvas) {
      wrapped = <CanvasProvider>{wrapped}</CanvasProvider>;
    }

    if (!skip.toast) {
      wrapped = <ToastProvider>{wrapped}</ToastProvider>;
    }

    if (!skip.iconoir) {
      wrapped = (
        <IconoirProvider
          iconProps={{ color: "currentColor", strokeWidth: 1.5, width: "1em", height: "1em" }}
        >
          {wrapped}
        </IconoirProvider>
      );
    }

    if (!skip.keybind) {
      wrapped = <KeybindProvider>{wrapped}</KeybindProvider>;
    }

    if (!skip.nuqs) {
      wrapped = <NuqsTestingWrapper>{wrapped}</NuqsTestingWrapper>;
    }

    return <>{wrapped}</>;
  };
}

/**
 * Render a component wrapped with all necessary providers
 *
 * @example
 * // Full provider stack (default)
 * const { getByText } = renderWithProviders(<MyComponent />);
 *
 * @example
 * // Skip specific providers for isolated testing
 * const { getByText } = renderWithProviders(<MyComponent />, {
 *   skip: { canvas: true, videoExport: true }
 * });
 *
 * @example
 * // With initial URL params for testing URL state
 * const { getByText } = renderWithProviders(<MyComponent />, {
 *   nuqsOptions: { searchParams: { shader: 'halftone', size: '20' } }
 * });
 */
export function renderWithProviders(
  ui: React.ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderResult {
  const { skip, nuqsOptions, ...renderOptions } = options;

  return render(ui, {
    wrapper: createAllProvidersWrapper({ skip, nuqsOptions }),
    ...renderOptions,
  });
}

/**
 * Create minimal providers wrapper with nuqs testing adapter
 */
function createMinimalProvidersWrapper(nuqsOptions: NuqsTestingOptions = {}) {
  const NuqsTestingWrapper = withNuqsTestingAdapter({
    searchParams: nuqsOptions.searchParams ?? {},
    onUrlUpdate: nuqsOptions.onUrlUpdate,
  });

  return function MinimalProviders({ children }: { children: ReactNode }) {
    return (
      <NuqsTestingWrapper>
        <IconoirProvider
          iconProps={{ color: "currentColor", strokeWidth: 1.5, width: "1em", height: "1em" }}
        >
          <KeybindProvider>
            <ToastProvider>{children}</ToastProvider>
          </KeybindProvider>
        </IconoirProvider>
      </NuqsTestingWrapper>
    );
  };
}

export interface RenderMinimalOptions extends Omit<RenderOptions, "wrapper"> {
  nuqsOptions?: NuqsTestingOptions;
}

/**
 * Render with minimal providers (no canvas/export contexts)
 * Faster for testing UI components that don't need canvas state
 */
export function renderMinimal(
  ui: React.ReactElement,
  options: RenderMinimalOptions = {},
): RenderResult {
  const { nuqsOptions, ...renderOptions } = options;
  return render(ui, {
    wrapper: createMinimalProvidersWrapper(nuqsOptions),
    ...renderOptions,
  });
}

/**
 * Result type for renderWithCanvas
 */
export interface RenderWithCanvasResult extends RenderResult {
  /** Direct access to useCanvas() - call context functions like the real app */
  canvas: CanvasContextValue;
  /** Direct access to useCanvasActions() */
  actions: ReturnType<typeof useCanvasActions>;
}

/**
 * Render with canvas context exposed for direct manipulation.
 * Use this to test like the real app - call canvas.addEntity(), canvas.selectEntity(), etc.
 *
 * @example
 * const { canvas, actions } = renderWithCanvas(<SidebarRight />);
 *
 * act(() => {
 *   const id = canvas.addEntity(createEntityInput());
 *   canvas.selectEntity(id);
 * });
 *
 * expect(screen.getByLabelText(/style/i)).toBeInTheDocument();
 *
 * act(() => {
 *   actions.handleShaderTypeChange(ShaderType.blobs);
 * });
 */
export function renderWithCanvas(
  ui?: React.ReactElement,
  options: RenderWithProvidersOptions = {},
): RenderWithCanvasResult {
  let canvasRef: CanvasContextValue | null = null;
  let actionsRef: ReturnType<typeof useCanvasActions> | null = null;

  function ContextCapture({ children }: { children?: ReactNode }) {
    canvasRef = useCanvas();
    actionsRef = useCanvasActions();
    return <>{children}</>;
  }

  const { skip, nuqsOptions, ...renderOptions } = options;

  const result = render(<ContextCapture>{ui}</ContextCapture>, {
    wrapper: createAllProvidersWrapper({ skip, nuqsOptions }),
    ...renderOptions,
  });

  return {
    ...result,
    canvas: canvasRef!,
    actions: actionsRef!,
  };
}
