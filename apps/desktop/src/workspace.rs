//! `.vdmsh` workspaces, the web app's format (`lib/serialization`, manifest v6): a zip with
//! `manifest.json` and the original media. Reads every manifest version the web app migrates
//! (v1–v6: inline or table-referenced params, media paths and original palettes) and writes v6,
//! so a file round-trips between the two apps.
//!
//! World units match: a world unit is a media pixel in both. The web viewport's `zoom` counts
//! device pixels per world unit and `offset` is the world point at the canvas's top-left.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde_json::{Map, Value, json};

use crate::effects::{DotShape, Palette, Params, Rgba, Shader};
use crate::media::{self, Asset, Kind, Original};

pub const EXTENSIONS: &[&str] = &["vdmsh", "studio", "zip"];
const VERSION: u64 = 6;

pub fn is_workspace(path: &Path) -> bool {
    path.extension().is_some_and(|e| EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// One entity as a workspace holds it.
#[derive(Clone)]
pub struct Item {
    /// The web's `entity-N` number, when it has one.
    pub id: Option<u32>,
    pub name: String,
    pub asset: Arc<Asset>,
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub z: u32,
    pub params: Params,
    pub fx_t: f64,
    pub playing: bool,
    pub play_t: f64,
    pub muted: bool,
}

/// The web viewport: the world point at the canvas's top-left and device pixels per world unit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Viewport {
    pub offset: [f64; 2],
    pub zoom: f64,
}

pub struct Workspace {
    pub items: Vec<Item>,
    pub viewport: Viewport,
    /// User palettes the entities reference.
    pub palettes: Vec<Palette>,
    /// Entities that couldn't be restored: `name: reason`.
    pub failed: Vec<String>,
}

/// Import progress, shared with the UI thread.
#[derive(Default)]
pub struct Progress {
    pub done: AtomicUsize,
    pub total: AtomicUsize,
    pub cancel: AtomicBool,
}

// ---------------------------------------------------------------------------------------- read

/// Read a workspace. Videos are written out to `cache` (AVFoundation reads files), keyed by
/// content so reopening a file reuses them. Nothing is half-applied: the caller adopts the
/// whole result or none of it.
pub fn read(path: &Path, cache: &Path, progress: &Progress) -> Result<Workspace, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("not a workspace ({e})"))?;
    let manifest: Value = {
        let mut f = zip.by_name("manifest.json").map_err(|_| "no manifest.json")?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        serde_json::from_str(&s).map_err(|e| format!("manifest: {e}"))?
    };
    if manifest["type"] != "studio-canvas" {
        return Err("not a Voidmesh workspace".into());
    }
    let version = manifest["version"].as_u64().ok_or("manifest has no version")?;
    if version > VERSION {
        return Err(format!("made by a newer Voidmesh (format {version})"));
    }
    let vp = &manifest["viewport"];
    let viewport = Viewport {
        offset: [vp["offset"]["x"].as_f64().unwrap_or(0.0), vp["offset"]["y"].as_f64().unwrap_or(0.0)],
        zoom: vp["zoom"].as_f64().filter(|z| *z > 0.0).unwrap_or(1.0),
    };
    let table = |k: &str| manifest[k].as_array().cloned().unwrap_or_default();
    let (params_table, media_table, originals_table) = (table("shaderParamsTable"), table("mediaFiles"), table("originalPalettes"));
    let palettes: Vec<Palette> = table("palettes").iter().filter_map(palette_from).collect();
    let entities = manifest["entities"].as_array().ok_or("manifest has no entities")?;
    progress.total.store(entities.len(), Ordering::Relaxed);

    let mut assets: HashMap<String, Arc<Asset>> = HashMap::new();
    let mut items = Vec::new();
    let mut failed = Vec::new();
    for (i, e) in entities.iter().enumerate() {
        if progress.cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let name = e["name"].as_str().unwrap_or("media").to_string();
        let resolve = |inline: &str, r: &str, t: &[Value]| -> Option<Value> {
            match e.get(inline) {
                Some(v) if !v.is_null() => Some(v.clone()),
                _ => e[r].as_u64().and_then(|i| t.get(i as usize).cloned()),
            }
        };
        let item = (|| -> Result<Item, String> {
            let media_path = resolve("mediaFile", "mediaFileRef", &media_table).and_then(|v| v.as_str().map(String::from)).ok_or("no media file")?;
            let asset = match assets.get(&media_path) {
                Some(a) => a.clone(),
                None => {
                    let a = Arc::new(load_media(&mut zip, &media_path, e, &name, cache)?);
                    assets.insert(media_path, a.clone());
                    a
                }
            };
            let params_json = resolve("shaderParams", "shaderParamsRef", &params_table).ok_or("no effect parameters")?;
            let mut params = params_from(e["shaderType"].as_str().unwrap_or("dithering"), &params_json);
            if let Some(t) = e["shaderTimeAutoPlay"].as_bool() {
                params.time_autoplay = t;
            }
            let fx_t = e["shaderTime"].as_f64().or_else(|| params_json["time"].as_f64()).unwrap_or(0.0);
            let pb = &e["playback"];
            let animated = asset.animated();
            let size = [e["size"]["width"].as_f64().unwrap_or(f64::from(asset.width)) as f32, e["size"]["height"].as_f64().unwrap_or(f64::from(asset.height)) as f32];
            Ok(Item {
                id: e["id"].as_str().and_then(|s| s.rsplit('-').next()).and_then(|n| n.parse().ok()),
                name: name.clone(),
                pos: [e["position"]["x"].as_f64().unwrap_or(0.0) as f32, e["position"]["y"].as_f64().unwrap_or(0.0) as f32],
                size,
                z: e["zIndex"].as_u64().unwrap_or(i as u64) as u32,
                params,
                fx_t,
                // Restored videos play if they were; GIFs only when saved playing.
                playing: animated && pb["isPlaying"].as_bool().unwrap_or(asset.kind == Kind::Video),
                play_t: pb["currentTime"].as_f64().unwrap_or(0.0).clamp(0.0, asset.duration.as_secs_f64()),
                muted: pb["muted"].as_bool().unwrap_or(true),
                asset,
            })
        })();
        match item {
            Ok(it) => items.push(it),
            Err(err) => failed.push(format!("{name}: {err}")),
        }
        progress.done.store(i + 1, Ordering::Relaxed);
    }
    // Saved Original palettes (videos have none of their own) fill in for the asset's.
    for (e, it) in entities.iter().zip(items.iter_mut()) {
        if it.asset.palette.is_none()
            && let Some(p) = e.get("originalPalette").filter(|v| !v.is_null()).cloned().or_else(|| e["originalPaletteRef"].as_u64().and_then(|i| originals_table.get(i as usize).cloned())).and_then(|v| palette_from(&v))
            && let Some(a) = Arc::get_mut(&mut it.asset)
        {
            a.palette = Some(p.colors);
        }
    }
    items.sort_by_key(|it| it.z);
    Ok(Workspace { items, viewport, palettes, failed })
}

