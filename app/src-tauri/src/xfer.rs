//! Moving photos from one catalog to another: "Export as catalog" (the chosen photos go into a new catalog of their own) and "Import from
//! another catalog" (everything in another catalog is added to this one). The two catalogs are opened side by side with SQLite's ATTACH and
//! the rows are copied across, so a photo keeps its rating, flag, label, text, keywords, develop settings, history and snapshots, and its
//! virtual copies. The photos' files are not copied: a photo points at the same file in both catalogs. A photo the other catalog already has
//! (the same id, or the same file name in the same folder) is skipped, so nothing is ever doubled.

use crate::catalog::Catalog;
use rusqlite::{params, Connection, OptionalExtension};
use std::fs;
use std::path::Path;

#[derive(Debug, Default, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct XferResult {
    /// photos added to the other catalog
    pub photos: usize,
    /// photos it already had
    pub skipped: usize,
    /// preview pictures copied with them
    pub previews: usize,
}

fn columns(conn: &Connection, schema: &str, table: &str) -> Result<Vec<String>, String> {
    let mut st = conn.prepare("select name from pragma_table_info(?1, ?2)").map_err(|e| e.to_string())?;
    let v = st.query_map(params![table, schema], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(v)
}

/// The columns both catalogs have for a table, leaving out the ones in `except`.
fn shared(conn: &Connection, from: &str, to: &str, table: &str, except: &[&str]) -> Result<Vec<String>, String> {
    let a = columns(conn, from, table)?;
    let b = columns(conn, to, table)?;
    Ok(a.into_iter().filter(|c| b.contains(c) && !except.contains(&c.as_str())).collect())
}

/// Copy these photos (and the masters of any virtual copies among them) from the catalog attached as `from` to the one attached as `to`
/// ("main" is this catalog). Returns the photos that were added as (id in `from`, id in `to`), and how many were skipped.
fn copy_photos(conn: &Connection, from: &str, to: &str, ids: &[i64]) -> Result<(Vec<(i64, i64)>, usize), String> {
    let e = |x: rusqlite::Error| x.to_string();
    conn.execute_batch("drop table if exists temp.xfer_ids; drop table if exists temp.xfer_map; create temp table xfer_ids(id integer primary key); create temp table xfer_map(src integer primary key, dst integer not null);").map_err(e)?;
    for id in ids {
        conn.execute("insert or ignore into temp.xfer_ids(id) values (?1)", [id]).map_err(e)?;
    }
    conn.execute(&format!("insert or ignore into temp.xfer_ids(id) select master_id from {from}.photo where id in (select id from temp.xfer_ids) and master_id is not null"), []).map_err(e)?;
    let wanted: i64 = conn.query_row(&format!("select count(*) from {from}.photo where id in (select id from temp.xfer_ids)"), [], |r| r.get(0)).map_err(e)?;
    let max_before: i64 = conn.query_row(&format!("select coalesce(max(id), 0) from {to}.photo"), [], |r| r.get(0)).map_err(e)?;

    // the places the photos are in
    conn.execute(
        &format!(
            "insert or ignore into {to}.root_folder(absolute_path, name, volume_id)
             select distinct r.absolute_path, r.name, r.volume_id from {from}.root_folder r join {from}.folder f on f.root_folder_id = r.id
             join {from}.photo p on p.folder_id = f.id where p.id in (select id from temp.xfer_ids)"
        ),
        [],
    )
    .map_err(e)?;
    conn.execute(
        &format!(
            "insert or ignore into {to}.folder(root_folder_id, parent_id, rel_path)
             select distinct dr.id, null, f.rel_path from {from}.folder f join {from}.root_folder r on r.id = f.root_folder_id
             join {to}.root_folder dr on dr.absolute_path = r.absolute_path
             join {from}.photo p on p.folder_id = f.id where p.id in (select id from temp.xfer_ids)"
        ),
        [],
    )
    .map_err(e)?;
    // the photos
    let cols = shared(conn, from, to, "photo", &["id", "folder_id", "master_id", "import_id", "stack_id", "stack_pos"])?;
    let list = cols.join(", ");
    let plist = cols.iter().map(|c| format!("p.{c}")).collect::<Vec<_>>().join(", ");
    conn.execute(
        &format!(
            "insert into {to}.photo({list}, folder_id)
             select {plist}, df.id from {from}.photo p
             join {from}.folder f on f.id = p.folder_id join {from}.root_folder r on r.id = f.root_folder_id
             join {to}.root_folder dr on dr.absolute_path = r.absolute_path
             join {to}.folder df on df.root_folder_id = dr.id and df.rel_path = f.rel_path
             where p.id in (select id from temp.xfer_ids)
               and not exists (select 1 from {to}.photo x where x.uuid = p.uuid)
               and not exists (select 1 from {to}.photo y where y.folder_id = df.id and y.base_name = p.base_name and y.ext = p.ext and y.copy_name is p.copy_name)
             order by p.master_id is not null, p.id"
        ),
        [],
    )
    .map_err(e)?;
    conn.execute(
        &format!("insert into temp.xfer_map(src, dst) select sp.id, dp.id from {from}.photo sp join {to}.photo dp on dp.uuid = sp.uuid where sp.id in (select id from temp.xfer_ids) and dp.id > ?1"),
        [max_before],
    )
    .map_err(e)?;
    // virtual copies point at their originals
    conn.execute(
        &format!(
            "update {to}.photo set master_id = (select dm.id from {to}.photo dm join {from}.photo sm on sm.uuid = dm.uuid
                 join {from}.photo sp on sp.master_id = sm.id where sp.uuid = {to}.photo.uuid)
             where id in (select dst from temp.xfer_map)"
        ),
        [],
    )
    .map_err(e)?;

    // what belongs to each photo
    for (table, own_id) in [("exif", false), ("iptc", false), ("develop_settings", false), ("snapshot", true), ("history_step", true)] {
        let mut except = vec!["photo_id"];
        if own_id {
            except.push("id");
        }
        let c = shared(conn, from, to, table, &except)?;
        if c.is_empty() {
            continue;
        }
        let list = c.join(", ");
        let clist = c.iter().map(|x| format!("c.{x}")).collect::<Vec<_>>().join(", ");
        conn.execute(&format!("insert or ignore into {to}.{table}(photo_id, {list}) select m.dst, {clist} from {from}.{table} c join temp.xfer_map m on m.src = c.photo_id"), []).map_err(e)?;
    }

    // keywords, found again by their names (a keyword that is not there yet is made, with the ones above it)
    let kw_cols = shared(conn, from, to, "keyword", &["id", "parent_id", "name"])?;
    let pairs: Vec<(i64, i64)> = {
        let mut st = conn
            .prepare(&format!("select m.dst, pk.keyword_id from {from}.photo_keyword pk join temp.xfer_map m on m.src = pk.photo_id"))
            .map_err(e)?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
        v
    };
    let mut made: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for (dst_photo, src_kw) in pairs {
        let kid = match made.get(&src_kw) {
            Some(k) => *k,
            None => {
                // the chain from the top keyword down to this one
                let mut chain: Vec<i64> = vec![];
                let mut at = Some(src_kw);
                while let Some(k) = at {
                    chain.push(k);
                    at = conn.query_row(&format!("select parent_id from {from}.keyword where id = ?1"), [k], |r| r.get::<_, Option<i64>>(0)).optional().map_err(e)?.flatten();
                    if chain.len() > 64 {
                        break;
                    }
                }
                chain.reverse();
                let mut parent: Option<i64> = None;
                for k in chain {
                    let name: String = conn.query_row(&format!("select name from {from}.keyword where id = ?1"), [k], |r| r.get(0)).map_err(e)?;
                    let found: Option<i64> = conn.query_row(&format!("select id from {to}.keyword where name = ?1 and parent_id is ?2"), params![name, parent], |r| r.get(0)).optional().map_err(e)?;
                    let id = match found {
                        Some(id) => id,
                        None => {
                            conn.execute(&format!("insert into {to}.keyword(name, parent_id) values (?1, ?2)"), params![name, parent]).map_err(e)?;
                            let id = conn.last_insert_rowid();
                            for col in &kw_cols {
                                conn.execute(&format!("update {to}.keyword set {col} = (select {col} from {from}.keyword where id = ?1) where id = ?2"), params![k, id]).map_err(e)?;
                            }
                            id
                        }
                    };
                    made.insert(k, id);
                    parent = Some(id);
                }
                *made.get(&src_kw).unwrap_or(&0)
            }
        };
        if kid != 0 {
            conn.execute(&format!("insert or ignore into {to}.photo_keyword(photo_id, keyword_id) values (?1, ?2)"), params![dst_photo, kid]).map_err(e)?;
        }
    }

    let added: Vec<(i64, i64)> = {
        let mut st = conn.prepare("select src, dst from temp.xfer_map order by src").map_err(e)?;
        let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<Result<Vec<_>, _>>().map_err(e)?;
        v
    };
    let skipped = (wanted as usize).saturating_sub(added.len());
    conn.execute_batch("drop table if exists temp.xfer_ids; drop table if exists temp.xfer_map;").map_err(e)?;
    Ok((added, skipped))
}

