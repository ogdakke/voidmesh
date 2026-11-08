//! The view. The canvas fills the window and everything else floats on it, in the web app's
//! styling: chrome at the corners (Add and the workspace tabs top-left, undo/redo bottom-left, view
//! controls and the zoom readout bottom-right), and the selection's own controls riding along
//! with it (its label bar above, the inspector beside, playback on the GIF itself).

mod canvas;
pub mod export_panel;
pub mod inspector;
pub mod library;
mod menu;
pub mod palette_editor;
pub mod settings;
pub mod look;
pub mod tick_slider;
pub mod tabs;
mod widgets;

use rune::{Color, Cx, El, FileDialogOptions, TextStyle, Tx, col, el, icon, row, text};

use crate::state::App;
use look::{Look, MEDIUM, SMALL};
use widgets::{FIT, GEAR, MUTED, PAUSE, PLAY, PLUS, REDO, SAVE, SOUND, TRASH, UNDO, icon_button};

/// The zoom readout is mono and tabular in the web app.
const MONO: TextStyle = TextStyle::new(13.0, 500.0).mono().features("'tnum' 1");
/// The media time label, a size under body text, with tabular digits.
const TIME: TextStyle = TextStyle::new(12.0, 400.0).features("'tnum' 1");
/// Room per character of a time label (12 pt tabular digits, with headroom for the colons).
const TIME_CHAR: f32 = 7.5;

pub fn view(s: &App, cx: &mut Cx<App>) -> El {
    let dark = cx.system_dark();
    let l = Look::new(dark);
    let insets = cx.chrome_insets();
    let mut root = el().key("root").on_key_up(crate::keys::on_key_up).on_paste_content(|s: &mut App, c: &rune::ClipboardContent, _: &mut Tx| crate::clip::paste(s, c)).w_full().h_full().fill(l.studio);
    root = root.child(canvas::surface(&l, s));
    if s.entities.is_empty() {
        root = root.child(empty_state(&l));
    }
    // The titlebar band: it moves the window, and floating UI keeps out of it. Under the chrome
    // it's a frosted bar, so the tabs read over busy media.
    let mut band = el().key("titlebar").absolute(0.0, 0.0).w_full().h(insets.height).window_drag().on_layout(|s: &mut App, r| s.top_inset = r[3]);
    if !s.bare && insets.height > 0.0 {
        band = band.backdrop_blur(16.0).fill(l.bar).child(el().absolute(0.0, insets.height - 1.0).w_full().h(1.0).fill(l.border).inert());
    }
    root = root.child(band);
    // `\` hides the chrome: the canvas alone, as the web's fullscreen.
    if let Some(sel) = s.bounds(&s.selection).filter(|_| !s.bare) {
        let r = s.cam.screen_rect(sel);
        if s.drag.as_ref().is_none_or(|m| !m.moved) && s.marquee.is_none() {
            root = root.child(entity_bar(&l, s, r, insets.height));
            if let Some(p) = s.focus().map(|e| e.params.clone()) {
                root = root.child(inspector::panel(&l, s, &p, r));
            }
        }
        if s.selection.len() == 1
            && let Some(e) = s.focus().filter(|e| e.asset.animated())
            && let Some(media) = media_controls(&l, s, e, r)
        {
            root = root.child(media);
        }
        // Over the playback bar it may hang across.
        if s.drag.as_ref().is_none_or(|m| !m.moved)
            && s.marquee.is_none()
            && let Some(panel) = export_panel::panel(&l, s, r, insets.height)
        {
            root = root.child(panel);
        }
    }
    if !s.bare {
        root = root.child(top_left(&l, s, insets)).child(bottom_left(&l, s)).child(bottom_right(&l, s, cx.env().scale));
    }
    if s.drop_hover {
        // `[data-drop-target]`: a 2 px primary outline inset into the canvas.
        root = root.child(el().key("drop").absolute(0.0, 0.0).w_full().h_full().p_all(4.0).inert().child(el().w_full().h_full().radius(16.0).border(2.0, l.primary)));
    }
    if s.settings {
        root = root.child(settings::view(&l, s, insets.height, dark)).child(el().key("titlebar-over").absolute(0.0, 0.0).w_full().h(insets.height).window_drag());
    } else if let Some(list) = &s.library {
        root = root.child(library::view(&l, s, list, insets.height)).child(el().key("titlebar-over").absolute(0.0, 0.0).w_full().h(insets.height).window_drag());
    }
    if let Some(t) = s.toasts.last() {
        root = root.child(
            row()
                .key("toast")
                .absolute(0.0, 0.0)
                .w_full()
                .h_full()
                .justify_center()
                .items_end()
                .pb(64.0)
                .inert()
                .child(l.floating(row().px(16.0).h(40.0).center_y().radius(12.0).child(text(t.text.clone()).font(MEDIUM).color(l.text)))),
        );
    }
    root
}

