//! Voidmesh on Rune: an infinite canvas of images, GIFs and SVGs, each with its own real-time GPU
//! effect (dithering, halftone, blobs, melt, ASCII, glass, glitch), adjustments and
//! post-processing. FEATURES.md maps the web app this follows.
//!
//!     cargo run -p voidmesh --release [-- files…]
//!     voidmesh --snap out.png --scene demo

mod effects;
mod export_video;
mod gfx;
mod hit;
mod keys;
mod media;
mod perf;
mod clip;
mod color;
mod palette;
mod prefs;
mod sandbox;
mod state;
mod store;
#[cfg(test)]
mod tests;
mod ui;
mod workspace;
mod video;

use std::path::PathBuf;

use rune::{AppSpec, Tx};

use state::App;

fn setup(s: &mut App, waker: rune::Waker) {
    s.loader.set_waker(waker);
    // Files given on a plain launch open on the canvas; tooling runs (`--snap` …) take none,
    // and keep their preferences in memory.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a.starts_with("--")) {
        return;
    }
    s.prefs = prefs::open();
    match store::LocalStore::open() {
        Some(st) => {
            let st: std::sync::Arc<dyn store::Store> = std::sync::Arc::new(st);
            sandbox::seed(st.as_ref());
            s.saver = Some(store::Saver::new(st.clone(), s.loader.clone()));
            s.store = Some(st);
        }
        None => s.toast("No data folder: workspaces won't be kept"),
    }
    prefs::load(s);
    let files: Vec<PathBuf> = args.into_iter().map(PathBuf::from).filter(|p| p.is_file()).collect();
    // A workspace among them opens; `import` routes it.
    if !files.is_empty() {
        s.import(files, None);
    }
}

fn poll(s: &mut App, t: f64, tx: &mut Tx) -> bool {
    let dt = if s.now > 0.0 { (t - s.now).clamp(0.0, 0.25) } else { 0.0 };
    s.now = t;
    let mut changed = false;

    for d in s.loader.drain() {
        s.receive(d);
        changed = true;
    }
    for done in s.loader.drain_workspaces() {
        match done {
            media::WorkspaceDone::Loaded { tab, imported, result } => s.receive_workspace(&tab, imported, result),
            media::WorkspaceDone::Exported(path, r) => s.exported_workspace(path, r),
        }
        changed = true;
    }
    if let Some(wait) = s.autosave() {
        tx.wake_after(std::time::Duration::from_secs_f64(wait.max(0.05)));
    }
    if s.loading().is_some() {
        // Progress shows in the chrome while a workspace reads.
        tx.wake_after(std::time::Duration::from_millis(100));
        changed = true;
    }
    for png in s.loader.drain_clipboard() {
        match rune::ClipboardImage::from_png(png) {
            Some(img) => {
                tx.copy_rich(rune::ClipboardContent::default().with_image(img));
                s.toast("Image copied to clipboard");
            }
            None => s.toast("Copy failed"),
        }
        changed = true;
    }
    for msg in s.loader.drain_notices() {
        s.toast(msg);
        changed = true;
    }
    changed |= export_video::poll(s, tx);
    // A slider's value field that lost focus keeps what was typed. Rune reports focus through
    // the field's model alone, so an open field keeps polling until it's seen to go.
    if s.value_target.is_some() {
        if s.value_edit.focused {
            tx.wake_after(std::time::Duration::from_millis(100));
        } else {
            s.commit_value();
            changed = true;
        }
    }

    if s.tick(dt) {
        changed = true;
    }
    s.sync_audio();
    let source = ui::inspector::time_source(s);
    changed |= ui::tick_slider::step(s, t, tx, &ui::tick_slider::TickSpec::TIME, ui::inspector::TIME_HOOKS, source);
    if s.step_zoom(dt) {
        tx.instant();
        changed = true;
    }
    if s.step_camera() {
        tx.instant();
        changed = true;
    }
    if s.perf.refresh() {
        changed = true;
    }
    if s.perf.settling() {
        tx.wake_after(std::time::Duration::from_secs_f64(perf::REFRESH));
    }
    let before = s.toasts.len();
    let now = s.now;
    s.toasts.retain(|t| t.until > now);
    if s.toasts.len() != before {
        changed = true;
    }
    if let Some(t) = s.toasts.iter().map(|t| t.until).reduce(f64::min) {
        tx.wake_after(std::time::Duration::from_secs_f64((t - now).max(0.05)));
    }
    changed
}