fn load_media<R: Read + std::io::Seek>(zip: &mut zip::ZipArchive<R>, path: &str, e: &Value, name: &str, cache: &Path) -> Result<Asset, String> {
    let mut f = zip.by_name(path).map_err(|_| format!("missing {path}"))?;
    let mut bytes = Vec::with_capacity(f.size() as usize);
    f.read_to_end(&mut bytes).map_err(|err| err.to_string())?;
    let ext = path.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
    let id = media::next_asset_id();
    if e["mediaType"] == "video" {
        let file = cache_video(cache, &bytes, &ext)?;
        return media::decode_video(id, name.to_string(), ext, file);
    }
    media::decode_bytes(id, name.to_string(), &ext, bytes.into())
}

/// Write a video's bytes to the cache under a content hash; an existing copy is reused.
fn cache_video(cache: &Path, bytes: &[u8], ext: &str) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    let ext = if media::is_video(ext) { ext } else { "mp4" };
    let path = cache.join(format!("{:016x}-{}.{ext}", h.finish(), bytes.len()));
    if std::fs::metadata(&path).is_ok_and(|m| m.len() == bytes.len() as u64) {
        return Ok(path);
    }
    std::fs::create_dir_all(cache).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

fn rgba_from(v: &Value) -> Option<Rgba> {
    let a = v.as_array()?;
    if a.len() != 4 {
        return None;
    }
    Some([0, 1, 2, 3].map(|i| a[i].as_f64().unwrap_or(1.0).clamp(0.0, 1.0) as f32))
}

