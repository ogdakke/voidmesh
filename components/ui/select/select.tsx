import { Select as BaseSelect, type SelectRootProps } from "@base-ui/react/select";
import { NavArrowDown, Check } from "iconoir-react";
import "./select.css";
import { uniqueId } from "../ui-util";
import type { ReactNode } from "react";

export type ItemMap<T = string> = Record<string, T>;

export interface SelectProps<
  Value,
  Multiple extends boolean | undefined = false,
> extends SelectRootProps<Value, Multiple> {
  label?: string;
  name?: string;
  children: React.ReactNode;
  disabled?: boolean;
  placeholder?: string;
  formatValue?: ReactNode | ((value: Value) => ReactNode);
}

export function Select<Value, Multiple extends boolean | undefined = false>({
  label,
  value,
  defaultValue,
  onValueChange,
  name,
  children,
  disabled,
  items,
  multiple,
  formatValue,
  ...props
}: SelectProps<Value, Multiple>) {
  const id = uniqueId();
  return (
    <div className="select-field">
      {label && (
        <label className="select-label" htmlFor={id}>
          {label}
        </label>
      )}
      <BaseSelect.Root
        {...props}
        id={id}
        value={value}
        defaultValue={defaultValue}
        onValueChange={onValueChange}
        name={name}
        disabled={disabled}
        items={items}
        multiple={multiple}
      >
        <BaseSelect.Trigger className="select-select">
          <BaseSelect.Value className="select-value_primary">{formatValue}</BaseSelect.Value>
          <BaseSelect.Icon className="select-select_icon">
            <NavArrowDown />
          </BaseSelect.Icon>
        </BaseSelect.Trigger>
        <BaseSelect.Portal>
          <BaseSelect.Positioner className="select-positioner">
            <BaseSelect.Popup className="select-popup">
              <BaseSelect.ScrollUpArrow className="select-scroll_arrow" />
              <BaseSelect.List className="select-list">{children}</BaseSelect.List>
              <BaseSelect.ScrollDownArrow className="select-scroll_arrow" />
            </BaseSelect.Popup>
          </BaseSelect.Positioner>
        </BaseSelect.Portal>
      </BaseSelect.Root>
    </div>
  );
}

export interface SelectItemProps {
  value: string;
  children: React.ReactNode;
  disabled?: boolean;
}

export function SelectItem({ value, children, disabled }: SelectItemProps) {
  return (
    <BaseSelect.Item value={value} className="select-item" disabled={disabled}>
      <BaseSelect.ItemIndicator className="select-item_indicator">
        <Check className="select-item_indicator_icon" />
      </BaseSelect.ItemIndicator>
      <BaseSelect.ItemText className="select-item_text">
        <span className="select-item_label">{children}</span>
      </BaseSelect.ItemText>
    </BaseSelect.Item>
  );
}
