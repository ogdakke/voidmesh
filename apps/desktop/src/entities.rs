//! The canvas's entity list and selection, built for canvases of hundreds of thousands.
//!
//! `Entities` keeps entities in copy-on-write chunks: cloning it (an undo snapshot, a parked tab)
//! copies a few hundred pointers, and a change copies only the chunks it touches. Chunk identity
//! doubles as change tracking: a holder of a chunk's `Arc` (the compositor) sees it replaced by
//! any change to the entities in it, without a dirty flag every mutation would have to set.
//!
//! `Selection` is a set of entity ids whose revision moves with every mutable access, so views
//! and the compositor can tell a changed selection from an unchanged one without comparing sets.

use std::cell::OnceCell;
use std::collections::{BTreeSet, HashMap};
use std::ops::{Deref, DerefMut};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use crate::state::Entity;

/// Entities per chunk: small enough that a one-entity change copies little, large enough that a
/// snapshot of a quarter-million entities is about a thousand pointers.
pub const CHUNK: usize = 256;

/// A process-wide revision: every new state gets one never used before, so equal revisions mean
/// equal contents (they are only shared by clones).
fn next_rev() -> u64 {
    static REV: AtomicU64 = AtomicU64::new(1);
    REV.fetch_add(1, Ordering::Relaxed)
}

pub type Chunk = Arc<Vec<Entity>>;

#[derive(Clone)]
pub struct Entities {
    chunks: Vec<Chunk>,
    len: usize,
    /// Moves with any change to the entities.
    rev: u64,
    /// Moves when entities are added, removed or reordered (not when one changes in place).
    layout: u64,
    /// Entity id to index, built on demand for the current layout.
    index: OnceCell<Arc<HashMap<u32, u32>>>,
}

impl Default for Entities {
    fn default() -> Self {
        Entities { chunks: Vec::new(), len: 0, rev: next_rev(), layout: next_rev(), index: OnceCell::new() }
    }
}

impl From<Vec<Entity>> for Entities {
    fn from(v: Vec<Entity>) -> Self {
        let mut e = Entities::default();
        e.extend(v);
        e
    }
}

impl Entities {
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Changes with any change to the entities.
    pub fn rev(&self) -> u64 {
        self.rev
    }

    /// Changes when entities are added, removed or reordered.
    pub fn layout(&self) -> u64 {
        self.layout
    }

    pub fn chunks(&self) -> &[Chunk] {
        &self.chunks
    }

    pub fn iter(&self) -> impl DoubleEndedIterator<Item = &Entity> + Clone {
        self.chunks.iter().flat_map(|c| c.iter())
    }

    pub fn get(&self, i: usize) -> Option<&Entity> {
        self.chunks.get(i / CHUNK).and_then(|c| c.get(i % CHUNK))
    }

    pub fn first(&self) -> Option<&Entity> {
        self.get(0)
    }

    fn index(&self) -> &HashMap<u32, u32> {
        self.index.get_or_init(|| Arc::new(self.iter().enumerate().map(|(i, e)| (e.id, i as u32)).collect()))
    }

    /// The position of entity `id`.
    pub fn position(&self, id: u32) -> Option<usize> {
        self.index().get(&id).map(|i| *i as usize)
    }

    pub fn by_id(&self, id: u32) -> Option<&Entity> {
        self.position(id).and_then(|i| self.get(i))
    }

    pub fn by_id_mut(&mut self, id: u32) -> Option<&mut Entity> {
        let i = self.position(id)?;
        self.get_mut(i)
    }

    pub fn get_mut(&mut self, i: usize) -> Option<&mut Entity> {
        if i >= self.len {
            return None;
        }
        self.rev = next_rev();
        Arc::make_mut(&mut self.chunks[i / CHUNK]).get_mut(i % CHUNK)
    }

    /// Calls `f` on each entity `pick` accepts, copying only the chunks that hold one. Returns
    /// how many it changed.
    pub fn update(&mut self, mut pick: impl FnMut(&Entity) -> bool, mut f: impl FnMut(&mut Entity)) -> usize {
        let mut n = 0;
        for c in &mut self.chunks {
            if !c.iter().any(&mut pick) {
                continue;
            }
            for e in Arc::make_mut(c).iter_mut() {
                if pick(e) {
                    f(e);
                    n += 1;
                }
            }
        }
        if n > 0 {
            self.rev = next_rev();
        }
        n
    }

    fn relaid(&mut self) {
        self.rev = next_rev();
        self.layout = next_rev();
        self.index = OnceCell::new();
    }

    pub fn push(&mut self, e: Entity) {
        match self.chunks.last_mut() {
            Some(c) if c.len() < CHUNK => Arc::make_mut(c).push(e),
            _ => {
                let mut v = Vec::with_capacity(CHUNK);
                v.push(e);
                self.chunks.push(Arc::new(v));
            }
        }
        self.len += 1;
        self.relaid();
    }

    pub fn extend(&mut self, it: impl IntoIterator<Item = Entity>) {
        let mut any = false;
        for e in it {
            match self.chunks.last_mut() {
                Some(c) if c.len() < CHUNK => Arc::make_mut(c).push(e),
                _ => {
                    let mut v = Vec::with_capacity(CHUNK);
                    v.push(e);
                    self.chunks.push(Arc::new(v));
                }
            }
            self.len += 1;
            any = true;
        }
        if any {
            self.relaid();
        }
    }