pub fn palette_from(v: &Value) -> Option<Palette> {
    let colors: Vec<Rgba> = v["colors"].as_array()?.iter().filter_map(rgba_from).take(crate::effects::MAX_COLORS).collect();
    if colors.len() < 2 {
        return None;
    }
    let name = v["name"].as_str().unwrap_or("Custom").to_string();
    Some(Palette { id: v["id"].as_str().unwrap_or("custom").to_string(), short_name: v["shortName"].as_str().map(String::from).unwrap_or_else(|| name.clone()), name, colors })
}

const SHADERS: [(&str, Shader); 7] =
    [("halftone", Shader::Halftone), ("blobs", Shader::Blobs), ("melt", Shader::Melt), ("dithering", Shader::Dithering), ("ascii", Shader::Ascii), ("glass", Shader::Glass), ("glitch", Shader::Glitch)];
const SHAPES: [(&str, DotShape); 3] = [("circle", DotShape::Circle), ("square", DotShape::Square), ("rect_v", DotShape::RectV)];
/// Index = `Params::dither_kind`.
pub const DITHER_IDS: [&str; 12] = ["bayer2x2", "bayer4x4", "bayer8x8", "whiteNoise", "blueNoise", "floydSteinberg", "atkinson", "jarvisJudiceNinke", "stucki", "burkes", "sierra", "sierraLite"];
const ASCII_IDS: [&str; 4] = ["standard", "extended", "binary", "minimal"];
const GLASS_IDS: [&str; 3] = ["fluted", "frostedVoronoi", "flowing"];
const GLITCH_IDS: [&str; 4] = ["channelShift", "scanline", "blockCorrupt", "pixelSmear"];

fn index(ids: &[&str], v: &Value) -> Option<u32> {
    v.as_str().and_then(|s| ids.iter().position(|x| *x == s)).map(|i| i as u32)
}

/// Web `ShaderParams` onto the defaults: absent fields keep them, as the web's deep merge does.
pub fn params_from(shader: &str, v: &Value) -> Params {
    let mut p = Params { shader: SHADERS.iter().find(|(s, _)| *s == shader).map_or(Shader::Dithering, |x| x.1), ..Params::default() };
    let f = |v: &Value, d: f32| v.as_f64().map_or(d, |x| x as f32);
    let b = |v: &Value, d: bool| v.as_bool().unwrap_or(d);
    p.size = f(&v["size"], p.size);
    if let Some(s) = v["shape"].as_str().and_then(|s| SHAPES.iter().find(|(x, _)| *x == s)) {
        p.shape = s.1;
    }
    p.preserve_colors = b(&v["preserveColors"], p.preserve_colors);
    p.reverse_palette = b(&v["reversePalette"], p.reverse_palette);
    p.show_original = b(&v["showOriginal"], p.show_original);
    p.scale = f(&v["scale"], p.scale);
    p.intensity = f(&v["intensity"], p.intensity);
    p.eagerness = f(&v["blobs"]["eagerness"], p.eagerness);
    p.dither_kind = index(&DITHER_IDS, &v["dithering"]["kind"]).unwrap_or(p.dither_kind);
    p.ascii_kind = index(&ASCII_IDS, &v["ascii"]["kind"]).unwrap_or(p.ascii_kind);
    p.ascii_invert = b(&v["ascii"]["invert"], p.ascii_invert);
    let g = &v["glass"];
    p.glass_kind = index(&GLASS_IDS, &g["kind"]).unwrap_or(p.glass_kind);
    p.glass_angle = f(&g["angle"], p.glass_angle);
    p.caustic = f(&g["caustic"], p.caustic);
    p.frostiness = f(&g["frostiness"], p.frostiness);
    p.highlight = f(&g["highlight"], p.highlight);
    p.dispersion = f(&g["dispersion"], p.dispersion);
    p.flow = f(&g["flow"], p.flow);
    p.glitch_kind = index(&GLITCH_IDS, &v["glitch"]["kind"]).unwrap_or(p.glitch_kind);
    p.glitch_angle = f(&v["glitch"]["angle"], p.glitch_angle);
    if let Some(pal) = palette_from(&v["palette"]) {
        p.palette = pal;
    }
    let a = &v["adjustments"];
    p.brightness = f(&a["brightness"], p.brightness);
    p.contrast = f(&a["contrast"], p.contrast);
    p.saturation = f(&a["saturation"], p.saturation);
    p.blur = f(&a["blur"], p.blur);
    let pp = &v["postProcess"];
    let master = b(&pp["enabled"], true);
    let (gr, bl, ca) = (&pp["grain"], &pp["bloom"], &pp["chromaticAberration"]);
    // A null effect is off; an absent one keeps the default.
    let on = |k: &str, d: bool| {
        master
            && match pp.get(k) {
                Some(Value::Null) => false,
                Some(x) => b(&x["enabled"], d),
                None => d,
            }
    };
    p.grain = on("grain", p.grain);
    p.grain_size = f(&gr["size"], p.grain_size);
    p.grain_intensity = f(&gr["intensity"], p.grain_intensity);
    p.bloom = on("bloom", p.bloom);
    p.bloom_threshold = f(&bl["threshold"], p.bloom_threshold);
    p.bloom_intensity = f(&bl["intensity"], p.bloom_intensity);
    p.bloom_radius = f(&bl["filterRadius"], p.bloom_radius);
    p.bloom_softness = f(&bl["softness"], p.bloom_softness);
    p.chroma = on("chromaticAberration", p.chroma);
    p.chroma_offset = f(&ca["offset"], p.chroma_offset);
    p.time_autoplay = b(&v["timeAutoPlay"], p.time_autoplay);
    p
}

