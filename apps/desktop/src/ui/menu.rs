//! The right-click menu, as the web app's (FEATURES.md §6.4), as a native context menu. On an
//! entity it mirrors the inspector and the selection's commands; on empty canvas it pastes,
//! saves and opens.

use rune::{PopupItem, PopupMenu, Shortcut, Tx};

use crate::effects::{self as fx, DotShape, Shader};
use crate::state::App;

fn item(id: impl Into<String>, title: impl Into<String>) -> PopupItem {
    PopupItem::new(id, title)
}

/// An item showing its shortcut.
fn keyed(id: &str, title: &str, chord: &str) -> PopupItem {
    let i = item(id, title);
    match chord.parse::<Shortcut>() {
        Ok(k) => i.key_equivalent(k),
        Err(_) => i,
    }
}

/// A picker submenu: `prefix:index` ids, the current value checked (none when mixed).
fn picker(prefix: &str, labels: &[&str], current: Option<usize>) -> PopupMenu {
    labels.iter().enumerate().fold(PopupMenu::new(), |m, (i, l)| m.item(item(format!("{prefix}:{i}"), *l).checked(current == Some(i))))
}

/// Every selected entity's value of `f` agrees: that value, else None (mixed).
fn agreed<T: PartialEq + Copy>(s: &App, f: impl Fn(&crate::state::Entity) -> T) -> Option<T> {
    let mut it = s.selected().map(f);
    let first = it.next()?;
    it.all(|v| v == first).then_some(first)
}

fn check(s: &App, id: &str, title: &str, chord: &str, f: impl Fn(&crate::state::Entity) -> bool) -> PopupItem {
    match agreed(s, f) {
        Some(on) => keyed(id, title, chord).checked(on),
        None => keyed(id, &format!("{title} (Mixed)"), chord),
    }
}

pub fn entity_menu(s: &App) -> PopupMenu {
    let n = s.selection.len();
    let count = |t: &str| if n > 1 { format!("{t} ({n})") } else { t.to_string() };
    let mut m = PopupMenu::new();
    if n > 1 {
        m = m.item(item("label", format!("{n} items selected")).enabled(false)).separator();
    }
    let shader = agreed(s, |e| e.params.shader);
    m = m.submenu("Style", picker("shader", &fx::SHADER_LABELS, shader.and_then(|x| Shader::ALL.iter().position(|y| *y == x))));
    let all = |f: fn(Shader) -> bool| s.selected().all(|e| f(e.params.shader));
    if all(Shader::has_shape) {
        m = m.submenu("Shape", picker("shape", &fx::SHAPE_LABELS, agreed(s, |e| e.params.shape).and_then(|x| DotShape::ALL.iter().position(|y| *y == x))));
    }
    if all(|x| x == Shader::Dithering) {
        m = m.submenu("Algorithm", picker("dither", &fx::DITHER_KINDS, agreed(s, |e| e.params.dither_kind as usize)));
    }
    if all(|x| x == Shader::Ascii) {
        let sub = picker("ascii", &fx::ASCII_KINDS, agreed(s, |e| e.params.ascii_kind as usize)).separator().item(check(s, "invert", "Invert Brightness", "", |e| e.params.ascii_invert));
        m = m.submenu("Character Set", sub);
    }
    if all(|x| x == Shader::Glass) {
        m = m.submenu("Glass Type", picker("glass", &fx::GLASS_KINDS, agreed(s, |e| e.params.glass_kind as usize)));
    }
    if all(|x| x == Shader::Glitch) {
        m = m.submenu("Glitch Type", picker("glitch", &fx::GLITCH_KINDS, agreed(s, |e| e.params.glitch_kind as usize)));
    }
    if s.selected().any(|e| e.params.shader.uses_palette()) {
        let current = s.focus().map(|e| e.params.palette.id.clone()).filter(|id| s.selected().all(|e| &e.params.palette.id == id));
        let pal = s.palette_options().into_iter().fold(PopupMenu::new(), |m, (id, name)| {
            let on = current.as_deref() == Some(id.as_str());
            m.item(item(format!("palette:{id}"), name).checked(on))
        });
        m = m.submenu("Palette Preset", pal).item(item("load-palette", "Load Palette…"));
    }
    m = m
        .separator()
        .item(check(s, "original", "Show Original", "o", |e| e.params.show_original))
        .item(check(s, "preserve", "Preserve Colors", "p", |e| e.params.preserve_colors))
        .item(check(s, "reverse", "Reverse Palette", "r", |e| e.params.reverse_palette))
        .separator();
    if n == 1 {
        let animated = s.focus().is_some_and(|e| e.asset.animated());
        m = m.item(keyed("copy-image", if animated { "Copy Frame" } else { "Copy Image" }, "cmd+c"));
    }
    let save = if s.selected().any(|e| e.asset.animated()) {
        PopupMenu::new().item(keyed("export-video", "Export…", "cmd+e")).separator().item(item("save-png", "Save Frame (PNG)")).item(item("save-jpeg", "Save Frame (JPEG)"))
    } else {
        PopupMenu::new().item(item("save-png", "PNG")).item(item("save-jpeg", "JPEG"))
    };
    m = m.submenu_enabled("Save as…", save, n == 1);
    let mut copy = PopupMenu::new();
    if n == 1 {
        copy = copy.item(keyed("copy-fx", "Copy Effects", "ctrl+cmd+c"));
    }
    m.submenu("Copy/Paste as…", copy.item(keyed("paste-fx", "Paste Effects", "cmd+v")))
        .separator()
        .item(keyed("dup", &count("Duplicate"), "cmd+d"))
        .item(item("reset", count("Reset")))
        .item(keyed("delete", &count("Delete"), "backspace"))
}

