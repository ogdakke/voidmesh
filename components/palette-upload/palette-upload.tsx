import { useRef } from "react";
import { Palette } from "iconoir-react";
import { Button } from "../ui/button";

export interface PaletteUploadProps {
  onUpload: (files: FileList | null) => void;
  /** Visual variant - desktop is compact, mobile is full-width */
  variant?: "desktop" | "mobile";
}

/**
 * Component for uploading an image to extract a color palette from.
 */
export function PaletteUpload({ onUpload, variant = "desktop" }: PaletteUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  if (variant === "mobile") {
    return (
      <div className="mobile-palette-upload">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          onChange={(e) => onUpload(e.target.files)}
          hidden
        />
        <Button
          variant="primary"
          onClick={() => inputRef.current?.click()}
          className="mobile-palette-upload__button"
        >
          <Palette />
          <span>Extract Palette from Image</span>
        </Button>
      </div>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={(e) => onUpload(e.target.files)}
        hidden
      />
      <Button variant="quiet" size="sm" onClick={() => inputRef.current?.click()}>
        <Palette />
        <span>Extract Palette from Image</span>
      </Button>
    </>
  );
}
