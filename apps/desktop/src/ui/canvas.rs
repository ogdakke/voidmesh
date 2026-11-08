//! The canvas surface. Each entity is an effect slot the compositor paints, laid out directly at
//! its screen rect from the camera (no element transform), so what's drawn is exactly the model. Gestures: wheel pans, ⌘-wheel or pinch zooms about
//! the pointer, Space or middle drag pans, a drag on empty canvas draws a marquee, a drag on an
//! entity moves the selection.

use std::collections::BTreeSet;

use rune::{Drag, El, MagnifyEvent, Phase, PointerButton, Tx, WheelEvent, el};

use super::look::Look;
use crate::gfx;
use crate::state::{App, GRID, MarqueeMode, MoveDrag};

/// Movement under this many points is a click.
const CLICK_SLOP: f32 = 5.0;
/// How long after a pinch event two-finger scrolls still count as part of the pinch.
const PINCH_HOLD: std::time::Duration = std::time::Duration::from_millis(150);

/// `VOIDMESH_TRACE_INPUT=1` prints each canvas gesture and the camera after it, for diagnosing
/// trackpad input that headless runs can't reproduce.
fn trace(s: &App, kind: &str, what: &str) {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *ON.get_or_init(|| std::env::var_os("VOIDMESH_TRACE_INPUT").is_some()) {
        eprintln!("{kind:5} {what} | cam pan {:.1},{:.1} scale {:.4}", s.cam.pan[0], s.cam.pan[1], s.cam.scale);
    }
}

pub fn surface(l: &Look, s: &App) -> El {
    let mut entities: Vec<&crate::state::Entity> = s.entities.iter().collect();
    entities.sort_by_key(|e| e.z);
    let world = entities.into_iter().fold(el().key("world").absolute(0.0, 0.0).w_full().h_full().instant_changes(), |w, e| w.child(entity(e, s.cam.screen_rect(e.rect()), s.bare)));
    let mut c = el()
        .key("canvas")
        .absolute(0.0, 0.0)
        .w_full()
        .h_full()
        .clip_soft(0.0)
        .cursor(if s.space || s.panning.is_some() { rune::Cursor::Grab } else { rune::Cursor::Default })
        .on_layout(|s: &mut App, r| s.resize_canvas(r))
        .child(el().key("grid").absolute(0.0, 0.0).w_full().h_full().effect(gfx::GRID))
        .child(world)
        // Deletion dust, over the entities, while it plays.
        .children((s.now < s.dust_until).then(|| el().key("dust").absolute(0.0, 0.0).w_full().h_full().effect(gfx::DUST).inert()))
        .pointer_buttons([PointerButton::Middle])
        .on_wheel(|s: &mut App, e: WheelEvent, tx: &mut Tx| {
            trace(s, "wheel", &format!("dx {:.2} dy {:.2} at {:.1},{:.1} cmd {} precise {} phase {:?} momentum {}", e.dx, e.dy, e.x, e.y, e.mods.cmd, e.precise, e.phase, e.momentum));
            if e.mods.cmd || e.mods.ctrl {
                // Momentum after the fingers lift would keep zooming on its own: drop it.
                if !e.momentum {
                    // Rune's deltas move content: scrolling down is negative, which zooms out.
                    // A mouse wheel steps; a trackpad's deltas scale smoothly. Either way the
                    // camera eases toward the target (`App::step_zoom`).
                    let k = if e.precise { (e.dy * 0.01).exp() } else if e.dy < 0.0 { 0.955 } else { 1.045 };
                    s.zoom_toward([e.x, e.y], k);
                }
            } else if s.last_pinch.is_some_and(|t| t.elapsed() < PINCH_HOLD) {
                // Mid-pinch: the fingers' drift arrives as scrolls. Hold the pan.
            } else {
                s.cam.anim = None;
                let pan = [s.cam.pan[0] + e.dx, s.cam.pan[1] + e.dy];
                s.cam.set(pan, s.cam.scale);
            }
            tx.instant();
            true
        })
        .on_magnify(|s: &mut App, e: MagnifyEvent, tx: &mut Tx| {
            trace(s, "pinch", &format!("delta {:.4} at {:.1},{:.1} phase {:?}", e.delta, e.x, e.y, e.phase));
            s.last_pinch = Some(std::time::Instant::now());
            s.cam.zoom_about([e.x, e.y], 1.0 + e.delta);
            tx.instant();
            true
        })
        .on_drag(canvas_drag)
        .on_secondary_press(|s: &mut App, p: rune::PointerPress, tx: &mut Tx| match s.entity_at([p.x, p.y]) {
            Some(id) => super::menu::open_on_entity(s, id, (p.x, p.y), tx),
            None => super::menu::open_on_canvas(s, (p.x, p.y), tx),
        })
        .on_drop_files(|s: &mut App, files, tx: &mut Tx| {
            let at = tx.drop_point().map(|p| s.cam.world([p.x, p.y]));
            let at = at.unwrap_or_else(|| s.cam.world([s.canvas[2] / 2.0, s.canvas[3] / 2.0]));
            s.import(files.to_vec(), Some(at));
            s.drop_hover = false;
        })
        .accepts_extensions(&super::accepted_extensions())
        .on_drop_hover(|s: &mut App, over, _| s.drop_hover = over);
    if s.lens != crate::state::Lensing::Off {
        // Over the media and grid, under the selection overlays and chrome, which stay sharp.
        c = c.child(el().key("lens").absolute(0.0, 0.0).w_full().h_full().effect(gfx::LENS).effect_backdrop(true).inert());
    }
    if let Some(m) = &s.marquee {
        let [x, y, w, h] = m.rect();
        c = c.child(el().key("marquee").absolute(x, y).size(w, h).fill(l.marquee_fill).border(1.0, super::look::BRAND).inert());
    }
    if s.selection.len() > 1
        && let Some(b) = s.bounds(&s.selection) {
            let [x, y, w, h] = s.cam.screen_rect(b);
            c = c.child(el().key("bbox").absolute(x - 4.0, y - 4.0).size(w + 8.0, h + 8.0).radius(3.0).border(1.5, super::look::BRAND).inert());
        }
    c
}

