//! Clipboard, as the web app uses it (FEATURES.md §4.9, §9.1): ⌘C copies the selected entity's
//! rendered image, ⌃⌘C its effect as `{"__voidmesh":true,…}` JSON, and ⌘V pastes effects onto
//! the selection, or images and files onto the canvas.

use std::sync::Arc;

use serde_json::{Value, json};

use crate::effects::{ORIGINAL_ID, Palette, presets};
use crate::state::{App, Export};
use crate::workspace;

/// The effects JSON for the focused entity.
pub fn effects_json(s: &App) -> Option<String> {
    let e = s.focus()?;
    let mut params = workspace::params_json(&e.params);
    params["time"] = json!(e.fx_t);
    params["timeAutoPlay"] = json!(e.params.time_autoplay);
    let mut v = json!({ "__voidmesh": true, "version": 1, "shaderType": workspace::shader_id(e.params.shader), "shaderParams": params });
    if let Some(p) = e.asset.original_palette() {
        v["originalPalette"] = workspace::palette_json(&p);
    }
    serde_json::to_string(&v).ok()
}

/// ⌃⌘C.
pub fn copy_effects(s: &mut App, tx: &mut rune::Tx) {
    if let Some(text) = effects_json(s) {
        tx.copy(text);
        s.toast("Effects copied to clipboard");
    }
}

/// ⌘C: the selected entity, rendered, as PNG (single selection, as on the web).
pub fn copy_image(s: &mut App) {
    if s.selection.len() != 1 {
        return;
    }
    if let Some(id) = s.focus().map(|e| e.id) {
        s.exports.push(Export { entity: id, path: None });
    }
}

/// Apply pasted effects JSON to the selection as one undo step; false if `text` isn't one.
pub fn paste_effects(s: &mut App, text: &str) -> bool {
    let Ok(v) = serde_json::from_str::<Value>(text.trim()) else { return false };
    if v["__voidmesh"] != true || !v["shaderParams"].is_object() {
        return false;
    }
    if s.selection.is_empty() {
        s.toast("Select something to paste effects onto");
        return true;
    }
    let mut params = workspace::params_from(v["shaderType"].as_str().unwrap_or("dithering"), &v["shaderParams"]);
    // A user palette comes along as one of ours (reused when the colours already exist).
    let pal = params.palette.clone();
    let preset = presets().iter().any(|p| p.id == pal.id);
    if !preset && pal.id != ORIGINAL_ID {
        params.palette = adopt_palette(s, pal);
    }
    let n = s.selection.len();
    s.checkpoint();
    let sel = s.selection.clone();
    for e in s.entities.iter_mut().filter(|e| sel.contains(&e.id)) {
        let mut p = params.clone();
        if p.palette.id == ORIGINAL_ID
            && let Some(own) = e.asset.original_palette()
        {
            p.palette = own;
        }
        e.params = p;
    }
    if let Some(p) = s.focus().map(|e| e.params.clone()) {
        s.last_params = p;
    }
    s.toast(format!("Applied effects to {n} {}", if n == 1 { "entity" } else { "entities" }));
    true
}

/// A user palette with these colours, added if new.
pub fn adopt_palette(s: &mut App, p: Palette) -> Palette {
    if let Some(have) = s.palettes.iter().find(|q| q.colors == p.colors) {
        return have.clone();
    }
    let n = s.palettes.iter().filter(|q| q.name.starts_with("Custom")).count() + 1;
    let id = crate::effects::new_palette_id("cstm_");
    let p = Palette { id, name: format!("Custom {n}"), short_name: format!("Custom {n}"), colors: p.colors };
    s.palettes.push(p.clone());
    crate::prefs::save_palettes(s);
    p
}

/// ⌘V: effects onto the selection; else images or files onto the canvas at the view's centre.
pub fn paste(s: &mut App, c: &rune::ClipboardContent) {
    if paste_effects(s, c.text()) {
        return;
    }
    if !c.files().is_empty() {
        s.import(c.files().to_vec(), None);
        return;
    }
    if let Some(img) = c.image() {
        let bytes: Arc<[u8]> = img.png().into();
        match crate::media::decode_bytes(crate::media::next_asset_id(), "Pasted image.png".into(), "png", bytes) {
            Ok(a) => {
                let at = s.cam.world([s.canvas[0] + s.canvas[2] / 2.0, s.canvas[1] + s.canvas[3] / 2.0]);
                s.place(vec![Arc::new(a)], at, true);
            }
            Err(e) => s.toast(format!("Couldn't paste: {e}")),
        }
        return;
    }
    // A path to media, as text.
    let path = std::path::PathBuf::from(c.text().trim());
    if path.is_absolute() && path.is_file() {
        s.import(vec![path], None);
        return;
    }
    s.toast("No media or effects found in clipboard");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effects::Shader;

    #[test]
    fn copied_effects_paste_onto_another_entity() {
        let mut s = App::default();
        s.place(vec![Arc::new(crate::media::test_asset(1, 10, 10)), Arc::new(crate::media::test_asset(2, 10, 10))], [0.0, 0.0], false);
        let ids: Vec<u32> = s.entities.iter().map(|e| e.id).collect();
        s.select_only(ids[0]);
        s.edit(|p| {
            p.set_shader(Shader::Glitch);
            p.palette = Palette { id: "cstm_x".into(), name: "Mine".into(), short_name: "Mine".into(), colors: vec![[1.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0]] };
        });
        let json = effects_json(&s).expect("json");
        s.select_only(ids[1]);
        let undo = s.undo.len();
        assert!(paste_effects(&mut s, &json));
        let b = s.entity(ids[1]).expect("b");
        assert_eq!(b.params.shader, Shader::Glitch);
        assert_eq!(b.params.palette.colors, vec![[1.0, 0.0, 0.0, 1.0], [0.0, 0.0, 1.0, 1.0]]);
        assert!(b.params.palette.id.starts_with("cstm_"));
        assert_eq!(s.palettes.len(), 1);
        assert_eq!(s.undo.len(), undo + 1);
        assert!(!paste_effects(&mut s, "hello"));
    }
}
