//! Settings: a view of its own inside the window (⌘,), never a separate window, styled as the
//! web app's desktop settings (`components/settings/settings.desktop*`): a full-window page on
//! `--background` with a 768 pt column, a "Settings" title, canvas lensing as three preview cards,
//! and bordered groups of 52 pt rows with switches under sentence-case headings. Esc or ⌘,
//! closes it.

use std::cell::OnceCell;

use rune::{Color, El, Pixels, ScrollSpec, TextStyle, Tx, col, el, icon, row, text};

use super::look::{self, Look};
use super::widgets::{CHEVRON_RIGHT, TRASH, XMARK, icon_button};
use crate::state::{App, Lensing};

/// `--text-xl` at weight 500.
const TITLE: TextStyle = TextStyle::new(28.0, 500.0);
/// Section headings (`h2`): `--text-sm`, weight 600.
const HEADING: TextStyle = TextStyle::new(14.0, 600.0);
const LABEL: TextStyle = TextStyle::new(14.0, 400.0);
const DESC: TextStyle = TextStyle::new(12.0, 400.0);
const KBD: TextStyle = TextStyle::new(14.0, 500.0);
const COLUMN: f32 = 768.0;
const ROW_H: f32 = 52.0;

pub fn toggle(s: &mut App) {
    s.settings = !s.settings;
    s.library = None;
}

/// `?`: the keyboard shortcuts, as the web's help dialog shows them; again closes them.
pub fn toggle_shortcuts(s: &mut App, tx: &mut Tx) {
    toggle(s);
    if s.settings {
        // Under the titlebar band, where the page's own title sits.
        tx.scroll_key_to(SHORTCUTS, s.top_inset + 8.0);
    }
}

/// The shortcuts section's key.
const SHORTCUTS: &str = "settings-shortcuts";

pub fn view(l: &Look, s: &App, top: f32, dark: bool) -> El {
    let close = el()
        .key("settings-close")
        .role("button")
        .label("Close Settings")
        .help("Close (Esc)")
        .size(32.0, 32.0)
        .radius(16.0)
        .center()
        .border(1.0, l.border)
        .fill(l.surface)
        .hover(l.hover)
        .press_scale(0.97)
        .cursor(rune::Cursor::Pointer)
        .on_press(toggle)
        .child(icon(&XMARK, 16.0).color(l.text));
    let page = col()
        .key("settings-page")
        .w_full()
        .max_w(COLUMN)
        .px(16.0)
        .pt(top + 40.0)
        .pb(40.0)
        .child(row().w_full().pb(40.0).center_y().justify_between().child(text("Settings").font(TITLE).color(l.text)).child(close))
        .child(lensing(l, s, dark))
        .child(group(
            l,
            vec![
                row_switch(l, "Snap to Grid", "snap-switch", s.snap, |s| crate::prefs::set_snap(s, !s.snap)),
                row_switch(l, "Fancy deletions", "fancy-delete-switch", s.fancy_deletions(), |s| {
                    let on = !s.fancy_deletions();
                    crate::prefs::set_fancy_deletions(s, on);
                }),
            ],
        ))
        .child(section(l, "Palettes", palettes(l, s)))
        .child(section(l, "Keyboard shortcuts", shortcuts(l)).key(SHORTCUTS))
        .child(section(
            l,
            "Voidmesh",
            vec![link(l, "settings-feedback", "Send feedback", |_, tx| {
                let _ = tx.open_url("mailto:dw@danielwargh.com?subject=Feedback%20on%20voidmesh");
            })],
        ));
    look::own_gestures(
        el().key("settings")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .fill(l.background)
            // A press on the page must not fall through to the canvas.
            .on_press(|_: &mut App| {})
            .child(col().key("settings-scroll").w_full().h_full().scroll(ScrollSpec { stick_bottom: false }).items_center().child(page)),
    )
}

/// `.desktop-settings-section`: an `h2` over a group, 32 pt below the one before.
fn section(l: &Look, title: &str, rows: Vec<El>) -> El {
    col().w_full().pt(32.0).gap(12.0).child(text(title.to_string()).font(HEADING).color(l.text_value)).child(group(l, rows))
}

/// `.desktop-settings-group`: rows in a bordered surface (radius 8), a hairline between rows.
fn group(l: &Look, rows: Vec<El>) -> El {
    let n = rows.len();
    let mut g = col().w_full().radius(8.0).clip_rounded(8.0).border(1.0, l.border).fill(l.surface);
    for (i, r) in rows.into_iter().enumerate() {
        g = g.child(r);
        if i + 1 < n {
            g = g.child(el().w_full().h(1.0).fill(l.border));
        }
    }
    g
}

/// A row's words: a label, and a description under it when there's one.
fn words(l: &Look, label: &str, desc: Option<&str>) -> El {
    let mut c = col().grow(1.0).shrink().gap(2.0).child(text(label.to_string()).font(LABEL).color(l.text_label).truncate());
    if let Some(d) = desc {
        c = c.child(text(d.to_string()).font(DESC).color(l.text_desc).truncate());
    }
    c
}

