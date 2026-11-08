//! Video/GIF export UI (FEATURES.md §6.8): a floating panel that hangs under the selection's
//! entity bar, and the export queue's indicator beside undo/redo. Both stay in the window.

use rune::{Color, Drag, El, FileDialogOptions, Icon, Phase, PopupMenu, Tx, col, el, icon, row, text};

use super::PadAll;
use super::look::{LARGE, Look, MEDIUM, NUMBER, SMALL};
use super::widgets::{CHEVRON_DOWN, CHEVRON_RIGHT};
use crate::export_video::{self as ev, Dither, Format, JobInfo, Options, Panel, Quality, Resolution, Status};
use crate::state::App;

pub const WIDTH: f32 = 280.0;

static CLOSE: Icon = Icon {
    name: "CLOSE",
    view: 24.0,
    body: r#"<path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>"#,
};

/// The single selected entity, when it can export as video.
fn exportable_focus(s: &App) -> Option<u32> {
    if s.selection.len() != 1 {
        return None;
    }
    s.focus().filter(|e| ev::exportable(&e.asset)).map(|e| e.id)
}

/// Open the panel for the selection, or close it if it's open.
pub fn toggle(s: &mut App) {
    if s.export.panel.take().is_none() {
        open(s);
    }
}

/// Open the panel for the selection, when it can export as video.
pub fn open(s: &mut App) {
    let Some(id) = exportable_focus(s) else { return };
    // A video's own frame rate is the starting point, as on the web.
    if let Some(fps) = s.entity(id).and_then(|e| e.asset.video.as_ref()).and_then(|v| v.fps) {
        s.export.options.fps = (fps.round() as u32).clamp(1, ev::FPS_MAX);
    }
    s.export.panel = Some(Panel { entity: id, advanced: false });
}

/// The save button and ⌘E: animated media opens the export panel; stills save an image.
pub fn save_or_export(s: &mut App, tx: &mut Tx) {
    if exportable_focus(s).is_some() {
        toggle(s);
    } else {
        super::export_selected(s, tx);
    }
}

/// Ask where, then queue the export.
fn start(s: &mut App, tx: &mut Tx) {
    let Some(id) = s.export.panel.as_ref().map(|p| p.entity) else { return };
    let Some(e) = s.entity(id) else { return };
    let ext = s.export.options.format.ext();
    let stem = e.name.rsplit_once('.').map(|(a, _)| a.to_string()).unwrap_or_else(|| e.name.clone());
    let title = if s.export.options.format.is_gif() { "Export GIF" } else { "Export video" };
    let label = Format::LABELS[Format::ALL.iter().position(|f| *f == s.export.options.format).unwrap_or(0)];
    let opts = FileDialogOptions { title: title.into(), file_name: Some(format!("{stem}.{ext}")), ..Default::default() }.filter(label, &[ext]);
    tx.save_file(opts, move |s: &mut App, r, _| match r {
        Ok(Some(path)) => ev::enqueue(s, id, path),
        Ok(None) => {}
        Err(e) => s.toast(e.to_string()),
    });
}

// ------------------------------------------------------------------ controls

