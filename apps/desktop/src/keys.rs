//! Window keys, as the web app binds them (see FEATURES.md §10).

use rune::{Key, KeyEvent, Tx};

use crate::state::App;

pub fn on_key(s: &mut App, e: &KeyEvent, tx: &mut Tx) -> bool {
    let m = e.mods;
    tx.instant();
    // The settings view takes the window: only closing it, and app-wide commands, apply.
    if s.settings {
        match &e.key {
            Key::Escape | Key::Command(',') => s.settings = false,
            Key::Command('s') => crate::ui::save(s, tx, m.shift),
            Key::Command('o') => crate::ui::open_any(s, tx),
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
            ('o', _) => crate::ui::open_any(s, tx),
            ('s', shift) => crate::ui::save(s, tx, shift),
            (',', _) => crate::ui::settings::toggle(s),
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
            "l" => crate::prefs::set_lensing(s, s.lens.next()),
            "m" => s.toggle_mute(),
            "\\" => s.bare = !s.bare,
            "o" => s.edit(|p| p.show_original = !p.show_original),
            "p" => s.edit(|p| p.preserve_colors = !p.preserve_colors),
            "r" => s.edit(|p| p.reverse_palette = !p.reverse_palette),
            _ => return false,
        },
        Key::Escape => {
            if s.picker.is_some() {
                s.close_picker();
            } else if s.opening.is_some() {
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
