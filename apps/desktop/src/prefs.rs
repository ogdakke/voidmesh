//! Preferences that outlive a run, in the app's config folder (Rune `Prefs`): snap to grid,
//! canvas lensing and the user's palettes, as the web keeps them in localStorage, and which
//! workspaces were open in tabs. Tests and headless runs use an in-memory store.

use serde_json::Value;

use crate::state::{App, Lensing};

const SNAP: &str = "snapToGrid";
const LENSING: &str = "canvasLensing";
/// The web's `fancyEffects`: none, all, deletions or prismWake. Desktop has the deletions part.
const FANCY: &str = "fancyEffects";
const PALETTES: &str = "customPalettes";
const TABS: &str = "workspaceTabs";
const ACTIVE: &str = "activeWorkspace";

pub fn open() -> rune::prefs::Prefs {
    rune::prefs::Prefs::open(crate::media::APP_ID)
}

/// Apply the stored preferences to a fresh app.
pub fn load(s: &mut App) {
    s.snap = s.prefs.get::<bool>(SNAP).unwrap_or(false);
    s.lens = match s.prefs.get::<String>(LENSING).as_deref() {
        Some("subtle") => Lensing::Subtle,
        Some("extreme") => Lensing::Extreme,
        _ => Lensing::Off,
    };
    s.fancy_deletions = s.prefs.get::<String>(FANCY).map(|v| matches!(v.as_str(), "all" | "deletions"));
    let stored: Vec<Value> = s.prefs.get(PALETTES).unwrap_or_default();
    s.palettes = stored.iter().filter_map(crate::workspace::palette_from).collect();
    let tabs: Vec<String> = s.prefs.get(TABS).unwrap_or_default();
    let active: Option<String> = s.prefs.get(ACTIVE);
    s.restore_tabs(&tabs, active.as_deref());
}

fn set(s: &mut App, key: &str, v: Value) {
    if let Err(e) = s.prefs.set(key, &v) {
        s.toast(e.to_string());
    }
}

pub fn set_snap(s: &mut App, on: bool) {
    s.snap = on;
    set(s, SNAP, Value::Bool(on));
}

pub fn set_lensing(s: &mut App, l: Lensing) {
    s.lens = l;
    let id = match l {
        Lensing::Off => "off",
        Lensing::Subtle => "subtle",
        Lensing::Extreme => "extreme",
    };
    set(s, LENSING, Value::from(id));
}

/// Fancy deletions on or off, keeping the stored value's other effect as the web does.
pub fn set_fancy_deletions(s: &mut App, on: bool) {
    let prism = s.prefs.get::<String>(FANCY).map_or(s.fancy_deletions(), |v| matches!(v.as_str(), "all" | "prismWake"));
    s.fancy_deletions = Some(on);
    let v = match (on, prism) {
        (true, true) => "all",
        (true, false) => "deletions",
        (false, true) => "prismWake",
        (false, false) => "none",
    };
    set(s, FANCY, Value::from(v));
}

pub fn save_palettes(s: &mut App) {
    let v: Vec<Value> = s.palettes.iter().map(crate::workspace::palette_json).collect();
    set(s, PALETTES, Value::Array(v));
}

/// The open tabs, in order, and the one showing.
pub fn save_tabs(s: &mut App) {
    let ids: Vec<Value> = s.tabs.iter().map(|t| Value::from(t.id.clone())).collect();
    let active = Value::from(s.tab().id.clone());
    set(s, TABS, Value::Array(ids));
    set(s, ACTIVE, active);
}
