//! The list of catalogs the person keeps, and which one is open.
//!
//! A catalog is a folder (it holds `catalog.db` and the previews). The list is a small file, `catalogs.json`, next to the
//! first catalog's folder. Nothing here ever deletes a catalog: taking one off the list only forgets where it is.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const FILE_NAME: &str = "catalogs.json";
const MAX_NAME: usize = 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    /// The catalog's folder.
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Registry {
    /// The id of the catalog that is open.
    pub current: String,
    pub items: Vec<Entry>,
}

fn new_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// A name the person typed, made tidy: spaces collapsed, no control characters, 1 to 60 letters.
pub fn clean_name(raw: &str) -> Result<String, String> {
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.is_empty() {
        return Err("Give the catalog a name.".into());
    }
    if name.chars().any(|c| c.is_control()) {
        return Err("A catalog name cannot contain control characters.".into());
    }
    if name.chars().count() > MAX_NAME {
        return Err(format!("The catalog name is too long ({MAX_NAME} letters at most)."));
    }
    Ok(name)
}

/// A folder name made from a catalog name: anything a folder name cannot hold becomes a dash.
pub fn folder_slug(name: &str) -> String {
    let s: String = name.chars().map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '-' } else { c }).collect();
    let s = s.trim().trim_end_matches(['.', ' ']).to_string();
    let stem = s.split('.').next().unwrap_or("").to_ascii_uppercase();
    let numbered = (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len() == 4 && stem[3..].chars().all(|c| ('1'..='9').contains(&c));
    if s.is_empty() || s == "." || s == ".." || ["CON", "PRN", "AUX", "NUL"].contains(&stem.as_str()) || numbered {
        "Catalog".to_string()
    } else {
        s
    }
}

/// A folder inside `parent` for a new catalog called `name` that does not exist yet ("Weddings", "Weddings 2", ...).
pub fn unique_dir(parent: &Path, name: &str) -> PathBuf {
    let slug = folder_slug(name);
    let first = parent.join(&slug);
    if !first.exists() {
        return first;
    }
    (2..).map(|n| parent.join(format!("{slug} {n}"))).find(|p| !p.exists()).unwrap()
}

/// Does this folder hold a catalog?
pub fn looks_like_catalog(dir: &Path) -> bool {
    dir.join("catalog.db").is_file()
}

/// How many photos a catalog holds, read without changing anything; nothing if it cannot be read.
pub fn count_photos(dir: &Path) -> Option<i64> {
    let db = dir.join("catalog.db");
    if !db.is_file() {
        return None;
    }
    let conn = rusqlite::Connection::open_with_flags(&db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX).ok()?;
    conn.query_row("select count(*) from photo", [], |r| r.get(0)).ok()
}

fn same_place(a: &str, b: &str) -> bool {
    let norm = |s: &str| std::fs::canonicalize(s).map(|p| p.to_string_lossy().to_lowercase()).unwrap_or_else(|_| s.trim_end_matches(['/', '\\']).to_lowercase());
    norm(a) == norm(b)
}