/// The progress hairline's track and fill. Fixed rather than themed: it sits on the media, not
/// on chrome, so it needs contrast against any frame.
const PROGRESS_TRACK: rune::Color = rune::Color { r: 0.0, g: 0.0, b: 0.0, a: 0.35 };
const PROGRESS_FILL: rune::Color = rune::Color { r: 1.0, g: 1.0, b: 1.0, a: 0.9 };

/// An entity at canvas rect `r`: its world rect through the camera. Animated media carry a
/// hairline of their playback position along the bottom edge, readable at any zoom.
fn entity(e: &crate::state::Entity, r: [f32; 4], bare: bool) -> El {
    let id = e.id;
    let mut node = el().key(format!("e{id}"));
    if e.asset.animated() && !bare {
        let dur = e.asset.duration.as_secs_f64();
        let t = if dur > 0.0 { (e.play_t / dur).clamp(0.0, 1.0) as f32 } else { 0.0 };
        node = node.child(el().key(format!("e{id}-progress")).pin(Some(0.0), None, Some(0.0), Some(0.0)).h(2.0).fill(PROGRESS_TRACK).inert().child(el().h(2.0).w_frac(t).fill(PROGRESS_FILL)));
    }
    node
        .absolute(r[0], r[1])
        .size(r[2], r[3])
        .effect(gfx::ENTITY + id)
        .effect_bleed(4.0)
        .label(e.name.clone())
}