/// The inspector's slider shape over an export option; no undo (options aren't document state).
#[allow(clippy::too_many_arguments)]
fn slider(l: &Look, key: &'static str, label: &str, value: f32, shown: String, range: (f32, f32, f32), set: fn(&mut Options, f32)) -> El {
    const H: f32 = 32.0;
    let (min, max, step) = range;
    let t = ((value - min) / (max - min)).clamp(0.0, 1.0);
    let to_value = move |x: f32, w: f32| {
        let v = min + (x / w.max(1.0)).clamp(0.0, 1.0) * (max - min);
        ((v / step).round() * step).clamp(min, max)
    };
    el().key(key)
        .role("slider")
        .label(label)
        .range_value(f64::from(value), f64::from(min), f64::from(max))
        .range_step(f64::from(step))
        .focusable(true)
        .focus_ring(2.0, 2.0, l.primary)
        .on_step(move |s: &mut App, steps, _| set(&mut s.export.options, (value + steps as f32 * step).clamp(min, max)))
        .w_full()
        .h(H)
        .radius(10.0)
        .fill(l.surface)
        .clip_rounded(10.0)
        .on_drag(move |s: &mut App, d: &mut Drag, tx: &mut Tx| {
            if !(d.phase == Phase::Up && d.cancelled()) {
                set(&mut s.export.options, to_value(d.x, d.w));
            }
            tx.instant();
        })
        .child(el().absolute(0.0, 0.0).h(H).w_frac(t).fill(l.indicator).a11y_hidden())
        .child(
            row()
                .absolute(0.0, 0.0)
                .w_full()
                .h(H)
                .px(12.0)
                .center_y()
                .justify_between()
                .child(text(label.to_string()).font(MEDIUM).color(l.text_strong))
                .child(text(shown).font(NUMBER).color(l.text_strong)),
        )
}

/// The inspector's select shape (a native menu) over an export option.
fn select(l: &Look, key: &'static str, label: &str, options: &'static [&'static str], current: usize, pick: fn(&mut Options, usize)) -> El {
    let value = options.get(current).copied().unwrap_or("");
    let trigger = row()
        .key(key)
        .role("combobox")
        .label(label.to_string())
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
                    pick(&mut s.export.options, i);
                }
            });
        })
        .child(text(value).font(LARGE).color(l.text_value))
        .child(icon(&CHEVRON_DOWN, 14.0).color(l.text_muted));
    col().w_full().gap(4.0).child(text(label.to_string()).font(MEDIUM).color(l.text_muted)).child(trigger)
}

/// The inspector's pill toggle over an export option.
fn toggle_pill(l: &Look, key: &'static str, label: &str, on: bool, flip: fn(&mut Options)) -> El {
    let mut t = el()
        .key(key)
        .role("switch")
        .label(label.to_string())
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
        .on_press(move |s: &mut App| flip(&mut s.export.options))
        .child(text(label.to_string()).font(MEDIUM).color(if on { l.text } else { l.text_strong }));
    if on {
        t = t.fill(l.surface).border(1.0, l.pressed_ring);
    }
    t
}

fn close_button(l: &Look, key: impl Into<String>, label: &str, size: f32, press: impl Fn(&mut App) + 'static) -> El {
    el().key(key)
        .role("button")
        .label(label.to_string())
        .help(label.to_string())
        .size(size, size)
        .radius(size / 2.0)
        .center()
        .hover(l.hover)
        .cursor(rune::Cursor::Pointer)
        .on_press(press)
        .child(icon(&CLOSE, size * 0.55).color(l.text_muted))
}

fn index<T: PartialEq>(all: &[T], v: &T) -> usize {
    all.iter().position(|x| x == v).unwrap_or(0)
}

// ------------------------------------------------------------------ panel

