//! The workspace library (⇧⌘O): every stored workspace, newest first, as a view inside the
//! window like Settings. A row opens its workspace in a tab (or shows its tab); the trash asks
//! once more, then deletes it. Esc closes it.

use rune::{El, ScrollSpec, TextStyle, col, el, icon, row, text};

use super::look::{self, Look, MEDIUM, SMALL};
use super::widgets::{PLUS, TRASH, XMARK};
use crate::state::App;

const TITLE: TextStyle = TextStyle::new(28.0, 500.0);
const LABEL: TextStyle = TextStyle::new(14.0, 400.0);
const DESC: TextStyle = TextStyle::new(12.0, 400.0);
const COLUMN: f32 = 768.0;

pub fn toggle(s: &mut App) {
    if s.library.is_some() {
        s.library = None;
    } else {
        s.open_library();
    }
}

/// "just now", "5 min ago", "3 h ago", "2 days ago", then a date.
pub fn ago(then_ms: u64, now_ms: u64) -> String {
    let secs = now_ms.saturating_sub(then_ms) / 1000;
    match secs {
        0..60 => "just now".into(),
        60..3600 => format!("{} min ago", secs / 60),
        3600..86_400 => format!("{} h ago", secs / 3600),
        86_400..604_800 => {
            let d = secs / 86_400;
            if d == 1 { "yesterday".into() } else { format!("{d} days ago") }
        }
        _ => {
            // Civil date (Howard Hinnant's algorithm), as `workspace::iso_now`.
            let z = (then_ms / 86_400_000) as i64 + 719_468;
            let era = z.div_euclid(146_097);
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = yoe + era * 400 + i64::from(m <= 2);
            format!("{y}-{m:02}-{d:02}")
        }
    }
}

pub fn view(l: &Look, s: &App, list: &[crate::store::Meta], top: f32) -> El {
    let close = el()
        .key("library-close")
        .role("button")
        .label("Close Workspaces")
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
    let new = l.primary_button(
        el().key("library-new")
            .role("button")
            .label("New workspace")
            .h(32.0)
            .px(14.0)
            .radius(16.0)
            .center()
            .press_scale(0.97)
            .cursor(rune::Cursor::Pointer)
            .on_press(|s: &mut App| {
                s.library = None;
                s.new_tab();
            })
            .child(row().gap(6.0).center_y().child(icon(&PLUS, 15.0).color(rune::Color::WHITE)).child(text("New").font(MEDIUM).color(rune::Color::WHITE))),
    );
    let now = crate::store::now_ms();
    let mut rows = col().w_full().radius(8.0).clip_rounded(8.0).border(1.0, l.border).fill(l.surface);
    if list.is_empty() {
        rows = rows.child(row().w_full().min_h(52.0).px(16.0).center_y().child(text("Workspaces you make are kept here. They save as you work.").font(LABEL).color(l.text_desc)));
    }
    for (i, m) in list.iter().enumerate() {
        if i > 0 {
            rows = rows.child(el().w_full().h(1.0).fill(l.border));
        }
        rows = rows.child(item(l, s, m, now));
    }
    let page = col()
        .key("library-page")
        .w_full()
        .max_w(COLUMN)
        .px(16.0)
        .pt(top + 40.0)
        .pb(40.0)
        .child(row().w_full().pb(32.0).center_y().justify_between().child(text("Workspaces").font(TITLE).color(l.text)).child(row().gap(12.0).center_y().child(new).child(close)))
        .child(rows);
    look::own_gestures(
        el().key("library")
            .absolute(0.0, 0.0)
            .w_full()
            .h_full()
            .fill(l.background)
            .on_press(|_: &mut App| {})
            .child(col().key("library-scroll").w_full().h_full().scroll(ScrollSpec { stick_bottom: false }).items_center().child(page)),
    )
}

fn item(l: &Look, s: &App, m: &crate::store::Meta, now: u64) -> El {
    let open_tab = s.tabs.iter().position(|t| t.id == m.id);
    let mut desc = format!("Edited {}", ago(m.updated, now));
    match open_tab {
        Some(i) if i == s.active => desc.push_str(" · showing"),
        Some(_) => desc.push_str(" · open"),
        None => {}
    }
    let (id, name) = (m.id.clone(), m.name.clone());
    let words = col().grow(1.0).shrink().gap(2.0).child(text(m.name.clone()).font(LABEL).color(l.text_label).truncate()).child(text(desc).font(DESC).color(l.text_desc).truncate());
    let del_id = m.id.clone();
    let confirming = s.confirm_delete.as_deref() == Some(m.id.as_str());
    let delete = if confirming {
        el().key(format!("library-confirm-{}", m.id))
            .role("button")
            .label("Delete for good")
            .h(28.0)
            .px(12.0)
            .radius(14.0)
            .center()
            .fill(l.destructive)
            .cursor(rune::Cursor::Pointer)
            .on_press(move |s: &mut App| s.delete_workspace(&del_id))
            .child(text("Delete").font(SMALL).color(rune::Color::WHITE))
    } else {
        el().key(format!("library-delete-{}", m.id))
            .role("button")
            .label("Delete workspace")
            .help("Delete")
            .size(32.0, 32.0)
            .radius(16.0)
            .center()
            .hover(l.hover)
            .cursor(rune::Cursor::Pointer)
            .on_press(move |s: &mut App| s.confirm_delete = Some(del_id.clone()))
            .child(icon(&TRASH, 16.0).color(l.text_muted))
    };
    row()
        .key(format!("library-{}", m.id))
        .role("button")
        .label(m.name.clone())
        .w_full()
        .min_h(56.0)
        .pl(16.0)
        .pr(10.0)
        .gap(16.0)
        .center_y()
        .hover(l.hover)
        .cursor(rune::Cursor::Pointer)
        .on_press(move |s: &mut App| {
            s.library = None;
            s.open_stored(&id, &name);
        })
        .child(words)
        .child(delete)
}

#[cfg(test)]
mod tests {
    use super::ago;

    #[test]
    fn times_read_naturally() {
        let now = 1_800_000_000_000;
        assert_eq!(ago(now - 5_000, now), "just now");
        assert_eq!(ago(now - 300_000, now), "5 min ago");
        assert_eq!(ago(now - 3 * 3_600_000, now), "3 h ago");
        assert_eq!(ago(now - 86_400_000, now), "yesterday");
        assert_eq!(ago(now - 3 * 86_400_000, now), "3 days ago");
        assert_eq!(ago(0, now), "1970-01-01");
    }
}
