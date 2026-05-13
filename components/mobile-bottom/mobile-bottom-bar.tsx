import {
  createContext,
  use,
  useState,
  type ComponentProps,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import "./mobile-bottom-bar.css";
import clsx from "clsx";
import { Enlarge, Reduce } from "iconoir-react";
import { useLayout } from "#context/use-layout.ts";
import { haptic } from "#lib/haptic.ts";
import { canvasStore } from "#engine";

interface BottomBarContextValue<T extends string> {
  items: T[];
  activeItem: string | null;
  setActiveItem: (item: string | null) => void;
  onChange: (item: string | null) => void;
}

const BottomBarContext = createContext<BottomBarContextValue<string> | null>(null);
function useBottomBarContext<T extends string>() {
  const context = use(BottomBarContext);
  if (!context) {
    throw new Error("useBottomBarContext must be used within a BottomBarProvider");
  }

  return context as unknown as BottomBarContextValue<T>;
}

function BottomBarProvider<T extends string>({
  items,
  onChange,
  value,
  children,
}: PropsWithChildren<{
  items: readonly T[];
  onChange?: (item: string | null) => void;
  value?: string | null;
}>) {
  const [activeItem, setActiveItem] = useState<string | null>(value ?? null);

  const contextValue = {
    items,
    activeItem,
    setActiveItem,
    onChange,
  };

  return (
    <BottomBarContext.Provider value={contextValue as any}>{children}</BottomBarContext.Provider>
  );
}

function BottomBarRoot<T extends string>({
  items,
  children,
  onChange,
  value,
}: {
  items: readonly T[];
  children: ReactNode | ((items: readonly T[]) => ReactNode);
  onChange?: (item: string | null) => void;
  value?: string | null;
}) {
  return (
    <BottomBarProvider items={items} onChange={onChange} value={value}>
      <div className="mobile-bottom-bar">
        {typeof children === "function" ? children(items) : children}
      </div>
    </BottomBarProvider>
  );
}

export function MobileBottomBar<T extends string>({
  items,
  children,
  onChange,
  value,
}: {
  items: readonly T[];
  children: ReactNode | ((items: readonly T[]) => ReactNode);
  onChange?: (item: string | null) => void;
  value: string | null;
  hideItems?: boolean;
}) {
  const { isFullscreen, toggleFullscreen } = useLayout();
  return (
    <div className="mobile-bottom-bar-container">
      <BottomBarRoot items={items} onChange={onChange} value={value}>
        {typeof children === "function" ? children(items) : children}
      </BottomBarRoot>
      <button
        className={"mobile-fullscreen-btn"}
        data-active={isFullscreen ? true : undefined}
        onClick={() => {
          haptic({ wantsHaptic: canvasStore.getState().haptics });
          toggleFullscreen();
        }}
        aria-label={`Toggle fullscreen ${isFullscreen ? "off" : "on"}`}
      >
        {isFullscreen ? <Reduce /> : <Enlarge />}
      </button>
    </div>
  );
}

export interface BottomBarItemProps extends ComponentProps<"button"> {
  label: string;
}

export function BottomBarItem({
  children,
  disabled,
  label,
  onClick,
  ...props
}: PropsWithChildren<BottomBarItemProps>) {
  const { activeItem, setActiveItem, onChange } = useBottomBarContext();
  return (
    <button
      {...props}
      className={clsx("bottom-bar-item", props.className)}
      value={label}
      data-active={activeItem === label ? true : undefined}
      aria-disabled={disabled}
      aria-label={label}
      onClick={(e) => {
        if (disabled) return;
        setActiveItem(label);
        onChange?.(label);
        onClick?.(e);
      }}
    >
      {children}
    </button>
  );
}
