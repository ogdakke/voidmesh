# Voidmesh desktop

A native desktop port of the core of Voidmesh, built with [Rune](https://github.com/anomalyco/rune)
(Rust, wgpu): an infinite canvas of images, videos, GIFs and SVGs, each with its own real-time
GPU effect, saved as `.vdmsh` workspaces the web app opens too. `FEATURES.md` maps the web app (the rest of this repo) and tracks what's ported.

Run from this directory:

```sh
cargo run --release [-- photo.jpg clip.gif logo.svg]
cargo test
target/release/voidmesh --snap out.png --scene demo --size 1280x820 --scale 2   # headless
./install.sh   # builds and installs ~/Applications/Voidmesh.app; run again to swap in a rebuild
VOIDMESH_TRACE_INPUT=1 ~/Applications/Voidmesh.app/Contents/MacOS/voidmesh     # log canvas gestures
VOIDMESH_OPEN=work.vdmsh VOIDMESH_FIT=1 target/release/voidmesh --snap out.png --scene open --at 2   # render real files headless
```

Runs outside the installed `.app` keep their workspaces and preferences in `target/dev-data`,
seeded with mock workspaces, so development never touches your own. Delete it to reseed.

Rune is pre-release, so `Cargo.toml` pins a revision of its `dev` branch; move it forward on
purpose. `rust-toolchain.toml` matches that Rune revision's toolchain.

The canvas is the app: the window is the canvas, and everything else floats on it. Chrome sits at
the corners, and the selection carries its own controls: a label bar above it, the inspector
beside it, and playback on the GIF itself.

## How it's built

- `state.rs`: entities, camera, selection, undo (snapshots, 100 deep), placement and commands.
- `effects.rs`: the web app's `ShaderParams`, with its defaults, ranges and per-shader resets.
- `media.rs`: decoding on worker threads (PNG, JPEG, WebP, BMP, animated GIF, SVG via resvg);
  assets keep their original bytes for saving. `video.rs`: AVFoundation probing and a
  streaming decoder per video entity (macOS).
- `workspace.rs`: `.vdmsh` read/write, the web's format. `prefs.rs`: persisted preferences.
- `clip.rs`: clipboard (image, effects JSON, paste). `palette.rs`: k-means palette extraction.
  `color.rs`: OKLCH and hex for the colour picker.
- `gfx/`: the compositor. Each entity is an `El::effect` slot laid out at its screen rect from the
  camera (no element transform, so what's drawn is exactly the model). `process.rs` runs the web
  app's pipeline in media pixels (adjustments, dual-Kawase blur, the effect, bloom, grain and
  chromatic aberration) into a mipmapped texture, only when its inputs change. `mod.rs` draws
  those textures, the dot grid and canvas lensing at their slots. `export.rs` reads a processed
  texture back and writes a PNG or JPEG.
- `shaders/process.wgsl`: ports of the web shaders (halftone, blobs, melt, dithering, ASCII, glass
  ×3, glitch ×4). `shaders/composite.wgsl`: entity, grid and lens drawing.
- `ui/`: the view, styled with the web app's tokens (`look.rs`) and primitives (`widgets.rs`);
  `settings.rs` (the in-window settings view), `menu.rs` (context menu), `palette_editor.rs`
  (palette editor and colour picker), `tick_slider.rs` (the Time control).
- `assets/fonts/`: Inter (the fallback face where the system's SF Rounded is missing) and IBM
  Plex Mono, both under the OFL (licences beside them).
