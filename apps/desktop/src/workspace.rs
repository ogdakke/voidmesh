//! `.vdmsh` workspaces, the web app's format (`lib/serialization`): a zip with `manifest.json`
//! and the original media. Reads every manifest version the web app migrates (v1–v7: inline or
//! table-referenced params, media paths and original palettes) and writes v7, so a file
//! round-trips between the two apps.
//!
//! v7 names media by content (`media/<sha256>.<ext>`, the original bytes), gives entities UUIDs
//! and carries the workspace's own id and name. The app's store keeps the same manifest, unzipped,
//! with the media in a shared blob folder (`store.rs`).
//!
//! World units match: a world unit is a media pixel in both. The web viewport's `zoom` counts
//! device pixels per world unit and `offset` is the world point at the canvas's top-left.

use std::collections::{HashMap, HashSet};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use serde_json::{Map, Value, json};

use crate::effects::{DotShape, Palette, Params, Rgba, Shader};
use crate::media::{self, Asset, Kind, Original};
use crate::store::{self, Store};

pub const EXTENSIONS: &[&str] = &["vdmsh", "studio", "zip"];
const VERSION: u64 = 7;

pub fn is_workspace(path: &Path) -> bool {
    path.extension().is_some_and(|e| EXTENSIONS.iter().any(|x| e.eq_ignore_ascii_case(x)))
}

/// One entity as a workspace holds it.
#[derive(Clone)]
pub struct Item {
    /// Its id in the manifest: a UUID, or the web's `entity-N` in older files.
    pub uid: Arc<str>,
    pub name: Arc<str>,
    pub asset: Arc<Asset>,
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub z: u32,
    /// Shared by the items that reference one entry of the manifest's params table.
    pub params: Arc<Params>,
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
    /// The workspace's own name, when the file has one (v7).
    pub name: Option<String>,
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

/// A media file a manifest names, held in the store.
pub struct Fetched {
    pub hash: String,
    pub ext: String,
    pub file: PathBuf,
    /// The bytes, when reading them was how it was fetched.
    pub bytes: Option<Arc<[u8]>>,
}

/// Where a manifest's media comes from.
pub trait Source {
    fn fetch(&mut self, path: &str, video: bool) -> Result<Fetched, String>;
}

/// Media already in a store, named by content.
pub struct StoreSource<'a>(pub &'a dyn Store);

impl Source for StoreSource<'_> {
    fn fetch(&mut self, path: &str, _: bool) -> Result<Fetched, String> {
        let (hash, ext) = store::parse_media_path(path).ok_or_else(|| format!("bad media path {path}"))?;
        Ok(Fetched { hash: hash.into(), ext: ext.into(), file: self.0.blob_path(hash, ext)?, bytes: None })
    }
}

/// Media in a `.vdmsh` zip, copied into the store as it's read.
struct ZipSource<'a, R> {
    zip: zip::ZipArchive<R>,
    store: &'a dyn Store,
}

impl<R: Read + std::io::Seek> Source for ZipSource<'_, R> {
    fn fetch(&mut self, path: &str, video: bool) -> Result<Fetched, String> {
        let mut f = self.zip.by_name(path).map_err(|_| format!("missing {path}"))?;
        let mut bytes = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut bytes).map_err(|err| err.to_string())?;
        let mut ext = path.rsplit_once('.').map(|(_, x)| x.to_ascii_lowercase()).unwrap_or_default();
        if video && !media::is_video(&ext) {
            ext = "mp4".into();
        }
        let blob = self.store.put_bytes(&bytes, &ext)?;
        Ok(Fetched { hash: blob.hash, ext, file: blob.path, bytes: Some(bytes.into()) })
    }
}