fn entity_drag(s: &mut App, id: u32, d: &mut Drag, tx: &mut Tx) {
    if s.space || tx.button() == PointerButton::Middle {
        pan_drag(s, d);
        tx.instant();
        return;
    }
    match d.phase {
        Phase::Down => {
            let before = s.snapshot();
            let shift = tx.mods().shift;
            let was = s.selection.contains(&id);
            let mut collapse_to = None;
            let mut toggle_play = None;
            if shift {
                if !s.selection.remove(&id) {
                    s.selection.insert(id);
                }
            } else if !was {
                s.select_only(id);
            } else if s.selection.len() > 1 {
                collapse_to = Some(id);
            } else if s.entity(id).is_some_and(|e| e.asset.animated()) {
                toggle_play = Some(id);
            }
            let ids = s.selected().map(|e| (e.id, e.pos)).collect();
            s.drag = Some(MoveDrag { ids, before, moved: false, collapse_to, toggle_play, clear_on_click: false });
        }
        Phase::Move => {
            let scale = s.cam.scale;
            let snap = s.snap;
            let Some(m) = s.drag.as_mut() else { return };
            if !m.moved && d.dx.hypot(d.dy) < CLICK_SLOP {
                return;
            }
            m.moved = true;
            let mut delta = [d.dx / scale, d.dy / scale];
            if snap
                && let Some((_, p0)) = m.ids.first() {
                    let target = [p0[0] + delta[0], p0[1] + delta[1]].map(|v| (v / GRID).round() * GRID);
                    delta = [target[0] - p0[0], target[1] - p0[1]];
                }
            let moves: Vec<(u32, [f32; 2])> = m.ids.iter().map(|(id, p)| (*id, [p[0] + delta[0], p[1] + delta[1]])).collect();
            for (id, p) in moves {
                if let Some(e) = s.entity_mut(id) {
                    e.pos = p;
                }
            }
        }
        Phase::Up => {
            let Some(m) = s.drag.take() else { return };
            if d.cancelled() {
                for (id, p) in &m.ids {
                    if let Some(e) = s.entity_mut(*id) {
                        e.pos = *p;
                    }
                }
            } else if m.moved {
                s.push_undo(m.before);
            } else if let Some(id) = m.collapse_to {
                s.select_only(id);
            } else if let Some(id) = m.toggle_play
                && let Some(e) = s.entity_mut(id) {
                    e.playing = !e.playing;
                }
        }
    }
    tx.instant();
}

fn pan_drag(s: &mut App, d: &Drag) {
    match d.phase {
        Phase::Down => s.panning = Some(s.cam.pan),
        Phase::Move => {
            if let Some(p0) = s.panning {
                s.cam.anim = None;
                s.cam.set([p0[0] + d.dx, p0[1] + d.dy], s.cam.scale);
                s.space_dragged = true;
            }
        }
        Phase::Up => {
            if d.cancelled()
                && let Some(p0) = s.panning {
                    s.cam.set(p0, s.cam.scale);
                }
            s.panning = None;
        }
    }
}

fn canvas_drag(s: &mut App, d: &mut Drag, tx: &mut Tx) {
    if s.space || tx.button() == PointerButton::Middle || s.panning.is_some() {
        pan_drag(s, d);
        tx.instant();
        return;
    }
    if d.phase == Phase::Down {
        // Entities don't take the pointer themselves: picking is alpha-aware, so a press on a
        // transparent region reaches whatever lies beneath it.
        if let Some(id) = s.entity_at([d.x, d.y]) {
            return entity_drag(s, id, d, tx);
        }
        // Empty space inside a multi-selection's box drags the group.
        if s.selection.len() > 1
            && let Some(b) = s.bounds(&s.selection) {
                let r = s.cam.screen_rect(b);
                if d.x >= r[0] && d.x <= r[0] + r[2] && d.y >= r[1] && d.y <= r[1] + r[3] {
                    let ids = s.selected().map(|e| (e.id, e.pos)).collect();
                    s.drag = Some(MoveDrag { ids, before: s.snapshot(), moved: false, collapse_to: None, toggle_play: None, clear_on_click: true });
                    tx.instant();
                    return;
                }
            }
    }
    if let Some(m) = &s.drag {
        let id = m.ids.first().map_or(0, |(id, _)| *id);
        let clear = d.phase == Phase::Up && !m.moved && m.clear_on_click;
        entity_drag(s, id, d, tx);
        if clear {
            s.selection.clear();
        }
        return;
    }
    match d.phase {
        Phase::Down => {
            let shift = tx.mods().shift;
            let mode = match (shift, s.selection.is_empty()) {
                (false, _) => MarqueeMode::Replace,
                (true, false) => MarqueeMode::Subtract,
                (true, true) => MarqueeMode::Add,
            };
            s.marquee = Some(crate::state::Marquee { start: [d.x, d.y], end: [d.x, d.y], mode, base: s.selection.clone() });
            if mode == MarqueeMode::Replace {
                s.selection = BTreeSet::new();
            }
        }
        Phase::Move => {
            if let Some(m) = s.marquee.as_mut() {
                m.end = [d.x, d.y];
                if (m.end[0] - m.start[0]).hypot(m.end[1] - m.start[1]) >= CLICK_SLOP {
                    s.update_marquee();
                }
            }
        }
        Phase::Up => {
            if d.cancelled()
                && let Some(m) = &s.marquee {
                    s.selection = m.base.clone();
                }
            s.marquee = None;
        }
    }
    tx.instant();
}
