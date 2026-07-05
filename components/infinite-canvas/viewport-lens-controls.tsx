import { useState, type PointerEvent } from "react";
import { canvasStore } from "#engine";
import type {
  InfiniteCanvasRenderer,
  ViewportLensDistortionConfig,
} from "#renderer/canvas-renderer.ts";
import { Checkbox } from "#ui/checkbox/checkbox.tsx";
import { Slider } from "#ui/slider/index.tsx";
import "./viewport-lens-controls.css";

export function ViewportLensControls({ renderer }: { renderer: InfiniteCanvasRenderer }) {
  const [lensConfig, setLensConfig] = useState<ViewportLensDistortionConfig>(
    renderer.viewPortLensConfig,
  );
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
        <span>Viewport lens</span>
        <span className="viewport-lens-controls__hint">drag</span>
      </div>

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
        max={4}
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
        max={4}
        step={0.01}
        value={lensConfig.scale}
        showValue
        onValueChange={(value) => updateLensConfig({ scale: value })}
      />
      <Slider
        name="viewport-lens-highlight"
        label="Highlight"
        min={0}
        max={1}
        step={0.01}
        value={lensConfig.highlight}
        showValue
        onValueChange={(value) => updateLensConfig({ highlight: value })}
      />
      <Slider
        name="viewport-lens-gloss"
        label="Gloss"
        min={0}
        max={1}
        step={0.01}
        value={lensConfig.gloss}
        showValue
        onValueChange={(value) => updateLensConfig({ gloss: value })}
      />
    </section>
  );
}