fn line(l: &Look, label: &str, desc: Option<&str>, control: El) -> El {
    row().w_full().min_h(ROW_H).px(16.0).py(8.0).gap(20.0).center_y().child(words(l, label, desc)).child(control)
}

/// A checkbox row with `switch` (`.desktop-settings-row input[switch]`): a 32×18 track, primary
/// when on, a 14 pt white knob.
fn row_switch(l: &Look, label: &str, key: &'static str, on: bool, flip: fn(&mut App)) -> El {
    let knob = el().size(14.0, 14.0).radius(7.0).fill(Color::WHITE).shadow(1.0, 3.0, Color::BLACK.alpha(0.35));
    let track = row().size(32.0, 18.0).radius(9.0).px(2.0).center_y().fill(if on { l.primary } else { l.switch_off });
    let track = if on { track.justify_end() } else { track.justify_start() };
    line(l, label, None, track.child(knob))
        .key(key)
        .role("switch")
        .label(label)
        .checked(on)
        .focusable(true)
        .cursor(rune::Cursor::Pointer)
        .on_press(flip)
}

/// `.desktop-settings-action`: a link row with a chevron.
fn link(l: &Look, key: &'static str, label: &str, press: fn(&mut App, &mut Tx)) -> El {
    line(l, label, None, icon(&CHEVRON_RIGHT, 16.0).color(l.text_muted)).key(key).role("link").label(label).cursor(rune::Cursor::Pointer).on_press_tx(press)
}

// ------------------------------------------------------------------ canvas lensing

/// The web's preview sprites: Off, Subtle and Extreme side by side, dark and light.
const SPRITE_DARK: &[u8] = include_bytes!("../../assets/lensing/dark.png");
const SPRITE_LIGHT: &[u8] = include_bytes!("../../assets/lensing/light.png");

/// A preview and its glow: the same picture with `saturate(1.35)` baked in.
#[derive(Clone)]
struct Preview {
    image: Pixels,
    glow: Pixels,
}

thread_local! {
    /// The three previews cut from each sprite, decoded once: `[dark, light]`.
    static PREVIEWS: OnceCell<[Vec<Preview>; 2]> = const { OnceCell::new() };
}

fn previews(dark: bool) -> Vec<Preview> {
    PREVIEWS.with(|p| p.get_or_init(|| [cut(SPRITE_DARK), cut(SPRITE_LIGHT)])[usize::from(!dark)].clone())
}

fn cut(png: &[u8]) -> Vec<Preview> {
    let Ok(img) = image::load_from_memory(png).map(|i| i.to_rgba8()) else { return Vec::new() };
    let (w, h) = img.dimensions();
    let third = w / 3;
    (0..3)
        .map(|i| {
            let part = image::imageops::crop_imm(&img, i * third, 0, third, h).to_image().into_raw();
            let (image, glow) = (Pixels::new(), Pixels::new());
            glow.set(third, h, saturate(&part, 1.35));
            image.set(third, h, part);
            Preview { image, glow }
        })
        .collect()
}

/// CSS `saturate(k)` (the Filter Effects matrix) on straight RGBA8.
fn saturate(rgba: &[u8], k: f32) -> Vec<u8> {
    let m = [
        [0.213 + 0.787 * k, 0.715 - 0.715 * k, 0.072 - 0.072 * k],
        [0.213 - 0.213 * k, 0.715 + 0.285 * k, 0.072 - 0.072 * k],
        [0.213 - 0.213 * k, 0.715 - 0.715 * k, 0.072 + 0.928 * k],
    ];
    rgba.chunks_exact(4)
        .flat_map(|p| {
            let c = [f32::from(p[0]), f32::from(p[1]), f32::from(p[2])];
            let ch = |r: [f32; 3]| (r[0] * c[0] + r[1] * c[1] + r[2] * c[2]).round().clamp(0.0, 255.0) as u8;
            [ch(m[0]), ch(m[1]), ch(m[2]), p[3]]
        })
        .collect()
}