/// The export panel, under the entity bar of the selection at canvas rect `sel`.
pub fn panel(l: &Look, s: &App, sel: [f32; 4], top: f32) -> Option<El> {
    let p = s.export.panel.as_ref()?;
    let e = s.entity(p.entity).filter(|_| s.selection.len() == 1 && s.selection.contains(&p.entity))?;
    let o = &s.export.options;
    let gif = o.format.is_gif();
    let fps = o.effective_fps();
    let mut body = col().w_full().gap(10.0);
    body = body.child(select(l, "export-format", "Format", &Format::LABELS, index(&Format::ALL, &o.format), |o, i| o.format = Format::ALL[i]));
    if !gif {
        body = body.child(select(l, "export-quality", "Quality", &Quality::LABELS, index(&Quality::ALL, &o.quality), |o, i| o.quality = Quality::ALL[i]));
    }
    let max_fps = if gif { ev::GIF_FPS_MAX } else { ev::FPS_MAX };
    body = body.child(slider(l, "export-fps", "Frame Rate (FPS)", fps as f32, fps.to_string(), (1.0, max_fps as f32, 1.0), |o, v| o.fps = v as u32));
    if !gif && e.has_audio() {
        body = body.child(row().child(toggle_pill(l, "export-audio", "Include Audio", o.include_audio, |o| o.include_audio = !o.include_audio)));
    }

    // Advanced, folded by default.
    let open = p.advanced;
    let trigger = row()
        .key("export-advanced")
        .role("button")
        .label("Advanced")
        .h(28.0)
        .px(8.0)
        .gap(8.0)
        .radius(4.0)
        .center_y()
        .hover(l.hover)
        .cursor(rune::Cursor::Pointer)
        .on_press(|s: &mut App| {
            if let Some(p) = &mut s.export.panel {
                p.advanced = !p.advanced;
            }
        })
        .child(icon(&CHEVRON_RIGHT, 12.0).color(l.text_muted).rotate(if open { std::f32::consts::FRAC_PI_2 } else { 0.0 }))
        .child(text("Advanced").font(MEDIUM).color(l.text_muted));
    body = body.child(trigger);
    if open {
        let mut adv = col().w_full().gap(10.0);
        if gif {
            let (lo, hi, step) = ev::GIF_WIDTH;
            let mw = o.gif_max_width.clamp(lo, hi);
            adv = adv
                .child(slider(l, "export-gif-width", "Max Width", mw as f32, format!("{mw}px"), (lo as f32, hi as f32, step as f32), |o, v| o.gif_max_width = v as u32))
                .child(select(l, "export-dither", "Dither", &Dither::LABELS, index(&Dither::ALL, &o.dither), |o, i| o.dither = Dither::ALL[i]));
        } else {
            let render = crate::gfx::process::render_size(e.asset.width, e.asset.height);
            let size = ev::target_size(render, o.resolution);
            let (lo, hi, step) = ev::BITRATE_KBPS;
            let kbps = o.bitrate_kbps.unwrap_or_else(|| ev::bitrate(size, o.quality, None) / 1000).clamp(lo, hi);
            let shown = if o.bitrate_kbps.is_some() { format!("{kbps}") } else { format!("Auto · {kbps}") };
            adv = adv.child(slider(l, "export-bitrate", "Bitrate (kbps)", kbps as f32, shown, (lo as f32, hi as f32, step as f32), |o, v| o.bitrate_kbps = Some(v as u32)));
            if o.bitrate_kbps.is_some() {
                adv = adv.child(row().child(toggle_pill(l, "export-bitrate-auto", "Auto Bitrate", false, |o| o.bitrate_kbps = None)));
            }
            adv = adv.child(select(l, "export-resolution", "Resolution", &Resolution::LABELS, index(&Resolution::ALL, &o.resolution), |o, i| o.resolution = Resolution::ALL[i]));
            adv = adv.child(text(format!("{} × {}", size.0, size.1)).font(SMALL).color(l.text_faint));
        }
        body = body.child(adv);
    }

    let button = l.primary_button(
        el().key("export-go")
            .role("button")
            .label(if gif { "Export GIF" } else { "Export Video" })
            .focusable(true)
            .w_full()
            .h(36.0)
            .radius(18.0)
            .center()
            .press_scale(0.98)
            .cursor(rune::Cursor::Pointer)
            .on_press_tx(start)
            .child(text(if gif { "Export GIF" } else { "Export Video" }).font(MEDIUM).color(Color::WHITE)),
    );
    body = body.child(el().pt(4.0).w_full().child(button));

    let header = row()
        .w_full()
        .h(44.0)
        .pl(16.0)
        .pr(8.0)
        .center_y()
        .justify_between()
        .child(text("Export").font(LARGE).color(l.text))
        .child(close_button(l, "export-close", "Close", 28.0, |s| s.export.panel = None));

    // Hangs under the entity bar (which sits 50 above the selection, or under the titlebar).
    let bar_y = (sel[1] - 50.0).max(top.max(12.0) + 8.0);
    let y = bar_y + 48.0;
    let x = sel[0].max(12.0).min((s.canvas[2] - WIDTH - 12.0).max(12.0));
    let max_h = (s.canvas[3] - y - 68.0).max(160.0);
    let panel = col()
        .key("export-panel")
        .absolute(x, y)
        .w(WIDTH)
        .max_h(max_h)
        .radius(16.0)
        .clip_rounded(16.0)
        .instant_changes()
        .child(header)
        .child(col().w_full().px(16.0).pb(16.0).child(body));
    Some(l.floating(panel))
}

