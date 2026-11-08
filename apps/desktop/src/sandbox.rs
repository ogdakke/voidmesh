//! Development runs keep away from the user's workspaces and preferences.
//!
//! A binary outside an `.app` bundle (`cargo run`, `target/*/voidmesh`) roots every folder Rune
//! resolves (`RUNE_DIRS_ROOT`: data, config, cache, …) under `target/dev-data`, and that store
//! starts with a few generated workspaces. Only the installed app reads the real folders.
//! An explicit `RUNE_DIRS_ROOT` wins, so a run can point at another scratch root.

use std::path::PathBuf;
use std::sync::Arc;

use crate::effects::{Params, Shader, presets};
use crate::media;
use crate::store::{self, Doc, Store};
use crate::workspace::{Item, Viewport};

const ROOT_ENV: &str = "RUNE_DIRS_ROOT";

/// Call first in `main`, before any thread starts: the environment is read by Rune's dirs and
/// prefs from then on.
pub fn enter() {
    if std::env::var_os(ROOT_ENV).is_some() || bundled() {
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target").join("dev-data");
    // SAFETY: called at the top of `main`, while the process has one thread.
    unsafe { std::env::set_var(ROOT_ENV, &root) };
    eprintln!("voidmesh: dev run, data under {}", root.display());
}

fn bundled() -> bool {
    std::env::current_exe().is_ok_and(|p| p.ancestors().any(|a| a.extension().is_some_and(|e| e == "app")))
}

/// Fill an empty sandboxed store with mock workspaces. The real store is never touched.
pub fn seed(st: &dyn Store) {
    if !rune::dirs::AppDirs::new(media::APP_ID).is_some_and(|d| d.is_rooted()) || !st.list().is_ok_and(|l| l.is_empty()) {
        return;
    }
    for doc in mock_docs() {
        if let Err(e) = st.save(&doc) {
            eprintln!("voidmesh: seeding {:?}: {e}", doc.name);
        }
    }
}

fn mock_docs() -> Vec<Doc> {
    let gradient = still("gradient.png", 480, 320, |u, v| {
        let d = ((u - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt();
        [u, (1.0 - d * 1.6).max(0.0), v]
    });
    let rings = still("rings.png", 360, 360, |u, v| {
        let r = ((u - 0.5).powi(2) + (v - 0.5).powi(2)).sqrt() * 24.0;
        let k = 0.5 + 0.5 * r.sin();
        [k, k * 0.6, 1.0 - k]
    });
    let bars = still("bars.png", 400, 260, |u, v| {
        let i = (u * 6.0).floor() / 5.0;
        [i, 1.0 - i, v]
    });
    let fx = |s: Shader| {
        let mut p = Params::default();
        p.set_shader(s);
        p
    };
    let mut duotone = fx(Shader::Halftone);
    duotone.palette = presets()[3 % presets().len()].clone();
    vec![
        doc("Mock: gradients", vec![(&gradient, [0.0, 0.0], Params::default()), (&gradient, [560.0, 0.0], duotone)]),
        doc("Mock: every effect", Shader::ALL.iter().enumerate().map(|(i, &s)| (&rings, [(i % 4) as f32 * 420.0, (i / 4) as f32 * 420.0], fx(s))).collect()),
        doc("Mock: shared media", vec![(&bars, [0.0, 0.0], fx(Shader::Glitch)), (&bars, [0.0, 320.0], fx(Shader::Ascii)), (&gradient, [480.0, 0.0], fx(Shader::Glass))]),
        doc("Mock: empty", vec![]),
    ]
}

fn doc(name: &str, items: Vec<(&Arc<media::Asset>, [f32; 2], Params)>) -> Doc {
    let items = items
        .into_iter()
        .enumerate()
        .map(|(z, (a, pos, params))| Item {
            uid: store::new_id(),
            name: a.name.clone(),
            asset: a.clone(),
            pos,
            size: [a.width as f32, a.height as f32],
            z: z as u32,
            params,
            fx_t: 0.0,
            playing: false,
            play_t: 0.0,
            muted: true,
        })
        .collect();
    Doc { id: store::new_id(), name: name.into(), items, viewport: Viewport { offset: [-80.0, -80.0], zoom: 1.0 }, palettes: vec![] }
}

fn still(name: &str, w: u32, h: u32, f: impl Fn(f32, f32) -> [f32; 3]) -> Arc<media::Asset> {
    let mut px = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let c = f(x as f32 / w as f32, y as f32 / h as f32);
            px.extend(c.map(|c| (c.clamp(0.0, 1.0) * 255.0) as u8));
            px.push(255);
        }
    }
    Arc::new(media::rgba_asset(media::next_asset_id(), name, w, h, px))
}
