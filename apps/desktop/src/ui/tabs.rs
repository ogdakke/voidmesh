//! Workspace tabs, in the titlebar band after Add: one pill per open workspace, the active one
//! raised with its close button. A click switches, a double-click on the active tab renames it,
//! a right-click offers Rename, Export and Close. "+" opens a new workspace and the stack icon
//! the library of every workspace (⌘⇧O). Tabs keep a minimum width; past the room the titlebar
//! has, they scroll sideways with their edges faded.

use rune::{Color, Drag, El, Phase, PointerPress, PopupItem, PopupMenu, Shortcut, Tx, el, icon, row, text, text_input};

use super::look::{self, Look, MEDIUM, SMALL};
use super::widgets::{PLUS, STACK, XMARK};
use crate::state::App;

/// A tab's label is cut at this width; the tab itself never gets narrower than `TAB_MIN`.
const TAB_W: f32 = 180.0;
const TAB_MIN: f32 = 96.0;


fn index(s: &App, id: &str) -> Option<usize> {
    s.tabs.iter().position(|t| t.id == id)
}

fn start_rename(s: &mut App) {
    s.tab_rename = Some(rune::TextEdit::new(s.tab().name.clone()));
}

/// The key the active tab draws under, to scroll it into view.
pub fn active_key(s: &App) -> String {
    format!("tab-{}", s.tab().id)
}

/// Show the active tab inside the strip's scroll.
pub fn reveal(s: &App, tx: &mut Tx) {
    tx.scroll_into_view_in("tabs-scroll", active_key(s));
}

/// The "+" and library buttons after the tabs, with the gaps before them.
const BUTTONS_W: f32 = 2.0 * (28.0 + 4.0);
/// The strip's padding and gap between tabs.
const GAP: f32 = 4.0;
/// Room above and below the tabs inside their scroll, so the active tab's border and shadow
/// aren't clipped: the strip is this much taller than a tab at each edge.
pub const PAD_Y: f32 = 2.0;

/// A tab's width as it lays out: its label (cut at `TAB_W`), padding and, when active, its close
/// button; never under `TAB_MIN`.
fn tab_w(s: &App, i: usize) -> f32 {
    let t = &s.tabs[i];
    let label = if t.loading.is_some() { format!("{}…", t.name) } else { t.name.clone() };
    let text_w = rune::text::measure(&label, &[], MEDIUM, None).0.min(TAB_W);
    let chrome = if i == s.active { 12.0 + 4.0 + 20.0 + 4.0 } else { 24.0 };
    (text_w + chrome).max(TAB_MIN)
}

/// The tabs, then "+" and the library, in `room` points: past that the tabs scroll.
pub fn strip(l: &Look, s: &App, room: f32) -> El {
    let natural = (0..s.tabs.len()).map(|i| tab_w(s, i)).sum::<f32>() + GAP * (s.tabs.len() as f32 - 1.0).max(0.0);
    let width = natural.min(room - BUTTONS_W).max(TAB_MIN);
    let tabs = s.tabs.iter().enumerate().fold(row().gap(GAP).py(PAD_Y).center_y(), |r, (i, t)| r.child(tab(l, s, i, t)));
    let r = row()
        .key("tabs")
        .gap(GAP)
        .center_y()
        .child(row().key("tabs-scroll").w(width).min_w(width).scroll_x().scroll_edge_fade(24.0).scroll_margin(24.0).child(tabs));
    let small = |key: &'static str, label: &'static str, glyph: &'static rune::Icon, press: fn(&mut App, &mut Tx)| {
        el().key(key).role("button").label(label).help(label).size(28.0, 28.0).radius(14.0).center().hover(l.hover).press_scale(0.97).cursor(rune::Cursor::Pointer).on_press_tx(press).child(icon(glyph, 15.0).color(l.text_muted))
    };
    r.child(small("tab-new", "New workspace (⌘T)", &PLUS, |s, tx| {
        s.new_tab();
        reveal(s, tx);
    }))
    .child(small("library-open", "Workspaces (⇧⌘O)", &STACK, super::library::toggle))
}