// ------------------------------------------------------------------ queue

fn status_text(j: &JobInfo) -> String {
    match &j.status {
        Status::Queued => "Queued".into(),
        Status::Processing => j.stage.clone(),
        Status::Completed => "Saved".into(),
        Status::Failed(_) => "Failed".into(),
        Status::Cancelled => "Cancelled".into(),
    }
}

fn bar(l: &Look, w: f32, t: f32) -> El {
    el().w(w).h(4.0).radius(2.0).fill(l.indicator).child(el().h(4.0).w(w * t.clamp(0.0, 1.0)).radius(2.0).fill(l.primary))
}

/// The queue indicator: the running job's progress with cancel, and the job list above it when
/// open. None when there are no jobs.
pub fn queue(l: &Look, s: &App) -> Option<El> {
    let jobs = s.export.jobs();
    if jobs.is_empty() {
        return None;
    }
    // The oldest active job runs first; jobs are newest first.
    let current = jobs.iter().rev().find(|j| j.status == Status::Processing).or_else(|| jobs.iter().rev().find(|j| j.status.active()));
    let waiting = jobs.iter().filter(|j| j.status == Status::Queued).count();
    let mut summary = row().gap(8.0).center_y();
    match current {
        Some(j) => {
            summary = summary.child(text(format!("{}%", (j.progress * 100.0).round())).font(NUMBER).color(l.text)).child(bar(l, 56.0, j.progress));
            if waiting > 0 && j.status == Status::Processing {
                summary = summary.child(text(format!("+{waiting}")).font(SMALL).color(l.text_muted));
            }
        }
        None => {
            let failed = jobs.iter().any(|j| matches!(j.status, Status::Failed(_)));
            summary = summary.child(text(if failed { "Export failed" } else { "Exports done" }).font(MEDIUM).color(if failed { l.text } else { l.text_muted }));
        }
    }
    let toggle_label = if s.export.list_open { "Hide exports" } else { "Show exports" };
    let toggle = el()
        .key("export-queue-toggle")
        .role("button")
        .label(toggle_label)
        .help(toggle_label)
        .h(28.0)
        .px(10.0)
        .radius(14.0)
        .center_y()
        .hover(l.hover)
        .cursor(rune::Cursor::Pointer)
        .on_press(|s: &mut App| s.export.list_open = !s.export.list_open)
        .child(summary);
    let mut pill = row().key("export-queue").gap(0.0).px(2.0).center_y().child(toggle);
    pill = match current {
        Some(j) => {
            let id = j.id;
            pill.child(close_button(l, "export-queue-cancel", "Cancel export", 24.0, move |s| s.export.cancel(id)))
        }
        None => pill.child(close_button(l, "export-queue-clear", "Clear", 24.0, |s| s.export.clear_finished())),
    };
    let pill = super::look::own_gestures(pill).h(28.0).radius(14.0).border(1.0, l.border).fill(l.surface).shadow(4.0, 12.0, Color::BLACK.alpha(0.07));

    let mut c = col().gap(8.0);
    if s.export.list_open {
        c = c.child(list(l, &jobs));
    }
    Some(c.child(pill))
}