    /// Keep the entities `keep` accepts. Chunks it keeps whole stay shared; the rest repack.
    pub fn retain(&mut self, mut keep: impl FnMut(&Entity) -> bool) {
        let before = self.len;
        let mut kept: Vec<Entity> = Vec::new();
        let mut out: Vec<Chunk> = Vec::with_capacity(self.chunks.len());
        let flush = |kept: &mut Vec<Entity>, out: &mut Vec<Chunk>| {
            for part in kept.chunks(CHUNK) {
                out.push(Arc::new(part.to_vec()));
            }
            kept.clear();
        };
        for c in std::mem::take(&mut self.chunks) {
            let keep_all = kept.is_empty() && c.len() == CHUNK && c.iter().all(&mut keep);
            if keep_all {
                out.push(c);
            } else {
                kept.extend(c.iter().filter(|e| keep(e)).cloned());
                if kept.len() >= CHUNK {
                    let rest = kept.split_off(CHUNK);
                    out.push(Arc::new(std::mem::replace(&mut kept, rest)));
                }
            }
        }
        flush(&mut kept, &mut out);
        self.chunks = out;
        self.len = self.chunks.iter().map(|c| c.len()).sum();
        if self.len != before {
            self.relaid();
        }
    }

    pub fn into_vec(self) -> Vec<Entity> {
        self.chunks.into_iter().flat_map(Arc::unwrap_or_clone).collect()
    }
}

impl std::ops::Index<usize> for Entities {
    type Output = Entity;
    fn index(&self, i: usize) -> &Entity {
        &self.chunks[i / CHUNK][i % CHUNK]
    }
}

/// The selected entity ids, with a revision that moves on any change.
#[derive(Clone, Debug)]
pub struct Selection {
    set: BTreeSet<u32>,
    rev: u64,
}

impl Default for Selection {
    fn default() -> Self {
        Selection { set: BTreeSet::new(), rev: next_rev() }
    }
}

impl Selection {
    pub fn rev(&self) -> u64 {
        self.rev
    }
}

impl From<BTreeSet<u32>> for Selection {
    fn from(set: BTreeSet<u32>) -> Self {
        Selection { set, rev: next_rev() }
    }
}

impl FromIterator<u32> for Selection {
    fn from_iter<I: IntoIterator<Item = u32>>(it: I) -> Self {
        BTreeSet::from_iter(it).into()
    }
}

impl Deref for Selection {
    type Target = BTreeSet<u32>;
    fn deref(&self) -> &BTreeSet<u32> {
        &self.set
    }
}

impl DerefMut for Selection {
    fn deref_mut(&mut self) -> &mut BTreeSet<u32> {
        self.rev = next_rev();
        &mut self.set
    }
}

impl PartialEq for Selection {
    fn eq(&self, other: &Self) -> bool {
        self.set == other.set
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ents(n: u32) -> Entities {
        let a = Arc::new(crate::media::test_asset(1, 4, 4));
        (0..n).map(|i| crate::state::Entity::new(i + 1, a.clone(), [i as f32, 0.0], i + 1, Arc::default())).collect::<Vec<_>>().into()
    }

    #[test]
    fn clones_share_chunks_and_a_change_copies_one() {
        let mut a = ents(1000);
        let b = a.clone();
        assert!(a.chunks().iter().zip(b.chunks()).all(|(x, y)| Arc::ptr_eq(x, y)));
        a.by_id_mut(300).expect("300").pos = [9.0, 9.0];
        let changed = a.chunks().iter().zip(b.chunks()).filter(|(x, y)| !Arc::ptr_eq(x, y)).count();
        assert_eq!(changed, 1);
        assert_eq!(b.by_id(300).map(|e| e.pos), Some([299.0, 0.0]), "the snapshot keeps its own");
    }

    #[test]
    fn retain_repacks_and_keeps_ids_findable() {
        let mut a = ents(1000);
        let layout = a.layout();
        a.retain(|e| e.id % 3 != 0);
        assert_eq!(a.len(), 667);
        assert_ne!(a.layout(), layout);
        assert!(a.chunks().iter().rev().skip(1).all(|c| c.len() == CHUNK));
        assert_eq!(a.by_id(4).map(|e| e.id), Some(4));
        assert!(a.by_id(3).is_none());
        assert_eq!(a.iter().map(|e| e.id).collect::<Vec<_>>(), (1..=1000).filter(|i| i % 3 != 0).collect::<Vec<_>>());
    }

    #[test]
    fn update_copies_only_chunks_it_changes() {
        let mut a = ents(1000);
        let b = a.clone();
        assert_eq!(a.update(|e| e.id == 900, |e| e.z = 0), 1);
        assert_eq!(a.chunks().iter().zip(b.chunks()).filter(|(x, y)| !Arc::ptr_eq(x, y)).count(), 1);
        let rev = a.rev();
        assert_eq!(a.update(|_| false, |_| {}), 0);
        assert_eq!(a.rev(), rev, "no change, no new revision");
    }

    #[test]
    fn selection_revision_moves_with_changes_only() {
        let mut s = Selection::default();
        let r = s.rev();
        assert!(!s.contains(&1));
        assert_eq!(s.rev(), r);
        s.insert(1);
        assert_ne!(s.rev(), r);
    }
}