/// Read a `.vdmsh` file, copying its media into `store`. Nothing is half-applied: the caller
/// adopts the whole result or none of it.
pub fn read_zip(path: &Path, store: &dyn Store, progress: &Progress) -> Result<Workspace, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(std::io::BufReader::new(file)).map_err(|e| format!("not a workspace ({e})"))?;
    let t = std::time::Instant::now();
    let trace = std::env::var_os("VOIDMESH_TRACE_LOAD").is_some();
    let manifest: Value = {
        let mut f = zip.by_name("manifest.json").map_err(|_| "no manifest.json")?;
        let mut s = String::new();
        f.read_to_string(&mut s).map_err(|e| e.to_string())?;
        if trace {
            eprintln!("load: inflate {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
        }
        serde_json::from_str(&s).map_err(|e| format!("manifest: {e}"))?
    };
    if trace {
        eprintln!("load: parsed {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
    }
    let r = read_manifest(&manifest, &mut ZipSource { zip, store }, progress);
    if trace {
        eprintln!("load: read {:.0} ms", t.elapsed().as_secs_f64() * 1e3);
    }
    r
}

pub fn read_manifest(manifest: &Value, source: &mut dyn Source, progress: &Progress) -> Result<Workspace, String> {
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
    let empty = Vec::new();
    let table = |k: &str| manifest[k].as_array().unwrap_or(&empty);
    let (params_table, media_table, originals_table) = (table("shaderParamsTable"), table("mediaFiles"), table("originalPalettes"));
    let palettes: Vec<Palette> = table("palettes").iter().filter_map(palette_from).collect();
    let (params_table, media_table, originals_table) = (params_table.as_slice(), media_table.as_slice(), originals_table.as_slice());
    let entities = manifest["entities"].as_array().ok_or("manifest has no entities")?;
    let assets = load_all_media(entities, media_table, source, progress)?;
    let mut uids: HashSet<Arc<str>> = HashSet::with_capacity(entities.len());
    let mut items = Vec::with_capacity(entities.len());
    let mut failed = Vec::new();
    // Entities naming the same table entry, effect and clock setting share one `Params`.
    let mut shared: HashMap<(u64, &str, Option<bool>), Arc<Params>> = HashMap::new();
    let mut names: HashMap<&str, Arc<str>> = HashMap::new();
    for (i, e) in entities.iter().enumerate() {
        let name_str = e["name"].as_str().unwrap_or("media");
        let name = names.entry(name_str).or_insert_with(|| name_str.into()).clone();
        let item = (|| -> Result<Item, String> {
            let media_path = media_of(e, media_table).ok_or("no media file")?;
            let asset = assets.get(&media_path).ok_or("no media file")?.clone()?;
            let shader = e["shaderType"].as_str().unwrap_or("dithering");
            let autoplay = e["shaderTimeAutoPlay"].as_bool();
            let make = |v: &Value| {
                let mut p = params_from(shader, v);
                if let Some(t) = autoplay {
                    p.time_autoplay = t;
                }
                Arc::new(p)
            };
            let (params, table_time) = match e.get("shaderParams") {
                Some(v) if !v.is_null() => (make(v), v["time"].as_f64()),
                _ => {
                    let r = e["shaderParamsRef"].as_u64().ok_or("no effect parameters")?;
                    let v = params_table.get(r as usize).ok_or("no effect parameters")?;
                    (shared.entry((r, shader, autoplay)).or_insert_with(|| make(v)).clone(), v["time"].as_f64())
                }
            };
            let fx_t = e["shaderTime"].as_f64().or(table_time).unwrap_or(0.0);
            let pb = &e["playback"];
            let animated = asset.animated();
            let size = [e["size"]["width"].as_f64().unwrap_or(f64::from(asset.width)) as f32, e["size"]["height"].as_f64().unwrap_or(f64::from(asset.height)) as f32];
            Ok(Item {
                uid: e["id"].as_str().filter(|id| !id.is_empty()).map(Arc::from).unwrap_or_else(|| Arc::from("")),
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
            Ok(mut it) => {
                // Ids are unique within a workspace; a missing or repeated one gets a new UUID.
                if it.uid.is_empty() || !uids.insert(it.uid.clone()) {
                    it.uid = store::new_id().into();
                    uids.insert(it.uid.clone());
                }
                items.push(it)
            }
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
    let name = manifest["workspace"]["name"].as_str().map(String::from);
    Ok(Workspace { name, items, viewport, palettes, failed })
}

/// A decode's result, filled by whichever worker takes it.
type Slot<T> = std::sync::Mutex<Option<Result<T, String>>>;

/// An entity's media path, inline or from the table.
fn media_of(e: &Value, table: &[Value]) -> Option<String> {
    match e.get("mediaFile") {
        Some(v) if !v.is_null() => v.as_str().map(String::from),
        _ => e["mediaFileRef"].as_u64().and_then(|i| table.get(i as usize)).and_then(|v| v.as_str().map(String::from)),
    }
}

/// Every distinct media file the entities name, decoded. Files are fetched in order (a zip reads
/// one entry at a time) and decoded in parallel: decoding is most of reading a large workspace.
/// Progress counts media files.
fn load_all_media(entities: &[Value], table: &[Value], source: &mut dyn Source, progress: &Progress) -> Result<HashMap<String, Result<Arc<Asset>, String>>, String> {
    type Job<'a> = (String, &'a Value, Slot<Fetched>);
    let mut seen = HashSet::new();
    let mut jobs: Vec<Job> = Vec::new();
    for e in entities {
        let Some(path) = media_of(e, table) else { continue };
        if seen.insert(path.clone()) {
            jobs.push((path, e, std::sync::Mutex::new(None)));
        }
    }
    progress.total.store(jobs.len(), Ordering::Relaxed);
    for (path, e, slot) in &jobs {
        if progress.cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let f = source.fetch(path, e["mediaType"] == "video");
        if let Ok(mut s) = slot.lock() {
            *s = Some(f);
        }
    }
    let next = AtomicUsize::new(0);
    let decoded: Vec<Slot<Arc<Asset>>> = jobs.iter().map(|_| std::sync::Mutex::new(None)).collect();
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get()).min(8).min(jobs.len().max(1));
    std::thread::scope(|sc| {
        for _ in 0..workers {
            sc.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                if i >= jobs.len() || progress.cancel.load(Ordering::Relaxed) {
                    return;
                }
                let (_, e, slot) = &jobs[i];
                let fetched = slot.lock().ok().and_then(|mut s| s.take()).unwrap_or_else(|| Err("not read".into()));
                let name = e["name"].as_str().unwrap_or("media");
                let r = fetched.and_then(|f| load_media(f, e, name)).map(Arc::new);
                if let Ok(mut d) = decoded[i].lock() {
                    *d = Some(r);
                }
                progress.done.fetch_add(1, Ordering::Relaxed);
            });
        }
    });
    if progress.cancel.load(Ordering::Relaxed) {
        return Err("cancelled".into());
    }
    Ok(jobs.into_iter().zip(decoded).map(|((path, ..), d)| (path, d.into_inner().ok().flatten().unwrap_or_else(|| Err("not decoded".into())))).collect())
}

fn load_media(f: Fetched, e: &Value, name: &str) -> Result<Asset, String> {
    let id = media::next_asset_id();
    let asset = if e["mediaType"] == "video" {
        media::decode_video(id, name.to_string(), f.ext, f.file)?
    } else {
        let bytes = match f.bytes {
            Some(b) => b,
            None => std::fs::read(&f.file).map_err(|err| err.to_string())?.into(),
        };
        media::decode_bytes(id, name.to_string(), &f.ext, bytes)?
    };
    let _ = asset.blob.set(f.hash);
    Ok(asset)
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
    p.post = b(&pp["enabled"], true);
    let (gr, bl, ca) = (&pp["grain"], &pp["bloom"], &pp["chromaticAberration"]);
    // A null effect is off; an absent one keeps the default.
    let on = |k: &str, d: bool| match pp.get(k) {
        Some(Value::Null) => false,
        Some(x) => b(&x["enabled"], d),
        None => d,
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
            "enabled": p.post,
            "grain": { "enabled": p.grain, "size": p.grain_size, "intensity": p.grain_intensity },
            "bloom": { "enabled": p.bloom, "threshold": p.bloom_threshold, "intensity": p.bloom_intensity, "filterRadius": p.bloom_radius, "softness": p.bloom_softness },
            "chromaticAberration": { "enabled": p.chroma, "offset": p.chroma_offset },
        },
        "adjustments": { "brightness": p.brightness, "contrast": p.contrast, "saturation": p.saturation, "blur": p.blur },
    })
}

