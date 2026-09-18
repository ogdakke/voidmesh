import { useCanvasCommands, useCanvasPreferences } from "#context/use-canvas.ts";
import useMediaQuery from "#hooks/use-media-query.ts";
import lensingSpriteDark from "#media/lensing-preview-sprite-grain.png?img";
import lensingSpriteLight from "#media/lensing-preview-sprite-light-grain.png?img";
import lensingSpriteMobileDark from "#media/lensing-preview-mobile-sprite-grain.png?img";
import lensingSpriteMobileLight from "#media/lensing-preview-mobile-sprite-light-grain.png?img";
import { CanvasLensing } from "#types/enums.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import lensingSpriteDarkLqip from "./assets/lensing-preview-sprite-grain-lqip.webp?inline";
import lensingSpriteLightLqip from "./assets/lensing-preview-sprite-light-grain-lqip.webp?inline";
import lensingSpriteMobileDarkLqip from "./assets/lensing-preview-mobile-sprite-grain-lqip.webp?inline";
import lensingSpriteMobileLightLqip from "./assets/lensing-preview-mobile-sprite-light-grain-lqip.webp?inline";
import "./canvas-lensing-previews.css";

const LENSING_OPTIONS = [
  { value: CanvasLensing.off, label: "Off" },
  { value: CanvasLensing.subtle, label: "Subtle" },
  { value: CanvasLensing.extreme, label: "Extreme" },
] as const;

type ColorScheme = "dark" | "light";
type PreviewLayout = "desktop" | "mobile";
type PreviewAsset = `${PreviewLayout}-${ColorScheme}`;

const loadedLensingSprites = new Set<PreviewAsset>();

function scrollSelectedOptionIntoView(grid: HTMLDivElement | null, behavior: ScrollBehavior) {
  const selectedOption = grid?.querySelector<HTMLElement>("[data-selected]");
  if (!grid || !selectedOption || grid.scrollWidth <= grid.clientWidth) return;

  selectedOption.scrollIntoView({ behavior, block: "nearest", inline: "center" });
}

export function CanvasLensingPreviews({ layout = "desktop" }: { layout?: PreviewLayout }) {
  const { canvasLensing } = useCanvasPreferences();
  const { setCanvasLensing } = useCanvasCommands();
  const isDarkMode = useMediaQuery("(prefers-color-scheme: dark)");
  const colorScheme = isDarkMode ? "dark" : "light";
  const previewAsset: PreviewAsset = `${layout}-${colorScheme}`;
  const gridRef = useRef<HTMLDivElement>(null);
  const didMountRef = useRef(false);
  const [loadedAsset, setLoadedAsset] = useState<PreviewAsset | null>(() =>
    loadedLensingSprites.has(previewAsset) ? previewAsset : null,
  );
  const isSpriteLoaded = loadedAsset === previewAsset || loadedLensingSprites.has(previewAsset);

  const handleSpriteLoad = () => {
    loadedLensingSprites.add(previewAsset);
    setLoadedAsset(previewAsset);
  };

  useLayoutEffect(() => {
    scrollSelectedOptionIntoView(gridRef.current, "instant");
  }, []);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return;
    }

    scrollSelectedOptionIntoView(gridRef.current, "smooth");
  }, [canvasLensing]);

  return (
    <fieldset className="settings-lensing-previews">
      <legend>Canvas lensing</legend>
      <span className="settings-lensing-sprite-preloader" aria-hidden="true">
        <LensingSpritePicture full layout={layout} onLoad={handleSpriteLoad} />
      </span>
      <div ref={gridRef} className="settings-lensing-preview-grid fade-mask-x">
        {LENSING_OPTIONS.map(({ value, label }) => (
          <label
            className="settings-lensing-preview-option"
            key={value}
            data-selected={canvasLensing === value || undefined}
          >
            <input
              className="settings-lensing-preview-input"
              type="radio"
              name="canvas-lensing"
              value={value}
              checked={canvasLensing === value}
              onChange={() => setCanvasLensing(value)}
            />
            <div className="settings-lensing-preview" data-lensing={value}>
              <div className="settings-lensing-preview-glow" aria-hidden="true">
                <LensingSpritePicture full={false} layout={layout} />
              </div>
              <div
                className="settings-lensing-preview-surface"
                data-loaded={isSpriteLoaded || undefined}
              >
                <LensingSpritePicture full={isSpriteLoaded} layout={layout} />
              </div>
            </div>
            <span className="settings-lensing-preview-label">{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function LensingSpritePicture({
  full,
  layout,
  onLoad,
}: {
  full: boolean;
  layout: PreviewLayout;
  onLoad?: () => void;
}) {
  const isMobile = layout === "mobile";
  const darkLqip = isMobile ? lensingSpriteMobileDarkLqip : lensingSpriteDarkLqip;
  const lightLqip = isMobile ? lensingSpriteMobileLightLqip : lensingSpriteLightLqip;

  if (!full) {
    return (
      <picture>
        <source media="(prefers-color-scheme: light)" srcSet={lightLqip} />
        <img src={darkLqip} width={93} height={20} alt="" />
      </picture>
    );
  }

  const darkSprite = isMobile ? lensingSpriteMobileDark : lensingSpriteDark;
  const lightSprite = isMobile ? lensingSpriteMobileLight : lensingSpriteLight;
  const sizes = isMobile ? "456px" : "768px";

  return (
    <picture>
      {lightSprite.sources.map((source) => (
        <source
          key={source.type}
          media="(prefers-color-scheme: light)"
          srcSet={source.srcSet}
          sizes={sizes}
          type={source.type}
        />
      ))}
      <source media="(prefers-color-scheme: light)" srcSet={lightSprite.src} />
      {darkSprite.sources.map((source) => (
        <source key={source.type} srcSet={source.srcSet} sizes={sizes} type={source.type} />
      ))}
      <img
        src={darkSprite.src}
        width={darkSprite.width}
        height={darkSprite.height}
        sizes={sizes}
        alt=""
        decoding="async"
        onLoad={onLoad}
      />
    </picture>
  );
}
