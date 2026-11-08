//! Window keys, as the web app binds them (see FEATURES.md §10).

use rune::{Key, KeyEvent, Tx};

use crate::state::App;

pub fn on_key(s: &mut App, e: &KeyEvent, tx: &mut Tx) -> bool {
    let m = e.mods;
    tx.instant();
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
            ('d', _) => s.duplicate_selection(),
            ('e', _) => crate::ui::export_selected(s, tx),
            ('o', _) => crate::ui::open_media(s, tx),
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
            "g" => s.snap = !s.snap,
            "l" => s.lens = s.lens.next(),
            "o" => s.edit(|p| p.show_original = !p.show_original),
            "p" => s.edit(|p| p.preserve_colors = !p.preserve_colors),
            "r" => s.edit(|p| p.reverse_palette = !p.reverse_palette),
            _ => return false,
        },
        Key::Escape => s.selection.clear(),
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
