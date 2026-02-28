import { type ReactNode } from "react";
import { Image } from "#ui/image.tsx";
import houseBurning from "../../media/house_burning_ascii.webp?img";
import "./about.css";

export function AboutSection({ children }: { children?: ReactNode }) {
  return (
    <section className="about-section">
      <h1>Voidmesh</h1>
      <p>
        Apply dithering, halftone, ASCII and more effects to videos, GIFs, and images. Everything
        runs locally in your browser—nothing gets uploaded.
      </p>
      <Image {...houseBurning} alt="Burning house ASCII" />
      <h2>Effects</h2>
      <dl className="about__effects">
        <div>
          <dt>Dithering</dt>
          <dd>Retro pixel patterns with limited colors</dd>
        </div>
        <div>
          <dt>Halftone</dt>
          <dd>Dot patterns like comic books or newsprint</dd>
        </div>
        <div>
          <dt>ASCII</dt>
          <dd>Convert to text characters</dd>
        </div>
        <div>
          <dt>Blobs</dt>
          <dd>Liquid, organic shapes</dd>
        </div>
        <div>
          <dt>Melt</dt>
          <dd>Dripping, melted look</dd>
        </div>
        <div>
          <dt>Fluted Glass</dt>
          <dd>Lines with refraction and caustics</dd>
        </div>
        <div>
          <dt>Frosted Glass</dt>
          <dd>Frosty, blurred glass</dd>
        </div>
        <div>
          <dt>Flowing Glass</dt>
          <dd>(experimental) A living, breathing, turbulent glass</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}

export function Footer() {
  return (
    <footer>
      <p>
        Made by{" "}
        <a href="https://x.com/ogdakke" target="_blank">
          Daniel
        </a>
        .
        <br />
        Source code available on{" "}
        <a href="https://github.com/ogdakke/voidmesh" target="_blank">
          GitHub
        </a>
        .
      </p>
    </footer>
  );
}

export function FeatureSection() {
  return (
    <section className="about-section">
      <h1>Features</h1>
      <ul>
        <li>Works on videos, images, GIFs, and SVGs</li>
        <li>
          Color palettes—Game Boy, CGA, sepia, or extract from any image. Custom palettes are saved
          locally in your browser.
        </li>
        <li>Post-processing—film grain, bloom, chromatic aberration</li>
        <li>Export to MP4, MOV, or GIF</li>
        <li>Save your work to a file, and continue later</li>
      </ul>
    </section>
  );
}