/// Copy the preview pictures of the photos that were added.
fn copy_previews(from_dir: &Path, to_dir: &Path, added: &[(i64, i64)]) -> usize {
    let _ = fs::create_dir_all(to_dir);
    let mut n = 0;
    for (src, dst) in added {
        for level in ["thumb", "standard", "ethumb", "estandard", "smart"] {
            let from = from_dir.join(format!("{src}_{level}.jpg"));
            if from.is_file() && fs::copy(&from, to_dir.join(format!("{dst}_{level}.jpg"))).is_ok() {
                n += 1;
            }
        }
    }
    n
}

fn attach(conn: &Connection, db: &Path, name: &str) -> Result<(), String> {
    conn.execute(&format!("attach database ?1 as {name}"), [db.to_string_lossy().as_ref()]).map_err(|e| format!("The other catalog could not be opened: {e}"))?;
    Ok(())
}

/// Put these photos into a new catalog in the folder `dest` (made if it is not there; it must not hold a catalog already).
pub fn export(cat: &Catalog, ids: &[i64], dest: &Path, with_previews: bool) -> Result<XferResult, String> {
    if ids.is_empty() {
        return Err("Select the photos to export first.".into());
    }
    if dest.join("catalog.db").exists() {
        return Err("There is a catalog in that folder already. Choose another folder, or another name.".into());
    }
    drop(Catalog::open(dest)?); // makes the empty catalog
    attach(&cat.conn, &dest.join("catalog.db"), "dst")?;
    let r = copy_photos(&cat.conn, "main", "dst", ids);
    let _ = cat.conn.execute_batch("detach database dst");
    let (added, skipped) = r?;
    let previews = if with_previews { copy_previews(&cat.previews_dir(), &dest.join("previews"), &added) } else { 0 };
    Ok(XferResult { photos: added.len(), skipped, previews })
}

/// Add every photo of the catalog in the folder `other` to this one.
pub fn import(cat: &Catalog, other: &Path, with_previews: bool) -> Result<XferResult, String> {
    if !crate::catalogs::looks_like_catalog(other) {
        return Err("That folder does not hold a catalog (there is no catalog.db in it).".into());
    }
    if other.join("catalog.db") == cat.root.join("catalog.db") {
        return Err("That is this catalog.".into());
    }
    attach(&cat.conn, &other.join("catalog.db"), "other")?;
    let r = (|| {
        let ids: Vec<i64> = {
            let mut st = cat.conn.prepare("select id from other.photo order by id").map_err(|e| format!("That does not look like a Lucent Raw catalog: {e}"))?;
            let v = st.query_map([], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            v
        };
        copy_photos(&cat.conn, "other", "main", &ids)
    })();
    let _ = cat.conn.execute_batch("detach database other");
    let (added, skipped) = r?;
    let previews = if with_previews { copy_previews(&other.join("previews"), &cat.previews_dir(), &added) } else { 0 };
    Ok(XferResult { photos: added.len(), skipped, previews })
}
