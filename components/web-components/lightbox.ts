import type { ThunkSync } from "#types/index.ts";

// Fallback for browsers without View Transitions
const transition = (callback: ThunkSync) => {
  if (!document.startViewTransition) {
    callback();
    return { finished: Promise.resolve() };
  }
  return document.startViewTransition(callback);
};

class AppLightbox extends HTMLElement {
  static observedAttributes = ["src", "alt", "loading", "close-button"];

  #controller: AbortController | undefined;
  #dialog: HTMLDialogElement | null = null;
  #image: HTMLImageElement | null = null;
  #closeButton: HTMLButtonElement | null = null;
  #imageLoaded = false;

  connectedCallback() {
    this.attachShadow({ mode: "open" });
    this.#controller = new AbortController();
    this.#render();
    this.#setupEventListeners(this.#controller.signal);

    // Set initial data attributes
    this.dataset.open = "false";
    if (this.hasAttribute("close-button")) {
      this.dataset.closeButton = "";
    }

    // Eager loading if specified
    if (this.getAttribute("loading") === "eager") {
      this.#loadImage();
    }
  }

  disconnectedCallback() {
    this.#controller?.abort();
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue === newValue) return;

    if (name === "close-button") {
      if (newValue !== null) {
        this.dataset.closeButton = "";
      } else {
        delete this.dataset.closeButton;
      }
    }
  }

  #render() {
    this.shadowRoot!.innerHTML = /* html */ `
    <style>
        :host {
            display: block;
            --dialog-shadow:
                0px 0px 3.5px rgba(0, 0, 0, 0.04),
                0px 0px 10px rgba(0, 0, 0, 0.04),
                0px 0px 24px rgba(0, 0, 0, 0.05),
                0px 0px 80px rgba(0, 0, 0, 0.08);
        }

        .trigger {
            all: unset;
            display: block;
            cursor: zoom-in;
            -webkit-user-select: none;
            user-select: none;
            touch-action: manipulation;
        }

        .trigger:focus-visible {
            outline: 1px solid var(--border, currentColor);
            outline-offset: 2px;
            border-radius: var(--radius);
        }

        dialog {
            border: none;
            padding: 0;
            background: transparent;
            max-width: 90vw;
            max-height: 90vh;
            overflow: visible;
            border-radius: var(--radius);
        }

        dialog::backdrop {
            background: oklch(0% 0 0 / 0.1);
            backdrop-filter: blur(8px);
            opacity: 0;
            transition:
                opacity 200ms ease-out,
                overlay 200ms ease-out allow-discrete,
                display 200ms ease-out allow-discrete;
        }

        dialog[open]::backdrop {
            opacity: 1;
            cursor: zoom-out;

            @starting-style {
            opacity: 0;
          }
        }


        dialog[open]:focus-visible {
            outline: 1px solid var(--border);
        }

        @starting-style {
            dialog[open]::backdrop {
            opacity: 0;
            }
        }

        .image {
            display: block;
            max-width: 90vw;
            max-height: 90vh;
            width: auto;
            height: auto;
            object-fit: contain;
            border-radius: var(--radius);
            cursor: zoom-out;
            box-shadow: var(--dialog-shadow);
        }

        .close {
            display: none;
            position: absolute;
            top: -12px;
            right: -12px;
            width: 32px;
            height: 32px;
            border-radius: 50%;
            border: none;
            background: var(--background);
            color: var(--color);
            font-size: 18px;
            line-height: 1;
            cursor: pointer;
            align-items: center;
            justify-content: center;
            box-shadow: 0 2px 8px oklch(0% 0 0 / 0.2);
            transition: transform 150ms ease-out, background 150ms ease-out;
        }

        :host([data-close-button]) .close {
            display: flex;
        }

        .close:hover {
            transform: scale(1.1);
            background: var(--accent);
        }

        .close:focus-visible {
            outline: 2px solid var(--primary, currentColor);
            outline-offset: 2px;
        }
    </style>
    <button class="trigger" aria-haspopup="dialog">
        <slot></slot>
    </button>

    <dialog class="lightbox-dialog">
        <img class="image" part="image" />
        <button class="close" aria-label="Close">&times;</button>
    </dialog>
    `;

    this.#dialog = this.shadowRoot!.querySelector("dialog");
    this.#image = this.shadowRoot!.querySelector("img");
    this.#closeButton = this.shadowRoot!.querySelector(".close");
  }

  #setupEventListeners(signal: AbortSignal) {
    const trigger = this.shadowRoot!.querySelector(".trigger");
    trigger?.addEventListener("click", () => this.#open(), { signal });

    this.#closeButton?.addEventListener("click", () => this.#close(), { signal });

    // Close on backdrop click (fallback for older browsers)
    this.#dialog?.addEventListener(
      "click",
      (e) => {
        if (e.target === this.#dialog) {
          this.#close();
        }
      },
      { signal },
    );

    // Intercept cancel (Escape key) to run transition first
    this.#dialog?.addEventListener(
      "cancel",
      (e) => {
        e.preventDefault();
        this.#close();
      },
      { signal },
    );

    // close on image click
    this.#image?.addEventListener("click", () => this.#close(), { signal });
  }

  #onScroll = () => {
    this.#close();
  };

  get #thumbnailImg(): HTMLImageElement | null {
    const slot = this.shadowRoot!.querySelector("slot");
    const assigned = slot?.assignedElements() ?? [];
    for (const el of assigned) {
      const img = el.querySelector("img") ?? (el instanceof HTMLImageElement ? el : null);
      if (img) return img;
    }
    return null;
  }

  get #prefersReducedMotion(): boolean {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  #open() {
    if (!this.#dialog || !this.#image) return;

    this.#loadImage();

    const thumbnail = this.#thumbnailImg;

    if (!this.#prefersReducedMotion && thumbnail) {
      thumbnail.style.viewTransitionName = "lightbox-image";

      transition(() => {
        thumbnail.style.viewTransitionName = "";
        this.dataset.transitioning = "image";
        this.#dialog?.showModal();
        this.dataset.open = "true";
      });
    } else {
      this.#dialog.showModal();
      this.dataset.open = "true";
    }

    window.addEventListener("scroll", this.#onScroll, { passive: true });
    this.dispatchEvent(new CustomEvent("lightbox-open", { bubbles: true }));
  }

  /** Public method to open the lightbox (for gallery coordination) */
  public open() {
    this.#open();
  }

  #close() {
    if (!this.#dialog) return;

    window.removeEventListener("scroll", this.#onScroll);

    const thumbnail = this.#thumbnailImg;

    if (!this.#prefersReducedMotion && thumbnail) {
      // Image already has view-transition-name via CSS (data-transitioning="image")
      transition(() => {
        delete this.dataset.transitioning;
        thumbnail.style.viewTransitionName = "lightbox-image";
        this.#dialog?.close();
        this.dataset.open = "false";
      })
        .finished.then(() => {
          thumbnail.style.viewTransitionName = "";
        })
        .catch(console.error);
    } else {
      this.#dialog.close();
      this.dataset.open = "false";
    }

    this.dispatchEvent(new CustomEvent("lightbox-close", { bubbles: true }));
  }

  /** Public method to close the lightbox (for gallery coordination) */
  public close() {
    this.#close();
  }

  #loadImage() {
    if (this.#imageLoaded || !this.#image) return;

    const src = this.getAttribute("src");
    const alt = this.getAttribute("alt") || "";
    const thumbnail = this.#thumbnailImg;

    if (!src) return;

    this.#image.alt = alt || thumbnail?.alt || "";

    if (thumbnail) {
      // Use currentSrc — the URL the browser actually loaded (respects <picture>/<source>)
      this.#image.src = thumbnail.currentSrc || thumbnail.src;

      // Set dimensions from thumbnail so the lightbox image isn't 0x0 while loading
      if (thumbnail.naturalWidth && thumbnail.naturalHeight) {
        this.#image.width = thumbnail.naturalWidth;
        this.#image.height = thumbnail.naturalHeight;
        this.#image.style.aspectRatio = `${thumbnail.naturalWidth} / ${thumbnail.naturalHeight}`;
      }

      const fullImage = new Image();
      fullImage.src = src;
      fullImage.onload = () => {
        if (this.#image) {
          this.#image.src = src;
          this.#image.width = fullImage.naturalWidth;
          this.#image.height = fullImage.naturalHeight;
          this.#image.style.aspectRatio = `${fullImage.naturalWidth} / ${fullImage.naturalHeight}`;
        }
      };
    } else {
      this.#image.src = src;
    }

    this.#imageLoaded = true;
  }
}

if (!customElements.get("app-lightbox")) {
  customElements.define("app-lightbox", AppLightbox);
}

export type { AppLightbox };