fn tab(l: &Look, s: &App, i: usize, t: &crate::state::Tab) -> El {
    let active = i == s.active;
    if active && let Some(edit) = &s.tab_rename {
        let field = text_input(edit, MEDIUM)
            .single_line()
            .key("tab-rename")
            .on_edit(|s: &mut App| s.tab_rename.get_or_insert_with(|| rune::TextEdit::new("")))
            .on_submit(|s: &mut App, _| {
                let name = s.tab_rename.as_ref().map(|e| e.text.clone()).unwrap_or_default();
                s.rename_tab(&name);
            })
            .on_input_key(|s: &mut App, k: &rune::KeyEvent, _| {
                if k.key == rune::Key::Escape {
                    s.tab_rename = None;
                    return true;
                }
                false
            })
            .w(TAB_W)
            .color(l.text);
        return row().key(format!("tab-{}", t.id)).min_w(TAB_MIN).h(28.0).px(12.0).radius(14.0).center_y().fill(l.surface).border(1.0, l.pressed_ring).child(field);
    }
    let id = t.id.clone();
    let id2 = t.id.clone();
    let mut label = t.name.clone();
    if t.loading.is_some() {
        label.push('…');
    }
    let mut e = row()
        .key(format!("tab-{}", t.id))
        .role("tab")
        .label(t.name.clone())
        .checked(active)
        .min_w(TAB_MIN)
        .h(28.0)
        .pl(12.0)
        .pr(if active { 4.0 } else { 12.0 })
        .gap(4.0)
        .radius(14.0)
        .center_y()
        .cursor(rune::Cursor::Pointer)
        .help(if active { "Double-click to rename".to_string() } else { t.name.clone() })
        .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
            if d.phase != Phase::Down {
                return;
            }
            let Some(i) = index(s, &id) else { return };
            if i == s.active && d.clicks >= 2 {
                start_rename(s);
            } else {
                s.switch_tab(i);
                reveal(s, tx);
            }
        })
        .on_secondary_press(move |s: &mut App, p: PointerPress, tx: &mut Tx| {
            if let Some(i) = index(s, &id2) {
                s.switch_tab(i);
                menu(s, p, tx);
            }
        })
        .child(text(label).font(MEDIUM).color(if active { l.text } else { l.text_muted }).truncate().max_w(TAB_W).grow(1.0));
    if active {
        e = look::own_gestures(e).fill(l.surface).border(1.0, l.border).shadow(4.0, 12.0, Color::BLACK.alpha(0.07)).child(
            el().key("tab-close")
                .role("button")
                .label("Close workspace (⌘W)")
                .help("Close (⌘W)")
                .size(20.0, 20.0)
                .radius(10.0)
                .center()
                .hover(l.hover)
                .cursor(rune::Cursor::Pointer)
                .on_press(|s: &mut App| s.close_tab(s.active))
                .child(icon(&XMARK, 12.0).color(l.text_muted)),
        );
    } else {
        e = e.hover(l.hover);
    }
    e
}

fn keyed(id: &str, title: &str, chord: &str) -> PopupItem {
    let i = PopupItem::new(id, title);
    match chord.parse::<Shortcut>() {
        Ok(k) => i.key_equivalent(k),
        Err(_) => i,
    }
}

fn menu(s: &mut App, p: PointerPress, tx: &mut Tx) {
    let _ = s;
    let m = PopupMenu::new().item(PopupItem::new("rename", "Rename")).item(keyed("export", "Export as .vdmsh…", "shift+cmd+s")).separator().item(keyed("close", "Close", "cmd+w"));
    tx.popup_menu(m, (p.x, p.y), |s: &mut App, picked, tx| match picked {
        Some("rename") => start_rename(s),
        Some("export") => super::export_workspace(s, tx),
        Some("close") => s.close_tab(s.active),
        _ => {}
    });
}

/// The active tab's read progress, beside the tabs.
pub fn progress(l: &Look, s: &App) -> Option<El> {
    use std::sync::atomic::Ordering;
    let p = s.loading()?;
    let (done, total) = (p.done.load(Ordering::Relaxed), p.total.load(Ordering::Relaxed));
    let what = if total == 0 { "Reading workspace…".to_string() } else { format!("Importing item {} of {total}…", (done + 1).min(total)) };
    let mut r = row().gap(6.0).center_y().child(text(what).font(SMALL).color(l.text_muted));
    if !s.tab().stored {
        r = r.child(
            el().key("cancel-open").role("button").label("Cancel").px(8.0).h(22.0).radius(11.0).center().hover(l.hover).cursor(rune::Cursor::Pointer).on_press(|s: &mut App| s.cancel_open()).child(text("Cancel").font(SMALL).color(l.text)),
        );
    }
    Some(r)
}