pub fn canvas_menu(s: &App) -> PopupMenu {
    let mut ws = PopupMenu::new().item(keyed("new-ws", "New Workspace", "cmd+t")).item(keyed("library", "Workspaces…", "shift+cmd+o")).separator();
    if !s.entities.is_empty() {
        ws = ws.item(keyed("export-ws", "Export as .vdmsh…", "shift+cmd+s"));
    }
    PopupMenu::new()
        .item(keyed("paste", "Paste", "cmd+v"))
        .submenu("Workspace", ws.item(keyed("open", "Open…", "cmd+o")))
        .separator()
        .item(keyed("snap", "Snap to Grid", "g").checked(s.snap))
        .item(keyed("settings", "Settings…", "cmd+,"))
}

/// Do what was picked.
pub fn run(s: &mut App, id: &str, tx: &mut Tx) {
    let idx = |p: &str| id.strip_prefix(p).and_then(|r| r.parse::<usize>().ok());
    if let Some(i) = idx("shader:") {
        if let Some(sh) = Shader::ALL.get(i).copied() {
            s.edit(|p| p.set_shader(sh));
        }
    } else if let Some(i) = idx("shape:") {
        if let Some(sh) = DotShape::ALL.get(i).copied() {
            s.edit(|p| p.shape = sh);
        }
    } else if let Some(i) = idx("dither:") {
        s.edit(|p| p.dither_kind = i as u32);
    } else if let Some(i) = idx("ascii:") {
        s.edit(|p| p.ascii_kind = i as u32);
    } else if let Some(i) = idx("glass:") {
        s.edit(|p| p.set_glass_kind(i as u32));
    } else if let Some(i) = idx("glitch:") {
        s.edit(|p| p.set_glitch_kind(i as u32));
    } else if let Some(pal) = id.strip_prefix("palette:") {
        s.set_palette(pal);
    } else {
        // A mixed checkbox turns everything on, as the web's does.
        let flip = |s: &mut App, get: fn(&fx::Params) -> bool, set: fn(&mut fx::Params, bool)| {
            let on = !s.selected().all(|e| get(&e.params));
            s.edit(|p| set(p, on));
        };
        match id {
            "original" => flip(s, |p| p.show_original, |p, v| p.show_original = v),
            "preserve" => flip(s, |p| p.preserve_colors, |p, v| p.preserve_colors = v),
            "reverse" => flip(s, |p| p.reverse_palette, |p, v| p.reverse_palette = v),
            "invert" => flip(s, |p| p.ascii_invert, |p, v| p.ascii_invert = v),
            "load-palette" => super::palette_editor::load_palette(s, tx),
            "copy-image" => crate::clip::copy_image(s),
            "save-png" => super::export_selected_as(s, tx, "png"),
            "save-jpeg" => super::export_selected_as(s, tx, "jpg"),
            "export-video" => super::export_panel::open(s),
            "copy-fx" => crate::clip::copy_effects(s, tx),
            "paste-fx" | "paste" => tx.read_clipboard(|s: &mut App, c, _| crate::clip::paste(s, c)),
            "dup" => s.duplicate_selection(),
            "reset" => s.reset_selection(),
            "delete" => s.delete_selection(),
            "new-ws" => s.new_tab(),
            "library" => super::library::toggle(s),
            "export-ws" => super::export_workspace(s, tx),
            "open" => super::open_any(s, tx),
            "snap" => crate::prefs::set_snap(s, !s.snap),
            "settings" => super::settings::toggle(s),
            _ => {}
        }
    }
}

/// Open the entity menu at a window point; the entity joins the selection first if it wasn't in it.
pub fn open_on_entity(s: &mut App, id: u32, at: (f32, f32), tx: &mut Tx) {
    if !s.selection.contains(&id) {
        s.select_only(id);
    }
    tx.popup_menu(entity_menu(s), at, |s: &mut App, picked, tx| {
        if let Some(p) = picked {
            run(s, p, tx);
        }
    });
}

pub fn open_on_canvas(s: &mut App, at: (f32, f32), tx: &mut Tx) {
    tx.popup_menu(canvas_menu(s), at, |s: &mut App, picked, tx| {
        if let Some(p) = picked {
            run(s, p, tx);
        }
    });
}