trait PadAll {
    fn p_all(self, v: f32) -> Self;
}

impl PadAll for El {
    fn p_all(self, v: f32) -> Self {
        self.px(v).py(v)
    }
}

/// Everything the canvas takes: media and workspaces.
pub fn accepted_extensions() -> Vec<&'static str> {
    [crate::media::IMAGE_EXTENSIONS, crate::media::VIDEO_EXTENSIONS, crate::workspace::EXTENSIONS].concat()
}

/// Add and ⌘O: a workspace opens, media lands on the canvas.
pub fn open_any(_: &mut App, tx: &mut Tx) {
    let opts = FileDialogOptions { title: "Open".into(), ..Default::default() }.filter("Media and workspaces", &accepted_extensions());
    tx.open_file(opts, |s: &mut App, r, _| match r {
        Ok(Some(path)) => s.import(vec![path], None),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

/// ⌘S: workspaces save as they change; this saves now and says so.
pub fn save(s: &mut App) {
    if s.saver.is_none() {
        return s.toast("Workspaces aren't kept in this run");
    }
    s.persist_if_dirty();
    s.toast("Saved. Changes save as you work");
}

/// ⇧⌘S: write the workspace to a `.vdmsh` file, which the web app opens too.
pub fn export_workspace(s: &mut App, tx: &mut Tx) {
    if s.entities.is_empty() {
        return s.toast("Nothing to export");
    }
    let opts = FileDialogOptions { title: "Export workspace".into(), file_name: Some(format!("{}.vdmsh", s.tab().name)), ..Default::default() }.filter("Voidmesh workspace", &["vdmsh"]);
    tx.save_file(opts, |s: &mut App, r, _| match r {
        Ok(Some(mut path)) => {
            if path.extension().is_none() {
                path.set_extension("vdmsh");
            }
            s.export_workspace(path);
        }
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

pub fn export_selected(s: &mut App, tx: &mut Tx) {
    export_selected_as(s, tx, "png");
}

/// Save the focused entity's rendered image; the dialog starts on `ext` (png or jpg).
pub fn export_selected_as(s: &mut App, tx: &mut Tx, ext: &str) {
    let Some(e) = s.focus() else { return };
    let id = e.id;
    let stem = e.name.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or_else(|| e.name.clone());
    let base = FileDialogOptions { title: "Save image".into(), file_name: Some(format!("{stem}.{ext}")), ..Default::default() };
    let opts = if ext == "png" { base.filter("PNG", &["png"]).filter("JPEG", &["jpg", "jpeg"]) } else { base.filter("JPEG", &["jpg", "jpeg"]).filter("PNG", &["png"]) };
    tx.save_file(opts, move |s: &mut App, r, _| match r {
        Ok(Some(path)) => s.exports.push(crate::state::Export { entity: id, path: Some(path) }),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

/// A small secondary pill (`.ui-button[data-size="sm"]`): 28 pt, hairline, surface fill.
fn pill(l: &Look, e: El) -> El {
    look::own_gestures(e).h(28.0).radius(14.0).border(1.0, l.border).fill(l.surface).shadow(4.0, 12.0, Color::BLACK.alpha(0.07))
}

/// Add and the workspace tabs, in the titlebar band beside the traffic lights.
fn top_left(l: &Look, s: &App, insets: rune::ChromeInsets) -> El {
    let add = l.primary_button(
        el().key("add")
            .role("button")
            .label("Add")
            .focusable(true)
            .h(28.0)
            .px(12.0)
            .radius(14.0)
            .center()
            .press_scale(0.97)
            .cursor(rune::Cursor::Pointer)
            .on_press_tx(open_any)
            .child(row().gap(6.0).center_y().child(icon(&PLUS, 15.0).color(Color::WHITE)).child(text("Add").font(MEDIUM).color(Color::WHITE))),
    );
    // The row is as tall as the tab strip, whose padding keeps the active tab's shadow: centred
    // on the band, the 28 pt pills share the traffic lights' middle, with the band's 12 pt
    // above and below them repeated after the lights.
    let pad = tabs::PAD_Y;
    let (x, y) = if insets.height > 0.0 { (insets.leading + 12.0, (insets.height - 28.0) / 2.0 - pad) } else { (12.0, 12.0 - pad) };
    // The tabs take what the titlebar has left after Add and room for progress, short of the
    // window's right edge.
    let add_w = 12.0 + 15.0 + 6.0 + rune::text::measure("Add", &[], MEDIUM, None).0 + 12.0;
    let busy = if s.loading().is_some() || s.pending > 0 { 220.0 } else { 0.0 };
    let room = s.canvas[2] - x - add_w - 10.0 - busy - 24.0;
    let mut r = look::own_gestures(row().key("top-left")).absolute(x, y).gap(10.0).center_y().child(add).child(tabs::strip(l, s, room));
    if let Some(p) = tabs::progress(l, s) {
        r = r.child(p);
    } else if s.pending > 0 {
        r = r.child(text(format!("Importing {}…", s.pending)).font(SMALL).color(l.text_muted));
    }
    r
}

/// `.undo-redo`: one pill holding both buttons.
fn bottom_left(l: &Look, s: &App) -> El {
    let b = |key: &'static str, label: &'static str, glyph: &'static rune::Icon, enabled: bool, f: fn(&mut App)| {
        let mut e = el().key(key).role("button").label(label).size(28.0, 28.0).center().cursor(rune::Cursor::Pointer).help(label).child(icon(glyph, 16.0).color(if enabled { l.text } else { l.text_muted.alpha(0.6) }));
        if enabled {
            e = e.on_press(f);
        }
        e
    };
    let group = pill(l, row().key("undo-redo").gap(8.0).px(2.0).center_y().child(b("undo", "Undo (⌘Z)", &UNDO, !s.undo.is_empty(), |s| {
        s.undo();
    })).child(b("redo", "Redo (⇧⌘Z)", &REDO, !s.redo.is_empty(), |s| {
        s.redo();
    })));
    let r = row().key("bottom-left").pin(Some(12.0), None, None, Some(12.0)).gap(8.0).items_end().child(group);
    match export_panel::queue(l, s) {
        Some(q) => r.child(q),
        None => r,
    }
}

fn bottom_right(l: &Look, s: &App, device_scale: f32) -> El {
    let pct = (s.cam.scale * device_scale * 100.0).round();
    let toggle = |key: &'static str, label: &str, help: &'static str, on: bool, f: fn(&mut App)| {
        let mut e = pill(l, el().key(key).role("switch").label(help).checked(on).px(12.0).center().hover(l.hover).press_scale(0.97).cursor(rune::Cursor::Pointer).help(help).on_press(f).child(text(label.to_string()).font(MEDIUM).color(if on { l.text } else { l.text_muted })));
        if on {
            e = e.border(1.0, l.pressed_ring);
        }
        e
    };
    let mut center = pill(l, el().key("fit").role("button").label("Center selection in view (F)").size(28.0, 28.0).center().hover(l.hover).cursor(rune::Cursor::Pointer).help("Center selection in view (F)").child(icon(&FIT, 15.0).color(l.text)));
    if !s.selection.is_empty() {
        center = center.on_press(|s: &mut App| s.fit_selection());
    } else {
        center = center.dim(0.5);
    }
    let zoom = pill(
        l,
        el().key("zoom").role("button").label("Zoom to 100%").px(10.0).center().hover(l.hover).press_scale(0.97).cursor(rune::Cursor::Pointer).help("Zoom to 100% (⌘0)").on_press(move |s: &mut App| s.reset_zoom(device_scale)).child(text(format!("{pct}%")).font(MONO).color(l.text)),
    );
    let gear = pill(l, el().key("settings-open").role("button").label("Settings (⌘,)").size(28.0, 28.0).center().hover(l.hover).cursor(rune::Cursor::Pointer).help("Settings (⌘,)").on_press(settings::toggle).child(icon(&GEAR, 16.0).color(l.text)));
    let mut r = row().key("bottom-right").pin(None, None, Some(12.0), Some(12.0)).gap(8.0).center_y();
    // Only what's on shows here; Settings holds the switches.
    if s.snap {
        r = r.child(toggle("snap", "Snap", "Snap to grid (G)", true, |s| crate::prefs::set_snap(s, false)));
    }
    r.child(gear).child(center).child(zoom)
}

/// Above the selection: its name (the web app's entity label) and what you can do to it.
fn entity_bar(l: &Look, s: &App, r: [f32; 4], top: f32) -> El {
    let label = match s.selection.len() {
        1 => s.focus().map(|e| e.name.clone()).unwrap_or_default(),
        n => format!("{n} items selected"),
    };
    // Only the actions with no other home on screen: playback rides on the clip, Original sits
    // in the inspector, and Duplicate is ⌘D and in the context menu.
    let anim = s.selected().any(|e| e.asset.animated());
    let actions = row()
        .gap(0.0)
        .center_y()
        .child(icon_button(l, "bar-save", if s.selection.len() == 1 && anim { "Export… (⌘E)" } else { "Save as PNG (⌘E)" }, &SAVE, export_panel::save_or_export))
        .child(icon_button(l, "bar-delete", "Delete (⌫)", &TRASH, |s, _| s.delete_selection()));
    let bar = l.floating(row().key("entity-bar").gap(4.0).pl(14.0).pr(4.0).h(BAR_H).radius(20.0).center_y().child(text(label).font(MEDIUM).color(l.text).truncate().max_w(320.0)).child(actions));
    el().key("entity-bar-wrap").absolute(r[0].max(EDGE), entity_bar_y(r, top)).instant_changes().child(bar)
}

/// Height of the floating bars that ride with the selection.
const BAR_H: f32 = 40.0;
/// Space between those bars and what they sit against.
const BAR_GAP: f32 = 8.0;
/// Floating UI keeps this far from the canvas edges.
const EDGE: f32 = 12.0;
/// The smallest visible clip area that holds the playback bar inside it with a usable track.
const MEDIA_INLINE_MIN: [f32; 2] = [360.0, 160.0];
/// The playback bar's width once it moves below a clip too small to hold it.
const MEDIA_DOCKED_W: f32 = 300.0;

/// The entity bar's top: above the selection, held below the titlebar band (`top`), where it
/// then overlaps the selection's top edge.
fn entity_bar_y(r: [f32; 4], top: f32) -> f32 {
    (r[1] - BAR_H - 10.0).max(top.max(EDGE) + BAR_GAP)
}

/// Where the playback bar goes for a clip at screen rect `r`, as `(x, y, width)`; `None` when
/// the clip is out of view. It works from the visible part of the clip: along its bottom edge
/// when that part has room below the entity bar, else docked under the clip (and under the
/// entity bar), so the two never overlap and neither crosses the titlebar band.
fn media_place(r: [f32; 4], canvas: [f32; 2], top: f32) -> Option<(f32, f32, f32)> {
    let floor = top.max(EDGE) + BAR_GAP;
    let (left, right, bottom) = (r[0].max(0.0), (r[0] + r[2]).min(canvas[0]), r[1] + r[3]);
    if right <= left || bottom <= top || r[1] >= canvas[1] {
        return None;
    }
    let below_label = entity_bar_y(r, top) + BAR_H + BAR_GAP;
    let vis_bottom = bottom.min(canvas[1]);
    let room = vis_bottom - r[1].max(below_label).max(floor);
    if right - left >= MEDIA_INLINE_MIN[0] && room >= MEDIA_INLINE_MIN[1] {
        let w = (right - left - 24.0).min(480.0);
        return Some((left + (right - left - w) / 2.0, vis_bottom - BAR_H - EDGE, w));
    }
    let max_x = (canvas[0] - MEDIA_DOCKED_W - EDGE).max(EDGE);
    let x = if right - left >= MEDIA_DOCKED_W {
        // A wide clip that is short on screen: centred under its visible span.
        left + (right - left - MEDIA_DOCKED_W) / 2.0
    } else if inspector::place(r, canvas, top).0 > r[0] {
        // The inspector takes the right: grow left from the clip's right edge.
        r[0] + r[2] - MEDIA_DOCKED_W
    } else {
        r[0]
    };
    let y = (bottom + BAR_GAP).max(below_label).min(canvas[1] - BAR_H - EDGE);
    Some((x.clamp(EDGE, max_x), y, MEDIA_DOCKED_W))
}

/// Playback for the selected clip: play/pause, a scrubber and the time (`media_place`).
fn media_controls(l: &Look, s: &App, e: &crate::state::Entity, r: [f32; 4]) -> Option<El> {
    let id = e.id;
    let dur = e.asset.duration.as_secs_f64().max(1e-3);
    let t = (e.play_t / dur) as f32;
    let (x, y, w) = media_place(r, [s.canvas[2], s.canvas[3]], s.top_inset)?;
    let scrub = el()
        .key("scrub")
        .role("slider")
        .label("Playback position")
        .grow(1.0)
        .h(24.0)
        .center_y()
        .cursor(rune::Cursor::Pointer)
        .range_value(e.play_t.min(dur), 0.0, dur)
        .focusable(true)
        .focus_ring(2.0, 2.0, l.primary)
        .on_key(move |s: &mut App, k: &rune::KeyEvent, tx: &mut Tx| {
            if !scrub_key(s, id, k) {
                return false;
            }
            tx.instant();
            true
        })
        .on_drag(move |s: &mut App, d: &mut rune::Drag, tx: &mut Tx| {
            if let Some(e) = s.entity_mut(id) {
                let dur = e.asset.duration.as_secs_f64();
                if d.phase == rune::Phase::Down {
                    d.data = if e.playing { 1.0 } else { 0.0 };
                    e.playing = false;
                }
                e.seek_to(f64::from((d.x / d.w).clamp(0.0, 0.999)) * dur);
                if d.phase == rune::Phase::Up {
                    e.playing = d.data > 0.5;
                }
            }
            tx.instant();
        })
        .child(el().w_full().h(4.0).radius(2.0).fill(l.indicator).child(el().h(4.0).w_frac(t.clamp(0.0, 1.0)).radius(2.0).fill(l.text)));
    let play = icon_button(l, "media-play", if e.playing { "Pause" } else { "Play" }, if e.playing { &PAUSE } else { &PLAY }, move |s, _| {
        if let Some(e) = s.entity_mut(id) {
            e.playing = !e.playing;
        }
    });
    // As the web: the current time left of the track, the duration right of it. The current
    // time sits in a fixed, right-aligned slot as wide as the duration's text, so the bar never
    // shifts as digits change.
    let total = media_time(dur);
    let slot = total.len() as f32 * TIME_CHAR;
    let now = row().w(slot).justify_end().child(text(media_time(e.play_t.min(dur))).font(TIME).color(l.text_strong));
    let end = row().w(slot).child(text(total).font(TIME).color(l.text_muted));
    let mut bar = row().key("media").absolute(x, y).w(w).h(BAR_H).pl(4.0).pr(12.0).gap(8.0).radius(20.0).center_y().instant_changes().child(play).child(now).child(scrub).child(end);
    if e.has_audio() {
        let (label, glyph) = if e.muted { ("Unmute (M)", &MUTED) } else { ("Mute (M)", &SOUND) };
        bar = bar.pr(4.0).child(icon_button(l, "media-mute", label, glyph, move |s, _| {
            if let Some(e) = s.entity_mut(id) {
                e.muted = !e.muted;
            }
        }));
    }
    Some(l.floating(bar))
}

/// Keys on the focused playback bar, as the web's: Space plays or pauses, `,` and `.` step a
/// frame, ←/→ (and ↓/↑) seek a second (Shift: ten), Page Up/Down ten, Home and End jump to the
/// ends. True when the key was the bar's.
fn scrub_key(s: &mut App, id: u32, k: &rune::KeyEvent) -> bool {
    use rune::Key;
    let big = if k.mods.shift { 10.0 } else { 1.0 };
    match &k.key {
        Key::Text(t) if t == " " => {
            if let Some(e) = s.entity_mut(id) {
                e.playing = !e.playing;
            }
        }
        Key::Text(t) if t == "." => s.step_frame(id, 1),
        Key::Text(t) if t == "," => s.step_frame(id, -1),
        Key::Right | Key::Up => s.seek_clip(id, big),
        Key::Left | Key::Down => s.seek_clip(id, -big),
        Key::PageUp => s.seek_clip(id, 10.0),
        Key::PageDown => s.seek_clip(id, -10.0),
        Key::Home => s.seek_clip_to(id, 0.0),
        Key::End => s.seek_clip_to(id, f64::INFINITY),
        _ => return false,
    }
    true
}

/// The web's media time: `S:cc` under a minute, `M:SS:cc` from one.
pub fn media_time(secs: f64) -> String {
    if !secs.is_finite() || secs < 0.0 {
        return "0:00".into();
    }
    let cs = (secs * 100.0).round() as u64;
    let (s, c) = (cs / 100, cs % 100);
    if s < 60 { format!("{s}:{c:02}") } else { format!("{}:{:02}:{c:02}", s / 60, s % 60) }
}

fn empty_state(l: &Look) -> El {
    col()
        .key("empty")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .center()
        .gap(8.0)
        .inert()
        .child(text("Voidmesh").font(TextStyle::new(28.0, 600.0)).color(l.text))
        .child(text("Drop images, videos, GIFs, SVGs or a .vdmsh workspace").font(look::BODY).color(l.text_muted))
        .child(text("All local, nothing gets uploaded. Saved as you go.").font(look::BODY).color(l.text_faint))
}

#[cfg(test)]
mod tests {
    use super::{BAR_H, MEDIA_DOCKED_W, entity_bar_y, media_place};

    const CANVAS: [f32; 2] = [1400.0, 900.0];
    /// The titlebar band's height.
    const TOP: f32 = 52.0;

    fn place(r: [f32; 4]) -> (f32, f32, f32) {
        media_place(r, CANVAS, TOP).expect("in view")
    }

    /// The playback bar starts below the entity bar and below the titlebar band.
    fn clear_of_chrome(r: [f32; 4], y: f32) {
        assert!(y >= TOP, "under the titlebar: y {y}");
        assert!(y >= entity_bar_y(r, TOP) + BAR_H, "over the entity bar: y {y}");
    }

    #[test]
    fn playback_rides_inside_a_large_clip() {
        let r = [100.0, 200.0, 600.0, 400.0];
        let (x, y, w) = place(r);
        assert_eq!(w, 480.0);
        assert!(x > r[0] && x + w < r[0] + r[2]);
        assert!(y > r[1] && y + BAR_H < r[1] + r[3]);
    }

    #[test]
    fn playback_docks_below_a_small_clip_at_full_width() {
        let r = [400.0, 300.0, 120.0, 80.0];
        let (x, y, w) = place(r);
        assert_eq!(w, MEDIA_DOCKED_W);
        assert!(y >= r[1] + r[3]);
        // The inspector takes the right, so the bar grows left from the clip's right edge.
        assert_eq!(x + w, r[0] + r[2]);
    }

    #[test]
    fn docked_playback_stays_in_the_canvas() {
        let (x, y, w) = place([-50.0, 880.0, 100.0, 60.0]);
        assert!(x >= 12.0 && x + w <= CANVAS[0] - 12.0);
        assert!(y + BAR_H <= CANVAS[1] - 12.0);
    }

    #[test]
    fn a_clip_mostly_under_the_titlebar_docks_below_the_entity_bar() {
        // Only a sliver shows: the entity bar is held under the band, overlapping the clip.
        let r = [60.0, -400.0, 650.0, 540.0];
        let (_, y, _) = place(r);
        clear_of_chrome(r, y);
        assert!(y >= r[1] + r[3]);
    }

    #[test]
    fn a_clip_whose_bottom_edge_is_in_the_band_keeps_its_playback_out_of_it() {
        let r = [120.0, -400.0, 650.0, 470.0];
        let (_, y, _) = place(r);
        clear_of_chrome(r, y);
    }

    #[test]
    fn a_tall_clip_running_off_the_top_keeps_playback_inline_at_its_visible_bottom() {
        let r = [100.0, -600.0, 800.0, 1100.0];
        let (_, y, _) = place(r);
        clear_of_chrome(r, y);
        assert!(y + BAR_H <= r[1] + r[3]);
    }

    #[test]
    fn a_clip_running_off_the_bottom_keeps_playback_on_screen() {
        let (_, y, _) = place([100.0, 300.0, 800.0, 1200.0]);
        assert!(y + BAR_H <= CANVAS[1] - 12.0);
    }

    #[test]
    fn number_styles_set_figures_at_one_width() {
        for style in [super::TIME, super::MONO, super::look::NUMBER] {
            let w = |s: &str| rune::text::measure(s, &[], style, None).0;
            assert_eq!(w("11:11"), w("44:44"));
            assert_eq!(w("11:11"), w("08:63"));
        }
    }

    #[test]
    fn no_playback_for_a_clip_out_of_view() {
        assert!(media_place([100.0, -600.0, 400.0, 600.0], CANVAS, TOP).is_none());
        assert!(media_place([1500.0, 300.0, 400.0, 300.0], CANVAS, TOP).is_none());
    }
}
