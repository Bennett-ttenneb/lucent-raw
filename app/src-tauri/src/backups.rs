//! Automatic catalog backups, and restoring from one.
//!
//! A backup is one file, `backups/<kind>-<date>-<time>.db`, inside the catalog's own folder, made with VACUUM INTO so it is
//! consistent while the program is using the catalog. Every function here works from the catalog's folder and opens its own
//! connection, so a backup never holds up the one the program is working with.
//!
//! Kinds: `auto` (made by the schedule), `before-upgrade` (made before a catalog is changed to a newer layout) and
//! `before-restore` (made just before a restore replaces the catalog, so a restore can always be undone). Only `auto` copies are
//! ever deleted by the program, and only the oldest ones beyond the number to keep.

use chrono::{Local, NaiveDateTime};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const FOLDER: &str = "backups";
const STAMP: &str = "%Y-%m-%d-%H%M%S";
const KINDS: [&str; 3] = ["auto", "before-upgrade", "before-restore"];
/// the most `before-upgrade` and `before-restore` copies kept (each), so they cannot pile up for ever
const KEEP_SAFETY: usize = 5;

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub on: bool,
    pub every_days: i64,
    pub keep: i64,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { on: true, every_days: 1, keep: 7 }
    }
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub file: String,
    pub kind: String,
    /// as "2026-10-19 13:02"
    pub when: String,
    pub bytes: u64,
    pub photos: i64,
}

fn meta_get(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("select value from catalog_meta where key = ?1", [key], |r| r.get(0)).ok()
}

fn meta_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("insert into catalog_meta(key, value) values (?1, ?2) on conflict(key) do update set value = excluded.value", [key, value])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn connect(root: &Path) -> Result<Connection, String> {
    let conn = Connection::open(root.join("catalog.db")).map_err(|e| e.to_string())?;
    conn.busy_timeout(std::time::Duration::from_secs(10)).map_err(|e| e.to_string())?;
    Ok(conn)
}

pub fn settings(root: &Path) -> Settings {
    let Ok(conn) = connect(root) else { return Settings::default() };
    let d = Settings::default();
    Settings {
        on: meta_get(&conn, "auto_backup").map(|v| v != "off").unwrap_or(d.on),
        every_days: meta_get(&conn, "auto_backup_days").and_then(|v| v.parse().ok()).unwrap_or(d.every_days).clamp(1, 90),
        keep: meta_get(&conn, "auto_backup_keep").and_then(|v| v.parse().ok()).unwrap_or(d.keep).clamp(1, 30),
    }
}

pub fn set_settings(root: &Path, s: &Settings) -> Result<Settings, String> {
    let s = Settings { on: s.on, every_days: s.every_days.clamp(1, 90), keep: s.keep.clamp(1, 30) };
    let conn = connect(root)?;
    meta_set(&conn, "auto_backup", if s.on { "on" } else { "off" })?;
    meta_set(&conn, "auto_backup_days", &s.every_days.to_string())?;
    meta_set(&conn, "auto_backup_keep", &s.keep.to_string())?;
    drop(conn);
    // a smaller number to keep takes effect at once
    prune(root, "auto", s.keep as usize);
    Ok(s)
}

