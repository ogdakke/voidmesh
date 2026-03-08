import { type ReactNode } from "react";
import { Image } from "#ui/image.tsx";
import houseBurning from "../../media/house_burning_ascii.webp?img";
import "./about.css";

export function AboutSection({ children, id }: { children?: ReactNode; id?: string }) {
  return (
    <section className="about-section" id={id}>
      <div className="about-hero">
        <h1>
          <img src="/favicon.webp" alt="" width={32} height={32} className="about-logo" />
          Voidmesh
        </h1>
        <p className="about-tagline">
          Apply dithering, halftone, ASCII and more effects to videos, GIFs, and images. Everything
          runs locally in your browser—nothing gets uploaded.
        </p>
      </div>
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
          <dd>A living, breathing, turbulent glass</dd>
        </div>
      </dl>
      {children}
    </section>
  );
}

export function Footer() {
  return (
    <footer className="about-footer">
      <p>
        Made by{" "}
        <a href="https://x.com/ogdakke" target="_blank">
          Daniel
        </a>
        {" · "}
        <a href="https://github.com/ogdakke/voidmesh" target="_blank">
          Source
        </a>
      </p>
    </footer>
  );
}

export function FeatureSection({ id }: { id?: string }) {
  return (
    <section className="about-section" id={id}>
      <h2>Features</h2>
      <ul className="about-features">
        <li>
          <strong>Any media</strong>
          <span>Videos, images, GIFs, and SVGs</span>
        </li>
        <li>
          <strong>Color palettes</strong>
          <span>Game Boy, CGA, sepia, or extract from any image</span>
        </li>
        <li>
          <strong>Post-processing</strong>
          <span>Film grain, bloom, chromatic aberration</span>
        </li>
        <li>
          <strong>Export</strong>
          <span>MP4, MOV, or GIF</span>
        </li>
        <li>
          <strong>Save &amp; resume</strong>
          <span>Save your canvas to a file, continue later</span>
        </li>
      </ul>
    </section>
  );
}
