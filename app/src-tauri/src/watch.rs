//! Auto import from a watched folder: every few seconds the folder is looked at, and a photo that has appeared and has stopped growing (a
//! camera or a card reader may still be writing it) is handed to the importer once.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// Which files have been seen, how they looked last time, and which have been handed on.
#[derive(Default)]
pub struct Tracker {
    last: HashMap<PathBuf, (u64, Option<SystemTime>)>,
    done: HashSet<PathBuf>,
}

impl Tracker {
    /// Look at the folder's files now. Returns those that are new and have not changed since the previous look.
    pub fn ready(&mut self, files: &[PathBuf]) -> Vec<PathBuf> {
        let mut out = vec![];
        let present: HashSet<&PathBuf> = files.iter().collect();
        self.last.retain(|p, _| present.contains(p));
        for f in files {
            if self.done.contains(f) {
                continue;
            }
            let Ok(m) = std::fs::metadata(f) else { continue };
            let now = (m.len(), m.modified().ok());
            if m.len() > 0 && self.last.get(f) == Some(&now) {
                out.push(f.clone());
            }
            self.last.insert(f.clone(), now);
        }
        out
    }

    /// These files have been handed on (imported, skipped as duplicates or failed): they are not offered again.
    pub fn finished(&mut self, files: &[PathBuf]) {
        for f in files {
            self.done.insert(f.clone());
            self.last.remove(f);
        }
    }
}

/// The folder a watch may not be pointed at: the catalog's own folder (its previews would be imported).
pub fn is_inside(folder: &Path, other: &Path) -> bool {
    match (std::fs::canonicalize(folder), std::fs::canonicalize(other)) {
        (Ok(a), Ok(b)) => a.starts_with(b),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_is_offered_once_after_it_has_stopped_changing() {
        let dir = tempfile::tempdir().unwrap();
        let a = dir.path().join("a.jpg");
        std::fs::write(&a, b"first").unwrap();
        let mut t = Tracker::default();
        assert!(t.ready(&[a.clone()]).is_empty(), "seen for the first time: it may still be being written");
        std::fs::write(&a, b"first and more").unwrap();
        assert!(t.ready(&[a.clone()]).is_empty(), "it grew since the last look");
        assert_eq!(t.ready(&[a.clone()]), vec![a.clone()], "unchanged between two looks: ready");
        t.finished(&[a.clone()]);
        assert!(t.ready(&[a.clone()]).is_empty(), "handed on already");
        assert!(t.ready(&[a.clone()]).is_empty());
    }

    #[test]
    fn an_empty_file_and_one_that_has_gone_are_never_ready() {
        let dir = tempfile::tempdir().unwrap();
        let e = dir.path().join("empty.jpg");
        std::fs::write(&e, b"").unwrap();
        let mut t = Tracker::default();
        t.ready(&[e.clone()]);
        assert!(t.ready(&[e.clone()]).is_empty());
        let gone = dir.path().join("gone.jpg");
        assert!(t.ready(&[gone.clone()]).is_empty());
        assert!(t.ready(&[]).is_empty());
    }

    #[test]
    fn the_catalogs_own_folder_cannot_be_watched() {
        let dir = tempfile::tempdir().unwrap();
        let inner = dir.path().join("previews");
        std::fs::create_dir_all(&inner).unwrap();
        assert!(is_inside(&inner, dir.path()));
        assert!(!is_inside(dir.path(), &inner));
    }
}
