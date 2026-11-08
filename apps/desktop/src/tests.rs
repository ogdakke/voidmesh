//! The canvas driven headlessly through the real view: selection, moves, the marquee, inspector
//! edits with undo, and camera gestures.

use std::sync::Arc;

use rune::{Env, Key, KeyEvent, Mods, PhysicalInput, Runtime, WheelEvent};

use crate::effects::Shader;
use crate::media::Asset;

use crate::state::App;

fn asset(id: u64, w: u32, h: u32) -> Arc<Asset> {
    Arc::new(crate::media::test_asset(id, w, h))
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
    // The inspector now sits at the right edge over part of item 2; click its uncovered part.
    click(&mut rt, 840.0, 350.0);
    assert_eq!(rt.state.selection.iter().copied().collect::<Vec<_>>(), [1]);
    shift(&mut rt, false);
    // Clear of the inspector, which floats beside item 1 down to the bottom chrome.
    click(&mut rt, 700.0, 700.0);
    assert!(rt.state.selection.is_empty(), "a click on empty canvas clears");
}

#[test]
fn clicks_pass_through_transparent_media() {
    let mut rt = canvas();
    // Over item 1 and the empty canvas to its right (x 150–350): opaque on its left half only.
    let rgba = (0..100).flat_map(|_| (0..200).flat_map(|x| [255, 0, 0, if x < 100 { 255 } else { 0 }])).collect();
    rt.state.place(vec![Arc::new(crate::media::rgba_asset(3, "half.png", 200, 100, rgba))], [250.0, 350.0], false);
    let id = rt.state.entities.last().expect("placed").id;
    rt.state.selection.clear();
    settle(&mut rt);
    // Past item 1, a drag from the transparent half draws a marquee (which selects by rect).
    let pos = rt.state.entity(id).expect("top").pos;
    drag(&mut rt, [330.0, 320.0], [340.0, 380.0]);
    assert_eq!(rt.state.selection.iter().copied().collect::<Vec<_>>(), [id]);
    assert_eq!(rt.state.entity(id).expect("top").pos, pos, "nothing moved");
    rt.state.selection.clear();
    settle(&mut rt);
    // A right-click there gets the canvas's menu, not the entity's.
    right_click(&mut rt, 330.0, 350.0);
    let menu = rt.popup_menu().expect("menu open");
    assert!(menu.find("new-ws").is_some() && menu.find("copy-image").is_none());
    rt.resolve_popup(None).expect("dismiss");
    settle(&mut rt);
    click(&mut rt, 200.0, 350.0);
    assert_eq!(rt.state.selection.iter().copied().collect::<Vec<_>>(), [id], "its opaque half takes the click");
    click(&mut rt, 280.0, 350.0);
    assert_eq!(rt.state.selection.iter().copied().collect::<Vec<_>>(), [1], "its transparent half passes it to item 1");
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

#[test]
fn media_time_reads_like_the_web() {
    use crate::ui::media_time;
    assert_eq!(media_time(0.0), "0:00");
    assert_eq!(media_time(5.1), "5:10");
    assert_eq!(media_time(59.99), "59:99");
    assert_eq!(media_time(60.0), "1:00:00");
    assert_eq!(media_time(125.05), "2:05:05");
}

fn right_click(rt: &mut Runtime<App>, x: f32, y: f32) {
    rt.pointer_move(x, y);
    rt.secondary_down(x, y);
    rt.secondary_up(x, y);
    rt.frame(1.0 / 60.0);
}

#[test]
fn right_click_selects_and_the_menu_edits_the_selection() {
    let mut rt = canvas();
    right_click(&mut rt, 900.0, 350.0);
    assert_eq!(rt.state.selection.iter().copied().collect::<Vec<_>>(), [2], "the clicked entity is selected");
    let menu = rt.popup_menu().expect("menu open");
    assert!(menu.find("shader:0").is_some() && menu.find("copy-image").is_some() && menu.find("dither:2").is_some_and(|i| i.is_checked()));
    rt.resolve_popup(Some("shader:0")).expect("pick");
    settle(&mut rt);
    assert_eq!(rt.state.entity(2).expect("2").params.shader, Shader::Halftone);
    let undo = rt.state.undo.len();
    right_click(&mut rt, 900.0, 350.0);
    rt.resolve_popup(Some("reverse")).expect("pick");
    settle(&mut rt);
    assert!(rt.state.entity(2).expect("2").params.reverse_palette);
    assert_eq!(rt.state.undo.len(), undo + 1);
    right_click(&mut rt, 900.0, 350.0);
    rt.resolve_popup(Some("delete")).expect("pick");
    settle(&mut rt);
    assert!(rt.state.entity(2).is_none());
}

#[test]
fn right_click_on_empty_canvas_offers_workspace_commands() {
    let mut rt = canvas();
    right_click(&mut rt, 600.0, 700.0);
    let menu = rt.popup_menu().expect("menu open");
    assert!(menu.find("new-ws").is_some() && menu.find("library").is_some() && menu.find("export-ws").is_some() && menu.find("open").is_some());
    rt.resolve_popup(Some("snap")).expect("pick");
    settle(&mut rt);
    assert!(rt.state.snap);
}

#[test]
fn the_inspector_keeps_clicks_and_drags_on_its_empty_space() {
    let mut rt = canvas();
    click(&mut rt, 200.0, 350.0);
    assert_eq!(rt.state.selection.len(), 1);
    let sel = rt.state.cam.screen_rect(rt.state.entity(1).expect("1").rect());
    let (x, y, _) = crate::ui::inspector::place(sel, [rt.state.canvas[2], rt.state.canvas[3]], rt.state.top_inset);
    // Its left padding, beside the header and beside a control: nothing there but the panel.
    let spots = [[x + 6.0, y + 20.0], [x + 6.0, y + 120.0]];
    for [x, y] in spots {
        click(&mut rt, x, y);
        assert_eq!(rt.state.selection.len(), 1, "a click at {x},{y} reached the canvas");
        drag(&mut rt, [x, y], [x - 150.0, y - 40.0]);
        assert_eq!(rt.state.selection.len(), 1, "a drag from {x},{y} drew a marquee");
        assert!(rt.state.marquee.is_none());
    }
}

#[test]
fn many_tabs_scroll_in_the_titlebar_and_keep_their_width() {
    let mut rt = canvas();
    // One tab: the strip is as wide as it, "+" right after.
    let strip = rt.presented("tabs-scroll").expect("tab strip").0;
    let plus = rt.presented("tab-new").expect("+").0;
    assert!((plus[0] - (strip[0] + strip[2] + 4.0)).abs() < 1.0 && strip[2] < 300.0, "{strip:?} then {plus:?}");
    let cmd = |c| KeyEvent { key: Key::Command(c), mods: Mods { cmd: true, ..Mods::default() } };
    for i in 0..14 {
        rt.key(cmd('t'));
        settle(&mut rt);
        rt.state.place(vec![asset(100 + i, 10, 10)], [0.0, 0.0], false);
    }
    rt.key(cmd('1'));
    settle(&mut rt);
    assert_eq!((rt.state.tabs.len(), rt.state.active), (15, 0));
    let strip = rt.presented("tabs-scroll").expect("tab strip").0;
    let window = 1200.0;
    let library = rt.presented("library-open").expect("library button").0;
    assert!(strip[2] > 600.0 && library[0] + library[2] <= window - 20.0, "the strip fills the titlebar and stops short of its edge: {strip:?}, {library:?}");
    let first = rt.state.tabs[0].id.clone();
    let tab = rt.presented(&format!("tab-{first}")).expect("first tab").0;
    assert!(tab[2] >= 96.0, "a tab keeps its minimum width: {}", tab[2]);
    // ⌘9 shows the last tab, scrolled into the strip.
    rt.key(cmd('9'));
    settle(&mut rt);
    assert_eq!(rt.state.active, rt.state.tabs.len() - 1);
    let last = rt.presented(&crate::ui::tabs::active_key(&rt.state)).expect("last tab").0;
    assert!(last[0] >= strip[0] - 0.5 && last[0] + last[2] <= strip[0] + strip[2] + 0.5, "the active tab is in view: {last:?} in {strip:?}");
}

#[test]
fn question_mark_shows_the_keyboard_shortcuts_and_closes_them() {
    let mut rt = canvas();
    let question = || KeyEvent { key: Key::Text("?".into()), mods: Mods { shift: true, ..Mods::default() } };
    rt.key(question());
    settle(&mut rt);
    assert!(rt.state.settings);
    let section = rt.presented("settings-shortcuts").expect("shortcuts").0;
    assert!(section[1] >= 0.0 && section[1] < 100.0, "the shortcuts open at the top: {section:?}");
    rt.key(question());
    settle(&mut rt);
    assert!(!rt.state.settings);
}

#[test]
fn a_mixed_selection_shows_what_it_shares_and_says_where_it_differs() {
    let mut rt = canvas();
    rt.state.entity_mut(1).expect("1").params.set_shader(Shader::Halftone);
    rt.state.entity_mut(2).expect("2").params.set_shader(Shader::Glass);
    rt.state.entity_mut(1).expect("1").params.show_original = true;
    rt.key(KeyEvent { key: Key::Command('a'), mods: Mods { cmd: true, ..Mods::default() } });
    settle(&mut rt);
    let label = |rt: &Runtime<App>, key: &str| rt.elements().into_iter().find(|e| e.key.as_deref() == Some(key)).map(|e| e.label.unwrap_or_default());
    // Only controls both effects have: no glass kind, no shape (halftone), no palette (glass).
    for key in ["glass-kind", "shape", "palette", "preserve"] {
        assert!(label(&rt, key).is_none(), "{key} shows for a halftone and a glass");
    }
    assert_eq!(label(&rt, "size").as_deref(), Some("Size (Mixed)"));
    assert_eq!(label(&rt, "scale").as_deref(), Some("Scale"));
    // A mixed toggle reads off, and a press turns it on for both.
    let (x, y) = rt.find("original").expect("original toggle");
    click(&mut rt, x, y);
    assert!(rt.state.entities.iter().all(|e| e.params.show_original));
    // Channel Shift glitches have no Scale. The mixed Style select picks for both.
    let (x, y) = rt.find("shader").expect("style select");
    click(&mut rt, x, y);
    let glitch = Shader::ALL.iter().position(|s| *s == Shader::Glitch).expect("glitch");
    rt.resolve_popup(Some(&glitch.to_string())).expect("menu answered");
    settle(&mut rt);
    assert!(rt.state.entities.iter().all(|e| e.params.shader == Shader::Glitch));
    assert!(label(&rt, "scale").is_none());
    assert!(label(&rt, "glitch-kind").is_some());
}

#[test]
fn a_slider_value_takes_typing_as_one_undo_step() {
    let mut rt = canvas();
    click(&mut rt, 200.0, 350.0);
    let undo = rt.state.undo.len();
    let (x, y) = rt.find("intensity-value").expect("strength readout");
    click(&mut rt, x, y);
    assert!(rt.state.value_target.is_some_and(|t| t.key == "intensity"), "the readout became a field");
    assert_eq!(rt.state.undo.len(), undo, "the press didn't drag the slider");
    let typed = |rt: &mut Runtime<App>, t: &str| {
        rt.key(KeyEvent { key: Key::Text(t.into()), mods: Mods::default() });
        settle(rt);
    };
    // The selected text is replaced, live.
    typed(&mut rt, "4");
    typed(&mut rt, "2");
    // Out of range clamps (Effect Strength runs 0–5).
    assert_eq!(rt.state.entity(1).expect("1").params.intensity, 5.0);
    rt.key(KeyEvent { key: Key::Backspace, mods: Mods::default() });
    settle(&mut rt);
    assert_eq!(rt.state.entity(1).expect("1").params.intensity, 4.0);
    rt.key(KeyEvent { key: Key::Down, mods: Mods::default() });
    settle(&mut rt);
    assert!((rt.state.entity(1).expect("1").params.intensity - 3.99).abs() < 1e-4, "a step down");
    rt.key(KeyEvent { key: Key::Escape, mods: Mods::default() });
    settle(&mut rt);
    assert!(rt.state.value_target.is_none());
    assert!(!rt.state.selection.is_empty(), "Escape left the field, not the selection");
    assert_eq!(rt.state.undo.len(), undo + 1, "one step for the typing");
    rt.key(KeyEvent { key: Key::Command('z'), mods: Mods { cmd: true, ..Mods::default() } });
    settle(&mut rt);
    assert_eq!(rt.state.entity(1).expect("1").params.intensity, 1.0);
}

#[test]
fn a_slider_value_field_commits_when_focus_leaves() {
    let mut rt = canvas();
    click(&mut rt, 200.0, 350.0);
    let (x, y) = rt.find("scale-value").expect("scale readout");
    click(&mut rt, x, y);
    rt.key(KeyEvent { key: Key::Text("2".into()), mods: Mods::default() });
    settle(&mut rt);
    // Elsewhere in the inspector (its title).
    let r = rt.presented("inspector").expect("inspector").0;
    click(&mut rt, r[0] + 40.0, r[1] + 20.0);
    // The field's poll sees the focus go.
    std::thread::sleep(std::time::Duration::from_millis(120));
    settle(&mut rt);
    assert!(rt.state.value_target.is_none() && rt.state.editing.is_none(), "the field closed its undo step");
    assert_eq!(rt.state.entity(1).expect("1").params.scale, 2.0);
}

#[test]
fn the_focused_playback_bar_steps_frames_and_jumps_to_the_ends() {
    let mut rt = canvas();
    // A three-frame GIF, 0.1 s a frame, large enough to carry its playback bar.
    let mut a = crate::media::test_asset(9, 500, 300);
    a.frames[0].delay = std::time::Duration::from_millis(100);
    for _ in 0..2 {
        a.frames.push(crate::media::Frame { rgba: a.frames[0].rgba.clone(), ..a.frames[0] });
    }
    a.duration = std::time::Duration::from_millis(300);
    rt.state.place(vec![Arc::new(a)], [600.0, 450.0], false);
    let id = rt.state.entities.last().expect("gif").id;
    settle(&mut rt);
    let (x, y) = rt.find("scrub").expect("playback bar");
    click(&mut rt, x, y);
    let key = |rt: &mut Runtime<App>, key: Key| {
        rt.key(KeyEvent { key, mods: Mods::default() });
        settle(rt);
    };
    let t = |rt: &Runtime<App>| rt.state.entity(id).expect("gif").play_t;
    key(&mut rt, Key::Text(" ".into()));
    assert!(!rt.state.entity(id).expect("gif").playing, "Space on the bar pauses");
    key(&mut rt, Key::Home);
    assert_eq!(t(&rt), 0.0);
    key(&mut rt, Key::Text(".".into()));
    assert!((t(&rt) - 0.1).abs() < 1e-9, "a frame on: {}", t(&rt));
    key(&mut rt, Key::Text(".".into()));
    key(&mut rt, Key::Text(".".into()));
    assert!((t(&rt) - 0.2).abs() < 1e-9, "held at the last frame: {}", t(&rt));
    key(&mut rt, Key::Text(",".into()));
    assert!((t(&rt) - 0.1).abs() < 1e-9, "a frame back: {}", t(&rt));
    key(&mut rt, Key::End);
    assert_eq!(rt.state.entity(id).expect("gif").asset.frame_at(t(&rt)), 2, "End shows the last frame");
    assert_eq!(rt.state.selection.len(), 1, "the bar's keys left the selection alone");
}

#[test]
fn d_shows_the_performance_overlay_and_a_click_switches_its_mode() {
    let mut rt = canvas();
    let d = || KeyEvent { key: Key::Text("d".into()), mods: Mods::default() };
    rt.key(d());
    settle(&mut rt);
    assert!(rt.state.perf.visible && rt.state.animating(), "continuous mode keeps frames coming");
    let (x, y) = rt.find("perf-overlay").expect("overlay");
    click(&mut rt, x, y);
    assert_eq!(rt.state.perf.mode, crate::perf::Mode::Rendered);
    assert!(rt.state.selection.is_empty(), "the click stayed on the overlay");
    assert!(!rt.state.animating(), "rendered mode draws only when asked");
    rt.key(d());
    settle(&mut rt);
    assert!(!rt.state.perf.visible && rt.find("perf-overlay").is_none());
}
