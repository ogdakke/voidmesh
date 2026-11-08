//! The canvas driven headlessly through the real view: selection, moves, the marquee, inspector
//! edits with undo, and camera gestures.

use std::sync::Arc;
use std::time::Duration;

use rune::{Env, Key, KeyEvent, Mods, PhysicalInput, Runtime, WheelEvent};

use crate::effects::Shader;
use crate::media::{Asset, Frame};
use crate::state::App;

fn asset(id: u64, w: u32, h: u32) -> Arc<Asset> {
    Arc::new(Asset { id, name: format!("a{id}.png"), width: w, height: h, frames: vec![Frame { rgba: vec![], delay: Duration::ZERO }], duration: Duration::ZERO })
}

/// Two 200×100 images at 1:1, centred on (200, 350) and (900, 350): far enough apart that the
/// inspector beside one doesn't cover the other.
fn canvas() -> Runtime<App> {
    let mut s = App::default();
    s.cam.set([0.0, 0.0], 1.0);
    s.place(vec![asset(1, 200, 100)], [200.0, 350.0], false);
    s.place(vec![asset(2, 200, 100)], [900.0, 350.0], false);
    s.selection.clear();
    s.undo.clear();
    let mut rt = Runtime::new(s, crate::ui::view, (1200.0, 800.0), Env::new(true, 2.0));
    rt.on_key = Some(crate::keys::on_key);
    rt.poll = Some(crate::poll);
    settle(&mut rt);
    rt
}

/// Run frames until nothing moves, counting the app's own motion (the zoom ease), as the window's
/// compositor keeps frames coming while `App::animating` holds.
fn settle(rt: &mut Runtime<App>) {
    for _ in 0..240 {
        let busy = rt.frame(1.0 / 60.0) || rt.has_pending_input() || rt.state.animating();
        if !busy {
            return;
        }
    }
}

fn click(rt: &mut Runtime<App>, x: f32, y: f32) {
    rt.pointer_move(x, y);
    rt.pointer_down(x, y);
    rt.pointer_up(x, y);
    settle(rt);
}

fn drag(rt: &mut Runtime<App>, from: [f32; 2], to: [f32; 2]) {
    rt.pointer_move(from[0], from[1]);
    rt.pointer_down(from[0], from[1]);
    for i in 1..=4 {
        let t = i as f32 / 4.0;
        rt.pointer_move(from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t);
        rt.frame(1.0 / 60.0);
    }
    rt.pointer_up(to[0], to[1]);
    settle(rt);
}

fn shift(rt: &mut Runtime<App>, on: bool) {
    rt.physical_input(PhysicalInput::Modifiers(Mods { shift: on, ..Mods::default() }));
    rt.frame(1.0 / 60.0);
}

#[test]
fn clicks_select_and_shift_click_toggles() {
    let mut rt = canvas();
    click(&mut rt, 200.0, 350.0);
    assert_eq!(rt.state.selection.iter().copied().collect::<Vec<_>>(), [1]);
    shift(&mut rt, true);
    click(&mut rt, 900.0, 350.0);
    assert_eq!(rt.state.selection.len(), 2);
    click(&mut rt, 900.0, 350.0);
    assert_eq!(rt.state.selection.iter().copied().collect::<Vec<_>>(), [1]);
    shift(&mut rt, false);
    click(&mut rt, 600.0, 700.0);
    assert!(rt.state.selection.is_empty(), "a click on empty canvas clears");
}

#[test]
fn dragging_moves_the_selection_and_undo_puts_it_back() {
    let mut rt = canvas();
    let before = rt.state.entity(1).expect("1").pos;
    drag(&mut rt, [200.0, 350.0], [260.0, 390.0]);
    let after = rt.state.entity(1).expect("1").pos;
    assert_eq!([after[0] - before[0], after[1] - before[1]], [60.0, 40.0]);
    assert!(rt.state.selection.contains(&1));
    rt.key(KeyEvent { key: Key::Command('z'), mods: Mods { cmd: true, ..Mods::default() } });
    settle(&mut rt);
    assert_eq!(rt.state.entity(1).expect("1").pos, before);
}

#[test]
fn a_marquee_selects_what_it_touches() {
    let mut rt = canvas();
    drag(&mut rt, [80.0, 250.0], [850.0, 330.0]);
    let sel: Vec<u32> = rt.state.selection.iter().copied().collect();
    assert_eq!(sel, [1, 2]);
    assert!(rt.state.marquee.is_none());
}