impl Registry {
    /// Read the list; a missing or damaged file gives a list of just the first catalog, so the person is never locked out.
    pub fn load(file: &Path, first_catalog: &Path) -> Registry {
        let mut r: Registry = std::fs::read_to_string(file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        r.items.retain(|e| !e.id.is_empty() && !e.path.is_empty());
        let mut seen = std::collections::HashSet::new();
        r.items.retain(|e| seen.insert(e.id.clone()));
        if r.items.is_empty() {
            let id = new_id();
            r.items.push(Entry { id: id.clone(), name: "Main catalog".into(), path: first_catalog.to_string_lossy().into_owned() });
            r.current = id;
        }
        if !r.items.iter().any(|e| e.id == r.current) {
            r.current = r.items[0].id.clone();
        }
        r
    }

    pub fn save(&self, file: &Path) -> Result<(), String> {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = file.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self).map_err(|e| e.to_string())?).map_err(|e| format!("The list of catalogs could not be saved: {e}"))?;
        std::fs::rename(&tmp, file).map_err(|e| format!("The list of catalogs could not be saved: {e}"))
    }

    pub fn find(&self, id: &str) -> Option<&Entry> {
        self.items.iter().find(|e| e.id == id)
    }

    pub fn current_entry(&self) -> Option<&Entry> {
        self.find(&self.current)
    }

    /// Put a catalog on the list (or find it if it is there already) and give back its id.
    pub fn add(&mut self, name: &str, dir: &Path) -> Result<String, String> {
        let path = dir.to_string_lossy().into_owned();
        if let Some(e) = self.items.iter().find(|e| same_place(&e.path, &path)) {
            return Ok(e.id.clone());
        }
        let id = new_id();
        self.items.push(Entry { id: id.clone(), name: clean_name(name)?, path });
        Ok(id)
    }

    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), String> {
        let name = clean_name(name)?;
        let e = self.items.iter_mut().find(|e| e.id == id).ok_or("That catalog is not on the list.")?;
        e.name = name;
        Ok(())
    }

    /// Take a catalog off the list. The open one cannot be removed, and its files are never touched.
    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        if id == self.current {
            return Err("Switch to another catalog first: the one that is open cannot be taken off the list.".into());
        }
        let before = self.items.len();
        self.items.retain(|e| e.id != id);
        if self.items.len() == before {
            return Err("That catalog is not on the list.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_tidied_and_refused_when_empty_long_or_odd() {
        assert_eq!(clean_name("  Wedding   2026 ").unwrap(), "Wedding 2026");
        assert_eq!(clean_name("Ünïcode ✓").unwrap(), "Ünïcode ✓");
        for bad in ["", "   ", "a\u{7}b", &"x".repeat(61)] {
            assert!(clean_name(bad).is_err(), "{bad:?}");
        }
        assert!(clean_name(&"x".repeat(60)).is_ok());
    }

    #[test]
    fn a_folder_name_is_made_from_a_catalog_name_and_never_reuses_a_folder() {
        assert_eq!(folder_slug("Client: Sam / Wedding?"), "Client- Sam - Wedding-");
        assert_eq!(folder_slug("CON"), "Catalog");
        assert_eq!(folder_slug("..."), "Catalog");
        assert_eq!(folder_slug("Trip."), "Trip");
        let dir = tempfile::tempdir().unwrap();
        let a = unique_dir(dir.path(), "Weddings");
        assert_eq!(a, dir.path().join("Weddings"));
        std::fs::create_dir(&a).unwrap();
        let b = unique_dir(dir.path(), "Weddings");
        assert_eq!(b, dir.path().join("Weddings 2"));
        std::fs::create_dir(&b).unwrap();
        assert_eq!(unique_dir(dir.path(), "weddings?"), dir.path().join("weddings-"), "another name, another folder");
        assert_eq!(unique_dir(dir.path(), "Weddings"), dir.path().join("Weddings 3"));
    }

    #[test]
    fn the_list_starts_with_the_first_catalog_survives_a_round_trip_and_a_damaged_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join(FILE_NAME);
        let first = dir.path().join("catalog");
        let mut r = Registry::load(&file, &first);
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].name, "Main catalog");
        assert_eq!(r.current, r.items[0].id);
        let id = r.add("Weddings", &dir.path().join("Weddings")).unwrap();
        r.current = id.clone();
        r.save(&file).unwrap();
        let again = Registry::load(&file, &first);
        assert_eq!(again, r);
        // a damaged file, and a file that names a current catalog that is not in it, both give a usable list
        std::fs::write(&file, "{not json").unwrap();
        let fixed = Registry::load(&file, &first);
        assert_eq!((fixed.items.len(), fixed.items[0].path.as_str()), (1, first.to_string_lossy().as_ref()));
        std::fs::write(&file, r#"{"current":"zzz","items":[{"id":"a","name":"A","path":"C:/a"},{"id":"a","name":"dup","path":"C:/dup"},{"id":"","name":"x","path":"y"}]}"#).unwrap();
        let odd = Registry::load(&file, &first);
        assert_eq!((odd.items.len(), odd.current.as_str()), (1, "a"), "duplicates and empty ids are dropped, current falls back");
    }

    #[test]
    fn adding_the_same_folder_twice_finds_it_and_rename_and_remove_protect_the_open_catalog() {
        let dir = tempfile::tempdir().unwrap();
        let mut r = Registry::load(&dir.path().join(FILE_NAME), &dir.path().join("catalog"));
        let first = r.current.clone();
        let sub = dir.path().join("Weddings");
        let a = r.add("Weddings", &sub).unwrap();
        assert_ne!(a, first);
        assert_eq!(r.add("Another name for it", &sub).unwrap(), a, "the same folder is the same catalog");
        assert_eq!(r.add("Again", &dir.path().join("Weddings").join("")).unwrap(), a, "a trailing slash is the same folder");
        assert_eq!(r.items.len(), 2);
        assert!(r.add("   ", &dir.path().join("x")).is_err());
        r.rename(&a, "Weddings 2026").unwrap();
        assert_eq!(r.find(&a).unwrap().name, "Weddings 2026");
        assert!(r.rename("nope", "x").is_err() && r.rename(&a, "").is_err());
        assert!(r.remove(&first).is_err(), "the open one stays");
        r.remove(&a).unwrap();
        assert!(r.remove(&a).is_err());
        assert_eq!(r.items.len(), 1);
    }

    #[test]
    fn a_folder_is_a_catalog_only_if_it_holds_the_database_and_the_photo_count_is_read_without_changing_it() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!looks_like_catalog(dir.path()) && count_photos(dir.path()).is_none());
        let cat = crate::catalog::Catalog::open(dir.path()).unwrap();
        assert!(looks_like_catalog(dir.path()));
        assert_eq!(count_photos(dir.path()), Some(0));
        drop(cat);
        std::fs::write(dir.path().join("catalog.db"), "this is not a database").unwrap();
        assert_eq!(count_photos(dir.path()), None, "a damaged file is not a count");
    }
}
