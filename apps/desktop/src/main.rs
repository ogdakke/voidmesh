//! Voidmesh on Rune: an infinite canvas of images, GIFs and SVGs, each with its own real-time GPU
//! effect (dithering, halftone, blobs, melt, ASCII, glass, glitch), adjustments and
//! post-processing. FEATURES.md maps the web app this follows.
//!
//!     cargo run -p voidmesh --release [-- files…]
//!     voidmesh --snap out.png --scene demo

mod effects;
mod gfx;
mod keys;
mod media;
mod state;
#[cfg(test)]
mod tests;
mod ui;

use std::path::PathBuf;

use rune::{AppSpec, Tx};

use state::App;

fn setup(s: &mut App, waker: rune::Waker) {
    s.loader.set_waker(waker);
    // Files given on a plain launch open on the canvas; tooling runs (`--snap` …) take none.
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a.starts_with("--")) {
        return;
    }
    let files: Vec<PathBuf> = args.into_iter().map(PathBuf::from).filter(|p| p.is_file()).collect();
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
    for msg in s.loader.drain_notices() {
        s.toast(msg);
        changed = true;
    }

    if s.tick(dt) {
        changed = true;
    }
    if s.step_zoom(dt) {
        tx.instant();
        changed = true;
    }
    if s.step_camera() {
        tx.instant();
        changed = true;
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
    let mk = |id: u64, name: &str| {
        std::sync::Arc::new(media::Asset {
            id,
            name: name.into(),
            width: w,
            height: h,
            frames: vec![media::Frame { rgba: px.clone(), delay: std::time::Duration::ZERO }],
            duration: std::time::Duration::ZERO,
        })
    };
    s.cam.set([40.0, 120.0], 0.5);
    s.place(vec![mk(1, "gradient.png")], [240.0, 160.0], false);
    s.place(vec![mk(2, "halftone.png")], [880.0, 160.0], false);
    s.next_id = 3;
    s.selection = [2].into_iter().collect();
    s.edit(|p| p.set_shader(effects::Shader::Halftone));
    s.undo.clear();
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
    let (fonts, ui) = fonts();
    let app = rune::App::new(AppSpec::<App> {
        min_size: Some((720.0, 480.0)),
        scenes: &[("demo", demo)],
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
    .compositor(gfx::Gfx::default());
    app.run();
}