#[test]
fn inspector_edits_apply_to_the_selection_as_one_undo_step() {
    let mut rt = canvas();
    rt.key(KeyEvent { key: Key::Command('a'), mods: Mods { cmd: true, ..Mods::default() } });
    settle(&mut rt);
    // The Style select opens a menu; pick Halftone (option 0).
    let (x, y) = rt.find("shader").expect("style select");
    click(&mut rt, x, y);
    assert!(rt.popup_menu().is_some(), "the select opened its menu");
    rt.resolve_popup(Some("0")).expect("menu answered");
    settle(&mut rt);
    assert!(rt.state.entities.iter().all(|e| e.params.shader == Shader::Halftone));
    // Drag the scale slider past its far end.
    let r = rt.elements().into_iter().find(|e| e.key.as_deref() == Some("scale")).expect("scale slider").rect;
    drag(&mut rt, [r[0] + 10.0, r[1] + r[3] / 2.0], [r[0] + r[2] + 40.0, r[1] + r[3] / 2.0]);
    assert!(rt.state.entities.iter().all(|e| e.params.scale == 3.0));
    assert_eq!(rt.state.undo.len(), 2, "the pick and the slider gesture, one step each");
    rt.key(KeyEvent { key: Key::Command('z'), mods: Mods { cmd: true, ..Mods::default() } });
    settle(&mut rt);
    assert!(rt.state.entities.iter().all(|e| e.params.scale == 1.0));
}

#[test]
fn the_wheel_pans_and_cmd_wheel_zooms_smoothly_about_the_pointer() {
    let mut rt = canvas();
    rt.wheel_event(WheelEvent::new(-30.0, -20.0).at(600.0, 700.0).precise(true));
    settle(&mut rt);
    assert_eq!(rt.state.cam.pan, [-30.0, -20.0]);
    let q = [600.0, 700.0];
    let w = rt.state.cam.world(q);
    let cmd = Mods { cmd: true, ..Mods::default() };
    // Coarse steps, as macOS sends them: the camera eases between them, never jumping a step.
    let mut last = rt.state.cam.scale;
    let mut sum = 0.0f32;
    for dy in [2.0f32, 2.0, 3.0, 1.0] {
        sum += dy;
        rt.wheel_event(WheelEvent::new(0.0, dy).at(q[0], q[1]).precise(true).mods(cmd));
        rt.frame(1.0 / 120.0);
        rt.frame(1.0 / 120.0);
        let s = rt.state.cam.scale;
        assert!(s > last && s <= (sum * 0.01).exp(), "rises without overshooting: {last} -> {s}");
        last = s;
    }
    settle(&mut rt);
    assert!((rt.state.cam.scale - (0.08f32).exp()).abs() < 1e-3, "lands on the target: {}", rt.state.cam.scale);
    let w2 = rt.state.cam.world(q);
    assert!((w[0] - w2[0]).abs() < 0.01 && (w[1] - w2[1]).abs() < 0.01, "the point under the pointer stays");
    // Momentum after the fingers lift doesn't zoom.
    let s = rt.state.cam.scale;
    // AppKit's momentum is a gesture that begins right after the touch's gesture ends.
    rt.wheel_event(WheelEvent::new(0.0, 0.0).at(q[0], q[1]).precise(true).mods(cmd).phase(rune::GesturePhase::Ended));
    rt.wheel_event(WheelEvent::new(0.0, -3.0).at(q[0], q[1]).precise(true).mods(cmd).phase(rune::GesturePhase::Began));
    rt.wheel_event(WheelEvent::new(0.0, -3.0).at(q[0], q[1]).precise(true).mods(cmd).phase(rune::GesturePhase::Moved));
    settle(&mut rt);
    assert_eq!(rt.state.cam.scale, s);
}

#[test]
fn delete_duplicate_and_escape_keys() {
    let mut rt = canvas();
    click(&mut rt, 200.0, 350.0);
    rt.key(KeyEvent { key: Key::Command('d'), mods: Mods { cmd: true, ..Mods::default() } });
    settle(&mut rt);
    assert_eq!(rt.state.entities.len(), 3);
    rt.key(KeyEvent { key: Key::Backspace, mods: Mods::default() });
    settle(&mut rt);
    assert_eq!(rt.state.entities.len(), 2);
    click(&mut rt, 200.0, 350.0);
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert!(rt.state.selection.is_empty());
}