fn list(l: &Look, jobs: &[JobInfo]) -> El {
    let mut rows = col().w_full().gap(10.0);
    for j in jobs {
        let mut info = col().gap(4.0).grow(1.0).child(text(j.name.clone()).font(MEDIUM).color(l.text).truncate().max_w(200.0));
        let mut status = text(status_text(j)).font(SMALL).color(l.text_muted);
        if let Status::Failed(e) = &j.status {
            status = status.help(e.clone());
            info = info.help(e.clone());
        }
        info = info.child(status);
        if j.status == Status::Processing {
            info = info.child(bar(l, 200.0, j.progress));
        }
        let mut r = row().key(format!("export-job-{}", j.id)).w_full().gap(8.0).center_y().child(info);
        if j.status.active() {
            let id = j.id;
            r = r.child(close_button(l, format!("export-job-{}-cancel", j.id), "Cancel", 24.0, move |s| s.export.cancel(id)));
        }
        rows = rows.child(r);
    }
    let finished = jobs.iter().any(|j| !j.status.active());
    let mut header = row().w_full().center_y().justify_between().child(text(format!("Export Queue ({})", jobs.len())).font(MEDIUM).color(l.text_muted));
    if finished {
        header = header.child(
            el().key("export-queue-clear-all")
                .role("button")
                .label("Clear")
                .px(8.0)
                .h(22.0)
                .radius(11.0)
                .center()
                .hover(l.hover)
                .cursor(rune::Cursor::Pointer)
                .on_press(|s: &mut App| s.export.clear_finished())
                .child(text("Clear").font(SMALL).color(l.text)),
        );
    }
    l.floating(col().key("export-queue-list").w(260.0).p_all(12.0).gap(10.0).radius(14.0).child(header).child(rows))
}