// --------------------------------------------------------------------------------------- write

/// The extension an asset's original is kept under.
pub fn blob_ext(a: &Asset) -> &str {
    match a.kind {
        Kind::Video if !media::is_video(&a.ext) => "mp4",
        _ => &a.ext,
    }
}

/// Each media file a manifest names, with the asset holding it.
pub type MediaFiles = Vec<(String, Arc<Asset>)>;

/// The v7 manifest for `items`, and the media it names.
pub fn manifest(workspace: Option<(&str, &str)>, items: &[Item], viewport: Viewport, palettes: &[Palette]) -> Result<(Value, MediaFiles), String> {
    let mut items: Vec<&Item> = items.iter().collect();
    items.sort_by_key(|it| it.z);
    let mut params_table: Vec<Value> = Vec::new();
    let mut media_files: Vec<String> = Vec::new();
    let mut originals: Vec<Value> = Vec::new();
    let mut entities = Vec::new();
    let mut media: MediaFiles = Vec::new();
    let intern = |table: &mut Vec<Value>, v: Value| table.iter().position(|x| *x == v).unwrap_or_else(|| {
        table.push(v);
        table.len() - 1
    });
    // Per distinct `Params` and asset, not per entity: a workspace of a quarter-million
    // entities has a handful of each.
    let mut params_refs: HashMap<*const Params, (usize, bool)> = HashMap::new();
    let mut asset_refs: HashMap<u64, (usize, Option<usize>)> = HashMap::new();
    let defaults = Params::default();
    let mut in_use: HashSet<&str> = HashSet::new();
    for it in &items {
        let a = &it.asset;
        let (media_ref, original_ref) = match asset_refs.get(&a.id) {
            Some(r) => *r,
            None => {
                let mpath = store::media_path(&store::asset_hash(a)?, blob_ext(a));
                let media_ref = media_files.iter().position(|m| *m == mpath).unwrap_or_else(|| {
                    media_files.push(mpath.clone());
                    media.push((mpath.clone(), a.clone()));
                    media_files.len() - 1
                });
                let original = a.original_palette().map(|p| intern(&mut originals, palette_json(&p)));
                asset_refs.insert(a.id, (media_ref, original));
                (media_ref, original)
            }
        };
        let (params_ref, edited) = *params_refs.entry(Arc::as_ptr(&it.params)).or_insert_with(|| {
            in_use.insert(it.params.palette.id.as_str());
            (intern(&mut params_table, params_json(&it.params)), *it.params != defaults)
        });
        let mut e = Map::new();
        e.insert("id".into(), json!(&*it.uid));
        e.insert("name".into(), json!(&*it.name));
        e.insert("position".into(), json!({ "x": it.pos[0], "y": it.pos[1] }));
        e.insert("size".into(), json!({ "width": it.size[0], "height": it.size[1] }));
        e.insert("originalSize".into(), json!({ "width": a.width, "height": a.height }));
        e.insert("zIndex".into(), json!(it.z));
        e.insert("rotation".into(), json!(0));
        e.insert("locked".into(), json!(false));
        e.insert("edited".into(), json!(edited));
        e.insert("shaderType".into(), json!(shader_id(it.params.shader)));
        e.insert("shaderParamsRef".into(), json!(params_ref));
        e.insert("shaderTime".into(), json!(it.fx_t));
        e.insert("shaderTimeAutoPlay".into(), json!(it.params.time_autoplay));
        if let Some(r) = original_ref {
            e.insert("originalPaletteRef".into(), json!(r));
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
    let used: Vec<Value> = palettes.iter().filter(|p| in_use.contains(p.id.as_str())).map(palette_json).collect();
    let mut manifest = json!({
        "type": "studio-canvas",
        "version": VERSION,
        "createdAt": iso_now(),
        "viewport": { "offset": { "x": viewport.offset[0], "y": viewport.offset[1] }, "zoom": viewport.zoom },
        "entities": entities,
        "shaderParamsTable": params_table,
        "mediaFiles": media_files,
    });
    if let Some((id, name)) = workspace {
        manifest["workspace"] = json!({ "id": id, "name": name });
    }
    if !originals.is_empty() {
        manifest["originalPalettes"] = json!(originals);
    }
    if !used.is_empty() {
        manifest["palettes"] = json!(used);
    }
    Ok((manifest, media))
}

fn media_bytes(a: &Asset) -> Result<Vec<u8>, String> {
    match &a.original {
        Original::Bytes(b) => Ok(b.to_vec()),
        Original::File(p) => std::fs::read(p).map_err(|e| format!("{}: {e}", p.display())),
    }
}

/// Export a workspace as a `.vdmsh` file (through a temporary file, so a failed write leaves
/// the old one).
pub fn write_zip(path: &Path, doc: &store::Doc) -> Result<(), String> {
    let (manifest, media) = manifest(Some((&doc.id, &doc.name)), &doc.items, doc.viewport, &doc.palettes)?;
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

/// A fun default name, as the web app's `adjective-noun-verb`.
pub fn random_name() -> String {
    const A: [&str; 12] = ["quiet", "velvet", "hollow", "lucid", "feral", "amber", "static", "drowsy", "sunken", "molten", "silver", "tender"];
    const N: [&str; 12] = ["moth", "signal", "harbor", "orchid", "comet", "lantern", "glacier", "ember", "meadow", "relic", "cipher", "tide"];
    const V: [&str; 12] = ["drifts", "hums", "unfolds", "flickers", "wanders", "dissolves", "blooms", "echoes", "melts", "sleeps", "glows", "turns"];
    let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos()) as usize;
    format!("{}-{}-{}", A[t % 12], N[(t / 12) % 12], V[(t / 144) % 12])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Doc, LocalStore, test_dir};

    #[test]
    fn the_post_processing_master_switch_round_trips() {
        let p = Params { post: false, ..Params::default() };
        let back = params_from("dithering", &params_json(&p));
        assert!(!back.post && back.grain && back.bloom);
    }

    fn item(asset: Arc<Asset>, id: u32, x: f32) -> Item {
        Item { uid: store::new_id().into(), name: format!("e{id}.png").into(), size: [asset.width as f32, asset.height as f32], asset, pos: [x, 10.0], z: id, params: Arc::default(), fx_t: 0.0, playing: false, play_t: 0.0, muted: true }
    }

    fn png(w: u32, h: u32, px: image::Rgba<u8>) -> Vec<u8> {
        let mut out = Vec::new();
        image::RgbaImage::from_pixel(w, h, px).write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png).expect("png");
        out
    }

    #[test]
    fn round_trips_entities_params_and_shared_assets() {
        let bytes = png(4, 4, image::Rgba([10, 20, 30, 255]));
        let mut a = media::decode_bytes(7, "a.png".into(), "png", bytes.clone().into()).expect("png");
        a.palette = Some(vec![[0.0, 0.0, 0.0, 1.0], [1.0, 1.0, 1.0, 1.0]]);
        let a = Arc::new(a);
        let mut one = item(a.clone(), 1, 0.0);
        let p = Arc::make_mut(&mut one.params);
        p.set_shader(Shader::Glass);
        p.set_glass_kind(2);
        p.palette = crate::effects::presets()[8].clone();
        one.fx_t = 3.5;
        let two = item(a, 2, 200.0);
        let d = test_dir("rt");
        let store = LocalStore::new(d.join("store"));
        let path = d.join("t.vdmsh");
        let vp = Viewport { offset: [-100.0, -50.0], zoom: 2.0 };
        let doc = Doc { id: store::new_id(), name: "Round trip".into(), items: vec![one.clone(), two.clone()], viewport: vp, palettes: vec![] };
        write_zip(&path, &doc).expect("write");
        let ws = read_zip(&path, &store, &Progress::default()).expect("read");
        assert!(ws.failed.is_empty(), "{:?}", ws.failed);
        assert_eq!(ws.name.as_deref(), Some("Round trip"));
        assert_eq!(ws.viewport, vp);
        assert_eq!(ws.items.len(), 2);
        assert!(Arc::ptr_eq(&ws.items[0].asset, &ws.items[1].asset), "one file for a shared asset");
        assert_eq!(ws.items[0].asset.original_bytes(), Some(&bytes[..]), "the original bytes, not a re-encode");
        assert_eq!(ws.items[0].asset.blob.get(), Some(&store::hash_bytes(&bytes)));
        let r = &ws.items[0];
        assert_eq!((&*r.uid, r.pos, r.fx_t), (&*one.uid, [0.0, 10.0], 3.5));
        assert_eq!(r.params, one.params);
        assert_eq!(ws.items[1].pos, [200.0, 10.0]);
    }

    #[test]
    fn reads_a_v1_manifest_with_inline_params() {
        let d = test_dir("v1");
        let store = LocalStore::new(d.join("store"));
        let path = d.join("old.vdmsh");
        let png = png(2, 2, image::Rgba([255, 0, 0, 255]));
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
        let ws = read_zip(&path, &store, &Progress::default()).expect("read");
        let r = &ws.items[0];
        assert_eq!(&*r.uid, "entity-4");
        assert_eq!(r.params.shader, Shader::Halftone);
        assert_eq!((r.params.size, r.params.shape), (12.0, DotShape::Square));
        assert!(!r.params.post && r.params.grain && r.params.bloom, "the master switch off, the effects' own kept");
        assert_eq!(r.params.dither_kind, 6);
        assert_eq!(&r.asset.frames[0].rgba[..4], &[255, 0, 0, 255]);
        assert!(store.blob_path(&store::hash_bytes(&png), "png").is_ok(), "the media was copied into the store");
    }

    /// `VOIDMESH_WORKSPACES=a.vdmsh:b.vdmsh cargo test real_workspaces -- --ignored --nocapture`
    #[test]
    #[ignore = "reads files named by VOIDMESH_WORKSPACES"]
    fn real_workspaces_read_and_round_trip() {
        let Some(list) = std::env::var_os("VOIDMESH_WORKSPACES") else { return };
        let d = test_dir("real");
        let store = LocalStore::new(d.join("store"));
        for path in std::env::split_paths(&list) {
            let ws = read_zip(&path, &store, &Progress::default()).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let kinds: Vec<String> = ws.items.iter().map(|it| format!("{:?}/{:?}", it.asset.kind, it.params.shader)).collect();
            println!("{}: {} items, {} failed {:?}, palettes {}, {kinds:?}", path.display(), ws.items.len(), ws.failed.len(), ws.failed, ws.palettes.len());
            let out = d.join("again.vdmsh");
            let doc = Doc { id: store::new_id(), name: "again".into(), items: ws.items.clone(), viewport: ws.viewport, palettes: ws.palettes.clone() };
            write_zip(&out, &doc).expect("write");
            let again = read_zip(&out, &store, &Progress::default()).expect("reread");
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
