//! Workspaces and their media, kept by the app and saved as they change.
//!
//! `Store` is the boundary a synced or remote store would implement: workspaces are documents
//! with UUIDs, media is content-addressed by SHA-256, and a save sends a whole document (a
//! `.vdmsh` v7 manifest) whose media the store already holds. `LocalStore` keeps everything
//! under the app's data folder:
//!
//!     workspaces/<id>/manifest.json   the document
//!     workspaces/<id>/meta.json       its name and times, for listing without reading manifests
//!     blobs/<sha256>.<ext>            media, shared by every workspace
//!
//! A workspace folder is an unzipped `.vdmsh` whose `media/<sha256>.<ext>` entries live in the
//! shared blob folder. Saves run in order on one thread (`Saver`), so a later save never loses
//! to an earlier one.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::effects::Palette;
use crate::media::{Asset, Original};
use crate::workspace::{self, Item, Progress, Viewport, Workspace};

/// A workspace as listed: what the library shows without opening it.
#[derive(Clone, Debug, PartialEq)]
pub struct Meta {
    pub id: String,
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub created: u64,
    pub updated: u64,
}

/// A whole workspace to save.
pub struct Doc {
    pub id: String,
    pub name: String,
    pub items: Vec<Item>,
    pub viewport: Viewport,
    pub palettes: Vec<Palette>,
}

/// A media blob held locally: its content hash and the file holding it.
pub struct BlobRef {
    pub hash: String,
    pub path: PathBuf,
}

pub trait Store: Send + Sync {
    /// Every workspace, most recently changed first.
    fn list(&self) -> Result<Vec<Meta>, String>;
    fn load(&self, id: &str, progress: &Progress) -> Result<Workspace, String>;
    /// Write a workspace, adding the media it references that the store lacks.
    fn save(&self, doc: &Doc) -> Result<(), String>;
    fn delete(&self, id: &str) -> Result<(), String>;
    /// Keep a copy of a media file.
    fn put_file(&self, path: &Path, ext: &str) -> Result<BlobRef, String>;
    fn put_bytes(&self, bytes: &[u8], ext: &str) -> Result<BlobRef, String>;
    /// A local file holding a blob the store has.
    fn blob_path(&self, hash: &str, ext: &str) -> Result<PathBuf, String>;
}

// ---------------------------------------------------------------------------------- identity

