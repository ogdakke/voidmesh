import clsx from "clsx";
import { useEffect, useRef } from "react";
import "./checkbox.css";

export interface CheckboxProps extends React.ComponentPropsWithoutRef<"input"> {
  /**
   * The label content for the checkbox.
   */
  children?: React.ReactNode;
  /**
   * When true, shows the indeterminate (mixed) state for multi-select.
   */
  indeterminate?: boolean;

  /** When true, renders the checkbox as a switch toggle. */
  switch?: boolean;
}

export function Checkbox({
  children,
  className,
  indeterminate,
  switch: isSwitch,
  ...props
}: CheckboxProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.indeterminate = indeterminate ?? false;
    }
  }, [indeterminate]);

  useEffect(() => {
    if (inputRef.current) {
      if (isSwitch) {
        inputRef.current.setAttribute("switch", "");
      } else {
        inputRef.current.removeAttribute("switch");
      }
    }
  }, [isSwitch]);

  return (
    <label className={clsx("ui-checkbox", className)}>
      <input ref={inputRef} type="checkbox" {...props} />
      {children && <span className="field-label ui-checkbox-label">{children}</span>}
    </label>
  );
}
