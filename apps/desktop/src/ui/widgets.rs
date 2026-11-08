//! Controls in the web app's shapes (`components/ui/`): a 32 pt slider whose label and value sit
//! inside the track, a pill toggle, a select whose trigger opens a native menu, a collapsible
//! section with an optional checkbox, round palette swatches and icon buttons.

use rune::{Color, Drag, El, Icon, Phase, PopupMenu, Tx, col, el, icon, row, text};

use super::look::{LARGE, Look, MEDIUM, NUMBER};
use crate::effects::{Params, Range};
use crate::state::App;

/// `.slider-root`: a 32 pt track, 10 pt radius, surface fill, the indicator up to the value, a
/// faint 3 pt thumb line. Click or drag anywhere; a drag is one undo step.
pub fn slider(l: &Look, key: &'static str, label: &str, value: f32, r: Range, set: fn(&mut Params, f32)) -> El {
    const H: f32 = 32.0;
    let t = ((value - r.min) / (r.max - r.min)).clamp(0.0, 1.0);
    let decimals = if r.step >= 1.0 { 0 } else if r.step >= 0.1 { 1 } else { 2 };
    let to_value = move |x: f32, w: f32| {
        let v = r.min + (x / w.max(1.0)).clamp(0.0, 1.0) * (r.max - r.min);
        ((v / r.step).round() * r.step).clamp(r.min, r.max)
    };
    el().key(key)
        .role("slider")
        .label(label)
        .range_value(f64::from(value), f64::from(r.min), f64::from(r.max))
        .range_step(f64::from(r.step))
        .focusable(true)
        .focus_ring(2.0, 2.0, l.primary)
        .on_step(move |s: &mut App, steps, _| s.edit(|p| set(p, (value + steps as f32 * r.step).clamp(r.min, r.max))))
        .w_full()
        .h(H)
        .radius(10.0)
        .fill(l.surface)
        .clip_rounded(10.0)
        .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
            match d.phase {
                Phase::Down => {
                    s.begin_edit();
                    s.edit_live(|p| set(p, to_value(d.x, d.w)));
                }
                Phase::Move => s.edit_live(|p| set(p, to_value(d.x, d.w))),
                Phase::Up => {
                    if d.cancelled() {
                        if let Some(before) = s.editing.take() {
                            s.push_undo(before);
                            s.undo();
                        }
                    } else {
                        s.end_edit();
                    }
                }
            }
            tx.instant();
        })
        .child(el().absolute(0.0, 0.0).h(H).w_frac(t).fill(l.indicator).a11y_hidden())
        .child(el().absolute(0.0, 0.0).w_full().h(H).a11y_hidden().child(el().absolute(0.0, H / 4.0).w_frac(t).h(H / 2.0).child(el().pin(None, Some(0.0), Some(3.0), None).size(3.0, H / 2.0).radius(2.0).fill(l.text_strong.alpha(0.2)))))
        .child(
            row()
                .absolute(0.0, 0.0)
                .w_full()
                .h(H)
                .px(12.0)
                .center_y()
                .justify_between()
                .child(text(label).font(MEDIUM).color(l.text_strong))
                .child(text(format!("{value:.decimals$}")).font(NUMBER).color(l.text_strong)),
        )
}

/// `.ui-toggle`: a transparent pill that fills with the surface and an inset ring when on.
pub fn toggle(l: &Look, key: &'static str, label: &str, on: bool, flip: fn(&mut Params)) -> El {
    let mut t = el()
        .key(key)
        .role("switch")
        .label(label)
        .checked(on)
        .focusable(true)
        .focus_ring(2.0, 2.0, l.primary)
        .h(28.0)
        .px(10.5)
        .center()
        .radius(14.0)
        .hover(l.hover)
        .press_scale(0.97)
        .cursor(rune::Cursor::Pointer)
        .on_press(move |s: &mut App| s.edit(flip))
        .child(text(label).font(MEDIUM).color(if on { l.text } else { l.text_strong }));
    if on {
        t = t.fill(l.surface).border(1.0, l.pressed_ring);
    }
    t
}