/// A new UUIDv7: time-ordered, so ids sort by creation.
pub fn new_id() -> String {
    use std::hash::BuildHasher;
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let ms = now_ms();
    // `RandomState` is seeded randomly per process and thread and advances per instance.
    let a = std::collections::hash_map::RandomState::new().hash_one((ms, SEQ.fetch_add(1, Ordering::Relaxed), std::process::id()));
    let b = std::collections::hash_map::RandomState::new().hash_one(a);
    let mut u = [0u8; 16];
    u[..6].copy_from_slice(&ms.to_be_bytes()[2..]);
    u[6..14].copy_from_slice(&a.to_be_bytes());
    u[14..].copy_from_slice(&b.to_be_bytes()[..2]);
    u[6] = (u[6] & 0x0f) | 0x70;
    u[8] = (u[8] & 0x3f) | 0x80;
    let h: String = u.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

fn hex(d: impl AsRef<[u8]>) -> String {
    d.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    hex(Sha256::digest(bytes))
}

pub fn hash_file(path: &Path) -> Result<String, String> {
    let mut f = std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(hex(h.finalize()))
}

/// An asset's content hash, computed once from its original bytes.
pub fn asset_hash(a: &Asset) -> Result<String, String> {
    if let Some(h) = a.blob.get() {
        return Ok(h.clone());
    }
    let h = match &a.original {
        Original::Bytes(b) => hash_bytes(b),
        Original::File(p) => hash_file(p)?,
    };
    let _ = a.blob.set(h.clone());
    Ok(h)
}

/// A blob's archive path, the same in a `.vdmsh` and a store's manifest.
pub fn media_path(hash: &str, ext: &str) -> String {
    format!("media/{hash}.{ext}")
}

/// `media/<hash>.<ext>` back to its parts.
pub fn parse_media_path(path: &str) -> Option<(&str, &str)> {
    let (hash, ext) = path.strip_prefix("media/")?.split_once('.')?;
    (hash.len() == 64 && hash.bytes().all(|c| c.is_ascii_hexdigit()) && !ext.is_empty() && !ext.contains('/')).then_some((hash, ext))
}

// -------------------------------------------------------------------------------- local store

pub struct LocalStore {
    root: PathBuf,
}

impl LocalStore {
    pub fn new(root: impl Into<PathBuf>) -> LocalStore {
        LocalStore { root: root.into() }
    }

    /// The app's own, under its data folder.
    pub fn open() -> Option<LocalStore> {
        rune::dirs::AppDirs::new(crate::media::APP_ID).map(|d| LocalStore::new(d.data().to_path_buf()))
    }

    fn dir(&self, id: &str) -> Result<PathBuf, String> {
        // Ids come from manifests and preferences: only UUID-shaped ones name folders.
        if id.is_empty() || !id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-') {
            return Err(format!("bad workspace id {id:?}"));
        }
        Ok(self.root.join("workspaces").join(id))
    }

    fn blob(&self, hash: &str, ext: &str) -> PathBuf {
        self.root.join("blobs").join(format!("{hash}.{ext}"))
    }

    fn read_meta(&self, id: &str) -> Result<Meta, String> {
        let v: Value = serde_json::from_slice(&std::fs::read(self.dir(id)?.join("meta.json")).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        Ok(Meta {
            id: id.to_string(),
            name: v["name"].as_str().unwrap_or("Untitled").to_string(),
            created: v["createdAt"].as_u64().unwrap_or(0),
            updated: v["updatedAt"].as_u64().unwrap_or(0),
        })
    }

    /// Move `path` into the blob folder as `hash.ext`, unless it's there already.
    fn adopt(&self, tmp: &Path, hash: &str, ext: &str) -> Result<PathBuf, String> {
        let dst = self.blob(hash, ext);
        if dst.exists() {
            let _ = std::fs::remove_file(tmp);
        } else {
            std::fs::rename(tmp, &dst).map_err(|e| e.to_string())?;
        }
        Ok(dst)
    }

    fn tmp(&self) -> Result<PathBuf, String> {
        let dir = self.root.join("blobs");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        Ok(dir.join(format!(".{}.part", new_id())))
    }
}

/// Write through a temporary file, so a crash leaves the old file or the new one.
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("part");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

impl Store for LocalStore {
    fn list(&self) -> Result<Vec<Meta>, String> {
        let dir = self.root.join("workspaces");
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.to_string()),
        };
        let mut v: Vec<Meta> = entries.filter_map(|e| e.ok()).filter_map(|e| self.read_meta(&e.file_name().to_string_lossy()).ok()).collect();
        // Most recent first; within a millisecond, the later id (UUIDv7s sort by creation).
        v.sort_by(|a, b| (b.updated, &b.id).cmp(&(a.updated, &a.id)));
        Ok(v)
    }

    fn load(&self, id: &str, progress: &Progress) -> Result<Workspace, String> {
        let dir = self.dir(id)?;
        let bytes = std::fs::read(dir.join("manifest.json")).map_err(|e| format!("workspace {id}: {e}"))?;
        let manifest: Value = serde_json::from_slice(&bytes).map_err(|e| format!("manifest: {e}"))?;
        let mut ws = workspace::read_manifest(&manifest, &mut workspace::StoreSource(self), progress)?;
        if let Ok(m) = self.read_meta(id) {
            ws.name = Some(m.name);
        }
        Ok(ws)
    }

    fn save(&self, doc: &Doc) -> Result<(), String> {
        let (manifest, media) = workspace::manifest(Some((&doc.id, &doc.name)), &doc.items, doc.viewport, &doc.palettes)?;
        for (path, asset) in &media {
            let Some((hash, ext)) = parse_media_path(path) else { continue };
            if self.blob(hash, ext).exists() {
                continue;
            }
            match &asset.original {
                Original::Bytes(b) => {
                    self.put_bytes(b, ext)?;
                }
                Original::File(p) => {
                    self.put_file(p, ext)?;
                }
            }
        }
        let dir = self.dir(&doc.id)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let created = self.read_meta(&doc.id).map_or_else(|_| now_ms(), |m| m.created);
        write_atomic(&dir.join("manifest.json"), serde_json::to_string(&manifest).map_err(|e| e.to_string())?.as_bytes())?;
        let meta = json!({ "id": doc.id, "name": doc.name, "createdAt": created, "updatedAt": now_ms() });
        write_atomic(&dir.join("meta.json"), meta.to_string().as_bytes())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        match std::fs::remove_dir_all(self.dir(id)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    fn put_file(&self, path: &Path, ext: &str) -> Result<BlobRef, String> {
        let hash = hash_file(path)?;
        let dst = self.blob(&hash, ext);
        if !dst.exists() {
            let tmp = self.tmp()?;
            std::fs::copy(path, &tmp).map_err(|e| format!("{}: {e}", path.display()))?;
            self.adopt(&tmp, &hash, ext)?;
        }
        Ok(BlobRef { hash, path: dst })
    }

    fn put_bytes(&self, bytes: &[u8], ext: &str) -> Result<BlobRef, String> {
        let hash = hash_bytes(bytes);
        let dst = self.blob(&hash, ext);
        if !dst.exists() {
            let tmp = self.tmp()?;
            std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
            self.adopt(&tmp, &hash, ext)?;
        }
        Ok(BlobRef { hash, path: dst })
    }

    fn blob_path(&self, hash: &str, ext: &str) -> Result<PathBuf, String> {
        let p = self.blob(hash, ext);
        if p.exists() { Ok(p) } else { Err(format!("missing media {hash}.{ext}")) }
    }
}

// ------------------------------------------------------------------------------------- saver

enum Job {
    Save(Doc),
    Delete(String),
}

/// Runs store writes in order on one thread and reports failures to the UI thread.
#[derive(Clone)]
pub struct Saver {
    tx: mpsc::Sender<Job>,
    pending: Arc<(Mutex<usize>, Condvar)>,
}

impl Saver {
    pub fn new(store: Arc<dyn Store>, loader: crate::media::Loader) -> Saver {
        let (tx, rx) = mpsc::channel::<Job>();
        let pending: Arc<(Mutex<usize>, Condvar)> = Arc::default();
        let p = pending.clone();
        std::thread::spawn(move || {
            for job in rx {
                let r = match &job {
                    Job::Save(doc) => store.save(doc).map_err(|e| format!("Couldn't save {}: {e}", doc.name)),
                    Job::Delete(id) => store.delete(id).map_err(|e| format!("Couldn't delete the workspace: {e}")),
                };
                if let Err(e) = r {
                    loader.notify(e);
                }
                let (lock, cv) = &*p;
                if let Ok(mut n) = lock.lock() {
                    *n = n.saturating_sub(1);
                    cv.notify_all();
                }
            }
        });
        Saver { tx, pending }
    }

    fn send(&self, job: Job) {
        if let Ok(mut n) = self.pending.0.lock() {
            *n += 1;
        }
        if self.tx.send(job).is_err()
            && let Ok(mut n) = self.pending.0.lock()
        {
            *n = n.saturating_sub(1);
        }
    }

    pub fn save(&self, doc: Doc) {
        self.send(Job::Save(doc));
    }

    pub fn delete(&self, id: String) {
        self.send(Job::Delete(id));
    }

    /// Block until every queued write has finished (quitting).
    pub fn flush(&self) {
        let (lock, cv) = &*self.pending;
        let Ok(mut n) = lock.lock() else { return };
        while *n > 0 {
            match cv.wait_timeout(n, std::time::Duration::from_secs(30)) {
                Ok((g, t)) if !t.timed_out() => n = g,
                _ => return,
            }
        }
    }
}

#[cfg(test)]
pub fn test_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("voidmesh-{name}-{}-{}", std::process::id(), new_id()));
    let _ = std::fs::create_dir_all(&d);
    d
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_uuid_v7_and_distinct() {
        let a = new_id();
        let b = new_id();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(a.as_bytes()[14], b'7');
        assert!(a < new_id() || a[..13] == new_id()[..13], "time-ordered");
    }

    #[test]
    fn media_paths_parse_back() {
        let h = hash_bytes(b"x");
        assert_eq!(parse_media_path(&media_path(&h, "png")), Some((h.as_str(), "png")));
        assert_eq!(parse_media_path("media/entity-1.png"), None);
        assert_eq!(parse_media_path(&format!("media/{h}.png/../x")), None);
    }

    #[test]
    fn saves_lists_loads_and_deletes_with_shared_blobs() {
        let store = LocalStore::new(test_dir("store"));
        let a = Arc::new(crate::media::test_asset(1, 4, 4));
        let item = |x: f32| Item { uid: new_id().into(), name: "a.png".into(), asset: a.clone(), pos: [x, 0.0], size: [4.0, 4.0], z: 1, params: Default::default(), fx_t: 0.0, playing: false, play_t: 0.0, muted: true };
        let (one, two) = (item(0.0), item(10.0));
        let doc = Doc { id: new_id(), name: "First".into(), items: vec![one.clone(), two.clone()], viewport: Viewport { offset: [1.0, 2.0], zoom: 2.0 }, palettes: vec![] };
        store.save(&doc).expect("save");
        let other = Doc { id: new_id(), name: "Second".into(), items: vec![item(5.0)], viewport: doc.viewport, palettes: vec![] };
        store.save(&other).expect("save");
        let blobs = std::fs::read_dir(store.root.join("blobs")).expect("blobs").count();
        assert_eq!(blobs, 1, "one copy of shared media");
        let list = store.list().expect("list");
        assert_eq!(list.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["Second", "First"]);
        let ws = store.load(&doc.id, &Progress::default()).expect("load");
        assert!(ws.failed.is_empty(), "{:?}", ws.failed);
        assert_eq!(ws.name.as_deref(), Some("First"));
        assert_eq!(ws.items.iter().map(|i| i.uid.clone()).collect::<Vec<_>>(), [one.uid, two.uid]);
        assert_eq!(ws.viewport, doc.viewport);
        assert!(Arc::ptr_eq(&ws.items[0].asset, &ws.items[1].asset));
        store.delete(&doc.id).expect("delete");
        assert_eq!(store.list().expect("list").len(), 1);
        assert!(store.load(&doc.id, &Progress::default()).is_err());
    }

    #[test]
    fn bad_ids_name_no_folders() {
        let store = LocalStore::new(test_dir("ids"));
        assert!(store.delete("../../etc").is_err());
        assert!(store.load("a/b", &Progress::default()).is_err());
    }
}

#[cfg(test)]
mod bench {
    /// Times reading a stored workspace:
    /// `VOIDMESH_BENCH_STORE=<data folder> VOIDMESH_BENCH_ID=<id> cargo test --release bench_load -- --ignored --nocapture`
    #[test]
    #[ignore = "times a real stored workspace"]
    fn bench_load() {
        use super::Store;
        let (Some(root), Some(id)) = (std::env::var_os("VOIDMESH_BENCH_STORE"), std::env::var("VOIDMESH_BENCH_ID").ok()) else { return };
        let store = super::LocalStore::new(root);
        for _ in 0..2 {
            let t = std::time::Instant::now();
            let ws = store.load(&id, &crate::workspace::Progress::default()).expect("load");
            println!("load: {} items, {} failed in {:?}", ws.items.len(), ws.failed.len(), t.elapsed());
        }
    }
}

