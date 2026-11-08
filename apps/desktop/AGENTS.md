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

## Invariants

- The canvas is the app: no sidebars. Chrome floats at the corners; the selection's controls ride
  with it. Floating surfaces own the wheel and pinch over them (`look::own_gestures`).
- Entities are laid out at their screen rects from `App::cam`. Don't move the camera through
  element transforms (`scale`, `offset`) or `Live` values: native windows draw those differently
  from layout, and the media drifts away from the UI and the pointer.
- Effects run in media pixels, as the web app's do: spatial params scale by render size over
  native size. Processed textures re-render only when `process::key` changes.
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
