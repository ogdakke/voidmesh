import { useState, type PointerEvent } from "react";
import { useCanvasInteraction } from "#context/use-canvas.ts";
import type {
  InfiniteCanvasRenderer,
  MinimapConfig,
  ViewportLensDistortionConfig,
} from "#renderer/canvas-renderer.ts";
import { Checkbox } from "#ui/checkbox/checkbox.tsx";
import { Slider } from "#ui/slider/index.tsx";
import "./viewport-lens-controls.css";

type ControlsTab = "viewport" | "minimap";

export default function ViewportLensControls({
  renderer,
  darkTheme,
}: {
  renderer: InfiniteCanvasRenderer;
  darkTheme: boolean;
}) {
  const interaction = useCanvasInteraction();
  const [lensConfig, setLensConfig] = useState<ViewportLensDistortionConfig>(
    renderer.viewPortLensConfig,
  );
  const [minimapConfig, setMinimapConfig] = useState<MinimapConfig>(renderer.minimapConfig);
  const [activeTab, setActiveTab] = useState<ControlsTab>("viewport");
  const [position, setPosition] = useState({ x: 18, y: 76 });
  const [drag, setDrag] = useState<{
    pointerId: number;
    originX: number;
    originY: number;
    startX: number;
    startY: number;
  } | null>(null);

  const updateLensConfig = (updates: Partial<ViewportLensDistortionConfig>) => {
    const next: ViewportLensDistortionConfig = { ...lensConfig, ...updates };
    setLensConfig(next);
    renderer?.setViewportLensDistortion(next);
    interaction.markContainerDirty();
  };

  const updateMinimapConfig = (updates: Partial<MinimapConfig>) => {
    const next: MinimapConfig = { ...minimapConfig, ...updates };
    setMinimapConfig(next);
    renderer.setMinimapConfig(next);
    canvasStore.setContainerDirty();
  };

  const handlePanelPointerDown = (event: PointerEvent) => {
    event.stopPropagation();
  };

  const handleDragPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrag({
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      startX: position.x,
      startY: position.y,
    });
  };

  const handleDragPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    setPosition({
      x: Math.max(8, drag.startX + event.clientX - drag.originX),
      y: Math.max(8, drag.startY + event.clientY - drag.originY),
    });
  };

  const handleDragPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.stopPropagation();
    setDrag(null);
  };

  return (
    <section
      className="viewport-lens-controls"
      aria-label="Viewport lens distortion controls"
      onPointerDown={handlePanelPointerDown}
      style={{ transform: `translate3d(${position.x}px, ${position.y}px, 0)` }}
    >
      <div
        className="viewport-lens-controls__handle"
        onPointerDown={handleDragPointerDown}
        onPointerMove={handleDragPointerMove}
        onPointerUp={handleDragPointerUp}
        onPointerCancel={handleDragPointerUp}
      >
        <span>Lens debug</span>
        <span className="viewport-lens-controls__hint">drag</span>
      </div>

      <div className="viewport-lens-controls__tabs" role="tablist" aria-label="Lens debug target">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "viewport"}
          data-active={activeTab === "viewport" || undefined}
          onClick={() => setActiveTab("viewport")}
        >
          Viewport
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "minimap"}
          data-active={activeTab === "minimap" || undefined}
          onClick={() => setActiveTab("minimap")}
        >
          Minimap
        </button>
      </div>

      {activeTab === "viewport" ? (
        <>
          <Checkbox
            switch
            checked={lensConfig.enabled}
            onChange={(event) => updateLensConfig({ enabled: event.target.checked })}
          >
            Edge warp
          </Checkbox>

          <Slider
            name="viewport-lens-strength"
            label="Roll"
            min={0}
            max={10}
            step={0.01}
            value={lensConfig.strength}
            showValue
            onValueChange={(value) => updateLensConfig({ strength: value })}
          />
          <Slider
            name="viewport-lens-radius"
            label="Edge width"
            min={0}
            max={0.9}
            step={0.01}
            value={lensConfig.radius}
            showValue
            onValueChange={(value) => updateLensConfig({ radius: value })}
          />
          <Slider
            name="viewport-lens-falloff"
            label="Falloff"
            min={0.01}
            max={10}
            step={0.01}
            value={lensConfig.falloff}
            showValue
            onValueChange={(value) => updateLensConfig({ falloff: value })}
          />
          <Slider
            name="viewport-lens-dispersion"
            label="Dispersion"
            min={0}
            max={2}
            step={0.01}
            value={lensConfig.dispersion}
            showValue
            onValueChange={(value) => updateLensConfig({ dispersion: value })}
          />
          <Slider
            name="viewport-lens-scale"
            label="Stretch"
            min={0}
            max={10}
            step={0.01}
            value={lensConfig.scale}
            showValue
            onValueChange={(value) => updateLensConfig({ scale: value })}
          />
          <Slider
            name="viewport-lens-reflection"
            label="Reflection"
            min={0}
            max={1}
            step={0.01}
            value={lensConfig.reflectionIntensity}
            showValue
            onValueChange={(value) => updateLensConfig({ reflectionIntensity: value })}
          />
          <Slider
            name="viewport-lens-reflection-focus"
            label="Focus"
            min={0}
            max={1}
            step={0.01}
            value={lensConfig.reflectionFocus}
            showValue
            onValueChange={(value) => updateLensConfig({ reflectionFocus: value })}
          />
          <Slider
            name="viewport-lens-occlusion"
            label="Occlusion"
            min={0}
            max={1}
            step={0.01}
            value={lensConfig.occlusion}
            showValue
            onValueChange={(value) => updateLensConfig({ occlusion: value })}
          />
          <Slider
            name="viewport-lens-vignette-light"
            label={darkTheme ? "Vignette · light" : "Vignette · light active"}
            min={0}
            max={1}
            step={0.01}
            value={lensConfig.vignetteLight}
            showValue
            onValueChange={(value) => updateLensConfig({ vignetteLight: value })}
          />
          <Slider
            name="viewport-lens-vignette-dark"
            label={darkTheme ? "Vignette · dark active" : "Vignette · dark"}
            min={0}
            max={1}
            step={0.01}
            value={lensConfig.vignetteDark}
            showValue
            onValueChange={(value) => updateLensConfig({ vignetteDark: value })}
          />
        </>
      ) : (
        <>
          <Checkbox
            switch
            checked={minimapConfig.enabled}
            onChange={(event) => updateMinimapConfig({ enabled: event.target.checked })}
          >
            Show minimap
          </Checkbox>

          <Slider
            name="minimap-width"
            label="Width"
            min={80}
            max={320}
            step={1}
            value={minimapConfig.width}
            showValue
            onValueChange={(value) => updateMinimapConfig({ width: value })}
          />
          <Slider
            name="minimap-height"
            label="Height"
            min={80}
            max={320}
            step={1}
            value={minimapConfig.height}
            showValue
            onValueChange={(value) => updateMinimapConfig({ height: value })}
          />
          <Slider
            name="minimap-border-radius"
            label="Corner radius"
            min={0}
            max={180}
            step={1}
            value={minimapConfig.borderRadius}
            showValue
            onValueChange={(value) => updateMinimapConfig({ borderRadius: value })}
          />
          <Slider
            name="minimap-margin"
            label="Margin"
            min={0}
            max={80}
            step={1}
            value={minimapConfig.margin}
            showValue
            onValueChange={(value) => updateMinimapConfig({ margin: value })}
          />
          <Slider
            name="minimap-backdrop-scale"
            label="Backdrop scale"
            min={0.1}
            max={1}
            step={0.01}
            value={minimapConfig.backdropScale}
            showValue
            onValueChange={(value) => updateMinimapConfig({ backdropScale: value })}
          />
          <Slider
            name="minimap-backdrop-blur"
            label="Backdrop blur"
            min={0}
            max={4}
            step={0.01}
            value={minimapConfig.backdropBlur}
            showValue
            onValueChange={(value) => updateMinimapConfig({ backdropBlur: value })}
          />
          <Slider
            name="minimap-map-opacity"
            label="Map pane"
            min={0}
            max={1}
            step={0.01}
            value={minimapConfig.mapOpacity}
            showValue
            onValueChange={(value) => updateMinimapConfig({ mapOpacity: value })}
          />
          <Slider
            name="minimap-entity-opacity"
            label="Entity opacity"
            min={0}
            max={1}
            step={0.01}
            value={minimapConfig.entityOpacity}
            showValue
            onValueChange={(value) => updateMinimapConfig({ entityOpacity: value })}
          />
          <Slider
            name="minimap-strength"
            label="Roll"
            min={0}
            max={10}
            step={0.01}
            value={minimapConfig.strength}
            showValue
            onValueChange={(value) => updateMinimapConfig({ strength: value })}
          />
          <Slider
            name="minimap-edge-width"
            label="Edge width"
            min={0.01}
            max={3}
            step={0.01}
            value={minimapConfig.edgeWidth}
            showValue
            onValueChange={(value) => updateMinimapConfig({ edgeWidth: value })}
          />
          <Slider
            name="minimap-falloff"
            label="Falloff"
            min={0.01}
            max={10}
            step={0.01}
            value={minimapConfig.falloff}
            showValue
            onValueChange={(value) => updateMinimapConfig({ falloff: value })}
          />
          <Slider
            name="minimap-dispersion"
            label="Dispersion"
            min={0}
            max={2}
            step={0.01}
            value={minimapConfig.dispersion}
            showValue
            onValueChange={(value) => updateMinimapConfig({ dispersion: value })}
          />
          <Slider
            name="minimap-scale"
            label="Stretch"
            min={0}
            max={4}
            step={0.01}
            value={minimapConfig.scale}
            showValue
            onValueChange={(value) => updateMinimapConfig({ scale: value })}
          />
          <Slider
            name="minimap-reflection"
            label="Reflection"
            min={0}
            max={1}
            step={0.01}
            value={minimapConfig.reflectionIntensity}
            showValue
            onValueChange={(value) => updateMinimapConfig({ reflectionIntensity: value })}
          />
          <Slider
            name="minimap-reflection-focus"
            label="Focus"
            min={0}
            max={1}
            step={0.01}
            value={minimapConfig.reflectionFocus}
            showValue
            onValueChange={(value) => updateMinimapConfig({ reflectionFocus: value })}
          />
          <Slider
            name="minimap-occlusion"
            label="Occlusion"
            min={0}
            max={1}
            step={0.01}
            value={minimapConfig.occlusion}
            showValue
            onValueChange={(value) => updateMinimapConfig({ occlusion: value })}
          />
          <Slider
            name="minimap-vignette"
            label="Vignette"
            min={0}
            max={1}
            step={0.01}
            value={minimapConfig.vignette}
            showValue
            onValueChange={(value) => updateMinimapConfig({ vignette: value })}
          />
        </>
      )}
    </section>
  );
}