/// `.ui-button` secondary, small: a bordered pill.
pub fn button(l: &Look, key: &'static str, label: &str, press: fn(&mut App)) -> El {
    el().key(key)
        .role("button")
        .label(label)
        .focusable(true)
        .focus_ring(2.0, 2.0, l.primary)
        .h(28.0)
        .px(12.0)
        .center()
        .radius(14.0)
        .border(1.0, l.border)
        .fill(l.surface)
        .hover(l.hover)
        .press_scale(0.97)
        .cursor(rune::Cursor::Pointer)
        .on_press(press)
        .child(text(label).font(MEDIUM).color(l.text))
}

/// `.select-field`: a label over a 32 pt trigger (radius 12, the input fill, a hairline) that
/// opens a native menu with the current option checked.
pub fn select(l: &Look, key: &'static str, label: Option<&str>, options: &'static [&'static str], current: usize, pick: fn(&mut Params, usize)) -> El {
    let value = options.get(current).copied().unwrap_or("Mixed");
    let trigger = row()
        .key(key)
        .role("combobox")
        .label(label.unwrap_or(value))
        .focusable(true)
        .focus_ring(2.0, -1.0, l.primary)
        .w_full()
        .h(34.0)
        .pl(14.0)
        .pr(12.0)
        .radius(12.0)
        .fill(l.surface)
        .border(1.0, l.field_border)
        .hover(l.hover)
        .center_y()
        .justify_between()
        .cursor(rune::Cursor::Pointer)
        .on_press_tx(move |_: &mut App, tx: &mut Tx| {
            let menu = PopupMenu::picker(options.iter().enumerate().map(|(i, o)| (i.to_string(), *o)), &current.to_string());
            tx.popup_menu(menu, key, move |s: &mut App, picked, _| {
                if let Some(i) = picked.and_then(|p| p.parse::<usize>().ok()) {
                    s.edit(|p| pick(p, i));
                }
            });
        })
        .child(text(value).font(LARGE).color(l.text_value))
        .child(icon(&CHEVRON_DOWN, 14.0).color(l.text_muted));
    match label {
        Some(label) => col().w_full().gap(4.0).child(text(label).font(MEDIUM).color(l.text_muted)).child(trigger),
        None => trigger,
    }
}

/// A select over options known only at run time, keyed by id: `(id, label)` pairs.
pub fn select_ids(l: &Look, key: &'static str, label: Option<&str>, options: Vec<(String, String)>, current: &str, pick: fn(&mut App, String)) -> El {
    let value = options.iter().find(|(id, _)| id == current).map_or_else(|| "Mixed".to_string(), |(_, t)| t.clone());
    let current = current.to_string();
    let trigger = row()
        .key(key)
        .role("combobox")
        .label(label.map_or_else(|| value.clone(), str::to_string))
        .focusable(true)
        .focus_ring(2.0, -1.0, l.primary)
        .w_full()
        .h(34.0)
        .pl(14.0)
        .pr(12.0)
        .radius(12.0)
        .fill(l.surface)
        .border(1.0, l.field_border)
        .hover(l.hover)
        .center_y()
        .justify_between()
        .cursor(rune::Cursor::Pointer)
        .on_press_tx(move |_: &mut App, tx: &mut Tx| {
            let menu = PopupMenu::picker(options.clone(), &current);
            tx.popup_menu(menu, key, move |s: &mut App, picked, _| {
                if let Some(id) = picked {
                    pick(s, id.to_string());
                }
            });
        })
        .child(text(value).font(LARGE).color(l.text_value).truncate())
        .child(icon(&CHEVRON_DOWN, 14.0).color(l.text_muted));
    match label {
        Some(label) => col().w_full().gap(4.0).child(text(label).font(MEDIUM).color(l.text_muted)).child(trigger),
        None => trigger,
    }
}

/// `.ui-checkbox`: 18 pt, radius 4, primary fill with a tick when on.
pub fn checkbox(l: &Look, key: String, label: String, on: bool, flip: fn(&mut Params)) -> El {
    let mut b = el()
        .key(key)
        .role("checkbox")
        .label(label)
        .checked(on)
        .focusable(true)
        .size(18.0, 18.0)
        .radius(4.0)
        .center()
        .cursor(rune::Cursor::Pointer)
        .on_press(move |s: &mut App| s.edit(flip));
    b = if on { b.fill(l.primary).child(icon(&CHECK, 12.0).color(Color::WHITE)) } else { b.fill(l.surface).border(1.0, l.pressed_ring) };
    b
}

/// `.collapsible`: a small trigger with a chevron that turns open, and an optional checkbox.
pub fn section(l: &Look, s: &App, id: &'static str, title: &str, enabled: Option<(bool, fn(&mut Params))>, body: El) -> El {
    let open = !s.folded.contains(id);
    let trigger = row()
        .key(format!("sec-{id}"))
        .role("button")
        .label(title)
        .h(28.0)
        .px(8.0)
        .gap(8.0)
        .radius(4.0)
        .center_y()
        .hover(l.hover)
        .cursor(rune::Cursor::Pointer)
        .on_press(move |s: &mut App| {
            if !s.folded.remove(id) {
                s.folded.insert(id);
            }
        })
        .child(icon(&CHEVRON_RIGHT, 12.0).color(l.text_muted).rotate(if open { std::f32::consts::FRAC_PI_2 } else { 0.0 }))
        .child(text(title).font(MEDIUM).color(l.text_muted));
    let mut header = row().w_full().center_y().justify_between().child(trigger);
    if let Some((on, flip)) = enabled {
        header = header.child(checkbox(l, format!("sec-{id}-on"), format!("{title} enabled"), on, flip));
    }
    let mut c = col().w_full().gap(8.0).child(header);
    if open {
        c = c.child(body);
    }
    c
}

/// An icon-only button (`.ui-button` md, icon only): a 32 pt circle.
pub fn icon_button(l: &Look, key: impl Into<String>, label: &str, glyph: &'static Icon, press: impl Fn(&mut App, &mut Tx) + 'static) -> El {
    el().key(key)
        .role("button")
        .label(label)
        .focusable(true)
        .focus_ring(2.0, 2.0, l.primary)
        .size(32.0, 32.0)
        .radius(16.0)
        .center()
        .hover(l.hover)
        .press_scale(0.97)
        .cursor(rune::Cursor::Pointer)
        .help(label)
        .on_press_tx(press)
        .child(icon(glyph, 18.0).color(l.text))
}

macro_rules! icons {
    ($($name:ident = $body:literal;)*) => {
        $(pub static $name: Icon = Icon { name: stringify!($name), view: 24.0, body: $body };)*
    };
}

icons! {
    PLUS = r#"<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>"#;
    UNDO = r#"<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    REDO = r#"<path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    PLAY = r#"<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>"#;
    PAUSE = r#"<path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/>"#;
    SAVE = r#"<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    TRASH = r#"<path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    FIT = r#"<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    CHEVRON_DOWN = r#"<path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    CHEVRON_RIGHT = r#"<path d="m9 6 6 6-6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    SOUND = r#"<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4.2 4.2 0 0 1 0 6M18 6.5a7.8 7.8 0 0 1 0 11" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>"#;
    MUTED = r#"<path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="m16 9.5 5 5m0-5-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>"#;
    GEAR = r#"<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="2" fill="none"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" stroke="currentColor" stroke-width="1.6" fill="none"/>"#;
    XMARK = r#"<path d="M6.75 6.75 17.25 17.25M17.25 6.75 6.75 17.25" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>"#;
    STACK = r#"<path d="m12 4 8 4-8 4-8-4z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" fill="none"/><path d="m4 12 8 4 8-4M4 16l8 4 8-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
    CHECK = r#"<path d="m5 12.5 4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>"#;
}
