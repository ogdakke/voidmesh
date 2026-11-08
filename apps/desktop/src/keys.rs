//! Window keys, as the web app binds them (see FEATURES.md §10).

use rune::{Key, KeyEvent, Tx};

use crate::state::App;

pub fn on_key(s: &mut App, e: &KeyEvent, tx: &mut Tx) -> bool {
    let m = e.mods;
    tx.instant();
    // Workspace commands work everywhere.
    match (&e.key, m.shift) {
        (Key::Command('t'), false) => s.new_tab(),
        (Key::Command('w'), false) => s.close_tab(s.active),
        (Key::Command('s'), false) => crate::ui::save(s),
        (Key::Command('s'), true) => crate::ui::export_workspace(s, tx),
        (Key::Command('o'), false) => crate::ui::open_any(s, tx),
        (Key::Command('o'), true) => crate::ui::library::toggle(s, tx),
        (Key::Command(c @ '1'..='9'), false) => {
            // ⌘9 is the last tab, as in browsers.
            let n = c.to_digit(10).unwrap_or(1) as usize;
            s.switch_tab(if n == 9 { s.tabs.len() - 1 } else { n - 1 });
        }
        (Key::Tab, shift) if m.ctrl => s.cycle_tab(if shift { -1 } else { 1 }),
        _ => return on_view_key(s, e, tx),
    }
    crate::ui::tabs::reveal(s, tx);
    true
}

fn on_view_key(s: &mut App, e: &KeyEvent, tx: &mut Tx) -> bool {
    let m = e.mods;
    // The settings view and the library take the window: only closing them applies.
    if s.settings || s.library.is_some() {
        match &e.key {
            Key::Escape => {
                s.settings = false;
                s.library = None;
            }
            Key::Command(',') => crate::ui::settings::toggle(s, tx),
            Key::Text(t) if t == "?" && s.settings => crate::ui::settings::toggle_shortcuts(s, tx),
            _ => return false,
        }
        return true;
    }
    match &e.key {
        Key::Command(c) => match (c, m.shift) {
            ('z', false) => {
                s.undo();
            }
            ('z', true) => {
                s.redo();
            }
            ('y', _) => {
                s.redo();
            }
            ('a', _) => s.select_all(),
            ('c', _) if m.ctrl => crate::clip::copy_effects(s, tx),
            ('c', _) => crate::clip::copy_image(s),
            ('d', _) => s.duplicate_selection(),
            ('e', _) => crate::ui::export_panel::save_or_export(s, tx),
            (',', _) => crate::ui::settings::toggle(s, tx),
            ('0', _) => {
                let k = s.device_scale;
                s.reset_zoom(k);
            }
            _ => return false,
        },
        Key::Text(t) if !m.cmd && !m.ctrl => match t.to_lowercase().as_str() {
            " " => {
                if !s.space {
                    s.space = true;
                    s.space_dragged = false;
                }
            }
            "f" | "h" => s.fit_selection(),
            "g" => crate::prefs::set_snap(s, !s.snap),
            "d" => s.perf.toggle(),
            "l" => crate::prefs::set_lensing(s, s.lens.next()),
            "m" => s.toggle_mute(),
            "\\" => s.bare = !s.bare,
            "?" => crate::ui::settings::toggle_shortcuts(s, tx),
            "o" => s.edit(|p| p.show_original = !p.show_original),
            "p" => s.edit(|p| p.preserve_colors = !p.preserve_colors),
            "r" => s.edit(|p| p.reverse_palette = !p.reverse_palette),
            _ => return false,
        },
        Key::Escape => {
            if s.picker.is_some() {
                s.close_picker();
            } else if s.loading().is_some() {
                s.cancel_open();
            } else {
                s.selection.clear();
            }
        }
        Key::Backspace | Key::Delete => s.delete_selection(),
        Key::Up => s.cycle(-1),
        Key::Down => s.cycle(1),
        Key::Left => s.seek(if m.shift { -1.0 } else { -0.1 }),
        Key::Right => s.seek(if m.shift { 1.0 } else { 0.1 }),
        _ => return false,
    }
    true
}

/// Space released: a tap without a drag plays or pauses the selection.
pub fn on_key_up(s: &mut App, e: &KeyEvent, _: &mut Tx) -> bool {
    if e.key != Key::Text(" ".into()) {
        return false;
    }
    if s.space && !s.space_dragged {
        s.toggle_play();
    }
    s.space = false;
    true
}
