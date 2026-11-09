# Voidmesh desktop

Native port of the web app's core on Rune (Rust, wgpu). A standalone Cargo project: run Cargo from
this directory; Bun and the web tooling don't apply here. `FEATURES.md` is the porting reference
(web behavior, defaults and ranges) and tracks what's ported; update its status section when that
changes.

## Commands

- `cargo test` while iterating; `cargo clippy --all-targets` before handoff.
- `cargo run --release -- <files>`; `--snap out.png --scene demo` renders headless.
- `./install.sh` installs `~/Applications/Voidmesh.app` from Rune's own bundler.
- Unbundled runs (`cargo run`, `target/*/voidmesh`) are sandboxed: every Rune folder roots under
  `target/dev-data`, seeded with mock workspaces (`sandbox.rs`). Never drive the installed app or
  point a run at the user's real folders; delete `target/dev-data` to reseed.
- `VOIDMESH_TRACE_INPUT=1` logs canvas gestures and the camera; ask for this output before
  guessing at trackpad behavior, which headless runs can't reproduce.
- `./bench.sh [filter]` runs the web app's render benchmark scenarios on the compositor
  (`bench.rs`) and compares them with the latest web record; `VOIDMESH_TRACE_FRAME=1` logs each
  frame's compositor phases.

## Invariants

- The canvas is the app: no sidebars. Chrome floats at the corners; the selection's controls ride
  with it. Floating surfaces own the wheel and pinch over them (`look::own_gestures`).
- Every entity is drawn by the compositor in one world slot, through `App::cam`
  (`gfx/scene.rs`); UI riding with the selection reads `App::selection_bounds`. Don't move the
  camera through element transforms (`scale`, `offset`) or `Live` values: native windows draw
  those differently from layout, and the media drifts away from the UI and the pointer.
- Processed textures are materials keyed by asset, frame and params (never by entity), made at
  a preview LOD and shared by every entity showing them; export renders the native size. Effects
  run in media pixels, as the web app's do: spatial params scale by render size over native size.
- Canvases reach hundreds of thousands of entities: `Entities` is copy-on-write chunks (snapshots
  are cheap, the compositor diffs chunks by identity), `Selection` carries a revision, and
  per-entity work happens only where something changed. A drag moves the selection by an offset
  and commits positions once it ends.
- The frame never waits on bulk work: uploads go through the scene's staging sets (Rune pins a
  buffer queue-written while the GPU reads it, and allocates on every later write), and source
  levels read from full-size pixels are built off the frame.
- `effects.rs` mirrors the web app's `ShaderParams`, defaults and per-shader resets; keep ranges
  and labels in step with `lib/config/index.ts`.
- UI uses the web app's tokens (`ui/look.rs`) and primitive shapes (`ui/widgets.rs`).
- No popup windows: settings, pickers and panels live inside the main window.
- `.vdmsh` stays compatible with the web app both ways (`workspace.rs` reads v1–v7, writes v7).
- Workspaces live behind the `Store` trait (`store.rs`): documents with UUIDs, media by SHA-256.
  UI and state never touch the data folder directly; a synced store implements the same trait.
- User palettes and undo: palettes are part of undo snapshots; preferences go through
  `prefs.rs` (tests and headless runs keep them in memory).
- Rune is pinned to a `dev` revision in `Cargo.toml`; move it forward deliberately, with
  `rust-toolchain.toml` matching that revision.