pub fn shader_id(s: Shader) -> &'static str {
    SHADERS.iter().find(|(_, x)| *x == s).map_or("dithering", |x| x.0)
}

pub fn palette_json(p: &Palette) -> Value {
    json!({ "id": p.id, "name": p.name, "shortName": p.short_name, "colors": p.colors })
}

/// `Params` as the web's static `ShaderParams` (no `time`/`timeAutoPlay`, which go on the entity).
pub fn params_json(p: &Params) -> Value {
    let id = |ids: &[&str], i: u32| ids.get(i as usize).copied().unwrap_or(ids[0]).to_string();
    json!({
        "size": p.size,
        "shape": SHAPES.iter().find(|(_, s)| *s == p.shape).map_or("circle", |x| x.0),
        "color": [33.0 / 255.0, 150.0 / 255.0, 243.0 / 255.0, 1.0],
        "background": [0.0, 0.0, 0.0, 1.0],
        "preserveColors": p.preserve_colors,
        "reversePalette": p.reverse_palette,
        "showOriginal": p.show_original,
        "scale": p.scale,
        "intensity": p.intensity,
        "blobs": { "eagerness": p.eagerness },
        "dithering": { "kind": id(&DITHER_IDS, p.dither_kind) },
        "ascii": { "kind": id(&ASCII_IDS, p.ascii_kind), "invert": p.ascii_invert },
        "glass": {
            "kind": id(&GLASS_IDS, p.glass_kind), "angle": p.glass_angle, "caustic": p.caustic, "frostiness": p.frostiness,
            "highlight": p.highlight, "dispersion": p.dispersion, "flow": p.flow,
        },
        "glitch": { "kind": id(&GLITCH_IDS, p.glitch_kind), "angle": p.glitch_angle },
        "palette": palette_json(&p.palette),
        "postProcess": {
            "enabled": true,
            "grain": { "enabled": p.grain, "size": p.grain_size, "intensity": p.grain_intensity },
            "bloom": { "enabled": p.bloom, "threshold": p.bloom_threshold, "intensity": p.bloom_intensity, "filterRadius": p.bloom_radius, "softness": p.bloom_softness },
            "chromaticAberration": { "enabled": p.chroma, "offset": p.chroma_offset },
        },
        "adjustments": { "brightness": p.brightness, "contrast": p.contrast, "saturation": p.saturation, "blur": p.blur },
    })
}

// --------------------------------------------------------------------------------------- write