/// Ask a backup file whether it is sound. Returns how many photos it holds.
pub fn check_file(file: &Path) -> Result<i64, String> {
    let conn = Connection::open_with_flags(file, OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(|e| format!("That file is not a catalog: {e}"))?;
    let verdict: String = conn.query_row("pragma integrity_check", [], |r| r.get(0)).map_err(|e| format!("That file is not a catalog: {e}"))?;
    if verdict != "ok" {
        return Err(format!("That backup is damaged ({verdict})."));
    }
    let n: i64 = conn.query_row("select count(*) from sqlite_master where name = 'catalog_meta'", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if n == 0 {
        return Err("That file is not a catalog.".into());
    }
    conn.query_row("select count(*) from photo", [], |r| r.get(0)).map_err(|e| format!("That file is not a catalog: {e}"))
}

/// Write one backup now, check it, and return it. A copy that fails its check is deleted.
pub fn write(root: &Path, kind: &str) -> Result<Backup, String> {
    if !KINDS.contains(&kind) {
        return Err("unknown kind of backup".into());
    }
    let dir = root.join(FOLDER);
    fs::create_dir_all(&dir).map_err(|e| format!("The backup folder could not be made: {e}"))?;
    let stem = format!("{kind}-{}", Local::now().format(STAMP));
    let mut file = dir.join(format!("{stem}.db"));
    let mut n = 2;
    while file.exists() {
        file = dir.join(format!("{stem}-{n}.db"));
        n += 1;
    }
    let conn = connect(root)?;
    let target = file.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("vacuum into '{target}'")).map_err(|e| format!("The backup could not be written: {e}"))?;
    if kind == "auto" {
        meta_set(&conn, "last_auto_backup", &Local::now().format("%Y-%m-%d %H:%M").to_string())?;
    }
    drop(conn);
    if let Err(e) = check_file(&file) {
        let _ = fs::remove_file(&file);
        return Err(format!("The backup was written but did not pass its own check, so it was removed. {e}"));
    }
    let b = describe(&file).ok_or("The backup could not be read back.")?;
    match kind {
        "auto" => prune(root, "auto", settings(root).keep as usize),
        other => prune(root, other, KEEP_SAFETY),
    }
    Ok(b)
}

/// Make the scheduled backup if it is switched on and the last one is old enough. `None` when nothing was due.
pub fn run_if_due(root: &Path) -> Result<Option<Backup>, String> {
    let s = settings(root);
    if !s.on {
        return Ok(None);
    }
    let last = connect(root).ok().and_then(|c| meta_get(&c, "last_auto_backup")).and_then(|t| NaiveDateTime::parse_from_str(&t, "%Y-%m-%d %H:%M").ok());
    let due = match last {
        None => true,
        Some(t) => Local::now().naive_local() - t >= chrono::Duration::days(s.every_days),
    };
    if due {
        write(root, "auto").map(Some)
    } else {
        Ok(None)
    }
}

fn describe(file: &Path) -> Option<Backup> {
    let name = file.file_name()?.to_string_lossy().into_owned();
    let kind = KINDS.iter().find(|k| name.starts_with(&format!("{k}-")))?.to_string();
    let rest = &name[kind.len() + 1..];
    let stamp = rest.get(..17)?;
    let when = NaiveDateTime::parse_from_str(stamp, STAMP).ok()?.format("%Y-%m-%d %H:%M").to_string();
    let bytes = fs::metadata(file).ok()?.len();
    let photos = check_file(file).ok()?;
    Some(Backup { file: file.to_string_lossy().replace('\\', "/"), kind, when, bytes, photos })
}

/// Every backup in the folder, newest first. Files that are not sound backups are left out of the list (and left alone).
pub fn list(root: &Path) -> Vec<Backup> {
    let Ok(rd) = fs::read_dir(root.join(FOLDER)) else { return vec![] };
    let mut v: Vec<Backup> = rd.filter_map(|e| e.ok()).map(|e| e.path()).filter(|p| p.extension().map(|x| x == "db").unwrap_or(false)).filter_map(|p| describe(&p)).collect();
    v.sort_by(|a, b| b.when.cmp(&a.when).then(b.file.cmp(&a.file)));
    v
}

fn prune(root: &Path, kind: &str, keep: usize) {
    let mut mine: Vec<Backup> = list(root).into_iter().filter(|b| b.kind == kind).collect();
    // newest first already; drop the oldest beyond `keep`
    for old in mine.drain(keep.min(mine.len())..) {
        let _ = fs::remove_file(&old.file);
    }
}

/// Put a backup in place of the catalog. The catalog must not be open (the caller lets go of it first). The backup is checked
/// before anything is replaced, and the old catalog file is kept as `catalog.db.before-restore` until the swap has worked.
pub fn restore(root: &Path, file: &Path) -> Result<(), String> {
    let inside = fs::canonicalize(root.join(FOLDER)).map_err(|_| "This catalog has no backups.".to_string())?;
    let chosen = fs::canonicalize(file).map_err(|_| "That backup is not there any more.".to_string())?;
    if chosen.parent() != Some(inside.as_path()) {
        return Err("Only a backup made by this program, in this catalog's backups folder, can be restored.".into());
    }
    check_file(&chosen)?;
    let live = root.join("catalog.db");
    let staged = root.join("catalog.db.restoring");
    let kept = root.join("catalog.db.before-restore");
    fs::copy(&chosen, &staged).map_err(|e| format!("The backup could not be copied: {e}"))?;
    let _ = fs::remove_file(&kept);
    if live.exists() {
        fs::rename(&live, &kept).map_err(|e| {
            let _ = fs::remove_file(&staged);
            format!("The catalog could not be put aside: {e}")
        })?;
    }
    // the write-ahead files belong to the old file
    let _ = fs::remove_file(root.join("catalog.db-wal"));
    let _ = fs::remove_file(root.join("catalog.db-shm"));
    if let Err(e) = fs::rename(&staged, &live) {
        let _ = fs::rename(&kept, &live);
        return Err(format!("The backup could not be put in place, so nothing was changed: {e}"));
    }
    let _ = fs::remove_file(&kept);
    Ok(())
}

pub fn dir_of(root: &Path) -> PathBuf {
    root.join(FOLDER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::catalog::Catalog;

    fn catalog_with(root: &Path, n: usize) {
        let cat = Catalog::open(root).unwrap();
        for i in 0..n {
            cat.conn.execute("insert into root_folder(absolute_path, name) values (?1, ?2)", [format!("c:/p{i}"), "x".to_string()]).unwrap();
        }
    }

    #[test]
    fn a_backup_is_a_checked_file_in_the_catalog_folder_and_the_schedule_makes_one_a_day() {
        let d = tempfile::tempdir().unwrap();
        drop(Catalog::open(d.path()).unwrap());
        assert!(settings(d.path()).on, "on by default");
        let first = run_if_due(d.path()).unwrap().expect("the first one is due at once");
        assert_eq!(first.kind, "auto");
        assert!(Path::new(&first.file).starts_with(d.path().join("backups")) || first.file.contains("/backups/"));
        assert!(run_if_due(d.path()).unwrap().is_none(), "not due again for a day");
        assert_eq!(list(d.path()).len(), 1);
    }

    #[test]
    fn only_the_newest_few_scheduled_copies_are_kept_and_the_safety_copies_are_not_touched() {
        let d = tempfile::tempdir().unwrap();
        drop(Catalog::open(d.path()).unwrap());
        set_settings(d.path(), &Settings { on: true, every_days: 1, keep: 2 }).unwrap();
        write(d.path(), "before-restore").unwrap();
        for _ in 0..4 {
            write(d.path(), "auto").unwrap();
        }
        let all = list(d.path());
        assert_eq!(all.iter().filter(|b| b.kind == "auto").count(), 2);
        assert_eq!(all.iter().filter(|b| b.kind == "before-restore").count(), 1);
        set_settings(d.path(), &Settings { on: true, every_days: 1, keep: 1 }).unwrap();
        assert_eq!(list(d.path()).iter().filter(|b| b.kind == "auto").count(), 1, "a smaller number applies at once");
    }

    #[test]
    fn switched_off_nothing_is_made_and_the_settings_stay_within_sensible_limits() {
        let d = tempfile::tempdir().unwrap();
        drop(Catalog::open(d.path()).unwrap());
        let s = set_settings(d.path(), &Settings { on: false, every_days: 9999, keep: 0 }).unwrap();
        assert_eq!((s.every_days, s.keep), (90, 1));
        assert!(run_if_due(d.path()).unwrap().is_none());
        assert!(list(d.path()).is_empty());
    }

    #[test]
    fn restoring_puts_the_old_catalog_back_and_refuses_anything_that_is_not_one_of_our_backups() {
        let d = tempfile::tempdir().unwrap();
        catalog_with(d.path(), 3);
        let b = write(d.path(), "auto").unwrap();
        // the catalog changes after the backup
        {
            let cat = Catalog::open(d.path()).unwrap();
            cat.conn.execute("insert into root_folder(absolute_path, name) values ('c:/later', 'x')", []).unwrap();
        }
        let count = |p: &Path| Connection::open(p.join("catalog.db")).unwrap().query_row("select count(*) from root_folder", [], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(count(d.path()), 4);
        restore(d.path(), Path::new(&b.file)).unwrap();
        assert_eq!(count(d.path()), 3, "back to how it was when the copy was made");
        assert!(Catalog::open(d.path()).is_ok(), "and it opens");
        // a file from anywhere else is refused
        let other = d.path().join("elsewhere.db");
        fs::copy(&b.file, &other).unwrap();
        assert!(restore(d.path(), &other).unwrap_err().contains("backups folder"));
        // a damaged file in the backups folder is refused and the catalog is not touched
        let bad = d.path().join("backups").join("auto-2020-01-01-000000.db");
        fs::write(&bad, b"this is not a database").unwrap();
        assert!(restore(d.path(), &bad).is_err());
        assert_eq!(count(d.path()), 3);
        assert!(list(d.path()).iter().all(|x| x.file != bad.to_string_lossy().replace('\\', "/")), "a damaged file is not offered");
    }

    #[test]
    fn a_catalog_from_an_older_layout_is_backed_up_before_it_is_changed() {
        let d = tempfile::tempdir().unwrap();
        drop(Catalog::open(d.path()).unwrap());
        Connection::open(d.path().join("catalog.db")).unwrap().execute("update catalog_meta set value = '0' where key = 'schema_version'", []).unwrap();
        drop(Catalog::open(d.path()).unwrap());
        let made = list(d.path());
        assert_eq!(made.iter().filter(|b| b.kind == "before-upgrade").count(), 1);
        let v: String = Connection::open(d.path().join("catalog.db")).unwrap().query_row("select value from catalog_meta where key = 'schema_version'", [], |r| r.get(0)).unwrap();
        assert_eq!(v, crate::catalog::SCHEMA_VERSION);
        drop(Catalog::open(d.path()).unwrap());
        assert_eq!(list(d.path()).iter().filter(|b| b.kind == "before-upgrade").count(), 1, "not again when nothing changed");
    }
}