#[test]
fn the_media_and_its_controls_move_together_through_a_pinch() {
    let mut rt = canvas();
    click(&mut rt, 200.0, 350.0);
    let near = |a: f32, b: f32| (a - b).abs() < 0.5;
    for _ in 0..12 {
        rt.magnify_event(rune::MagnifyEvent::new(0.08).at(260.0, 380.0));
        rt.frame(1.0 / 60.0);
        let want = rt.state.cam.screen_rect(rt.state.entity(1).expect("1").rect());
        let drawn = rt.presented("e1").expect("e1").0;
        assert!((0..4).all(|i| near(drawn[i], want[i])), "the image lands this frame: {drawn:?} vs {want:?}");
        let bar = rt.presented("entity-bar-wrap").expect("bar").0;
        assert!(near(bar[0], want[0].max(12.0)), "the bar rides the image: {} vs {}", bar[0], want[0]);
        let inspector = rt.presented("inspector").expect("inspector").0;
        let (x, ..) = crate::ui::inspector::place(want, [rt.state.canvas[2], rt.state.canvas[3]], rt.state.top_inset);
        assert!(near(inspector[0], x), "the inspector rides beside it: {} vs {x}", inspector[0]);
    }
}

#[test]
fn scrolling_over_the_inspector_scrolls_it_and_leaves_the_canvas_alone() {
    let mut rt = canvas();
    click(&mut rt, 200.0, 350.0);
    let r = rt.presented("inspector").expect("inspector").0;
    let pan = rt.state.cam.pan;
    let (x, y) = (r[0] + r[2] / 2.0, r[1] + r[3] / 2.0);
    rt.pointer_move(x, y);
    for _ in 0..5 {
        rt.wheel_event(WheelEvent::new(0.0, -40.0).at(x, y).precise(true));
        rt.frame(1.0 / 60.0);
    }
    settle(&mut rt);
    assert_eq!(rt.state.cam.pan, pan, "the canvas didn't pan");
    let body = rt.presented("inspector-body").expect("body").0;
    assert!(body[1] < r[1] + 44.0 - 1.0, "the inspector scrolled instead: body top {} under header {}", body[1], r[1] + 44.0);
    // Its header (outside the scroll view), the entity bar and the corner chrome take the wheel too.
    let bar = rt.presented("entity-bar").expect("bar").0;
    let zoom = rt.presented("zoom").expect("zoom").0;
    for (px, py) in [(x, r[1] + 20.0), (bar[0] + 20.0, bar[1] + bar[3] / 2.0), (zoom[0] + 5.0, zoom[1] + 5.0)] {
        rt.pointer_move(px, py);
        rt.wheel_event(WheelEvent::new(0.0, -40.0).at(px, py).precise(true));
        settle(&mut rt);
        assert_eq!(rt.state.cam.pan, pan, "a wheel at ({px}, {py}) panned the canvas");
    }
    rt.pointer_move(x, y);
    let scale = rt.state.cam.scale;
    rt.wheel_event(WheelEvent::new(0.0, 4.0).at(x, y).precise(true).mods(Mods { cmd: true, ..Mods::default() }));
    rt.magnify_event(rune::MagnifyEvent::new(0.2).at(x, y));
    settle(&mut rt);
    assert_eq!(rt.state.cam.scale, scale, "nor zoom");
}

#[test]
fn scrolls_that_arrive_mid_pinch_hold_the_pan() {
    let mut rt = canvas();
    let q = [600.0, 700.0];
    let w = rt.state.cam.world(q);
    for _ in 0..6 {
        rt.magnify_event(rune::MagnifyEvent::new(0.05).at(q[0], q[1]));
        rt.wheel_event(WheelEvent::new(3.0, 5.0).at(q[0], q[1]).precise(true));
        rt.frame(1.0 / 60.0);
    }
    settle(&mut rt);
    let w2 = rt.state.cam.world(q);
    assert!((w[0] - w2[0]).abs() < 0.01 && (w[1] - w2[1]).abs() < 0.01, "the point under the pointer stays: {w:?} -> {w2:?}");
}
