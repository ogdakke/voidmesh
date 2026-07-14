import { ScaleFrameEnlarge } from "iconoir-react";
import { Drawer } from "#ui/drawer/index.tsx";
import { Button } from "#ui/button/button.tsx";
import { NativeSelect, NativeSelectOption } from "#ui/native-select/native-select.tsx";
import { useUpscaleQueue } from "#context/use-upscale-queue.ts";
import { useSelectedEntityIds } from "#context/use-canvas.ts";
import type { ModelSize, ContentVariant } from "#renderer/upscale/upscale-types.ts";
import type { ChangeEvent } from "react";
import "./upscale-drawer.css";

const MODEL_SIZE_OPTIONS = [
  { value: "s", label: "Fast" },
  { value: "m", label: "Balanced" },
  { value: "l", label: "Quality" },
];

const CONTENT_VARIANT_OPTIONS = [
  { value: "rl", label: "Photo" },
  { value: "an", label: "Anime" },
  { value: "3d", label: "3D Render" },
];

interface UpscaleDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UpscaleDrawer({ open, onOpenChange }: UpscaleDrawerProps) {
  const { addToUpscaleQueue, upscaleSettings, setUpscaleSettings } = useUpscaleQueue();
  const selectedEntityIds = useSelectedEntityIds();

  const handleUpscale = () => {
    const selectedIds = [...selectedEntityIds];
    if (selectedIds.length > 0) {
      addToUpscaleQueue(selectedIds);
    }
    onOpenChange(false);
  };

  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Popup className="upscale-drawer">
        <Drawer.Title>Upscale 2×</Drawer.Title>
        <Drawer.Content>
          <div className="upscale-drawer-settings">
            <div className="native-select-field native-select-field--mobile">
              <label className="select-label" htmlFor="mobile-upscale-model">
                Model
              </label>
              <NativeSelect
                id="mobile-upscale-model"
                value={upscaleSettings.size}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setUpscaleSettings({ size: e.target.value as ModelSize })
                }
                variant="quiet"
                name="upscale-model-size"
              >
                {MODEL_SIZE_OPTIONS.map(({ value, label }) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <p className="hint-text">Higher quality produces sharper details but takes longer</p>
            <div className="native-select-field native-select-field--mobile">
              <label className="select-label" htmlFor="mobile-upscale-content">
                Content
              </label>
              <NativeSelect
                id="mobile-upscale-content"
                value={upscaleSettings.variant}
                onChange={(e: ChangeEvent<HTMLSelectElement>) =>
                  setUpscaleSettings({ variant: e.target.value as ContentVariant })
                }
                variant="quiet"
                name="upscale-content-variant"
              >
                {CONTENT_VARIANT_OPTIONS.map(({ value, label }) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <p className="hint-text">Match this to your source material</p>
          </div>
          <div className="upscale-drawer-actions">
            <Button variant="primary" onClick={handleUpscale}>
              <ScaleFrameEnlarge />
              <span>Upscale</span>
            </Button>
          </div>
        </Drawer.Content>
      </Drawer.Popup>
    </Drawer.Root>
  );
}