fn demo(s: &mut App) {
    // A deterministic scene for headless snapshots: a gradient image with the default effect
    // next to the same image as halftone.
    let (w, h) = (480u32, 320u32);
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
            let d = ((u - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt();
            px.extend_from_slice(&[(255.0 * u) as u8, (255.0 * (1.0 - d * 1.6).max(0.0)) as u8, (255.0 * v) as u8, 255]);
        }
    }
    let mk = |id: u64, name: &str| std::sync::Arc::new(media::rgba_asset(id, name, w, h, px.clone()));
    s.cam.set([40.0, 120.0], 0.5);
    s.place(vec![mk(1, "gradient.png")], [240.0, 160.0], false);
    s.place(vec![mk(2, "halftone.png")], [880.0, 160.0], false);
    s.next_id = 3;
    s.selection = [2].into_iter().collect();
    s.edit(|p| p.set_shader(effects::Shader::Halftone));
    s.undo.clear();
}

/// Headless: open the files in `VOIDMESH_OPEN` (path-list) synchronously, so `--snap` can render
/// real workspaces and media: `VOIDMESH_OPEN=a.vdmsh voidmesh --snap out.png --scene open --at 2`.
/// Workspace media goes to a scratch store in the temp folder.
fn open_scene(s: &mut App) {
    s.canvas = [0.0, 0.0, 1280.0, 820.0];
    s.settings = std::env::var_os("VOIDMESH_SETTINGS").is_some();
    let Some(list) = std::env::var_os("VOIDMESH_OPEN") else { return };
    let mut assets = Vec::new();
    for p in std::env::split_paths(&list) {
        if workspace::is_workspace(&p) {
            let st = store::LocalStore::new(std::env::temp_dir().join("voidmesh-headless"));
            let r = workspace::read_zip(&p, &st, &workspace::Progress::default());
            let tab = s.tab().id.clone();
            s.receive_workspace(&tab, true, r);
            if std::env::var_os("VOIDMESH_FIT").is_some() {
                s.select_all();
                if let Some(b) = s.bounds(&s.selection.clone()) {
                    s.fit(b);
                    if let Some(a) = s.cam.anim.take() {
                        s.cam.set(a.to.0, a.to.1);
                    }
                }
            }
        } else {
            match media::decode_file(media::next_asset_id(), &p) {
                Ok(a) => assets.push(std::sync::Arc::new(a)),
                Err(e) => eprintln!("{e}"),
            }
        }
    }
    if !assets.is_empty() {
        let c = s.cam.world([640.0, 410.0]);
        s.place(assets, c, true);
    }
    // `VOIDMESH_PICK=i`: the first entity selected, its palette colour `i` in the picker.
    if let Some(i) = std::env::var("VOIDMESH_PICK").ok().and_then(|v| v.parse().ok())
        && let Some(id) = s.entities.first().map(|e| e.id)
    {
        s.select_only(id);
        s.open_picker(i);
    }
}

/// The web app's face is `ui-rounded`: on macOS the system's SF Rounded, which ships in the OS
/// rather than with the app, so it's read at launch. Elsewhere (no such file) the UI falls back to
/// Inter, Rune's bundled face.
fn fonts() -> (&'static [&'static [u8]], &'static str) {
    const MONO: &[u8] = include_bytes!("../assets/fonts/IBMPlexMono-Medium.ttf");
    match std::fs::read("/System/Library/Fonts/SFNSRounded.ttf") {
        Ok(rounded) => {
            let rounded: &'static [u8] = Box::leak(rounded.into_boxed_slice());
            (Box::leak(vec![rounded, MONO].into_boxed_slice()), ".SF NS Rounded")
        }
        Err(_) => (
            Box::leak(
                vec![
                    include_bytes!("../assets/fonts/Inter-Regular.ttf").as_slice(),
                    include_bytes!("../assets/fonts/Inter-Medium.ttf").as_slice(),
                    include_bytes!("../assets/fonts/Inter-SemiBold.ttf").as_slice(),
                    MONO,
                ]
                .into_boxed_slice(),
            ),
            "Inter",
        ),
    }
}

fn main() {
    sandbox::enter();
    let (fonts, ui) = fonts();
    let app = rune::App::new(AppSpec::<App> {
        min_size: Some((720.0, 480.0)),
        scenes: &[("demo", demo), ("open", open_scene)],
        fonts,
        families: (ui, "IBM Plex Mono"),
        setup: Some(setup),
        poll: Some(poll),
        on_key: Some(keys::on_key),
        ..AppSpec::new("Voidmesh", (1280.0, 820.0), App::default, ui::view)
    })
    // The canvas runs under a transparent titlebar band the app draws; the traffic lights sit in
    // it, and `Cx::chrome_insets` says how much they take.
    .titlebar(rune::Titlebar::new(state::TITLEBAR))
    // Save what changed before the app goes.
    .on_quit(|s: &mut App, _| s.flush())
    .compositor(gfx::Gfx::default());
    app.run();
}
