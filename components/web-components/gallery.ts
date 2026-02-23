import type { AppLightbox } from "./lightbox";

export class AppGallery extends HTMLElement {
  #controller: AbortController | undefined;
  #lightboxes: AppLightbox[] = [];
  #activeIndex = -1;

  connectedCallback() {
    this.#controller = new AbortController();
    this.#lightboxes = Array.from(this.querySelectorAll("app-lightbox")) as AppLightbox[];
    this.#setupEventListeners(this.#controller.signal);
  }

  disconnectedCallback() {
    this.#controller?.abort();
    window.removeEventListener("keydown", this.#onKeydown);
  }

  #setupEventListeners(signal: AbortSignal) {
    this.addEventListener("lightbox-open", this.#onLightboxOpen, { signal });
    this.addEventListener("lightbox-close", this.#onLightboxClose, { signal });
  }

  #onLightboxOpen = (e: Event) => {
    const target = e.target as AppLightbox;
    this.#activeIndex = this.#lightboxes.indexOf(target);
    window.addEventListener("keydown", this.#onKeydown);
  };

  #onLightboxClose = () => {
    this.#activeIndex = -1;
    window.removeEventListener("keydown", this.#onKeydown);
  };

  #onKeydown = (e: KeyboardEvent) => {
    if (this.#activeIndex === -1) return;

    if (e.key === "ArrowRight") {
      e.preventDefault();
      this.#navigate(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      this.#navigate(-1);
    }
  };

  #navigate(direction: 1 | -1) {
    const nextIndex = this.#activeIndex + direction;
    if (nextIndex < 0 || nextIndex >= this.#lightboxes.length) return;

    const current = this.#lightboxes[this.#activeIndex];
    const next = this.#lightboxes[nextIndex];

    if (!current || !next) return;

    current.close();
    next.open();
    this.#activeIndex = nextIndex;
  }
}

if (!customElements.get("app-gallery")) {
  customElements.define("app-gallery", AppGallery);
}