/// Where an entity's media goes: one PNG per shared still asset (as the web writes it), the
/// original bytes for GIF, SVG and video.
fn media_path(a: &Asset, entity_id: &str) -> String {
    match a.kind {
        Kind::Image => format!("media/assets/asset-{}-1.png", a.id),
        Kind::Gif => format!("media/{entity_id}.gif"),
        Kind::Svg => format!("media/{entity_id}.svg"),
        Kind::Video => format!("media/{entity_id}.{}", if media::is_video(&a.ext) { a.ext.as_str() } else { "mp4" }),
    }
}

fn media_bytes(a: &Asset) -> Result<Vec<u8>, String> {
    match (a.kind, &a.original) {
        (Kind::Image, _) => {
            let f = a.frames.first().ok_or("no pixels")?;
            let mut out = Vec::new();
            image::RgbaImage::from_raw(a.width, a.height, f.rgba.clone())
                .ok_or("bad image size")?
                .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
                .map_err(|e| e.to_string())?;
            Ok(out)
        }
        (_, Original::Bytes(b)) => Ok(b.to_vec()),
        (_, Original::File(p)) => std::fs::read(p).map_err(|e| format!("{}: {e}", p.display())),
    }
}

/// Write a workspace to `path` (through a temporary file, so a failed save leaves the old one).
pub fn write(path: &Path, items: &[Item], viewport: Viewport, palettes: &[Palette]) -> Result<(), String> {
    let mut items: Vec<&Item> = items.iter().collect();
    items.sort_by_key(|it| it.z);
    let mut params_table: Vec<Value> = Vec::new();
    let mut media_files: Vec<String> = Vec::new();
    let mut originals: Vec<Value> = Vec::new();
    let mut entities = Vec::new();
    let mut media: Vec<(String, Arc<Asset>)> = Vec::new();
    let intern = |table: &mut Vec<Value>, v: Value| table.iter().position(|x| *x == v).unwrap_or_else(|| {
        table.push(v);
        table.len() - 1
    });
    for (n, it) in items.iter().enumerate() {
        let entity_id = format!("entity-{}", it.id.unwrap_or(n as u32 + 1));
        let mpath = media_path(&it.asset, &entity_id);
        let media_ref = media_files.iter().position(|m| *m == mpath).unwrap_or_else(|| {
            media_files.push(mpath.clone());
            media.push((mpath.clone(), it.asset.clone()));
            media_files.len() - 1
        });
        let a = &it.asset;
        let mut e = Map::new();
        e.insert("id".into(), json!(entity_id));
        e.insert("name".into(), json!(it.name));
        e.insert("position".into(), json!({ "x": it.pos[0], "y": it.pos[1] }));
        e.insert("size".into(), json!({ "width": it.size[0], "height": it.size[1] }));
        e.insert("originalSize".into(), json!({ "width": a.width, "height": a.height }));
        e.insert("zIndex".into(), json!(it.z));
        e.insert("rotation".into(), json!(0));
        e.insert("locked".into(), json!(false));
        e.insert("edited".into(), json!(it.params != Params::default()));
        e.insert("shaderType".into(), json!(shader_id(it.params.shader)));
        e.insert("shaderParamsRef".into(), json!(intern(&mut params_table, params_json(&it.params))));
        e.insert("shaderTime".into(), json!(it.fx_t));
        e.insert("shaderTimeAutoPlay".into(), json!(it.params.time_autoplay));
        if let Some(p) = a.original_palette() {
            e.insert("originalPaletteRef".into(), json!(intern(&mut originals, palette_json(&p))));
        }
        e.insert("mediaFileRef".into(), json!(media_ref));
        let playback = json!({ "currentTime": it.play_t, "loop": true, "playbackRate": 1, "muted": it.muted, "volume": 1, "isPlaying": it.playing });
        match a.kind {
            Kind::Image => {
                e.insert("mediaType".into(), json!("image"));
            }
            Kind::Svg => {
                e.insert("mediaType".into(), json!("svg"));
            }
            Kind::Gif => {
                let secs = a.duration.as_secs_f64();
                e.insert("mediaType".into(), json!("gif"));
                e.insert("duration".into(), json!(secs));
                e.insert("fps".into(), json!(if secs > 0.0 { a.frames.len() as f64 / secs } else { 10.0 }));
                e.insert("playback".into(), playback);
            }
            Kind::Video => {
                let v = a.video.as_ref();
                e.insert("mediaType".into(), json!("video"));
                e.insert("duration".into(), json!(a.duration.as_secs_f64()));
                e.insert("fps".into(), json!(v.and_then(|v| v.fps)));
                e.insert("hasAudio".into(), json!(v.is_some_and(|v| v.has_audio)));
                e.insert("playback".into(), playback);
            }
        }
        entities.push(Value::Object(e));
    }
    // Custom palettes the entities use.
    let used: Vec<Value> = palettes.iter().filter(|p| items.iter().any(|it| it.params.palette.id == p.id)).map(palette_json).collect();
    let mut manifest = json!({
        "type": "studio-canvas",
        "version": VERSION,
        "createdAt": iso_now(),
        "viewport": { "offset": { "x": viewport.offset[0], "y": viewport.offset[1] }, "zoom": viewport.zoom },
        "entities": entities,
        "shaderParamsTable": params_table,
        "mediaFiles": media_files,
    });
    if !originals.is_empty() {
        manifest["originalPalettes"] = json!(originals);
    }
    if !used.is_empty() {
        manifest["palettes"] = json!(used);
    }

    let tmp = path.with_extension("vdmsh.part");
    let result = (|| -> Result<(), String> {
        let file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
        let deflate = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored).large_file(true);
        zip.start_file("manifest.json", deflate).map_err(|e| e.to_string())?;
        zip.write_all(serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?.as_bytes()).map_err(|e| e.to_string())?;
        for (p, a) in &media {
            let bytes = media_bytes(a)?;
            // Compressed media doesn't shrink; SVG text does.
            zip.start_file(p.as_str(), if a.kind == Kind::Svg { deflate } else { stored }).map_err(|e| e.to_string())?;
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?.flush().map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

/// UTC now as ISO 8601, without a date crate.
fn iso_now() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil from days (Howard Hinnant's algorithm).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z", rem / 3600, rem % 3600 / 60, rem % 60)
}

/// A fun default name, as the web app's `adjective-noun-verb.vdmsh`.
pub fn random_name() -> String {
    const A: [&str; 12] = ["quiet", "velvet", "hollow", "lucid", "feral", "amber", "static", "drowsy", "sunken", "molten", "silver", "tender"];
    const N: [&str; 12] = ["moth", "signal", "harbor", "orchid", "comet", "lantern", "glacier", "ember", "meadow", "relic", "cipher", "tide"];
    const V: [&str; 12] = ["drifts", "hums", "unfolds", "flickers", "wanders", "dissolves", "blooms", "echoes", "melts", "sleeps", "glows", "turns"];
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()) as usize;
    format!("{}-{}-{}.vdmsh", A[t % 12], N[(t / 12) % 12], V[(t / 144) % 12])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(asset: Arc<Asset>, id: u32, x: f32) -> Item {
        Item { id: Some(id), name: format!("e{id}.png"), size: [asset.width as f32, asset.height as f32], asset, pos: [x, 10.0], z: id, params: Params::default(), fx_t: 0.0, playing: false, play_t: 0.0, muted: true }
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("voidmesh-ws-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&d);
        d
    }

    #[test]
    fn round_trips_entities_params_and_shared_assets() {
        let mut px = vec![0u8; 4 * 4 * 4];
        px.iter_mut().enumerate().for_each(|(i, v)| *v = (i * 7 % 256) as u8);
        let mut a = media::test_asset(7, 4, 4);
        a.frames[0].rgba = px.clone();
        a.palette = Some(vec![[0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]]);
        let a = Arc::new(a);
        let mut one = item(a.clone(), 1, 0.0);
        one.params.set_shader(Shader::Glass);
        one.params.set_glass_kind(2);
        one.params.palette = crate::effects::presets()[8].clone();
        one.fx_t = 3.5;
        let two = item(a, 2, 200.0);
        let d = dir("rt");
        let path = d.join("t.vdmsh");
        let vp = Viewport { offset: [-100.0, -50.0], zoom: 2.0 };
        write(&path, &[one.clone(), two], vp, &[]).expect("write");
        let ws = read(&path, &d, &Progress::default()).expect("read");
        assert!(ws.failed.is_empty(), "{:?}", ws.failed);
        assert_eq!(ws.viewport, vp);
        assert_eq!(ws.items.len(), 2);
        assert!(Arc::ptr_eq(&ws.items[0].asset, &ws.items[1].asset), "one PNG for a shared asset");
        assert_eq!(ws.items[0].asset.frames[0].rgba, px);
        let r = &ws.items[0];
        assert_eq!((r.id, r.pos, r.fx_t), (Some(1), [0.0, 10.0], 3.5));
        assert_eq!(r.params, one.params);
        assert_eq!(ws.items[1].pos, [200.0, 10.0]);
    }

    #[test]
    fn reads_a_v1_manifest_with_inline_params() {
        let d = dir("v1");
        let path = d.join("old.vdmsh");
        let png = {
            let mut out = Vec::new();
            image::RgbaImage::from_pixel(2, 2, image::Rgba([255, 0, 0, 255])).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).expect("png");
            out
        };
        let manifest = json!({
            "type": "studio-canvas", "version": 1, "createdAt": "2025-01-01T00:00:00.000Z",
            "viewport": { "offset": { "x": 0, "y": 0 }, "zoom": 1 },
            "entities": [{
                "id": "entity-4", "name": "red.png", "position": { "x": 5, "y": 6 }, "size": { "width": 2, "height": 2 },
                "originalSize": { "width": 2, "height": 2 }, "zIndex": 3, "rotation": 0, "locked": false, "edited": true,
                "shaderType": "halftone", "mediaType": "image", "mediaFile": "media/entity-4.png",
                "shaderParams": { "size": 12, "shape": "square", "postProcess": { "enabled": false }, "dithering": { "kind": "atkinson" } }
            }]
        });
        {
            let mut z = zip::ZipWriter::new(std::fs::File::create(&path).expect("create"));
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("manifest.json", o).expect("start");
            z.write_all(manifest.to_string().as_bytes()).expect("write");
            z.start_file("media/entity-4.png", o).expect("start");
            z.write_all(&png).expect("write");
            z.finish().expect("finish");
        }
        let ws = read(&path, &d, &Progress::default()).expect("read");
        let r = &ws.items[0];
        assert_eq!(r.id, Some(4));
        assert_eq!(r.params.shader, Shader::Halftone);
        assert_eq!((r.params.size, r.params.shape), (12.0, DotShape::Square));
        assert!(!r.params.grain && !r.params.bloom, "post-processing master switch off");
        assert_eq!(r.params.dither_kind, 6);
        assert_eq!(&r.asset.frames[0].rgba[..4], &[255, 0, 0, 255]);
    }

    /// `VOIDMESH_WORKSPACES=a.vdmsh:b.vdmsh cargo test real_workspaces -- --ignored --nocapture`
    #[test]
    #[ignore = "reads files named by VOIDMESH_WORKSPACES"]
    fn real_workspaces_read_and_round_trip() {
        let Some(list) = std::env::var_os("VOIDMESH_WORKSPACES") else { return };
        let d = dir("real");
        for path in std::env::split_paths(&list) {
            let ws = read(&path, &d, &Progress::default()).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let kinds: Vec<String> = ws.items.iter().map(|it| format!("{:?}/{:?}", it.asset.kind, it.params.shader)).collect();
            println!("{}: {} items, {} failed {:?}, palettes {}, {kinds:?}", path.display(), ws.items.len(), ws.failed.len(), ws.failed, ws.palettes.len());
            let out = d.join("again.vdmsh");
            write(&out, &ws.items, ws.viewport, &ws.palettes).expect("write");
            let again = read(&out, &d, &Progress::default()).expect("reread");
            assert_eq!(again.items.len(), ws.items.len());
            for (a, b) in ws.items.iter().zip(&again.items) {
                assert_eq!(a.params, b.params, "{}", a.name);
                assert_eq!((a.pos, a.size, a.z), (b.pos, b.size, b.z));
            }
        }
    }

    #[test]
    fn iso_dates_are_well_formed() {
        let s = iso_now();
        assert_eq!(s.len(), 24);
        assert!(s.ends_with('Z') && s.as_bytes()[10] == b'T');
    }
}