#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use rune::{Env, Key, KeyEvent, Mods, Runtime};

    use crate::export_video::{Format, Status};
    use crate::media::{Asset, Frame, Kind};
    use crate::state::App;

    /// A 2-frame 200×150 GIF: red then blue, 100 ms each.
    fn gif() -> Arc<Asset> {
        let frame = |c: [u8; 4]| Frame { rgba: std::iter::repeat_n(c, 200 * 150).flatten().collect(), delay: Duration::from_millis(100) };
        Arc::new(Asset {
            kind: Kind::Gif,
            name: "clip.gif".into(),
            frames: vec![frame([255, 0, 0, 255]), frame([0, 0, 255, 255])],
            duration: Duration::from_millis(200),
            ext: "gif".into(),
            ..crate::media::test_asset(7, 200, 150)
        })
    }

    fn settle(rt: &mut Runtime<App>) {
        for _ in 0..240 {
            if !(rt.frame(1.0 / 60.0) || rt.has_pending_input() || rt.state.animating()) {
                return;
            }
        }
    }

    fn click(rt: &mut Runtime<App>, key: &str) {
        let (x, y) = rt.find(key).unwrap_or_else(|| panic!("no {key}"));
        rt.pointer_move(x, y);
        rt.pointer_down(x, y);
        rt.pointer_up(x, y);
        settle(rt);
    }

    fn cmd_e(rt: &mut Runtime<App>) {
        rt.key(KeyEvent { key: Key::Command('e'), mods: Mods { cmd: true, ..Mods::default() } });
        settle(rt);
    }

    fn runtime(assets: Vec<Arc<Asset>>) -> Runtime<App> {
        let mut s = App::default();
        s.cam.set([0.0, 0.0], 1.0);
        s.place(assets, [500.0, 400.0], false);
        let mut rt = Runtime::new(s, crate::ui::view, (1200.0, 800.0), Env::new(true, 2.0));
        rt.on_key = Some(crate::keys::on_key);
        rt.poll = Some(crate::poll);
        settle(&mut rt);
        rt
    }

    #[test]
    fn cmd_e_on_a_gif_opens_the_panel_and_exports_through_the_queue() {
        let mut rt = runtime(vec![gif()]);
        assert_eq!(rt.state.selection.len(), 1);
        cmd_e(&mut rt);
        assert!(rt.state.export.panel.is_some());
        assert!(rt.presented("export-panel").is_some(), "the panel shows");
        assert!(rt.state.exports.is_empty(), "no still export");

        // Format → GIF (option 2) through the select's menu; quality and audio go away.
        click(&mut rt, "export-format");
        rt.resolve_popup(Some("2")).unwrap_or_else(|e| panic!("menu: {e:?}"));
        settle(&mut rt);
        assert_eq!(rt.state.export.options.format, Format::Gif);
        assert!(rt.find("export-quality").is_none());

        let dir = std::env::temp_dir().join(format!("voidmesh-export-ui-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        click(&mut rt, "export-go");
        assert!(rt.file_dialog().is_some(), "a save dialog asks where");
        // No extension given: the format's is added.
        rt.resolve_file_dialog(Some(dir.join("clip"))).unwrap_or_else(|e| panic!("dialog: {e:?}"));
        settle(&mut rt);
        assert!(rt.state.export.panel.is_none(), "the panel closes once queued");

        let until = Instant::now() + Duration::from_secs(30);
        let mut toasted = false;
        loop {
            rt.frame(1.0 / 60.0);
            toasted |= rt.state.toasts.iter().any(|t| t.text == "Saved clip.gif");
            let jobs = rt.state.export.jobs();
            if jobs.iter().all(|j| !j.status.active()) {
                assert_eq!(jobs.len(), 1);
                assert_eq!(jobs[0].status, Status::Completed, "{:?}", jobs[0]);
                break;
            }
            assert!(Instant::now() < until, "export didn't finish: {jobs:?}");
            std::thread::sleep(Duration::from_millis(10));
        }
        settle(&mut rt);
        let out = dir.join("clip.gif");
        assert!(out.is_file());
        assert!(toasted || rt.state.toasts.iter().any(|t| t.text == "Saved clip.gif"), "a toast says so");
        let pill = rt.presented("export-queue").unwrap_or_else(|| panic!("the queue indicator shows")).0;
        let undo = rt.presented("undo-redo").unwrap_or_else(|| panic!("undo/redo")).0;
        assert!(pill[0] >= undo[0] + undo[2] && (pill[1] + pill[3] - (undo[1] + undo[3])).abs() < 1.0, "beside undo/redo: {pill:?} vs {undo:?}");
        click(&mut rt, "export-queue-toggle");
        assert!(rt.presented("export-queue-list").is_some_and(|(r, _)| r[1] + r[3] <= pill[1]), "the list opens above");
        click(&mut rt, "export-queue-clear");
        assert!(rt.state.export.jobs().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stills_keep_the_image_save_and_the_menu_offers_export_for_clips() {
        let mut rt = runtime(vec![Arc::new(crate::media::test_asset(1, 40, 30))]);
        cmd_e(&mut rt);
        assert!(rt.state.export.panel.is_none());
        assert!(rt.file_dialog().is_some(), "the image save dialog");
        let _ = rt.resolve_file_dialog(None);
        settle(&mut rt);

        let mut rt = runtime(vec![gif()]);
        let r = rt.presented("e1").unwrap_or_else(|| panic!("entity")).0;
        // Clear of the playback bar along the clip's bottom.
        let (x, y) = (r[0] + r[2] / 2.0, r[1] + 20.0);
        rt.pointer_move(x, y);
        rt.secondary_down(x, y);
        rt.secondary_up(x, y);
        rt.frame(1.0 / 60.0);
        assert!(rt.popup_menu().is_some_and(|m| m.find("export-video").is_some()));
        rt.resolve_popup(Some("export-video")).unwrap_or_else(|e| panic!("menu: {e:?}"));
        settle(&mut rt);
        assert!(rt.state.export.panel.is_some());
        // Selecting nothing closes it.
        rt.state.selection.clear();
        settle(&mut rt);
        assert!(rt.state.export.panel.is_none());
    }
}
