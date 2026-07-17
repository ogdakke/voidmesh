import type { AppGallery } from "#components/gallery.ts";
import type { AppLightbox } from "#components/lightbox.ts";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "app-gallery": React.DetailedHTMLProps<React.HTMLAttributes<AppGallery>, AppGallery>;
      "app-lightbox": React.DetailedHTMLProps<
        React.HTMLAttributes<AppLightbox> & { src: string },
        AppLightbox
      >;
    }
  }
}