/// `.settings-lensing-previews`: a legend over three preview cards (aspect 1.55, radius 20) with
/// a label under each. The chosen one's label brightens and its glow fades in behind it: the
/// same picture saturated 1.35×, inset 8% then scaled 1.2× wide and 1.3× tall, blurred 32 pt, at
/// 50% opacity (30% in dark) over 180 ms.
fn lensing(l: &Look, s: &App, dark: bool) -> El {
    let pics = previews(dark);
    // The card's width from the column's (768 at most, 16 pt gutters, two 12 pt gaps), to place
    // the glow, which overflows the card, in points.
    let card_w = ((s.canvas[2].min(COLUMN) - 32.0 - 24.0) / 3.0).max(1.0);
    let card_h = card_w / 1.55;
    let (gw, gh) = (card_w * 0.84 * 1.2, card_h * 0.84 * 1.3);
    let (gx, gy) = ((card_w - gw) / 2.0, (card_h - gh) / 2.0);
    let glow_on = if dark { 0.3 } else { 0.5 };
    let options = [(Lensing::Off, "Off"), (Lensing::Subtle, "Subtle"), (Lensing::Extreme, "Extreme")];
    let grid = options.into_iter().enumerate().fold(row().w_full().gap(12.0), |g, (i, (v, label))| {
        let on = s.lens == v;
        let mut glow = el().key(format!("lens-glow-{label}")).absolute(gx, gy).size(gw, gh).blur(32.0).opacity(if on { glow_on } else { 0.0 })
            // `transition: opacity 180ms ease-out`.
            .opacity_motion(rune::Anim::new(rune::Curve::tween(0.18, rune::Easing::EASE_OUT)))
            .inert();
        let mut card = el().w_full().aspect_ratio(1.55).radius(20.0).clip_rounded(20.0).border(1.0, l.border);
        if let Some(p) = pics.get(i) {
            glow = glow.pixels_fit(&p.glow, rune::SurfaceFit::Fill);
            card = card.pixels_fit(&p.image, rune::SurfaceFit::Fill);
        }
        g.child(
            col()
                .key(format!("lens-{label}"))
                .role("radio")
                .label(format!("Canvas lensing: {label}"))
                .checked(on)
                .focusable(true)
                .grow(1.0)
                .w(0.0)
                .gap(8.0)
                .items_center()
                .cursor(rune::Cursor::Pointer)
                .on_press(move |s: &mut App| crate::prefs::set_lensing(s, v))
                .child(el().w_full().aspect_ratio(1.55).child(glow).child(card))
                .child(text(label).font(DESC).color(if on { l.text_label } else { l.text_muted })),
        )
    });
    col().w_full().pb(20.0).gap(12.0).child(text("Canvas lensing").font(LABEL).color(l.text_label)).child(grid)
}

// ------------------------------------------------------------------ desktop sections

fn palettes(l: &Look, s: &App) -> Vec<El> {
    if s.palettes.is_empty() {
        return vec![line(l, "No palettes yet", Some("Palettes you make, load or paste are kept here for every workspace."), el())];
    }
    let srgb = |v: f32| if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) };
    s.palettes
        .iter()
        .map(|p| {
            let chips = p.colors.iter().fold(row().gap(4.0), |r, c| r.child(el().size(16.0, 16.0).radius(8.0).border(1.0, l.border).fill(Color { r: srgb(c[0]), g: srgb(c[1]), b: srgb(c[2]), a: c[3] })));
            let id = p.id.clone();
            let delete = icon_button(l, format!("pal-del-{}", p.id), "Delete palette", &TRASH, move |s, _| s.delete_palette(&id));
            row().w_full().min_h(ROW_H).pl(16.0).pr(10.0).gap(16.0).center_y().child(words(l, &p.name, None)).child(chips).child(delete)
        })
        .collect()
}

/// `.keybind-item`: the action, and its keys as `.kbd` chips.
fn shortcuts(l: &Look) -> Vec<El> {
    const ROWS: &[(&str, &[&str])] = &[
        ("Open media or a .vdmsh file", &["⌘", "O"]),
        ("Workspaces", &["⇧", "⌘", "O"]),
        ("New workspace", &["⌘", "T"]),
        ("Close workspace", &["⌘", "W"]),
        ("Switch workspace", &["⌘", "1–9"]),
        ("Next / previous workspace", &["⌃", "Tab"]),
        ("Export workspace as .vdmsh", &["⇧", "⌘", "S"]),
        ("Undo", &["⌘", "Z"]),
        ("Redo", &["⇧", "⌘", "Z"]),
        ("Settings", &["⌘", ","]),
        ("Keyboard shortcuts", &["?"]),
        ("Copy image", &["⌘", "C"]),
        ("Copy effects", &["⌃", "⌘", "C"]),
        ("Paste media, or effects onto the selection", &["⌘", "V"]),
        ("Duplicate", &["⌘", "D"]),
        ("Delete", &["⌫"]),
        ("Save or export the selection", &["⌘", "E"]),
        ("Select all", &["⌘", "A"]),
        ("Previous / next item", &["↑", "↓"]),
        ("Fit the selection", &["F"]),
        ("Zoom to 100%", &["⌘", "0"]),
        ("Show original", &["O"]),
        ("Preserve colors", &["P"]),
        ("Reverse palette", &["R"]),
        ("Play or pause", &["Space"]),
        ("Seek", &["←", "→"]),
        ("Mute", &["M"]),
        ("Snap to grid", &["G"]),
        ("Canvas lensing", &["L"]),
        ("Hide the controls", &["\\"]),
        ("Performance overlay", &["D"]),
    ];
    ROWS.iter()
        .map(|(what, keys)| {
            let chips = keys.iter().fold(row().gap(4.0), |r, k| r.child(row().min_w(20.0).h(20.0).px(4.0).radius(4.0).center().fill(l.kbd).child(text(*k).font(KBD).color(l.text_muted))));
            row().w_full().h(40.0).px(16.0).gap(16.0).center_y().child(words(l, what, None)).child(chips)
        })
        .collect()
}
