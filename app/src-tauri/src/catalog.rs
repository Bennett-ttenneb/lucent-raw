//! The catalog: one SQLite file plus a previews folder. All SQL lives here.

use crate::develop::{self, Recipe};
use crate::media::{self, Kind};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const SCHEMA: &str = include_str!("../migrations/001_init.sql");
pub const SCHEMA_VERSION: &str = "1";

pub struct Catalog {
    pub conn: Connection,
    pub root: PathBuf,
}

/// A folder of the catalog that has photos whose files are not there.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MissingGroup {
    pub root_id: i64,
    pub path: String,
    /// the folder itself is there (so single files are missing) or not (a drive that is not connected, or a folder that moved)
    pub folder_there: bool,
    pub missing: i64,
    pub total: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MissingReport {
    pub checked: i64,
    pub missing: i64,
    pub groups: Vec<MissingGroup>,
}

#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct Relocation {
    pub found: i64,
    pub total: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub relinked: i64,
    pub still_missing: i64,
    /// photos that fit more than one file, or whose file fits more than one photo, and were left alone
    pub ambiguous: i64,
    /// photos whose file is already in the catalog under another photo
    pub conflicts: i64,
    /// how many of the relinked photos were found by what is inside the file, because it had been renamed
    pub by_content: i64,
}

/// What synchronising a folder would do.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncPreview {
    /// supported files on the disk that the catalog does not have
    pub new_files: Vec<String>,
    /// photos the catalog has whose files are not there
    pub gone: Vec<SyncGone>,
    /// photos in the catalog under this folder
    pub present: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncGone {
    pub id: i64,
    pub name: String,
}

/// What a catalog holds and the room it takes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDetails {
    pub photos: i64,
    pub virtual_copies: i64,
    pub folders: i64,
    pub collections: i64,
    pub keywords: i64,
    pub edited: i64,
    pub catalog_bytes: u64,
    pub previews_bytes: u64,
    pub created: Option<String>,
    pub schema_version: String,
}

/// How big the catalog file was before and after it was compacted, in bytes.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeReport {
    pub before: u64,
    pub after: u64,
}

/// What the check of the catalog found.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    pub ok: bool,
    /// in words, at most 20
    pub problems: Vec<String>,
    pub photos: i64,
    pub books: i64,
    pub size_bytes: u64,
}

/// One book in the list.
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookEntry {
    pub id: i64,
    pub name: String,
    pub pages: usize,
    pub updated: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PhotoRow {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub folder: String,
    pub format: String,
    pub rating: i64,
    pub flag: i64,
    pub label: Option<String>,
    pub captured: Option<String>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub missing: bool,
    pub camera: Option<String>,
    pub lens: Option<String>,
    pub iso: Option<i64>,
    pub aperture: Option<f64>,
    pub shutter_s: Option<f64>,
    pub focal_mm: Option<f64>,
    pub previewable: bool,
    /// The photo has develop edits.
    pub edited: bool,
    /// "Copy 1", "Copy 2" ... for a virtual copy (a photo of its own that shares another photo's file), otherwise None.
    pub copy_name: Option<String>,
    /// The photo a virtual copy was made from.
    pub master_id: Option<i64>,
    /// The stack the photo is in, its place in it (0 = the picture that shows when the stack is closed) and how many photos the stack has.
    pub stack_id: Option<i64>,
    pub stack_pos: i64,
    pub stack_count: i64,
    pub stack_collapsed: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Query {
    pub sort: String,
    pub desc: bool,
    pub min_rating: Option<i64>,
    pub flag: Option<String>,
    pub label: Option<String>,
    /// "yes" for the photos that have edits, "no" for the ones that have none.
    pub edited: Option<String>,
    /// "no" leaves the virtual copies out, "only" shows nothing else.
    pub copies: Option<String>,
    /// "all" shows every photo of every stack; otherwise a closed stack shows only its top photo.
    pub stacks: Option<String>,
    pub text: Option<String>,
    pub folder_id: Option<i64>,
    pub collection_id: Option<i64>,
    pub keyword_id: Option<i64>,
    /// The camera as the grid names it ("Canon EOS 800D"), and the lens.
    pub camera: Option<String>,
    pub lens: Option<String>,
    /// Ranges, both ends included. A photo without the information is left out when a range is set.
    pub min_iso: Option<i64>,
    pub max_iso: Option<i64>,
    pub min_focal: Option<f64>,
    pub max_focal: Option<f64>,
    pub min_aperture: Option<f64>,
    pub max_aperture: Option<f64>,
    /// "YYYY-MM-DD", the day the photo was taken (its file date when it has no capture time).
    pub date_from: Option<String>,
    pub date_to: Option<String>,
    pub offset: i64,
    pub limit: i64,
}

/// The camera as the grid names it: the model, with the make in front unless the model already starts with it.
const CAMERA_SQL: &str = "(case when e.make is not null and e.model is not null and substr(e.model, 1, length(e.make)) = e.make then e.model
                               when e.make is not null and e.model is not null then e.make || ' ' || e.model
                               when e.model is not null then e.model
                               else e.make end)";

/// The day a photo was taken, for the date range.
const DAY_SQL: &str = "date(coalesce(p.captured_local, p.file_mtime))";

/// Is this "YYYY-MM-DD" (a real-looking date)?
fn is_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10 && b[4] == b'-' && b[7] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit()) && chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").is_ok()
}

#[derive(Debug, Serialize, PartialEq)]
pub struct Counted {
    pub name: String,
    pub count: i64,
}

/// What the catalog holds, for the Metadata filter to offer: the cameras and lenses with how many photos each, and the
/// lowest and highest ISO, focal length, aperture and day.
#[derive(Debug, Serialize, PartialEq, Default)]
pub struct MetadataValues {
    pub cameras: Vec<Counted>,
    pub lenses: Vec<Counted>,
    pub iso: Option<(i64, i64)>,
    pub focal: Option<(f64, f64)>,
    pub aperture: Option<(f64, f64)>,
    pub days: Option<(String, String)>,
}

impl Default for Query {
    fn default() -> Self {
        Query {
            sort: "capture".into(),
            desc: false,
            min_rating: None,
            flag: None,
            label: None,
            edited: None,
            copies: None,
            stacks: None,
            text: None,
            folder_id: None,
            collection_id: None,
            keyword_id: None,
            camera: None,
            lens: None,
            min_iso: None,
            max_iso: None,
            min_focal: None,
            max_focal: None,
            min_aperture: None,
            max_aperture: None,
            date_from: None,
            date_to: None,
            offset: 0,
            limit: 200,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct Page {
    pub total: i64,
    pub rows: Vec<PhotoRow>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FolderRow {
    pub id: i64,
    pub root: String,
    /// where the root is on the disk (for the free-space line)
    pub root_path: String,
    pub rel_path: String,
    pub count: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRow {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub is_target: bool,
    pub count: i64,
    /// the collection set this one is in, or None at the top
    pub parent_id: Option<i64>,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeywordRow {
    pub id: i64,
    pub name: String,
    pub parent_id: Option<i64>,
    pub count: i64,
    /// other words that mean the same, comma separated: searched in the keyword list
    pub synonyms: String,
    /// written to sidecar files (on by default)
    pub include_on_export: bool,
    /// a private keyword stays in the catalog and is never written to a sidecar
    pub is_private: bool,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeywordUse {
    pub keyword_id: i64,
    pub count: i64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRow {
    pub id: i64,
    pub seq: i64,
    pub label: String,
    pub delta_text: Option<String>,
    pub value_text: Option<String>,
    pub created_at: String,
    /// The full recipe after this step, so clicking a step can go back to it.
    pub recipe: Recipe,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DevelopState {
    pub recipe: Recipe,
    /// Newest first.
    pub history: Vec<HistoryRow>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StepIn {
    pub label: String,
    pub delta_text: Option<String>,
    pub value_text: Option<String>,
}

const HISTORY_LIMIT: i64 = 500;
const SNAPSHOT_LIMIT: i64 = 100;
pub const USER_PRESET_GROUP: &str = "User Presets";

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PresetRow {
    pub id: i64,
    pub name: String,
    pub group: String,
    /// Which groups of settings the preset applies (see develop::SETTING_GROUPS).
    pub groups: Vec<String>,
    pub recipe: Recipe,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRow {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub recipe: Recipe,
}

/// What is stored in preset.settings_json.
#[derive(Debug, Serialize, Deserialize)]
struct PresetBody {
    groups: Vec<String>,
    recipe: Recipe,
}

fn clean_label(s: &str, what: &str) -> Result<String, String> {
    let n = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if n.is_empty() || n.chars().count() > 100 {
        Err(format!("Give the {what} a name of 1 to 100 characters."))
    } else {
        Ok(n)
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaView {
    pub title: Vec<String>,
    pub caption: Vec<String>,
    pub creator: Vec<String>,
    pub copyright: Vec<String>,
    pub credit: Vec<String>,
    pub source: Vec<String>,
    pub sublocation: Vec<String>,
    pub city: Vec<String>,
    pub state: Vec<String>,
    pub country: Vec<String>,
    pub headline: Vec<String>,
    pub job_title: Vec<String>,
    pub instructions: Vec<String>,
    pub job_id: Vec<String>,
    pub usage_terms: Vec<String>,
}

#[derive(Debug, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct MetaPatch {
    pub title: Option<String>,
    pub caption: Option<String>,
    pub creator: Option<String>,
    pub copyright: Option<String>,
    pub credit: Option<String>,
    pub source: Option<String>,
    pub sublocation: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub country: Option<String>,
    pub headline: Option<String>,
    pub job_title: Option<String>,
    pub instructions: Option<String>,
    pub job_id: Option<String>,
    pub usage_terms: Option<String>,
}

/// The names of the details a photo carries, in the order they are shown.
pub const DETAIL_NAMES: [&str; 15] = ["title", "caption", "creator", "copyright", "credit", "source", "sublocation", "city", "state", "country", "headline", "job_title", "instructions", "job_id", "usage_terms"];

impl MetaPatch {
    /// A patch that sets only the detail with this name.
    pub fn only(name: &str, value: String) -> MetaPatch {
        let mut p = MetaPatch::default();
        let v = Some(value);
        match name {
            "title" => p.title = v,
            "caption" => p.caption = v,
            "creator" => p.creator = v,
            "copyright" => p.copyright = v,
            "credit" => p.credit = v,
            "source" => p.source = v,
            "sublocation" => p.sublocation = v,
            "city" => p.city = v,
            "state" => p.state = v,
            "country" => p.country = v,
            "headline" => p.headline = v,
            "job_title" => p.job_title = v,
            "instructions" => p.instructions = v,
            "job_id" => p.job_id = v,
            "usage_terms" => p.usage_terms = v,
            _ => {}
        }
        p
    }
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub added: Vec<(i64, String)>, // (photo id, absolute path), for the preview worker
    pub duplicates: usize,
    pub failed: Vec<String>,
    /// Photos that were moved: copied and checked, but the original could not be removed (it is still where it was).
    pub left_behind: Vec<String>,
}

/// How copied and moved photos are named and filed. Photos left in place are not renamed or moved.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ImportOpts {
    /// {name}, {date}, {seq} and {camera}, as in an export.
    pub name_template: String,
    /// How the folders under the destination are made from the day the photo was taken: "YYYY-MM-DD", "YYYY/MM/DD", "YYYY/YYYY-MM-DD",
    /// "YYYY-MM", "YYYY" or "flat" (no sub-folders).
    pub folder_format: String,
    /// Also skip a photo that is probably one already in the catalog: the same file name, taken at the same moment, by the same camera
    /// (a copy that was saved again, so its bytes differ). Photos without a capture time are never skipped this way.
    pub skip_suspected: bool,
    /// The number {seq} starts at (1 by default), for continuing a numbering from an earlier import.
    pub seq_start: u32,
    /// With \"copy_dng\": also pack the original RAW file inside each DNG.
    pub embed_original: bool,
}

impl Default for ImportOpts {
    fn default() -> Self {
        ImportOpts { name_template: "{name}".into(), folder_format: "YYYY-MM-DD".into(), skip_suspected: false, seq_start: 1, embed_original: false }
    }
}

/// The folder (under the destination) for a photo taken on `day` ("2026-10-19", or "undated"). Anything unknown is the plain day folder.
pub fn folder_for(format: &str, day: &str) -> String {
    let parts: Vec<&str> = day.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 {
        return if format == "flat" { String::new() } else { "undated".into() };
    }
    let (y, m, d) = (parts[0], parts[1], parts[2]);
    match format {
        "YYYY/MM/DD" => format!("{y}/{m}/{d}"),
        "YYYY/YYYY-MM-DD" => format!("{y}/{y}-{m}-{d}"),
        "YYYY-MM" => format!("{y}-{m}"),
        "YYYY" => y.to_string(),
        "flat" => String::new(),
        _ => day.to_string(),
    }
}

const LABELS: &[&str] = &["red", "yellow", "green", "blue", "purple"];

fn path_str(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

impl Catalog {
    pub fn open(root: &Path) -> Result<Catalog, String> {
        fs::create_dir_all(root.join("previews")).map_err(|e| e.to_string())?;
        let conn = Connection::open(root.join("catalog.db")).map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(|e| e.to_string())?;
        let has: i64 = conn
            .query_row("select count(*) from sqlite_master where name = 'catalog_meta'", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if has == 0 {
            conn.execute_batch(SCHEMA).map_err(|e| format!("schema: {e}"))?;
            conn.execute(
                "insert into catalog_meta(key, value) values ('schema_version', ?1), ('catalog_uuid', ?2)",
                params![SCHEMA_VERSION, uuid::Uuid::new_v4().to_string()],
            )
            .map_err(|e| e.to_string())?;
        } else {
            // a catalog made by an older layout is copied first, so an upgrade can never be the end of someone's work
            let stored: i64 = conn.query_row("select value from catalog_meta where key = 'schema_version'", [], |r| r.get::<_, String>(0)).ok().and_then(|v| v.parse().ok()).unwrap_or(1);
            let current: i64 = SCHEMA_VERSION.parse().unwrap_or(1);
            if stored < current {
                crate::backups::write(root, "before-upgrade").map_err(|e| format!("The catalog was not changed, because a copy could not be made first. {e}"))?;
                conn.execute("update catalog_meta set value = ?1 where key = 'schema_version'", [SCHEMA_VERSION]).map_err(|e| e.to_string())?;
            }
        }
        // details added after the first layout: one column each, added when the catalog does not have them yet
        for col in ["headline", "job_title", "instructions", "job_id", "usage_terms"] {
            let has: i64 = conn.query_row("select count(*) from pragma_table_info('iptc') where name = ?1", [col], |r| r.get(0)).map_err(|e| e.to_string())?;
            if has == 0 {
                conn.execute(&format!("alter table iptc add column {col} text"), []).map_err(|e| format!("iptc {col}: {e}"))?;
            }
        }
        conn.execute_batch("create table if not exists book(id integer primary key, name text not null, json text not null, updated integer not null default 0);")
            .map_err(|e| format!("book table: {e}"))?;
        conn.execute(
            "insert into collection(name, kind) select 'Quick Collection', 'quick'
             where not exists (select 1 from collection where kind = 'quick')",
            [],
        )
        .map_err(|e| e.to_string())?;
        Ok(Catalog { conn, root: root.to_path_buf() })
    }

    pub fn previews_dir(&self) -> PathBuf {
        self.root.join("previews")
    }

    pub fn list_files(source: &Path) -> Vec<PathBuf> {
        Self::list_files_in(source, true)
    }

    /// The supported photos in a folder, and with `subfolders` also those in every folder inside it.
    pub fn list_files_in(source: &Path, subfolders: bool) -> Vec<PathBuf> {
        let mut walk = WalkDir::new(source).follow_links(false);
        if !subfolders {
            walk = walk.max_depth(1);
        }
        let mut v: Vec<PathBuf> = walk
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file() && media::kind_of(e.path()).is_some())
            .map(|e| e.into_path())
            .collect();
        v.sort();
        v
    }

    /// The files to import when the person chose some: each must really be inside `source`, be a supported photo and
    /// be listed once. Anything else is ignored. In the order of the folder listing.
    pub fn pick_files(source: &Path, requested: &[String]) -> Vec<PathBuf> {
        let Ok(root) = fs::canonicalize(source) else { return Vec::new() };
        let wanted: std::collections::HashSet<PathBuf> = requested.iter().filter_map(|r| fs::canonicalize(r).ok()).filter(|p| p.starts_with(&root) && p.is_file()).collect();
        Self::list_files(source).into_iter().filter(|f| fs::canonicalize(f).map(|c| wanted.contains(&c)).unwrap_or(false)).collect()
    }

    fn folder_id(&self, root_abs: &str, root_name: &str, rel: &str) -> Result<i64, String> {
        let root_id: i64 = match self
            .conn
            .query_row("select id from root_folder where absolute_path = ?1", [root_abs], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?
        {
            Some(id) => id,
            None => {
                self.conn
                    .execute("insert into root_folder(absolute_path, name) values (?1, ?2)", params![root_abs, root_name])
                    .map_err(|e| e.to_string())?;
                self.conn.last_insert_rowid()
            }
        };
        if let Some(id) = self
            .conn
            .query_row(
                "select id from folder where root_folder_id = ?1 and rel_path = ?2",
                params![root_id, rel],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(id);
        }
        self.conn
            .execute("insert into folder(root_folder_id, rel_path) values (?1, ?2)", params![root_id, rel])
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Phase one of an import: read metadata, copy if asked, insert rows. Fast. Previews come after.
    pub fn import_files(&mut self, files: &[PathBuf], source: &Path, mode: &str, dest: Option<&Path>, progress: impl FnMut(usize, usize)) -> Result<ImportSummary, String> {
        self.import_files_with(files, source, mode, dest, &ImportOpts::default(), progress)
    }

    /// The same, with the naming and filing of copied and moved photos chosen. `mode` is "add" (leave in place), "copy" or "move" (copy,
    /// check the copy against the original, and only then remove the original).
    pub fn import_files_with(
        &mut self,
        files: &[PathBuf],
        source: &Path,
        mode: &str,
        dest: Option<&Path>,
        opts: &ImportOpts,
        mut progress: impl FnMut(usize, usize),
    ) -> Result<ImportSummary, String> {
        let copying = mode == "copy" || mode == "move" || mode == "copy_dng";
        if copying && dest.is_none() {
            return Err(format!("Choose a destination folder to {mode} into."));
        }
        if copying && dest.map(|d| source.starts_with(d) || d.starts_with(source)).unwrap_or(false) {
            return Err("The destination cannot be the folder you are importing from, or one inside it (or the other way round).".into());
        }
        let mut out = ImportSummary::default();
        self.conn
            .execute(
                "insert into import_session(started_at, source, mode) values (strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?1, ?2)",
                params![path_str(source), match mode { "copy" => "copy", "move" => "move", "copy_dng" => "copy_dng", _ => "add" }],
            )
            .map_err(|e| e.to_string())?;
        let import_id = self.conn.last_insert_rowid();
        let total = files.len();

        for (i, src) in files.iter().enumerate() {
            progress(i, total);
            let res: Result<Option<(i64, PathBuf)>, String> = (|| {
                let hash = {
                    let mut f = fs::File::open(src).map_err(|e| format!("{}: {e}", src.display()))?;
                    blake3::Hasher::new().update_reader(&mut f).map_err(|e| e.to_string())?.finalize().to_hex().to_string()
                };
                let dup: Option<i64> = self
                    .conn
                    .query_row("select id from photo where file_hash = ?1", [&hash], |r| r.get(0))
                    .optional()
                    .map_err(|e| e.to_string())?;
                if dup.is_some() {
                    return Ok(None);
                }
                let meta = media::read_meta(src);
                if opts.skip_suspected {
                    if let Some(when) = &meta.captured_local {
                        let name = src.file_stem().and_then(|e| e.to_str()).unwrap_or("");
                        let likely: Option<i64> = self
                            .conn
                            .query_row(
                                "select p.id from photo p left join exif e on e.photo_id = p.id
                                 where p.captured_local = ?1 and lower(p.base_name) = lower(?2) and coalesce(e.model, '') = coalesce(?3, '') limit 1",
                                params![when, name, meta.model],
                                |r| r.get(0),
                            )
                            .optional()
                            .map_err(|e| e.to_string())?;
                        if likely.is_some() {
                            return Ok(None);
                        }
                    }
                }
                let md = fs::metadata(src).map_err(|e| e.to_string())?;
                let mtime: String = md
                    .modified()
                    .ok()
                    .map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%dT%H:%M:%SZ").to_string())
                    .unwrap_or_default();
                let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();
                let stem = src.file_stem().and_then(|e| e.to_str()).unwrap_or("photo").to_string();

                let (final_path, root_abs, rel) = if copying {
                    let dest = dest.unwrap();
                    let day = meta
                        .captured_local
                        .as_ref()
                        .map(|c| c[0..10].to_string())
                        .unwrap_or_else(|| if mtime.len() >= 10 { mtime[0..10].to_string() } else { "undated".into() });
                    let rel = folder_for(&opts.folder_format, &day);
                    let dir = if rel.is_empty() { dest.to_path_buf() } else { dest.join(&rel) };
                    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let name = crate::export::expand_name(&opts.name_template, src, &meta, i + opts.seq_start.max(1) as usize);
                    // RAW photos become DNG files when asked (the rest are copied as they are)
                    let as_dng = mode == "copy_dng" && media::kind_of(src) == Some(media::Kind::Raw) && !ext.eq_ignore_ascii_case("dng");
                    let target = media::unique_path(&dir, &name, if as_dng { "dng" } else { &ext });
                    if as_dng {
                        crate::dngout::convert(src, &target, opts.embed_original)?;
                    } else {
                        fs::copy(src, &target).map_err(|e| format!("copy {}: {e}", src.display()))?;
                    }
                    (target, path_str(dest), rel)
                } else {
                    let rel = src
                        .parent()
                        .and_then(|p| p.strip_prefix(source).ok())
                        .map(path_str)
                        .unwrap_or_default();
                    (src.clone(), path_str(source), rel)
                };
                let root_name = Path::new(&root_abs).file_name().and_then(|n| n.to_str()).unwrap_or(&root_abs).to_string();
                let folder_id = self.folder_id(&root_abs, &root_name, &rel)?;
                let base = final_path.file_stem().and_then(|e| e.to_str()).unwrap_or(&stem).to_string();
                // what was written (a DNG is not the size or the kind of file it came from)
                let ext = final_path.extension().and_then(|e| e.to_str()).unwrap_or(&ext).to_string();
                let md = fs::metadata(&final_path).unwrap_or(md);
                self.conn
                    .execute(
                        "insert into photo(uuid, folder_id, base_name, ext, format, file_size, file_mtime, file_hash,
                                           captured_local, width, height, orientation, import_id)
                         values (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                        params![
                            uuid::Uuid::new_v4().to_string(),
                            folder_id,
                            base,
                            ext,
                            media::format_name(&final_path),
                            md.len() as i64,
                            mtime,
                            hash,
                            meta.captured_local,
                            meta.width,
                            meta.height,
                            meta.orientation,
                            import_id
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                let id = self.conn.last_insert_rowid();
                self.conn
                    .execute(
                        "insert into exif(photo_id, make, model, lens, iso, aperture, shutter_s, focal_mm)
                         values (?1,?2,?3,?4,?5,?6,?7,?8)",
                        params![id, meta.make, meta.model, meta.lens, meta.iso, meta.aperture, meta.shutter_s, meta.focal_mm],
                    )
                    .map_err(|e| e.to_string())?;
                if mode == "move" {
                    // the copy is read back and compared before the original is touched
                    let same = fs::File::open(&final_path)
                        .and_then(|mut f| blake3::Hasher::new().update_reader(&mut f).map(|h| h.finalize().to_hex().to_string()))
                        .map(|h| h == hash)
                        .unwrap_or(false);
                    if !same {
                        return Err(format!("{}: the copy did not match the original, so the original was kept", src.display()));
                    }
                    if let Err(e) = fs::remove_file(src) {
                        out.left_behind.push(format!("{}: {e}", src.display()));
                    }
                }
                Ok(Some((id, final_path)))
            })();
            match res {
                Ok(Some((id, p))) => out.added.push((id, path_str(&p))),
                Ok(None) => out.duplicates += 1,
                Err(e) => out.failed.push(e),
            }
        }
        self.conn
            .execute("update import_session set finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), photo_count = ?1 where id = ?2", params![out.added.len() as i64, import_id])
            .map_err(|e| e.to_string())?;
        progress(total, total);
        Ok(out)
    }

    /// WHERE clause and bound values for a query. Every value is bound, never spliced into the SQL.
    fn build_where(&self, q: &Query) -> (String, Vec<Value>) {
        let mut wh: Vec<String> = vec!["1=1".into()];
        let mut args: Vec<Value> = vec![];
        if let Some(r) = q.min_rating {
            wh.push("p.rating >= ?".into());
            args.push(Value::Integer(r.clamp(0, 5)));
        }
        match q.flag.as_deref() {
            Some("pick") => wh.push("p.flag = 1".into()),
            Some("reject") => wh.push("p.flag = -1".into()),
            Some("unflagged") => wh.push("p.flag = 0".into()),
            _ => {}
        }
        if let Some(l) = &q.label {
            if LABELS.contains(&l.as_str()) {
                wh.push("p.color_label = ?".into());
                args.push(Value::Text(l.clone()));
            }
        }
        match q.edited.as_deref() {
            Some("yes") => wh.push("exists(select 1 from develop_settings d where d.photo_id = p.id)".into()),
            Some("no") => wh.push("not exists(select 1 from develop_settings d where d.photo_id = p.id)".into()),
            _ => {}
        }
        match q.copies.as_deref() {
            Some("no") => wh.push("p.master_id is null".into()),
            Some("only") => wh.push("p.master_id is not null".into()),
            _ => {}
        }
        if q.stacks.as_deref() != Some("all") {
            // a closed stack shows only its top photo
            wh.push("(p.stack_id is null or p.stack_pos = 0 or not exists(select 1 from stack s where s.id = p.stack_id and s.collapsed = 1))".into());
        }
        if let Some(f) = q.folder_id {
            wh.push("p.folder_id = ?".into());
            args.push(Value::Integer(f));
        }
        if let Some(c) = q.collection_id {
            if let Some(rules) = self.smart_rules_of(c) {
                // a smart collection: whatever meets its rules now
                let (sql, a) = rules.to_sql(CAMERA_SQL, DAY_SQL);
                wh.push(sql);
                args.extend(a);
            } else {
                wh.push("p.id in (select photo_id from collection_photo where collection_id = ?)".into());
                args.push(Value::Integer(c));
            }
        }
        if let Some(k) = q.keyword_id {
            // the keyword and everything below it
            wh.push(
                "p.id in (select photo_id from photo_keyword where keyword_id in (
                    with recursive sub(id) as (
                        select id from keyword where id = ?
                        union all
                        select k.id from keyword k join sub on k.parent_id = sub.id
                    ) select id from sub))"
                    .into(),
            );
            args.push(Value::Integer(k));
        }
        if let Some(t) = q.text.as_ref().filter(|t| !t.trim().is_empty()) {
            wh.push("(p.base_name like ? escape '\\' or e.model like ? escape '\\' or e.lens like ? escape '\\')".into());
            let like = format!("%{}%", t.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
            for _ in 0..3 {
                args.push(Value::Text(like.clone()));
            }
        }
        if let Some(c) = q.camera.as_ref().filter(|c| !c.is_empty()) {
            wh.push(format!("{CAMERA_SQL} = ?"));
            args.push(Value::Text(c.clone()));
        }
        if let Some(l) = q.lens.as_ref().filter(|l| !l.is_empty()) {
            wh.push("e.lens = ?".into());
            args.push(Value::Text(l.clone()));
        }
        let mut range = |column: &str, lo: Option<f64>, hi: Option<f64>, slack: f64| {
            if let Some(v) = lo.filter(|v| v.is_finite()) {
                wh.push(format!("{column} >= ?"));
                args.push(Value::Real(v - slack));
            }
            if let Some(v) = hi.filter(|v| v.is_finite()) {
                wh.push(format!("{column} <= ?"));
                args.push(Value::Real(v + slack));
            }
        };
        range("e.iso", q.min_iso.map(|v| v as f64), q.max_iso.map(|v| v as f64), 0.0);
        range("e.focal_mm", q.min_focal, q.max_focal, 0.0005);
        range("e.aperture", q.min_aperture, q.max_aperture, 0.0005);
        if let Some(d) = q.date_from.as_ref().filter(|d| is_day(d)) {
            wh.push(format!("{DAY_SQL} >= ?"));
            args.push(Value::Text(d.clone()));
        }
        if let Some(d) = q.date_to.as_ref().filter(|d| is_day(d)) {
            wh.push(format!("{DAY_SQL} <= ?"));
            args.push(Value::Text(d.clone()));
        }
        (wh.join(" and "), args)
    }

    /// The cameras, lenses and ranges in the catalog, for the Metadata filter.
    pub fn metadata_values(&self) -> Result<MetadataValues, String> {
        let counted = |sql: String| -> Result<Vec<Counted>, String> {
            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| Ok(Counted { name: r.get(0)?, count: r.get(1)? })).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            Ok(rows)
        };
        let cameras = counted(format!("select {CAMERA_SQL} as c, count(*) from exif e where c is not null and c <> '' group by c order by lower(c)"))?;
        let lenses = counted("select e.lens as l, count(*) from exif e where l is not null and l <> '' group by l order by lower(l)".into())?;
        let pair_i = |col: &str| -> Result<Option<(i64, i64)>, String> {
            self.conn.query_row(&format!("select min({col}), max({col}) from exif where {col} is not null"), [], |r| Ok(r.get::<_, Option<i64>>(0)?.zip(r.get::<_, Option<i64>>(1)?))).map_err(|e| e.to_string())
        };
        let pair_f = |col: &str| -> Result<Option<(f64, f64)>, String> {
            self.conn.query_row(&format!("select min({col}), max({col}) from exif where {col} is not null and {col} > 0"), [], |r| Ok(r.get::<_, Option<f64>>(0)?.zip(r.get::<_, Option<f64>>(1)?))).map_err(|e| e.to_string())
        };
        let days = self
            .conn
            .query_row(&format!("select min({DAY_SQL}), max({DAY_SQL}) from photo p"), [], |r| Ok(r.get::<_, Option<String>>(0)?.zip(r.get::<_, Option<String>>(1)?)))
            .map_err(|e| e.to_string())?;
        Ok(MetadataValues { cameras, lenses, iso: pair_i("iso")?, focal: pair_f("focal_mm")?, aperture: pair_f("aperture")?, days })
    }

    pub fn query(&self, q: &Query) -> Result<Page, String> {
        let (whs, args) = self.build_where(q);
        let order = match q.sort.as_str() {
            "name" => "p.base_name collate nocase",
            "rating" => "p.rating",
            _ => "coalesce(p.captured_local, p.file_mtime)",
        };
        let dir = if q.desc { "desc" } else { "asc" };
        let from = "from photo p join folder f on f.id = p.folder_id join root_folder r on r.id = f.root_folder_id
                    left join exif e on e.photo_id = p.id";
        let total: i64 = self
            .conn
            .query_row(&format!("select count(*) {from} where {whs}"), params_from_iter(args.iter()), |r| r.get(0))
            .map_err(|e| e.to_string())?;

        let sql = format!(
            "select p.id, p.base_name, p.ext, r.absolute_path, f.rel_path, p.format, p.rating, p.flag, p.color_label,
                    p.captured_local, p.width, p.height, p.missing, e.make, e.model, e.lens, e.iso, e.aperture,
                    e.shutter_s, e.focal_mm, exists(select 1 from develop_settings d where d.photo_id = p.id), p.copy_name, p.master_id,
                    p.stack_id, coalesce(p.stack_pos, 0), (select count(*) from photo o where o.stack_id = p.stack_id),
                    coalesce((select s.collapsed from stack s where s.id = p.stack_id), 0)
             {from} where {whs} order by {order} {dir}, p.id {dir} limit ? offset ?"
        );
        let mut args2 = args.clone();
        args2.push(Value::Integer(q.limit.clamp(1, 2000)));
        args2.push(Value::Integer(q.offset.max(0)));
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(args2.iter()), |r| {
                let name: String = r.get(1)?;
                let ext: String = r.get(2)?;
                let root: String = r.get(3)?;
                let rel: String = r.get(4)?;
                let format: String = r.get(5)?;
                let make: Option<String> = r.get(13)?;
                let model: Option<String> = r.get(14)?;
                let camera = match (make, model) {
                    (Some(a), Some(b)) if b.starts_with(&a) => Some(b),
                    (Some(a), Some(b)) => Some(format!("{a} {b}")),
                    (None, Some(b)) => Some(b),
                    (Some(a), None) => Some(a),
                    _ => None,
                };
                let dir_path = if rel.is_empty() { root.clone() } else { format!("{root}/{rel}") };
                Ok(PhotoRow {
                    id: r.get(0)?,
                    path: format!("{dir_path}/{name}.{ext}"),
                    name: format!("{name}.{ext}"),
                    folder: if rel.is_empty() { Path::new(&root).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string() } else { rel },
                    previewable: true,
                    edited: r.get::<_, i64>(20)? != 0,
                    format,
                    rating: r.get(6)?,
                    flag: r.get(7)?,
                    label: r.get(8)?,
                    captured: r.get(9)?,
                    width: r.get(10)?,
                    height: r.get(11)?,
                    missing: r.get::<_, i64>(12)? != 0,
                    camera,
                    lens: r.get(15)?,
                    iso: r.get(16)?,
                    aperture: r.get(17)?,
                    shutter_s: r.get(18)?,
                    focal_mm: r.get(19)?,
                    copy_name: r.get(21)?,
                    master_id: r.get(22)?,
                    stack_id: r.get(23)?,
                    stack_pos: r.get(24)?,
                    stack_count: r.get(25)?,
                    stack_collapsed: r.get::<_, i64>(26)? != 0,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(Page { total, rows })
    }

    pub fn folders(&self) -> Result<Vec<FolderRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "select f.id, r.name, f.rel_path, count(p.id), r.absolute_path from folder f
                 join root_folder r on r.id = f.root_folder_id left join photo p on p.folder_id = f.id
                 group by f.id order by r.name collate nocase, f.rel_path collate nocase",
            )
            .map_err(|e| e.to_string())?;
        let v = stmt
            .query_map([], |r| Ok(FolderRow { id: r.get(0)?, root: r.get(1)?, root_path: r.get(4)?, rel_path: r.get(2)?, count: r.get(3)? }))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(v)
    }

    /// The same, for the commands outside this file.
    pub fn folder_parts_public(&self, id: i64) -> Result<(i64, String, String), String> {
        self.folder_parts(id)
    }

    /// The ISO a photo was taken at, when it is known.
    pub fn photo_iso(&self, id: i64) -> Result<Option<i64>, String> {
        Ok(self.conn.query_row("select iso from exif where photo_id = ?1", [id], |r| r.get::<_, Option<i64>>(0)).optional().map_err(|e| e.to_string())?.flatten())
    }

    /// The folder on the disk that a photo's place in the catalog starts from (its root).
    pub fn photo_root(&self, id: i64) -> Result<PathBuf, String> {
        self.conn
            .query_row("select r.absolute_path from photo p join folder f on f.id = p.folder_id join root_folder r on r.id = f.root_folder_id where p.id = ?1", [id], |r| r.get::<_, String>(0))
            .map(PathBuf::from)
            .map_err(|_| "That photo is no longer in the catalog.".to_string())
    }

    /// (root id, root path on the disk, the folder's path under the root) of a folder of the catalog.
    fn folder_parts(&self, id: i64) -> Result<(i64, String, String), String> {
        self.conn
            .query_row(
                "select f.root_folder_id, r.absolute_path, f.rel_path from folder f join root_folder r on r.id = f.root_folder_id where f.id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .map_err(|_| "That folder is not in the catalog.".to_string())
    }

    /// A folder name as typed: trimmed, and refused when Windows would not accept it.
    pub fn clean_folder_name(name: &str) -> Result<String, String> {
        let n = name.trim();
        if n.is_empty() || n == "." || n == ".." || n.ends_with('.') || n.chars().any(|c| c.is_control() || "\\/:*?\"<>|".contains(c)) {
            return Err("A folder name cannot be empty, end with a dot, or contain any of \\ / : * ? \" < > |".into());
        }
        Ok(n.to_string())
    }

    /// Move the folder at `old_rel` (and every folder inside it) to `new_rel`, on the disk and in the catalog, as one step: if the catalog
    /// cannot be updated the folder is put back where it was. Photos are found through their folder, so none of them needs touching.
    fn retarget_folder(&mut self, root_id: i64, root_abs: &str, old_rel: &str, new_rel: &str) -> Result<(), String> {
        let old = Path::new(root_abs).join(old_rel);
        let new = Path::new(root_abs).join(new_rel);
        if !old.is_dir() {
            return Err("The folder is not on the disk. Use Find missing photos first.".into());
        }
        if new.exists() {
            return Err(format!("There is already something called \"{new_rel}\" there."));
        }
        if !new.parent().map(|p| p.is_dir()).unwrap_or(false) {
            return Err("The place to put the folder is not there.".into());
        }
        let all: Vec<(i64, String)> = {
            let mut stmt = self.conn.prepare("select id, rel_path from folder where root_folder_id = ?1").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([root_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            rows
        };
        let inside = |rel: &str| rel == old_rel || rel.starts_with(&format!("{old_rel}/"));
        let moving: Vec<(i64, String)> = all.iter().filter(|(_, r)| inside(r)).map(|(id, r)| (*id, format!("{new_rel}{}", &r[old_rel.len()..]))).collect();
        if let Some((_, clash)) = moving.iter().find(|(id, nr)| all.iter().any(|(oid, orel)| orel == nr && oid != id)) {
            return Err(format!("The catalog already has a folder called \"{clash}\"."));
        }
        fs::rename(&old, &new).map_err(|e| format!("The folder could not be moved: {e}"))?;
        let done = (|| -> Result<(), String> {
            let tx = self.conn.transaction().map_err(|e| e.to_string())?;
            for (id, rel) in &moving {
                tx.execute("update folder set rel_path = ?1 where id = ?2", params![rel, id]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())
        })();
        if let Err(e) = done {
            let _ = fs::rename(&new, &old); // put it back: the catalog still says it is there
            return Err(format!("The catalog could not be updated, so the folder was left where it was: {e}"));
        }
        Ok(())
    }

    /// Give a folder another name, on the disk and in the catalog. A folder that is the top of an imported place is renamed where it is,
    /// and the catalog follows it.
    pub fn rename_folder(&mut self, folder_id: i64, new_name: &str) -> Result<(), String> {
        let name = Self::clean_folder_name(new_name)?;
        let (root_id, root_abs, rel) = self.folder_parts(folder_id)?;
        if rel.is_empty() {
            let old = PathBuf::from(&root_abs);
            let Some(parent) = old.parent() else { return Err("That place has no folder above it to rename in.".into()) };
            let new = parent.join(&name);
            if !old.is_dir() {
                return Err("The folder is not on the disk. Use Find missing photos first.".into());
            }
            if new.exists() {
                return Err(format!("There is already something called \"{name}\" there."));
            }
            fs::rename(&old, &new).map_err(|e| format!("The folder could not be renamed: {e}"))?;
            let new_abs = path_str(&new);
            if let Err(e) = self.conn.execute("update root_folder set absolute_path = ?1, name = ?2 where id = ?3", params![new_abs, name, root_id]) {
                let _ = fs::rename(&new, &old);
                return Err(format!("The catalog could not be updated, so the folder was left as it was: {e}"));
            }
            return Ok(());
        }
        let parent = rel.rsplit_once('/').map(|(p, _)| p.to_string()).unwrap_or_default();
        let new_rel = if parent.is_empty() { name } else { format!("{parent}/{name}") };
        if new_rel == rel {
            return Ok(());
        }
        self.retarget_folder(root_id, &root_abs, &rel, &new_rel)
    }

    /// Move a folder (with the folders inside it) into another folder of the same imported place, or to the top of that place when `dest` is None.
    pub fn move_folder(&mut self, folder_id: i64, dest: Option<i64>) -> Result<(), String> {
        let (root_id, root_abs, rel) = self.folder_parts(folder_id)?;
        if rel.is_empty() {
            return Err("The top of an imported place cannot be moved from here.".into());
        }
        let dest_rel = match dest {
            None => String::new(),
            Some(d) => {
                let (droot, _, drel) = self.folder_parts(d)?;
                if droot != root_id {
                    return Err("A folder can only be moved inside the place it came from.".into());
                }
                drel
            }
        };
        if dest_rel == rel || dest_rel.starts_with(&format!("{rel}/")) {
            return Err("A folder cannot be moved into itself.".into());
        }
        let leaf = rel.rsplit('/').next().unwrap_or(&rel).to_string();
        let new_rel = if dest_rel.is_empty() { leaf } else { format!("{dest_rel}/{leaf}") };
        if new_rel == rel {
            return Ok(());
        }
        self.retarget_folder(root_id, &root_abs, &rel, &new_rel)
    }

    /// What this catalog holds and takes up, for the catalog's own page in Preferences.
    pub fn details(&self) -> Result<CatalogDetails, String> {
        let n = |sql: &str| -> Result<i64, String> { self.conn.query_row(sql, [], |r| r.get(0)).map_err(|e| e.to_string()) };
        let file = |name: &str| fs::metadata(self.root.join(name)).map(|m| m.len()).unwrap_or(0);
        let previews: u64 = fs::read_dir(self.previews_dir()).map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).map(|m| m.len()).sum()).unwrap_or(0);
        let meta = |key: &str| -> Option<String> { self.conn.query_row("select value from catalog_meta where key = ?1", [key], |r| r.get(0)).optional().ok().flatten() };
        Ok(CatalogDetails {
            photos: n("select count(*) from photo where master_id is null")?,
            virtual_copies: n("select count(*) from photo where master_id is not null")?,
            folders: n("select count(*) from folder")?,
            collections: n("select count(*) from collection where kind in ('collection', 'smart', 'set')")?,
            keywords: n("select count(*) from keyword")?,
            edited: n("select count(*) from develop_settings")?,
            catalog_bytes: file("catalog.db") + file("catalog.db-wal"),
            previews_bytes: previews,
            created: meta("created_at"),
            schema_version: meta("schema_version").unwrap_or_default(),
        })
    }

    /// Mark these photos as missing (their files were not found).
    pub fn mark_missing(&self, ids: &[i64]) -> Result<(), String> {
        for id in ids {
            self.conn.execute("update photo set missing = 1 where id = ?1 or master_id = ?1", [id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// What synchronising a folder would do: the supported files on the disk (in the folder and the folders inside it) that the catalog does not
    /// have, and the catalog's photos there whose files are gone. Nothing is changed.
    pub fn sync_preview(&self, folder_id: i64) -> Result<SyncPreview, String> {
        let (root_id, root_abs, rel) = self.folder_parts(folder_id)?;
        let dir = if rel.is_empty() { PathBuf::from(&root_abs) } else { Path::new(&root_abs).join(&rel) };
        if !dir.is_dir() {
            return Err("The folder is not on the disk. Use Find missing photos first.".into());
        }
        // what the catalog has under it, by where each file is
        let have: Vec<(i64, String, String)> = {
            let mut st = self
                .conn
                .prepare(
                    "select p.id, f.rel_path, p.base_name || '.' || p.ext from photo p join folder f on f.id = p.folder_id
                     where f.root_folder_id = ?1 and p.master_id is null and (f.rel_path = ?2 or f.rel_path like ?3 escape '\\')",
                )
                .map_err(|e| e.to_string())?;
            // every folder inside it; for the top of a place, every folder of the place
            let like = if rel.is_empty() { "%".to_string() } else { format!("{}/%", rel.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")) };
            let rows = st.query_map(params![root_id, rel, like], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let path_of = |rel: &str, name: &str| -> String { path_str(&Path::new(&root_abs).join(rel).join(name)).to_lowercase() };
        let known: std::collections::HashSet<String> = have.iter().map(|(_, r, n)| path_of(r, n)).collect();
        let on_disk = Self::list_files(&dir);
        let on_disk_set: std::collections::HashSet<String> = on_disk.iter().map(|p| path_str(p).to_lowercase()).collect();
        let new_files: Vec<String> = on_disk.iter().filter(|p| !known.contains(&path_str(p).to_lowercase())).map(|p| path_str(p)).collect();
        let gone: Vec<(i64, String)> = have.iter().filter(|(_, r, n)| !on_disk_set.contains(&path_of(r, n))).map(|(id, _, n)| (*id, n.clone())).collect();
        Ok(SyncPreview { new_files, gone: gone.into_iter().map(|(id, name)| SyncGone { id, name }).collect(), present: have.len() })
    }

    pub fn count(&self) -> Result<i64, String> {
        self.conn.query_row("select count(*) from photo", [], |r| r.get(0)).map_err(|e| e.to_string())
    }

    pub fn set_rating(&mut self, ids: &[i64], rating: i64) -> Result<(), String> {
        if !(0..=5).contains(&rating) {
            return Err("Rating must be 0 to 5.".into());
        }
        self.update_each(ids, "update photo set rating = ?1, metadata_dirty = 1 where id = ?2", Value::Integer(rating))
    }

    pub fn set_flag(&mut self, ids: &[i64], flag: i64) -> Result<(), String> {
        if !(-1..=1).contains(&flag) {
            return Err("Flag must be -1, 0 or 1.".into());
        }
        self.update_each(ids, "update photo set flag = ?1, metadata_dirty = 1 where id = ?2", Value::Integer(flag))
    }

    pub fn set_label(&mut self, ids: &[i64], label: Option<&str>) -> Result<(), String> {
        let v = match label {
            Some(l) if LABELS.contains(&l) => Value::Text(l.to_string()),
            Some(_) => return Err("Unknown colour label.".into()),
            None => Value::Null,
        };
        self.update_each(ids, "update photo set color_label = ?1, metadata_dirty = 1 where id = ?2", v)
    }

    fn update_each(&mut self, ids: &[i64], sql: &str, v: Value) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        {
            let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
            for id in ids {
                stmt.execute(params![v, id]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    // ---- select all, remove -------------------------------------------------

    /// Every id in a query result (for "select all"), capped so a huge catalog cannot exhaust memory.
    pub fn photo_ids(&self, q: &Query) -> Result<Vec<i64>, String> {
        let (whs, args) = self.build_where(q);
        let sql = format!(
            "select p.id from photo p join folder f on f.id = p.folder_id
             join root_folder r on r.id = f.root_folder_id left join exif e on e.photo_id = p.id
             where {whs} order by p.id limit 200000"
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let ids = stmt
            .query_map(params_from_iter(args.iter()), |r| r.get::<_, i64>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(ids)
    }

    /// Remove photos from the catalog. The files on disk are never touched; only our own preview copies go.
    pub fn photo_remove(&mut self, ids: &[i64]) -> Result<usize, String> {
        let mut removed = 0;
        // a photo's virtual copies go with it (they have no file of their own), and so do their previews
        let mut gone: Vec<i64> = ids.to_vec();
        for id in ids {
            let mut st = self.conn.prepare("select id from photo where master_id = ?1").map_err(|e| e.to_string())?;
            let copies = st.query_map([id], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            gone.extend(copies);
        }
        {
            let tx = self.conn.transaction().map_err(|e| e.to_string())?;
            for id in ids {
                removed += tx.execute("delete from photo where master_id = ?1", [id]).map_err(|e| e.to_string())?;
                removed += tx.execute("delete from photo where id = ?1", [id]).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }
        for id in &gone {
            for level in media::PREVIEW_LEVELS {
                let _ = fs::remove_file(media::preview_path(&self.previews_dir(), *id, level));
            }
            let _ = fs::remove_file(media::smart_path(&self.previews_dir(), *id));
        }
        self.stack_tidy()?;
        Ok(removed)
    }

    /// After photos have left, close up every stack: the places are numbered from 0 again (so a top photo always exists), and a stack with
    /// fewer than two photos ends.
    fn stack_tidy(&mut self) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let stacks = {
            let mut st = tx.prepare("select id from stack").map_err(|e| e.to_string())?;
            let v = st.query_map([], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            v
        };
        for s in stacks {
            let left = {
                let mut st = tx.prepare("select id from photo where stack_id = ?1 order by stack_pos, id").map_err(|e| e.to_string())?;
                let v = st.query_map([s], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
                v
            };
            if left.len() < 2 {
                tx.execute("update photo set stack_id = null, stack_pos = 0 where stack_id = ?1", [s]).map_err(|e| e.to_string())?;
                tx.execute("delete from stack where id = ?1", [s]).map_err(|e| e.to_string())?;
            } else {
                for (pos, p) in left.iter().enumerate() {
                    tx.execute("update photo set stack_pos = ?1 where id = ?2", params![pos as i64, p]).map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// The files that deleting these photos from the disk would take: each photo's own file and the sidecar beside it. A virtual copy has no
    /// file of its own (it shares its original's), so it adds none; each file is listed once.
    pub fn files_to_delete(&self, ids: &[i64]) -> Result<Vec<PathBuf>, String> {
        let mut out: Vec<PathBuf> = Vec::new();
        for id in ids {
            let master: Option<i64> = self.conn.query_row("select master_id from photo where id = ?1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.flatten();
            if master.is_some() {
                continue;
            }
            let Ok(path) = self.photo_path(*id) else { continue };
            let raw = media::kind_of(&path) == Some(media::Kind::Raw);
            let sidecar = crate::xmp::sidecar_path(&path, raw);
            for p in [path, sidecar] {
                if p.is_file() && !out.contains(&p) {
                    out.push(p);
                }
            }
        }
        Ok(out)
    }

    /// Delete preview files whose photo is no longer in the catalog (for example, written by a
    /// preview worker that finished after the photo was removed). Returns how many files went.
    pub fn prune_orphan_previews(&self) -> Result<usize, String> {
        let live: std::collections::HashSet<i64> = {
            let mut st = self.conn.prepare("select id from photo").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<_, _>>().map_err(|e| e.to_string())?
        };
        let mut pruned = 0;
        for entry in fs::read_dir(self.previews_dir()).map_err(|e| e.to_string())?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let id = name.split('_').next().and_then(|s| s.parse::<i64>().ok());
            let is_preview = media::PREVIEW_LEVELS.iter().any(|l| name.ends_with(&format!("_{l}.jpg")));
            if let (true, Some(id)) = (is_preview, id) {
                if !live.contains(&id) && fs::remove_file(entry.path()).is_ok() {
                    pruned += 1;
                }
            }
        }
        Ok(pruned)
    }

    // ---- collections --------------------------------------------------------

    fn clean_name(name: &str) -> Result<String, String> {
        let n = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if n.is_empty() || n.chars().count() > 100 {
            Err("Give the collection a name of 1 to 100 characters.".into())
        } else {
            Ok(n)
        }
    }

    fn collection_kind(&self, id: i64) -> Result<String, String> {
        self.conn
            .query_row("select kind from collection where id = ?1", [id], |r| r.get(0))
            .map_err(|_| "That collection no longer exists.".to_string())
    }

    pub fn collections(&self) -> Result<Vec<CollectionRow>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "select c.id, c.name, c.kind, c.is_target, count(cp.photo_id), c.parent_id
                 from collection c left join collection_photo cp on cp.collection_id = c.id
                 where c.kind in ('collection', 'quick', 'smart', 'set') group by c.id
                 order by (c.kind = 'quick') desc, c.name collate nocase",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CollectionRow { id: r.get(0)?, name: r.get(1)?, kind: r.get(2)?, is_target: r.get::<_, i64>(3)? != 0, count: r.get(4)?, parent_id: r.get(5)? })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        // a smart collection holds whatever meets its rules, so its count is worked out now
        let rows = rows
            .into_iter()
            .map(|mut c| {
                if c.kind == "smart" {
                    c.count = self.smart_rules_of(c.id).and_then(|r| self.smart_count(&r).ok()).unwrap_or(0);
                }
                c
            })
            .collect();
        Ok(rows)
    }

    /// The rules of a smart collection (None if it is not one, or its rules cannot be read).
    pub fn smart_rules_of(&self, id: i64) -> Option<crate::smart::SmartRules> {
        let json: Option<String> = self.conn.query_row("select rules_json from collection where id = ?1 and kind = 'smart'", [id], |r| r.get(0)).optional().ok().flatten();
        let rules: crate::smart::SmartRules = serde_json::from_str(&json?).ok()?;
        rules.validate().ok()?;
        Some(rules)
    }

    /// How many photos meet these rules now.
    pub fn smart_count(&self, rules: &crate::smart::SmartRules) -> Result<i64, String> {
        rules.validate()?;
        let (sql, args) = rules.to_sql(CAMERA_SQL, DAY_SQL);
        self.conn
            .query_row(
                &format!("select count(*) from photo p join folder f on f.id = p.folder_id join root_folder r on r.id = f.root_folder_id left join exif e on e.photo_id = p.id where {sql}"),
                params_from_iter(args.iter()),
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())
    }

    pub fn smart_create(&self, name: &str, rules: &crate::smart::SmartRules) -> Result<i64, String> {
        let n = Self::clean_name(name)?;
        rules.validate()?;
        let json = serde_json::to_string(rules).map_err(|e| e.to_string())?;
        self.conn.execute("insert into collection(name, kind, rules_json) values (?1, 'smart', ?2)", params![n, json]).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Change a smart collection's name and rules.
    pub fn smart_update(&self, id: i64, name: &str, rules: &crate::smart::SmartRules) -> Result<(), String> {
        if self.collection_kind(id)? != "smart" {
            return Err("That is not a smart collection.".into());
        }
        let n = Self::clean_name(name)?;
        rules.validate()?;
        let json = serde_json::to_string(rules).map_err(|e| e.to_string())?;
        self.conn.execute("update collection set name = ?1, rules_json = ?2 where id = ?3", params![n, json, id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn collection_create(&self, name: &str) -> Result<i64, String> {
        let n = Self::clean_name(name)?;
        self.conn
            .execute("insert into collection(name, kind) values (?1, 'collection')", [n])
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// A collection set: a folder of collections (and of other sets).
    pub fn collection_set_create(&self, name: &str, parent: Option<i64>) -> Result<i64, String> {
        let n = Self::clean_name(name)?;
        if let Some(p) = parent {
            if self.collection_kind(p)? != "set" {
                return Err("A collection can only be put inside a collection set.".into());
            }
        }
        self.conn.execute("insert into collection(name, kind, parent_id) values (?1, ?2, ?3)", params![n, "set", parent]).map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    /// Put a collection, smart collection or set inside a set (or back at the top when `parent` is None). A set cannot go inside itself or
    /// inside a set that is inside it.
    pub fn collection_move(&self, id: i64, parent: Option<i64>) -> Result<(), String> {
        if !matches!(self.collection_kind(id)?.as_str(), "collection" | "smart" | "set") {
            return Err("The Quick Collection cannot be moved.".into());
        }
        if let Some(p) = parent {
            if self.collection_kind(p)? != "set" {
                return Err("A collection can only be put inside a collection set.".into());
            }
            let mut at = Some(p);
            while let Some(a) = at {
                if a == id {
                    return Err("A set cannot be put inside itself.".into());
                }
                at = self.conn.query_row("select parent_id from collection where id = ?1", [a], |r| r.get::<_, Option<i64>>(0)).optional().map_err(|e| e.to_string())?.flatten();
            }
        }
        self.conn.execute("update collection set parent_id = ?1 where id = ?2", params![parent, id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn collection_rename(&self, id: i64, name: &str) -> Result<(), String> {
        if !matches!(self.collection_kind(id)?.as_str(), "collection" | "smart" | "set") {
            return Err("The Quick Collection cannot be renamed.".into());
        }
        let n = Self::clean_name(name)?;
        self.conn.execute("update collection set name = ?1 where id = ?2", params![n, id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn collection_delete(&self, id: i64) -> Result<(), String> {
        let kind = self.collection_kind(id)?;
        if !matches!(kind.as_str(), "collection" | "smart" | "set") {
            return Err("The Quick Collection cannot be deleted.".into());
        }
        if kind == "set" {
            // what was in the set moves up to where the set was: deleting a set never deletes the collections in it
            self.conn
                .execute("update collection set parent_id = (select parent_id from collection where id = ?1) where parent_id = ?1", [id])
                .map_err(|e| e.to_string())?;
        }
        self.conn.execute("delete from collection where id = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// A smart collection fills itself from its rules, so photos cannot be put in it or taken out by hand.
    fn not_smart(&self, id: i64) -> Result<(), String> {
        if self.collection_kind(id)? == "smart" {
            return Err("A smart collection fills itself from its rules. Photos cannot be added to it or taken out by hand; change its rules instead.".into());
        }
        Ok(())
    }

    pub fn collection_add(&mut self, id: i64, ids: &[i64]) -> Result<(), String> {
        self.not_smart(id)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut pos: i64 = tx
            .query_row("select coalesce(max(position), 0) from collection_photo where collection_id = ?1", [id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        for photo in ids {
            pos += 1;
            tx.execute(
                "insert or ignore into collection_photo(collection_id, photo_id, position) values (?1, ?2, ?3)",
                params![id, photo, pos],
            )
            .map_err(|_| "One of the selected photos is no longer in the catalog.".to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn collection_remove(&mut self, id: i64, ids: &[i64]) -> Result<(), String> {
        self.not_smart(id)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for photo in ids {
            tx.execute("delete from collection_photo where collection_id = ?1 and photo_id = ?2", params![id, photo])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// At most one collection is the target. `None` clears it.
    pub fn collection_set_target(&mut self, id: Option<i64>) -> Result<(), String> {
        if let Some(id) = id {
            self.not_smart(id)?;
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("update collection set is_target = 0 where is_target = 1", []).map_err(|e| e.to_string())?;
        if let Some(id) = id {
            tx.execute("update collection set is_target = 1 where id = ?1", [id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// B key: if every photo is already in the Quick Collection take them out, otherwise put them all in.
    /// Returns true when photos were added.
    pub fn quick_toggle(&mut self, ids: &[i64]) -> Result<bool, String> {
        let quick: i64 = self
            .conn
            .query_row("select id from collection where kind = 'quick'", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        let mut unique: Vec<i64> = ids.to_vec();
        unique.sort_unstable();
        unique.dedup();
        let mut already = 0usize;
        for id in &unique {
            let n: i64 = self
                .conn
                .query_row("select count(*) from collection_photo where collection_id = ?1 and photo_id = ?2", params![quick, id], |r| r.get(0))
                .map_err(|e| e.to_string())?;
            already += n as usize;
        }
        let all_in = !unique.is_empty() && already == unique.len();
        if all_in {
            self.collection_remove(quick, &unique)?;
        } else {
            self.collection_add(quick, &unique)?;
        }
        Ok(!all_in)
    }

    // ---- keywords -----------------------------------------------------------

    fn placeholders(n: usize) -> String {
        vec!["?"; n].join(",")
    }

    fn guard_ids(ids: &[i64]) -> Result<(), String> {
        if ids.len() > 30_000 {
            Err("That is too many photos at once. Select fewer.".into())
        } else {
            Ok(())
        }
    }

    pub fn keywords(&self) -> Result<Vec<KeywordRow>, String> {
        let mut stmt = self
            .conn
            .prepare("select id, name, parent_id, coalesce(synonyms, ''), include_on_export, is_private from keyword order by name collate nocase")
            .map_err(|e| e.to_string())?;
        let base = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)? != 0, r.get::<_, i64>(5)? != 0)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        // A keyword count includes photos that carry any keyword below it, each photo counted once.
        let mut count_stmt = self
            .conn
            .prepare(
                "select count(distinct photo_id) from photo_keyword where keyword_id in (
                    with recursive sub(id) as (
                        select id from keyword where id = ?1
                        union all
                        select k.id from keyword k join sub on k.parent_id = sub.id
                    ) select id from sub)",
            )
            .map_err(|e| e.to_string())?;
        let mut out = Vec::with_capacity(base.len());
        for (id, name, parent_id, synonyms, include_on_export, is_private) in base {
            let count: i64 = count_stmt.query_row([id], |r| r.get(0)).map_err(|e| e.to_string())?;
            out.push(KeywordRow { id, name, parent_id, count, synonyms, include_on_export, is_private });
        }
        Ok(out)
    }

    /// Set a keyword's synonyms (comma separated), whether it goes into sidecar files, and whether it is private. The photos that carry it are
    /// marked so their sidecars are written again.
    pub fn keyword_set_options(&mut self, id: i64, synonyms: &str, include_on_export: bool, is_private: bool) -> Result<(), String> {
        let mut seen: Vec<String> = Vec::new();
        for s in synonyms.split(',') {
            let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
            if s.is_empty() || seen.iter().any(|x| x.eq_ignore_ascii_case(&s)) {
                continue;
            }
            if s.chars().count() > 100 {
                return Err("A synonym must be 100 characters or fewer.".into());
            }
            seen.push(s);
        }
        if seen.len() > 20 {
            return Err("A keyword can have up to 20 synonyms.".into());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let n = tx
            .execute(
                "update keyword set synonyms = ?1, include_on_export = ?2, is_private = ?3 where id = ?4",
                params![if seen.is_empty() { None } else { Some(seen.join(", ")) }, include_on_export as i64, is_private as i64, id],
            )
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("That keyword is not in the catalog.".into());
        }
        tx.execute("update photo set metadata_dirty = 1 where id in (select photo_id from photo_keyword where keyword_id = ?1)", [id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Add a keyword path such as ["Places", "Beach"] to the photos, creating missing levels. Returns the leaf id.
    pub fn keyword_add(&mut self, ids: &[i64], path: &[String]) -> Result<i64, String> {
        Self::guard_ids(ids)?;
        if path.is_empty() || path.len() > 3 {
            return Err("A keyword can have up to three levels.".into());
        }
        let names: Vec<String> = path.iter().map(|p| p.split_whitespace().collect::<Vec<_>>().join(" ")).collect();
        if names.iter().any(|n| n.is_empty() || n.chars().count() > 100) {
            return Err("A keyword must be 1 to 100 characters.".into());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut parent: Option<i64> = None;
        for name in &names {
            let found: Option<i64> = tx
                .query_row("select id from keyword where parent_id is ?1 and name = ?2 collate nocase", params![parent, name], |r| r.get(0))
                .optional()
                .map_err(|e| e.to_string())?;
            let id = match found {
                Some(id) => id,
                None => {
                    tx.execute("insert into keyword(name, parent_id) values (?1, ?2)", params![name, parent]).map_err(|e| e.to_string())?;
                    tx.last_insert_rowid()
                }
            };
            parent = Some(id);
        }
        let leaf = parent.ok_or("A keyword cannot be empty.")?;
        for photo in ids {
            tx.execute("insert or ignore into photo_keyword(photo_id, keyword_id) values (?1, ?2)", params![photo, leaf])
                .map_err(|_| "One of the selected photos is no longer in the catalog.".to_string())?;
            tx.execute("update photo set metadata_dirty = 1 where id = ?1", [photo]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(leaf)
    }

    pub fn keyword_remove(&mut self, ids: &[i64], keyword_id: i64) -> Result<(), String> {
        Self::guard_ids(ids)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for photo in ids {
            tx.execute("delete from photo_keyword where photo_id = ?1 and keyword_id = ?2", params![photo, keyword_id])
                .map_err(|e| e.to_string())?;
            tx.execute("update photo set metadata_dirty = 1 where id = ?1", [photo]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// For the keyword panel: each keyword on any of these photos, and on how many of them.
    pub fn keywords_for(&self, ids: &[i64]) -> Result<Vec<KeywordUse>, String> {
        Self::guard_ids(ids)?;
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let sql = format!(
            "select keyword_id, count(*) from photo_keyword where photo_id in ({}) group by keyword_id order by keyword_id",
            Self::placeholders(ids.len())
        );
        let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params_from_iter(ids.iter()), |r| Ok(KeywordUse { keyword_id: r.get(0)?, count: r.get(1)? }))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows)
    }

    // ---- editable metadata ---------------------------------------------------

    /// Up to two distinct values per field (empty string for none): enough to tell "same" from "mixed".
    pub fn metadata_get(&self, ids: &[i64]) -> Result<MetaView, String> {
        Self::guard_ids(ids)?;
        let mut view = MetaView::default();
        if ids.is_empty() {
            return Ok(view);
        }
        for col in DETAIL_NAMES {
            // `col` comes from this fixed list, never from the caller
            let sql = format!(
                "select distinct coalesce(i.{col}, '') from photo p left join iptc i on i.photo_id = p.id where p.id in ({}) limit 2",
                Self::placeholders(ids.len())
            );
            let mut stmt = self.conn.prepare(&sql).map_err(|e| e.to_string())?;
            let vals = stmt
                .query_map(params_from_iter(ids.iter()), |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?;
            match col {
                "title" => view.title = vals,
                "caption" => view.caption = vals,
                "creator" => view.creator = vals,
                "copyright" => view.copyright = vals,
                "credit" => view.credit = vals,
                "source" => view.source = vals,
                "sublocation" => view.sublocation = vals,
                "city" => view.city = vals,
                "state" => view.state = vals,
                "country" => view.country = vals,
                "headline" => view.headline = vals,
                "job_title" => view.job_title = vals,
                "instructions" => view.instructions = vals,
                "job_id" => view.job_id = vals,
                _ => view.usage_terms = vals,
            }
        }
        Ok(view)
    }

    pub fn metadata_set(&mut self, ids: &[i64], patch: &MetaPatch) -> Result<(), String> {
        Self::guard_ids(ids)?;
        let fields: Vec<(&str, &String)> = [
            ("title", &patch.title),
            ("caption", &patch.caption),
            ("creator", &patch.creator),
            ("copyright", &patch.copyright),
            ("credit", &patch.credit),
            ("source", &patch.source),
            ("sublocation", &patch.sublocation),
            ("city", &patch.city),
            ("state", &patch.state),
            ("country", &patch.country),
            ("headline", &patch.headline),
            ("job_title", &patch.job_title),
            ("instructions", &patch.instructions),
            ("job_id", &patch.job_id),
            ("usage_terms", &patch.usage_terms),
        ]
            .into_iter()
            .filter_map(|(c, v)| v.as_ref().map(|v| (c, v)))
            .collect();
        if fields.iter().any(|(_, v)| v.chars().count() > 2000) {
            return Err("That text is too long (2000 characters at most).".into());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for photo in ids {
            tx.execute("insert or ignore into iptc(photo_id) values (?1)", [photo])
                .map_err(|_| "One of the selected photos is no longer in the catalog.".to_string())?;
            for (col, value) in &fields {
                // `col` comes from the fixed list above
                tx.execute(&format!("update iptc set {col} = ?1 where photo_id = ?2"), params![value, photo]).map_err(|e| e.to_string())?;
            }
            tx.execute("update photo set metadata_dirty = 1 where id = ?1", [photo]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// The size of the photo as it is shown (the camera's turn applied), when it is known.
    pub fn photo_dims(&self, id: i64) -> Result<Option<(u32, u32)>, String> {
        let (w, h, o): (Option<i64>, Option<i64>, Option<i64>) = self
            .conn
            .query_row("select width, height, orientation from photo where id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|_| "That photo is no longer in the catalog.".to_string())?;
        Ok(match (w, h) {
            (Some(w), Some(h)) if w > 0 && h > 0 => Some(if matches!(o, Some(5..=8)) { (h as u32, w as u32) } else { (w as u32, h as u32) }),
            _ => None,
        })
    }

    /// Keep the size of a photo that was found by opening it (the stored orientation is already applied to what is given).
    pub fn set_photo_dims(&self, id: i64, w: u32, h: u32) -> Result<(), String> {
        self.conn.execute("update photo set width = ?1, height = ?2, orientation = 1 where id = ?3 and (width is null or height is null or width = 0 or height = 0)", params![w as i64, h as i64, id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// For each photo: its file name and when it was taken (the camera's clock), for culling.
    pub fn cull_info(&self, ids: &[i64]) -> Result<std::collections::HashMap<i64, (String, Option<String>)>, String> {
        let mut stmt = self.conn.prepare("select base_name || '.' || ext, captured_local from photo where id = ?1").map_err(|e| e.to_string())?;
        let mut out = std::collections::HashMap::new();
        for id in ids {
            if let Ok(row) = stmt.query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))) {
                out.insert(*id, row);
            }
        }
        Ok(out)
    }

    pub fn photo_path(&self, id: i64) -> Result<PathBuf, String> {
        let (root, rel, name, ext): (String, String, String, String) = self
            .conn
            .query_row(
                "select r.absolute_path, f.rel_path, p.base_name, p.ext from photo p
                 join folder f on f.id = p.folder_id join root_folder r on r.id = f.root_folder_id where p.id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .map_err(|_| "That photo is no longer in the catalog.".to_string())?;
        let dir = if rel.is_empty() { PathBuf::from(root) } else { PathBuf::from(root).join(rel) };
        Ok(dir.join(format!("{name}.{ext}")))
    }

    // ---- looking after the catalog ---------------------------------------------------------------------

    fn meta_get(&self, key: &str) -> Option<String> {
        self.conn.query_row("select value from catalog_meta where key = ?1", [key], |r| r.get(0)).optional().ok().flatten()
    }

    fn meta_set(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn.execute("insert into catalog_meta(key, value) values (?1, ?2) on conflict(key) do update set value = excluded.value", params![key, value]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Compact the catalog file (take out the room left by deleted rows), rebuild its indexes and refresh what the database knows about
    /// its tables. Safe to run at any time; nothing in it changes. Everything else waits while it runs.
    pub fn optimize(&self) -> Result<OptimizeReport, String> {
        let size = || ["catalog.db", "catalog.db-wal"].iter().filter_map(|n| fs::metadata(self.root.join(n)).ok()).map(|m| m.len()).sum::<u64>();
        let before = size();
        self.conn.execute_batch("pragma wal_checkpoint(truncate); vacuum; reindex; analyze; pragma optimize;").map_err(|e| format!("The catalog could not be compacted: {e}"))?;
        Ok(OptimizeReport { before, after: size() })
    }

    /// When the last backup was made (text, as written), if one ever was.
    pub fn last_backup(&self) -> Option<String> {
        self.meta_get("last_backup")
    }

    /// Ask SQLite whether the catalog file is sound, and whether every link between its tables points at something that is there.
    pub fn integrity(&self) -> Result<IntegrityReport, String> {
        let mut problems: Vec<String> = Vec::new();
        {
            let mut st = self.conn.prepare("pragma integrity_check").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            for row in rows {
                let line = row.map_err(|e| e.to_string())?;
                if line != "ok" && problems.len() < 20 {
                    problems.push(line);
                }
            }
        }
        {
            let mut st = self.conn.prepare("pragma foreign_key_check").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
            for row in rows {
                let (table, rowid, parent) = row.map_err(|e| e.to_string())?;
                if problems.len() < 20 {
                    problems.push(format!("a row in \"{table}\" (number {}) belongs to something in \"{parent}\" that is not there", rowid.map(|r| r.to_string()).unwrap_or_else(|| "?".into())));
                }
            }
        }
        let count = |sql: &str| self.conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(0);
        let size = fs::metadata(self.root.join("catalog.db")).map(|m| m.len()).unwrap_or(0);
        Ok(IntegrityReport { ok: problems.is_empty(), problems, photos: count("select count(*) from photo"), books: count("select count(*) from book"), size_bytes: size })
    }

    /// A copy of the catalog as one consistent file, `folder`/catalog.db (made with VACUUM INTO, so it is safe while the app is
    /// using the catalog), checked after it is written. The folder is a catalog folder, so "Open an existing catalog" takes it.
    /// Previews are not copied; they are made again. Nothing that is already there is replaced.
    pub fn backup_to(&self, folder: &Path) -> Result<u64, String> {
        let file = folder.join("catalog.db");
        if file.exists() {
            return Err("There is already a catalog in that folder; nothing was replaced.".into());
        }
        fs::create_dir_all(folder).map_err(|e| format!("The backup folder could not be made: {e}"))?;
        let target = file.to_string_lossy().replace('\'', "''");
        self.conn.execute_batch(&format!("vacuum into '{target}'")).map_err(|e| format!("The backup could not be written: {e}"))?;
        let copy = Catalog::open(folder)?;
        let report = copy.integrity()?;
        drop(copy);
        if !report.ok {
            let _ = fs::remove_file(&file);
            return Err("The backup was written but did not pass its own check, so it was removed.".into());
        }
        self.meta_set("last_backup", &chrono::Local::now().format("%Y-%m-%d %H:%M").to_string())?;
        Ok(fs::metadata(&file).map(|m| m.len()).unwrap_or(0))
    }

    // ---- what goes in a photo's sidecar file ----------------------------------------------------------

    /// Whether sidecars are kept up to date by themselves in this catalog (off until it is switched on).
    pub fn xmp_auto(&self) -> bool {
        self.meta_get("xmp_auto").as_deref() == Some("1")
    }

    pub fn set_xmp_auto(&self, on: bool) -> Result<(), String> {
        self.meta_set("xmp_auto", if on { "1" } else { "0" })
    }

    /// Photos whose sidecar is out of date: something about them changed since it was written (or it was never written).
    pub fn changed_photo_ids(&self, limit: usize) -> Result<Vec<i64>, String> {
        let mut st = self.conn.prepare("select id from photo where metadata_dirty = 1 and master_id is null order by id limit ?1").map_err(|e| e.to_string())?;
        let rows = st.query_map([limit as i64], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    pub fn changed_photo_count(&self) -> i64 {
        self.conn.query_row("select count(*) from photo where metadata_dirty = 1 and master_id is null", [], |r| r.get(0)).unwrap_or(0)
    }

    pub fn all_photo_ids(&self) -> Result<Vec<i64>, String> {
        let mut st = self.conn.prepare("select id from photo order by id").map_err(|e| e.to_string())?;
        let rows = st.query_map([], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// The sidecar has been written (or read): nothing is waiting any more.
    pub fn clear_changed(&self, ids: &[i64]) -> Result<(), String> {
        for id in ids {
            self.conn.execute("update photo set metadata_dirty = 0 where id = ?1", [id]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    /// Is this photo's file a RAW file (it decides what its sidecar is called).
    pub fn is_raw(&self, id: i64) -> Result<bool, String> {
        Ok(media::kind_of(&self.photo_path(id)?) == Some(Kind::Raw))
    }

    fn keyword_paths(&self, id: i64) -> Result<Vec<Vec<String>>, String> {
        let mut st = self
            .conn
            .prepare(
                "with recursive up(leaf, id, name, parent, depth) as (
                   select k.id, k.id, k.name, k.parent_id, 0 from keyword k join photo_keyword pk on pk.keyword_id = k.id where pk.photo_id = ?1 and k.include_on_export = 1 and k.is_private = 0
                   union all
                   select up.leaf, k.id, k.name, k.parent_id, up.depth + 1 from keyword k join up on k.id = up.parent)
                 select leaf, name from up order by leaf, depth desc",
            )
            .map_err(|e| e.to_string())?;
        let rows = st.query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))).map_err(|e| e.to_string())?;
        let mut paths: Vec<Vec<String>> = vec![];
        let mut last = None;
        for row in rows {
            let (leaf, name) = row.map_err(|e| e.to_string())?;
            if last != Some(leaf) {
                paths.push(vec![]);
                last = Some(leaf);
            }
            paths.last_mut().unwrap().push(name);
        }
        Ok(paths)
    }

    /// Everything this catalog knows about the photo that a sidecar holds.
    pub fn sidecar_data(&self, id: i64) -> Result<crate::xmp::Sidecar, String> {
        let (rating, flag, label): (i64, i64, Option<String>) = self
            .conn
            .query_row("select rating, flag, color_label from photo where id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(|_| "That photo is no longer in the catalog.".to_string())?;
        let text = |col: &str| -> Option<String> {
            self.conn.query_row(&format!("select {col} from iptc where photo_id = ?1"), [id], |r| r.get::<_, Option<String>>(0)).optional().ok().flatten().flatten().filter(|s| !s.is_empty())
        };
        let recipe = self.develop_recipe(id)?.filter(|r| *r != Recipe::default()).and_then(|r| serde_json::to_string(&r).ok());
        Ok(crate::xmp::Sidecar {
            rating: Some(rating),
            flag: Some(flag),
            label,
            title: text("title"),
            caption: text("caption"),
            creator: text("creator"),
            copyright: text("copyright"),
            credit: text("credit"),
            source: text("source"),
            sublocation: text("sublocation"),
            city: text("city"),
            state: text("state"),
            country: text("country"),
            headline: text("headline"),
            job_title: text("job_title"),
            instructions: text("instructions"),
            job_id: text("job_id"),
            usage_terms: text("usage_terms"),
            keywords: self.keyword_paths(id)?,
            recipe,
            ours: true,
            crs: None,
        })
    }

    /// In what ways a sidecar that was read differs from the catalog. A sidecar this app wrote is a whole picture of the photo
    /// (a label that is not in it means none); one from another program only speaks for what it contains. Keywords and edits
    /// are only ever added to, never taken away.
    pub fn sidecar_differences(&self, id: i64, sc: &crate::xmp::Sidecar) -> Result<Vec<&'static str>, String> {
        let now = self.sidecar_data(id)?;
        let mut d = vec![];
        let norm = |s: &Option<String>| s.clone().unwrap_or_default();
        if sc.rating.is_some() && sc.rating != now.rating {
            d.push("rating");
        }
        if sc.flag.is_some() && sc.flag != now.flag {
            d.push("flag");
        }
        if (sc.ours || sc.label.is_some()) && sc.label != now.label {
            d.push("label");
        }
        for (name, a, b) in [
            ("title", &sc.title, &now.title),
            ("caption", &sc.caption, &now.caption),
            ("creator", &sc.creator, &now.creator),
            ("copyright", &sc.copyright, &now.copyright),
            ("credit", &sc.credit, &now.credit),
            ("source", &sc.source, &now.source),
            ("sublocation", &sc.sublocation, &now.sublocation),
            ("city", &sc.city, &now.city),
            ("state", &sc.state, &now.state),
            ("country", &sc.country, &now.country),
            ("headline", &sc.headline, &now.headline),
            ("job_title", &sc.job_title, &now.job_title),
            ("instructions", &sc.instructions, &now.instructions),
            ("job_id", &sc.job_id, &now.job_id),
            ("usage_terms", &sc.usage_terms, &now.usage_terms),
        ] {
            if (sc.ours || a.is_some()) && norm(a) != norm(b) {
                d.push(name);
            }
        }
        let have: std::collections::HashSet<String> = now.keywords.iter().map(|p| p.join("|").to_lowercase()).collect();
        if sc.keywords.iter().any(|p| !have.contains(&p.join("|").to_lowercase())) {
            d.push("keywords");
        }
        if let Some(r) = sc.recipe.as_deref().and_then(|j| serde_json::from_str::<Recipe>(j).ok()).map(|r| r.sanitized()) {
            if self.develop_recipe(id)?.unwrap_or_default() != r {
                d.push("edits");
            }
        } else if let Some(crs) = &sc.crs {
            // another program's develop settings: the ones understood here are put on the photo's edits
            let now = self.develop_recipe(id)?.unwrap_or_default();
            if crs.apply_to(&now).sanitized() != now.sanitized() {
                d.push("lightroom");
            }
        }
        Ok(d)
    }

    /// Make the catalog agree with the sidecar, in the ways `sidecar_differences` lists. Returns those ways.
    pub fn apply_sidecar(&mut self, id: i64, sc: &crate::xmp::Sidecar) -> Result<Vec<&'static str>, String> {
        let diffs = self.sidecar_differences(id, sc)?;
        for d in &diffs {
            match *d {
                "rating" => self.set_rating(&[id], sc.rating.unwrap_or(0))?,
                "flag" => self.set_flag(&[id], sc.flag.unwrap_or(0))?,
                "label" => self.set_label(&[id], sc.label.as_deref())?,
                name if DETAIL_NAMES.contains(&name) => {
                    let value = match name {
                        "title" => &sc.title,
                        "caption" => &sc.caption,
                        "creator" => &sc.creator,
                        "copyright" => &sc.copyright,
                        "credit" => &sc.credit,
                        "source" => &sc.source,
                        "sublocation" => &sc.sublocation,
                        "city" => &sc.city,
                        "state" => &sc.state,
                        "country" => &sc.country,
                        "headline" => &sc.headline,
                        "job_title" => &sc.job_title,
                        "instructions" => &sc.instructions,
                        "job_id" => &sc.job_id,
                        _ => &sc.usage_terms,
                    };
                    self.metadata_set(&[id], &MetaPatch::only(name, value.clone().unwrap_or_default()))?
                }
                "keywords" => {
                    for p in &sc.keywords {
                        self.keyword_add(&[id], p)?;
                    }
                }
                "lightroom" => {
                    if let Some(crs) = &sc.crs {
                        let merged = crs.apply_to(&self.develop_recipe(id)?.unwrap_or_default());
                        self.develop_save(id, &merged, Some(&StepIn { label: "Read Lightroom settings".into(), delta_text: None, value_text: None }))?;
                    }
                }
                "edits" => {
                    if let Some(r) = sc.recipe.as_deref().and_then(|j| serde_json::from_str::<Recipe>(j).ok()) {
                        self.develop_save(id, &r, Some(&StepIn { label: "Read from sidecar".into(), delta_text: None, value_text: None }))?;
                    }
                }
                _ => {}
            }
        }
        Ok(diffs)
    }

    /// Every photo with where its file is and its edits (None if untouched), for making previews.
    pub fn preview_items(&self) -> Result<Vec<(i64, PathBuf, Option<Recipe>)>, String> {
        let ids = self.all_photo_ids()?;
        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Ok(path) = self.photo_path(id) {
                out.push((id, path, self.develop_recipe(id)?));
            }
        }
        Ok(out)
    }

    // ---- stacks -----------------------------------------------------------------------------------

    /// Put these photos (in this order: the first is the top) into one stack, closed. Photos that are already in a stack bring the rest of
    /// that stack with them, and the stacks join. Returns the stack's id.
    pub fn stack_group(&mut self, ids: &[i64]) -> Result<i64, String> {
        Self::guard_ids(ids)?;
        if ids.len() < 2 {
            return Err("Pick two or more photos to put into a stack.".into());
        }
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        // the photos that are in the picked ones' stacks already, after the picked ones
        let mut order: Vec<i64> = ids.to_vec();
        for id in ids {
            let sid: Option<i64> = tx.query_row("select stack_id from photo where id = ?1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.flatten();
            if let Some(sid) = sid {
                let mut st = tx.prepare("select id from photo where stack_id = ?1 order by stack_pos, id").map_err(|e| e.to_string())?;
                let others = st.query_map([sid], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
                for o in others {
                    if !order.contains(&o) {
                        order.push(o);
                    }
                }
            }
        }
        tx.execute("insert into stack(collapsed) values (1)", []).map_err(|e| e.to_string())?;
        let stack = tx.last_insert_rowid();
        for (pos, id) in order.iter().enumerate() {
            tx.execute("update photo set stack_id = ?1, stack_pos = ?2 where id = ?3", params![stack, pos as i64, id]).map_err(|e| e.to_string())?;
        }
        tx.execute("delete from stack where id not in (select distinct stack_id from photo where stack_id is not null)", []).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(stack)
    }

    /// Stack the photos that were taken within `gap_s` seconds of the one before (in the order of capture time). Photos that are in a stack
    /// already, that are virtual copies or that have no capture time are left alone. Returns (stacks made, photos stacked).
    pub fn stack_auto(&mut self, ids: &[i64], gap_s: i64) -> Result<(usize, usize), String> {
        Self::guard_ids(ids)?;
        let gap_s = gap_s.clamp(1, 86_400);
        let mut dated: Vec<(chrono::NaiveDateTime, i64)> = vec![];
        for id in ids {
            let row: Option<(Option<String>, Option<i64>, Option<i64>)> = self
                .conn
                .query_row("select captured_local, master_id, stack_id from photo where id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((Some(when), None, None)) = row {
                if let Ok(t) = chrono::NaiveDateTime::parse_from_str(&when, "%Y-%m-%dT%H:%M:%S").or_else(|_| chrono::NaiveDateTime::parse_from_str(&when, "%Y-%m-%d %H:%M:%S")) {
                    dated.push((t, *id));
                }
            }
        }
        dated.sort();
        let (mut stacks, mut photos) = (0, 0);
        let mut run: Vec<i64> = vec![];
        let mut last: Option<chrono::NaiveDateTime> = None;
        for (t, id) in dated {
            if last.map(|l| (t - l).num_seconds() > gap_s).unwrap_or(false) {
                if run.len() >= 2 {
                    self.stack_group(&run)?;
                    stacks += 1;
                    photos += run.len();
                }
                run.clear();
            }
            run.push(id);
            last = Some(t);
        }
        if run.len() >= 2 {
            self.stack_group(&run)?;
            stacks += 1;
            photos += run.len();
        }
        Ok((stacks, photos))
    }

    /// Stack photos that look alike (a burst, or the same shot taken again): a 64 bit fingerprint of each photo's small preview is compared
    /// with the next 30 photos in capture order, and those no more than `max_distance` bits apart go into one stack. Photos in a stack
    /// already, virtual copies and photos with no preview are left alone. Returns (stacks made, photos stacked).
    pub fn stack_similar(&mut self, ids: &[i64], max_distance: u32) -> Result<(usize, usize), String> {
        Self::guard_ids(ids)?;
        let max_distance = max_distance.min(24);
        let previews = self.previews_dir();
        let mut items: Vec<(String, i64, u64)> = vec![];
        for id in ids {
            let row: Option<(Option<String>, Option<i64>, Option<i64>)> = self
                .conn
                .query_row("select coalesce(captured_local, ''), master_id, stack_id from photo where id = ?1", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .optional()
                .map_err(|e| e.to_string())?;
            if let Some((when, None, None)) = row {
                if let Some(h) = media::fingerprint(&media::preview_path(&previews, *id, "thumb")) {
                    items.push((when.unwrap_or_default(), *id, h));
                }
            }
        }
        items.sort();
        // groups of photos that look alike: each is compared with the 30 after it, and the ones that match are joined
        let mut parent: Vec<usize> = (0..items.len()).collect();
        fn find(p: &mut Vec<usize>, mut i: usize) -> usize {
            while p[i] != i {
                p[i] = p[p[i]];
                i = p[i];
            }
            i
        }
        for i in 0..items.len() {
            for j in i + 1..(i + 31).min(items.len()) {
                if (items[i].2 ^ items[j].2).count_ones() <= max_distance {
                    let (a, b) = (find(&mut parent, i), find(&mut parent, j));
                    if a != b {
                        parent[b] = a;
                    }
                }
            }
        }
        let mut groups: std::collections::BTreeMap<usize, Vec<i64>> = std::collections::BTreeMap::new();
        for i in 0..items.len() {
            let root = find(&mut parent, i);
            groups.entry(root).or_default().push(items[i].1);
        }
        let (mut stacks, mut photos) = (0, 0);
        for (_, group) in groups {
            if group.len() >= 2 {
                self.stack_group(&group)?;
                stacks += 1;
                photos += group.len();
            }
        }
        Ok((stacks, photos))
    }

    /// Take apart the stacks these photos are in: every photo of each goes back to being on its own.
    pub fn stack_ungroup(&mut self, ids: &[i64]) -> Result<usize, String> {
        Self::guard_ids(ids)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut stacks: Vec<i64> = vec![];
        for id in ids {
            if let Some(s) = tx.query_row("select stack_id from photo where id = ?1", [id], |r| r.get::<_, Option<i64>>(0)).optional().map_err(|e| e.to_string())?.flatten() {
                if !stacks.contains(&s) {
                    stacks.push(s);
                }
            }
        }
        for s in &stacks {
            tx.execute("update photo set stack_id = null, stack_pos = 0 where stack_id = ?1", [s]).map_err(|e| e.to_string())?;
            tx.execute("delete from stack where id = ?1", [s]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(stacks.len())
    }

    /// Take these photos out of their stacks (the stack goes on without them; a stack left with one photo ends).
    pub fn stack_remove(&mut self, ids: &[i64]) -> Result<usize, String> {
        Self::guard_ids(ids)?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let mut n = 0;
        let mut touched: Vec<i64> = vec![];
        for id in ids {
            if let Some(s) = tx.query_row("select stack_id from photo where id = ?1", [id], |r| r.get::<_, Option<i64>>(0)).optional().map_err(|e| e.to_string())?.flatten() {
                tx.execute("update photo set stack_id = null, stack_pos = 0 where id = ?1", [id]).map_err(|e| e.to_string())?;
                n += 1;
                if !touched.contains(&s) {
                    touched.push(s);
                }
            }
        }
        for s in touched {
            // close up the places, and end a stack that has fewer than two photos
            let mut st = tx.prepare("select id from photo where stack_id = ?1 order by stack_pos, id").map_err(|e| e.to_string())?;
            let left = st.query_map([s], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
            drop(st);
            if left.len() < 2 {
                tx.execute("update photo set stack_id = null, stack_pos = 0 where stack_id = ?1", [s]).map_err(|e| e.to_string())?;
                tx.execute("delete from stack where id = ?1", [s]).map_err(|e| e.to_string())?;
            } else {
                for (pos, p) in left.iter().enumerate() {
                    tx.execute("update photo set stack_pos = ?1 where id = ?2", params![pos as i64, p]).map_err(|e| e.to_string())?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n)
    }

    /// Open or close one stack.
    pub fn stack_set_collapsed(&self, stack_id: i64, collapsed: bool) -> Result<(), String> {
        self.conn.execute("update stack set collapsed = ?1 where id = ?2", params![collapsed as i64, stack_id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Open or close every stack.
    pub fn stack_set_all_collapsed(&self, collapsed: bool) -> Result<(), String> {
        self.conn.execute("update stack set collapsed = ?1", [collapsed as i64]).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Make this photo the top of its stack, the one that shows when the stack is closed.
    pub fn stack_make_top(&mut self, id: i64) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        let sid: Option<i64> = tx.query_row("select stack_id from photo where id = ?1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.flatten();
        let Some(sid) = sid else { return Err("That photo is not in a stack.".into()) };
        tx.execute("update photo set stack_pos = stack_pos + 1 where stack_id = ?1 and stack_pos < (select stack_pos from photo where id = ?2)", params![sid, id]).map_err(|e| e.to_string())?;
        tx.execute("update photo set stack_pos = 0 where id = ?1", [id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    // ---- virtual copies ---------------------------------------------------------------------------

    pub fn is_virtual_copy(&self, id: i64) -> bool {
        self.conn.query_row("select master_id is not null from photo where id = ?1", [id], |r| r.get::<_, i64>(0)).map(|v| v != 0).unwrap_or(false)
    }

    /// Every photo that has a file of its own (not the virtual copies).
    pub fn master_photo_ids(&self) -> Result<Vec<i64>, String> {
        let mut st = self.conn.prepare("select id from photo where master_id is null order by id").map_err(|e| e.to_string())?;
        let rows = st.query_map([], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
    }

    /// Make a virtual copy of each photo: a photo of its own, with its own rating, flag, label, keywords, text, collections and
    /// edits (a start from the original's), that shares the original's file, so it takes no room. A copy of a copy is a copy of
    /// the original. Returns (the original, the new copy) for each. The previews are copied too.
    pub fn virtual_copies(&mut self, ids: &[i64]) -> Result<Vec<(i64, i64)>, String> {
        Self::guard_ids(ids)?;
        if ids.len() > 200 {
            return Err("Make virtual copies of 200 photos at most at a time.".into());
        }
        let previews = self.previews_dir();
        let mut made: Vec<(i64, i64)> = vec![];
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        for id in ids {
            let master: i64 = tx
                .query_row("select coalesce(master_id, id) from photo where id = ?1", [id], |r| r.get(0))
                .map_err(|_| "One of the selected photos is no longer in the catalog.".to_string())?;
            let taken: Vec<String> = {
                let mut st = tx.prepare("select copy_name from photo where master_id = ?1").map_err(|e| e.to_string())?;
                let rows = st.query_map([master], |r| r.get::<_, Option<String>>(0)).map_err(|e| e.to_string())?;
                rows.filter_map(|r| r.ok().flatten()).collect()
            };
            let n = taken.iter().filter_map(|c| c.strip_prefix("Copy ").and_then(|n| n.parse::<u32>().ok())).max().unwrap_or(0) + 1;
            tx.execute(
                "insert into photo(uuid, folder_id, base_name, ext, format, file_size, file_mtime, file_hash, master_id, copy_name, import_id,
                                   captured_local, captured_offset_min, captured_utc, rating, flag, color_label, width, height, orientation, missing, metadata_dirty)
                 select ?1, folder_id, base_name, ext, format, file_size, file_mtime, file_hash, ?2, ?3, import_id,
                        captured_local, captured_offset_min, captured_utc, rating, flag, color_label, width, height, orientation, missing, 0
                 from photo where id = ?4",
                params![uuid::Uuid::new_v4().to_string(), master, format!("Copy {n}"), id],
            )
            .map_err(|e| e.to_string())?;
            let new = tx.last_insert_rowid();
            for table in ["exif", "iptc", "develop_settings", "photo_keyword", "collection_photo"] {
                let cols: Vec<String> = {
                    let mut st = tx.prepare("select name from pragma_table_info(?1) where name <> 'photo_id'").map_err(|e| e.to_string())?;
                    let rows = st.query_map([table], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
                    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
                };
                let list = cols.join(", ");
                // `table` and the column names come from the fixed list and the catalog's own schema, never from the caller
                tx.execute(&format!("insert into {table}(photo_id, {list}) select ?1, {list} from {table} where photo_id = ?2"), params![new, id]).map_err(|e| e.to_string())?;
            }
            // the copy starts with the original's History and snapshots, so it can be stepped back like the original
            tx.execute("insert into history_step(photo_id, seq, label, delta_text, value_text, patch_json) select ?1, seq, label, delta_text, value_text, patch_json from history_step where photo_id = ?2", params![new, id]).map_err(|e| e.to_string())?;
            tx.execute("insert into snapshot(photo_id, name, settings_json) select ?1, name, settings_json from snapshot where photo_id = ?2", params![new, id]).map_err(|e| e.to_string())?;
            made.push((*id, new));
        }
        tx.commit().map_err(|e| e.to_string())?;
        for (from, to) in &made {
            for level in media::PREVIEW_LEVELS {
                let _ = fs::copy(media::preview_path(&previews, *from, level), media::preview_path(&previews, *to, level));
            }
        }
        Ok(made)
    }

    /// Give a virtual copy a name of its own ("Black and white", "Crop for print"). The names of one photo's copies are all different.
    pub fn rename_copy(&self, id: i64, name: &str) -> Result<(), String> {
        let master: Option<i64> = self.conn.query_row("select master_id from photo where id = ?1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?.flatten();
        let Some(master) = master else { return Err("Only a virtual copy can be named. Make a virtual copy first.".into()) };
        let n = name.split_whitespace().collect::<Vec<_>>().join(" ");
        if n.is_empty() || n.chars().count() > 40 {
            return Err("Give the copy a name of 1 to 40 characters.".into());
        }
        let clash: i64 = self.conn.query_row("select count(*) from photo where master_id = ?1 and id != ?2 and copy_name = ?3 collate nocase", params![master, id, n], |r| r.get(0)).map_err(|e| e.to_string())?;
        if clash > 0 {
            return Err("Another copy of this photo already has that name.".into());
        }
        self.conn.execute("update photo set copy_name = ?1 where id = ?2", params![n, id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- photos whose files are not where the catalog says ---------------------------------------------

    /// Look for every photo's file, mark the ones that are not there (and clear the mark on the ones that are again), and say
    /// which folders they were in. `progress(done, total)` is told as it goes. Nothing on disk is touched.
    pub fn scan_missing(&self, mut progress: impl FnMut(usize, usize)) -> Result<MissingReport, String> {
        let rows: Vec<(i64, i64, String, String, String, String, bool)> = {
            let mut st = self
                .conn
                .prepare(
                    "select p.id, r.id, r.absolute_path, f.rel_path, p.base_name, p.ext, p.missing from photo p
                     join folder f on f.id = p.folder_id join root_folder r on r.id = f.root_folder_id",
                )
                .map_err(|e| e.to_string())?;
            let r = st
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get::<_, i64>(6)? != 0)))
                .map_err(|e| e.to_string())?;
            r.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        let total = rows.len();
        let mut groups: std::collections::BTreeMap<i64, MissingGroup> = std::collections::BTreeMap::new();
        let (mut to_missing, mut to_found): (Vec<i64>, Vec<i64>) = (vec![], vec![]);
        let mut there: std::collections::HashMap<i64, bool> = std::collections::HashMap::new();
        for (i, (id, root_id, root, rel, name, ext, was)) in rows.iter().enumerate() {
            if i % 200 == 0 {
                progress(i, total);
            }
            let dir = if rel.is_empty() { PathBuf::from(root) } else { PathBuf::from(root).join(rel) };
            let found = dir.join(format!("{name}.{ext}")).is_file();
            let g = groups.entry(*root_id).or_insert_with(|| MissingGroup { root_id: *root_id, path: root.clone(), folder_there: *there.entry(*root_id).or_insert_with(|| Path::new(root).is_dir()), missing: 0, total: 0 });
            g.total += 1;
            if !found {
                g.missing += 1;
            }
            if !found && !was {
                to_missing.push(*id);
            } else if found && *was {
                to_found.push(*id);
            }
        }
        let tx = self.conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for id in &to_missing {
            tx.execute("update photo set missing = 1 where id = ?1", [id]).map_err(|e| e.to_string())?;
        }
        for id in &to_found {
            tx.execute("update photo set missing = 0 where id = ?1", [id]).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        progress(total, total);
        let missing: i64 = groups.values().map(|g| g.missing).sum();
        Ok(MissingReport { checked: total as i64, missing, groups: groups.into_values().filter(|g| g.missing > 0).collect() })
    }

    /// If a whole folder of the catalog was moved to `new_root`, how many of its photos are there (same folders inside, same names).
    pub fn relocation_preview(&self, root_id: i64, new_root: &Path) -> Result<Relocation, String> {
        let mut st = self
            .conn
            .prepare("select f.rel_path, p.base_name, p.ext from photo p join folder f on f.id = p.folder_id where f.root_folder_id = ?1")
            .map_err(|e| e.to_string())?;
        let rows = st.query_map([root_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).map_err(|e| e.to_string())?;
        let (mut found, mut total) = (0i64, 0i64);
        for row in rows {
            let (rel, name, ext) = row.map_err(|e| e.to_string())?;
            total += 1;
            let dir = if rel.is_empty() { new_root.to_path_buf() } else { new_root.join(&rel) };
            if dir.join(format!("{name}.{ext}")).is_file() {
                found += 1;
            }
        }
        Ok(Relocation { found, total })
    }

    /// Point a folder of the catalog at its new place. Only if some of its photos are there, and not if another folder of the
    /// catalog is already at that place. Files are not moved or copied.
    pub fn relocate_root(&self, root_id: i64, new_root: &Path) -> Result<(), String> {
        if !new_root.is_dir() {
            return Err("That folder is not there.".into());
        }
        let abs = path_str(new_root);
        let taken: Option<i64> = self.conn.query_row("select id from root_folder where absolute_path = ?1 and id <> ?2", params![abs, root_id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        if taken.is_some() {
            return Err("That folder is already in the catalog as another folder, so these photos cannot be pointed at it.".into());
        }
        if self.relocation_preview(root_id, new_root)?.found == 0 {
            return Err("None of this folder's photos are in the folder you chose, so nothing was changed.".into());
        }
        let n = self.conn.execute("update root_folder set absolute_path = ?1 where id = ?2", params![abs, root_id]).map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("That folder is not in the catalog.".into());
        }
        Ok(())
    }

    /// Look through `folder` (and the folders in it) for the files of the photos that are marked missing, by name and size, and
    /// point each photo at the file it finds. A file that fits two photos, or a photo that fits two files, is left alone.
    pub fn relink_by_search(&self, folder: &Path, mut progress: impl FnMut(usize)) -> Result<SearchOutcome, String> {
        type Key = (String, String, u64);
        let mut wanted: std::collections::HashMap<Key, Vec<i64>> = std::collections::HashMap::new();
        {
            let mut st = self.conn.prepare("select id, base_name, ext, file_size from photo where missing = 1 and master_id is null").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?))).map_err(|e| e.to_string())?;
            for row in rows {
                let (id, name, ext, size) = row.map_err(|e| e.to_string())?;
                wanted.entry((name.to_lowercase(), ext.to_lowercase(), size.max(0) as u64)).or_default().push(id);
            }
        }
        let still = wanted.values().map(|v| v.len() as i64).sum::<i64>();
        let mut found: std::collections::HashMap<Key, Vec<PathBuf>> = std::collections::HashMap::new();
        let mut seen = 0usize;
        // every photo file in the folder by its size, for the second look (by content) at what the names did not find
        let mut by_size: std::collections::HashMap<u64, Vec<PathBuf>> = std::collections::HashMap::new();
        for entry in WalkDir::new(folder).follow_links(false).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            seen += 1;
            if seen % 500 == 0 {
                progress(seen);
            }
            let p = entry.path();
            if media::kind_of(p).is_none() {
                continue;
            }
            let (Some(stem), Some(ext)) = (p.file_stem().and_then(|s| s.to_str()), p.extension().and_then(|s| s.to_str())) else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            let key = (stem.to_lowercase(), ext.to_lowercase(), meta.len());
            by_size.entry(meta.len()).or_default().push(p.to_path_buf());
            if wanted.contains_key(&key) {
                found.entry(key).or_default().push(p.to_path_buf());
            }
        }
        progress(seen);
        let root_abs = path_str(folder);
        let root_name = folder.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Photos".into());
        let (mut relinked, mut ambiguous, mut conflicts) = (0i64, 0i64, 0i64);
        let mut linked: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
        let mut skip: std::collections::HashSet<i64> = std::collections::HashSet::new(); // already judged doubtful by name: not looked at again
        for (key, ids) in &wanted {
            let Some(paths) = found.get(key) else { continue };
            if ids.len() != 1 || paths.len() != 1 {
                ambiguous += ids.len() as i64;
                skip.extend(ids.iter().copied());
                continue;
            }
            let p = &paths[0];
            let rel = p.parent().and_then(|d| d.strip_prefix(folder).ok()).map(path_str).unwrap_or_default();
            let (stem, ext) = (p.file_stem().unwrap().to_string_lossy().into_owned(), p.extension().unwrap().to_string_lossy().to_ascii_lowercase());
            let folder_id = self.folder_id(&root_abs, &root_name, &rel)?;
            match self.conn.execute("update photo set folder_id = ?1, base_name = ?2, ext = ?3, missing = 0 where id = ?4 or master_id = ?4", params![folder_id, stem, ext, ids[0]]) {
                Ok(_) => {
                    relinked += 1;
                    linked.insert(p.clone());
                }
                Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => conflicts += 1,
                Err(e) => return Err(e.to_string()),
            }
        }
        // a second look at what the names did not find: a file that was renamed is still the same file, so what is inside it is compared
        // (only the files of exactly the same size are read)
        let mut by_content = 0i64;
        let mut hashes: std::collections::HashMap<PathBuf, Option<String>> = std::collections::HashMap::new();
        let left: Vec<(i64, i64, Option<String>)> = {
            let mut st = self.conn.prepare("select id, file_size, file_hash from photo where missing = 1 and master_id is null").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?))).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        for (id, size, hash) in left {
            if skip.contains(&id) {
                continue;
            }
            let Some(hash) = hash.filter(|h| !h.is_empty()) else { continue };
            let Some(candidates) = by_size.get(&(size.max(0) as u64)) else { continue };
            let mut same: Vec<&PathBuf> = Vec::new();
            for c in candidates.iter().filter(|c| !linked.contains(*c)) {
                let h = hashes
                    .entry(c.clone())
                    .or_insert_with(|| fs::File::open(c).ok().and_then(|mut f| blake3::Hasher::new().update_reader(&mut f).ok().map(|h| h.finalize().to_hex().to_string())))
                    .clone();
                if h.as_deref() == Some(hash.as_str()) {
                    same.push(c);
                }
            }
            if same.len() != 1 {
                if same.len() > 1 {
                    ambiguous += 1;
                }
                continue;
            }
            let p = same[0];
            let rel = p.parent().and_then(|d| d.strip_prefix(folder).ok()).map(path_str).unwrap_or_default();
            let (Some(stem), Some(ext)) = (p.file_stem().map(|s| s.to_string_lossy().into_owned()), p.extension().map(|s| s.to_string_lossy().to_ascii_lowercase())) else { continue };
            let folder_id = self.folder_id(&root_abs, &root_name, &rel)?;
            match self.conn.execute("update photo set folder_id = ?1, base_name = ?2, ext = ?3, missing = 0 where id = ?4 or master_id = ?4", params![folder_id, stem, ext, id]) {
                Ok(_) => {
                    relinked += 1;
                    by_content += 1;
                    linked.insert(p.clone());
                }
                Err(rusqlite::Error::SqliteFailure(e, _)) if e.code == rusqlite::ErrorCode::ConstraintViolation => conflicts += 1,
                Err(e) => return Err(e.to_string()),
            }
        }
        Ok(SearchOutcome { relinked, still_missing: still - relinked, ambiguous, conflicts, by_content })
    }

    /// Point one photo (and its virtual copies) at a file chosen by hand, when the program could not find it by itself. The file's size, date
    /// and contents are noted again, and the photo's old previews are dropped so they are made from this file.
    pub fn relink_photo(&self, id: i64, file: &Path) -> Result<(), String> {
        if !file.is_file() || media::kind_of(file).is_none() {
            return Err("That is not a photo file this program can open.".into());
        }
        if self.is_virtual_copy(id) {
            return Err("A virtual copy uses its original's file. Reconnect the original instead.".into());
        }
        let exists: i64 = self.conn.query_row("select count(*) from photo where id = ?1", [id], |r| r.get(0)).map_err(|e| e.to_string())?;
        if exists == 0 {
            return Err("That photo is not in the catalog.".into());
        }
        let parent = file.parent().ok_or("That file has no folder.")?;
        let file_s = path_str(file);
        // inside a place the catalog already knows: keep using it; otherwise the folder the file is in becomes a new place
        let mut roots: Vec<String> = {
            let mut st = self.conn.prepare("select absolute_path from root_folder").map_err(|e| e.to_string())?;
            let rows = st.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
        };
        roots.sort_by_key(|r| std::cmp::Reverse(r.len()));
        let (root_abs, rel) = match roots.iter().find(|r| file_s.starts_with(&format!("{}/", r.trim_end_matches('/')))) {
            Some(r) => {
                let root = r.trim_end_matches('/');
                let rel = path_str(parent).strip_prefix(root).unwrap_or("").trim_start_matches('/').to_string();
                (r.clone(), rel)
            }
            None => (path_str(parent), String::new()),
        };
        let root_name = Path::new(&root_abs).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "Photos".into());
        let folder_id = self.folder_id(&root_abs, &root_name, &rel)?;
        let md = fs::metadata(file).map_err(|e| e.to_string())?;
        let mtime: String = md.modified().ok().map(|t| chrono::DateTime::<chrono::Utc>::from(t).format("%Y-%m-%dT%H:%M:%SZ").to_string()).unwrap_or_default();
        let hash = {
            let mut f = fs::File::open(file).map_err(|e| e.to_string())?;
            blake3::Hasher::new().update_reader(&mut f).map_err(|e| e.to_string())?.finalize().to_hex().to_string()
        };
        let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("photo").to_string();
        let ext = file.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        let taken: i64 = self
            .conn
            .query_row(
                "select count(*) from photo where id != ?1 and master_id is null and ((folder_id = ?2 and base_name = ?3 and ext = ?4) or file_hash = ?5)",
                params![id, folder_id, stem, ext, hash],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if taken > 0 {
            return Err("That file is already in the catalog under another photo.".into());
        }
        self.conn
            .execute(
                "update photo set folder_id = ?1, base_name = ?2, ext = ?3, missing = 0, file_size = ?4, file_mtime = ?5, file_hash = ?6 where id = ?7 or master_id = ?7",
                params![folder_id, stem, ext, md.len() as i64, mtime, hash, id],
            )
            .map_err(|e| match e {
                rusqlite::Error::SqliteFailure(f, _) if f.code == rusqlite::ErrorCode::ConstraintViolation => "That file is already in the catalog under another photo.".to_string(),
                other => other.to_string(),
            })?;
        for level in media::PREVIEW_LEVELS {
            let _ = fs::remove_file(media::preview_path(&self.previews_dir(), id, level));
        }
        Ok(())
    }

    // ---- books ----------------------------------------------------------------------
    pub fn book_list(&self) -> Result<Vec<BookEntry>, String> {
        let mut st = self
            .conn
            .prepare("select id, name, json, updated from book order by updated desc, id desc")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in rows {
            let (id, name, json, updated) = row.map_err(|e| e.to_string())?;
            let pages = serde_json::from_str::<crate::book::Book>(&json).map(|b| b.pages.len()).unwrap_or(0);
            out.push(BookEntry { id, name, pages, updated });
        }
        Ok(out)
    }

    pub fn book_create(&self, book: &crate::book::Book) -> Result<i64, String> {
        let b = book.sanitized();
        let json = serde_json::to_string(&b).map_err(|e| e.to_string())?;
        self.conn
            .execute("insert into book(name, json, updated) values (?1, ?2, strftime('%s','now'))", params![b.name, json])
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn book_get(&self, id: i64) -> Result<crate::book::Book, String> {
        let json: Option<String> = self.conn.query_row("select json from book where id = ?1", [id], |r| r.get(0)).optional().map_err(|e| e.to_string())?;
        let json = json.ok_or("That book is not in this catalog.")?;
        serde_json::from_str::<crate::book::Book>(&json).map(|b| b.sanitized()).map_err(|e| format!("The book could not be read: {e}"))
    }

    /// Store the book (kept tidy). Returns it as stored.
    pub fn book_save(&self, id: i64, book: &crate::book::Book) -> Result<crate::book::Book, String> {
        let b = book.sanitized();
        let json = serde_json::to_string(&b).map_err(|e| e.to_string())?;
        let n = self
            .conn
            .execute("update book set name = ?2, json = ?3, updated = strftime('%s','now') where id = ?1", params![id, b.name, json])
            .map_err(|e| e.to_string())?;
        if n == 0 {
            return Err("That book is not in this catalog.".into());
        }
        Ok(b)
    }

    pub fn book_delete(&self, id: i64) -> Result<(), String> {
        self.conn.execute("delete from book where id = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    // ---- develop ------------------------------------------------------------------

    /// The saved recipe, or None if the photo was never edited.
    pub fn develop_recipe(&self, id: i64) -> Result<Option<Recipe>, String> {
        let json: Option<String> = self
            .conn
            .query_row("select settings_json from develop_settings where photo_id = ?1", [id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        Ok(json.and_then(|j| serde_json::from_str::<Recipe>(&j).ok()).map(|r| r.sanitized()))
    }

    pub fn develop_get(&self, id: i64) -> Result<DevelopState, String> {
        self.photo_path(id)?; // fails with a clear message if the photo is gone
        let recipe = self.develop_recipe(id)?.unwrap_or_default();
        let mut st = self
            .conn
            .prepare("select id, seq, label, delta_text, value_text, created_at, patch_json from history_step where photo_id = ?1 order by seq desc limit 200")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([id], |r| {
                let json: String = r.get(6)?;
                Ok(HistoryRow {
                    id: r.get(0)?,
                    seq: r.get(1)?,
                    label: r.get(2)?,
                    delta_text: r.get(3)?,
                    value_text: r.get(4)?,
                    created_at: r.get(5)?,
                    recipe: serde_json::from_str::<Recipe>(&json).unwrap_or_default().sanitized(),
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(DevelopState { recipe, history: rows })
    }

    /// Store the recipe and, when `step` is given, one history entry holding the recipe after it.
    pub fn develop_save(&mut self, id: i64, recipe: &Recipe, step: Option<&StepIn>) -> Result<(), String> {
        crate::licence::editing_allowed()?;
        self.photo_path(id)?;
        let r = recipe.sanitized();
        let json = serde_json::to_string(&r).map_err(|e| e.to_string())?;
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        if r == Recipe::default() {
            // back to untouched: no stored recipe, so the photo no longer counts as edited (its history stays)
            tx.execute("delete from develop_settings where photo_id = ?1", [id]).map_err(|e| e.to_string())?;
        } else {
            tx.execute(
                "insert into develop_settings(photo_id, process_version, settings_json, has_masks, has_crop, edited_at)
                 values (?1, ?2, ?3, ?5, ?4, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
                 on conflict(photo_id) do update set process_version = excluded.process_version, settings_json = excluded.settings_json,
                   has_crop = excluded.has_crop, has_masks = excluded.has_masks, edited_at = excluded.edited_at",
                params![id, develop::PROCESS_VERSION, json, r.has_crop() as i64, r.has_masks() as i64],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(step) = step {
            let label: String = step.label.chars().take(80).collect();
            tx.execute(
                "insert into history_step(photo_id, seq, label, delta_text, value_text, patch_json)
                 values (?1, coalesce((select max(seq) from history_step where photo_id = ?1), 0) + 1, ?2, ?3, ?4, ?5)",
                params![id, label, step.delta_text, step.value_text, json],
            )
            .map_err(|e| e.to_string())?;
            tx.execute(
                "delete from history_step where photo_id = ?1 and seq <= (select max(seq) from history_step where photo_id = ?1) - ?2",
                params![id, HISTORY_LIMIT],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.execute("update photo set metadata_dirty = 1 where id = ?1", [id]).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    // ---- presets and snapshots ----------------------------------------------------

    pub fn preset_list(&self) -> Result<Vec<PresetRow>, String> {
        let mut st = self
            .conn
            .prepare("select id, name, coalesce(group_name, ?1), settings_json from preset where type = 'develop' order by lower(coalesce(group_name, ?1)), lower(name)")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([USER_PRESET_GROUP], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        // a row whose body cannot be read is skipped rather than breaking the whole list
        Ok(rows
            .into_iter()
            .filter_map(|(id, name, group, json)| {
                let body: PresetBody = serde_json::from_str(&json).ok()?;
                Some(PresetRow { id, name, group, groups: body.groups, recipe: body.recipe.sanitized() })
            })
            .collect())
    }

    pub fn preset_create(&mut self, name: &str, group: Option<&str>, groups: &[String], recipe: &Recipe) -> Result<i64, String> {
        let name = clean_label(name, "preset")?;
        let group = match group.map(str::trim).filter(|g| !g.is_empty()) {
            Some(g) => clean_label(g, "group")?,
            None => USER_PRESET_GROUP.to_string(),
        };
        let mut groups: Vec<String> = groups.iter().filter(|g| develop::SETTING_GROUPS.contains(&g.as_str())).cloned().collect();
        groups.dedup();
        if groups.is_empty() {
            return Err("Pick at least one group of settings for the preset.".into());
        }
        let exists: i64 = self
            .conn
            .query_row("select count(*) from preset where type = 'develop' and coalesce(group_name, ?1) = ?2 and lower(name) = lower(?3)", params![USER_PRESET_GROUP, group, name], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if exists > 0 {
            return Err("A preset with that name already exists in this group.".into());
        }
        let body = serde_json::to_string(&PresetBody { groups, recipe: recipe.sanitized() }).map_err(|e| e.to_string())?;
        self.conn
            .execute("insert into preset(type, name, group_name, settings_json) values ('develop', ?1, ?2, ?3)", params![name, group, body])
            .map_err(|e| e.to_string())?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn preset_rename(&mut self, id: i64, name: &str) -> Result<(), String> {
        let name = clean_label(name, "preset")?;
        let group: String = self
            .conn
            .query_row("select coalesce(group_name, ?2) from preset where id = ?1 and type = 'develop'", params![id, USER_PRESET_GROUP], |r| r.get(0))
            .map_err(|_| "That preset no longer exists.".to_string())?;
        let clash: i64 = self
            .conn
            .query_row("select count(*) from preset where type = 'develop' and id <> ?1 and coalesce(group_name, ?2) = ?3 and lower(name) = lower(?4)", params![id, USER_PRESET_GROUP, group, name], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if clash > 0 {
            return Err("A preset with that name already exists in this group.".into());
        }
        self.conn.execute("update preset set name = ?2 where id = ?1", params![id, name]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn preset_delete(&mut self, id: i64) -> Result<(), String> {
        self.conn.execute("delete from preset where id = ?1 and type = 'develop'", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn snapshot_list(&self, photo_id: i64) -> Result<Vec<SnapshotRow>, String> {
        let mut st = self
            .conn
            .prepare("select id, name, created_at, settings_json from snapshot where photo_id = ?1 order by created_at desc, id desc")
            .map_err(|e| e.to_string())?;
        let rows = st
            .query_map([photo_id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        Ok(rows
            .into_iter()
            .filter_map(|(id, name, created_at, json)| Some(SnapshotRow { id, name, created_at, recipe: serde_json::from_str::<Recipe>(&json).ok()?.sanitized() }))
            .collect())
    }

    pub fn snapshot_create(&mut self, photo_id: i64, name: &str, recipe: &Recipe) -> Result<i64, String> {
        let name = clean_label(name, "snapshot")?;
        self.photo_path(photo_id)?;
        let json = serde_json::to_string(&recipe.sanitized()).map_err(|e| e.to_string())?;
        self.conn.execute("insert into snapshot(photo_id, name, settings_json) values (?1, ?2, ?3)", params![photo_id, name, json]).map_err(|e| e.to_string())?;
        let id = self.conn.last_insert_rowid();
        // keep the newest SNAPSHOT_LIMIT per photo
        self.conn
            .execute("delete from snapshot where photo_id = ?1 and id not in (select id from snapshot where photo_id = ?1 order by id desc limit ?2)", params![photo_id, SNAPSHOT_LIMIT])
            .map_err(|e| e.to_string())?;
        Ok(id)
    }

    pub fn snapshot_delete(&mut self, id: i64) -> Result<(), String> {
        self.conn.execute("delete from snapshot where id = ?1", [id]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn kind(&self, id: i64) -> Result<Kind, String> {
        Ok(media::kind_of(&self.photo_path(id)?).unwrap_or(Kind::Raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgb};

    fn make_jpeg(dir: &Path, name: &str, shade: u8, w: u32, h: u32) {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(w, h, |x, y| Rgb([shade, (x % 255) as u8, (y % 255) as u8]));
        img.save(dir.join(name)).unwrap();
    }

    fn setup() -> (tempfile::TempDir, tempfile::TempDir, Catalog) {
        let src = tempfile::tempdir().unwrap();
        let cat_dir = tempfile::tempdir().unwrap();
        make_jpeg(src.path(), "a.jpg", 10, 800, 400);
        make_jpeg(src.path(), "b.jpg", 90, 300, 600);
        fs::create_dir_all(src.path().join("sub")).unwrap();
        make_jpeg(&src.path().join("sub"), "c.jpg", 200, 64, 64);
        fs::write(src.path().join("notes.txt"), "ignore me").unwrap();
        let cat = Catalog::open(cat_dir.path()).unwrap();
        (src, cat_dir, cat)
    }

    /// A JPEG that says it was taken at `when` ("2026:10:19 12:00:00"): an EXIF block with only the original date, put after the JPEG's start.
    fn make_exif_jpeg(dir: &Path, name: &str, shade: u8, when: &str) {
        let img: ImageBuffer<Rgb<u8>, Vec<u8>> = ImageBuffer::from_fn(64, 48, |x, y| Rgb([shade, (x % 255) as u8, (y % 255) as u8]));
        let mut jpeg = Vec::new();
        img.write_to(&mut std::io::Cursor::new(&mut jpeg), image::ImageFormat::Jpeg).unwrap();
        let mut tiff: Vec<u8> = vec![0x49, 0x49, 0x2A, 0, 8, 0, 0, 0];
        tiff.extend([1, 0, 0x69, 0x87, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0]); // IFD0: one entry, the Exif block at 26
        tiff.extend([1, 0, 0x03, 0x90, 2, 0, 20, 0, 0, 0, 44, 0, 0, 0, 0, 0, 0, 0]); // Exif block: the original date, stored at 44
        tiff.extend(when.as_bytes());
        tiff.push(0);
        let mut seg = vec![0xFF, 0xE1];
        seg.extend(((2 + 6 + tiff.len()) as u16).to_be_bytes());
        seg.extend(b"Exif\0\0");
        seg.extend(&tiff);
        let mut out = jpeg[..2].to_vec();
        out.extend(seg);
        out.extend(&jpeg[2..]);
        fs::write(dir.join(name), out).unwrap();
    }

    #[test]
    fn suspected_duplicates_are_skipped_only_when_asked_and_only_for_the_same_name_time_and_camera() {
        let (src, _c, mut cat) = setup();
        let other = tempfile::tempdir().unwrap();
        make_exif_jpeg(src.path(), "IMG_1.jpg", 10, "2026:10:19 12:00:00");
        let first = Catalog::list_files(src.path()).into_iter().filter(|f| f.file_name().unwrap() == "IMG_1.jpg").collect::<Vec<_>>();
        cat.import_files(&first, src.path(), "add", None, |_, _| {}).unwrap();
        // the same shot saved again: different bytes, same name and moment
        make_exif_jpeg(other.path(), "img_1.jpg", 99, "2026:10:19 12:00:00");
        let resaved = Catalog::list_files(other.path());
        let plain = cat.import_files_with(&resaved, other.path(), "add", None, &ImportOpts::default(), |_, _| {}).unwrap();
        assert_eq!((plain.added.len(), plain.duplicates), (1, 0), "off by default: only identical files are skipped");
        let other2 = tempfile::tempdir().unwrap();
        make_exif_jpeg(other2.path(), "img_1.jpg", 150, "2026:10:19 12:00:00");
        let asked = cat.import_files_with(&Catalog::list_files(other2.path()), other2.path(), "add", None, &ImportOpts { skip_suspected: true, ..ImportOpts::default() }, |_, _| {}).unwrap();
        assert_eq!((asked.added.len(), asked.duplicates), (0, 1));
        // another moment, or another name, is a different photo
        let other3 = tempfile::tempdir().unwrap();
        make_exif_jpeg(other3.path(), "img_1.jpg", 180, "2026:10:19 12:00:05");
        make_exif_jpeg(other3.path(), "img_2.jpg", 181, "2026:10:19 12:00:00");
        let different = cat.import_files_with(&Catalog::list_files(other3.path()), other3.path(), "add", None, &ImportOpts { skip_suspected: true, ..ImportOpts::default() }, |_, _| {}).unwrap();
        assert_eq!((different.added.len(), different.duplicates), (2, 0));
    }

    #[test]
    fn deleting_from_the_disk_lists_each_photo_file_and_its_sidecar_once_and_nothing_for_a_virtual_copy() {
        let (src, _c, mut cat) = setup();
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let rows = cat.query(&Query { sort: "name".into(), ..Default::default() }).unwrap().rows;
        let (a, b) = (rows[0].id, rows[1].id);
        fs::write(src.path().join("a.jpg.xmp"), "<x/>").unwrap();
        // b is made a copy of a: it has no file of its own
        cat.conn.execute("update photo set master_id = ?1 where id = ?2", [a, b]).unwrap();
        let files = cat.files_to_delete(&[a, a, b]).unwrap();
        let names: Vec<String> = files.iter().map(|p| p.file_name().unwrap().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["a.jpg".to_string(), "a.jpg.xmp".to_string()]);
        assert!(cat.files_to_delete(&[b]).unwrap().is_empty());
    }

    #[test]
    fn synchronising_a_folder_finds_new_files_and_gone_photos_and_changes_only_what_is_asked() {
        let (src, _c, mut cat) = setup();
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let sub = cat.folders().unwrap().into_iter().find(|f| f.rel_path == "sub").unwrap().id;
        let top = cat.folders().unwrap().into_iter().find(|f| f.rel_path.is_empty()).unwrap().id;
        // nothing has changed yet
        let p = cat.sync_preview(top).unwrap();
        assert_eq!((p.new_files.len(), p.gone.len(), p.present), (0, 0, 3));
        // two new files (one in a folder inside), one file gone
        make_jpeg(src.path(), "new1.jpg", 33, 50, 50);
        fs::create_dir_all(src.path().join("sub").join("deeper")).unwrap();
        make_jpeg(&src.path().join("sub").join("deeper"), "new2.jpg", 44, 50, 50);
        fs::remove_file(src.path().join("b.jpg")).unwrap();
        let p = cat.sync_preview(top).unwrap();
        assert_eq!((p.new_files.len(), p.gone.len(), p.present), (2, 1, 3), "{p:?}");
        assert_eq!(p.gone[0].name, "b.jpg");
        // asked about just the sub folder: its own new file and nothing of the top folder
        let q = cat.sync_preview(sub).unwrap();
        assert_eq!((q.new_files.len(), q.gone.len(), q.present), (1, 0, 1), "{q:?}");
        // the preview changed nothing
        assert_eq!(cat.count().unwrap(), 3);
        // bring the new ones in, and mark the gone one missing
        let files: Vec<PathBuf> = p.new_files.iter().map(PathBuf::from).collect();
        let added = cat.import_files_with(&files, src.path(), "add", None, &ImportOpts::default(), |_, _| {}).unwrap();
        assert_eq!(added.added.len(), 2);
        cat.mark_missing(&p.gone.iter().map(|g| g.id).collect::<Vec<_>>()).unwrap();
        let after = cat.sync_preview(top).unwrap();
        assert_eq!((after.new_files.len(), after.present), (0, 5));
        let missing = cat.query(&Query { sort: "name".into(), ..Default::default() }).unwrap().rows.into_iter().filter(|r| r.missing).count();
        assert_eq!(missing, 1);
        // the new photos are in their own folder rows
        assert!(cat.folders().unwrap().iter().any(|f| f.rel_path == "sub/deeper"));
        // a folder that is not on the disk is refused in words
        fs::remove_dir_all(src.path().join("sub")).unwrap();
        assert!(cat.sync_preview(sub).unwrap_err().contains("not on the disk"));
    }
    #[test]
    fn the_catalog_says_what_it_holds_and_the_room_it_takes() {
        let (src, _c, mut cat) = setup();
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let first = cat.query(&Query::default()).unwrap().rows[0].id;
        cat.virtual_copies(&[first]).unwrap();
        cat.collection_create("A").unwrap();
        cat.keyword_add(&[first], &["Places".into(), "Beach".into()]).unwrap();
        let d = cat.details().unwrap();
        assert_eq!((d.photos, d.virtual_copies, d.collections, d.keywords, d.edited), (3, 1, 1, 2, 0), "{d:?}");
        assert!(d.folders >= 2 && d.catalog_bytes > 0);
        assert_eq!(d.schema_version, SCHEMA_VERSION);
    }
    #[test]
    fn smart_rules_can_be_turned_round_and_grouped_against_the_real_catalog() {
        use crate::smart::{Rule, SmartRules};
        let (src, _c, mut cat) = setup();
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let rows = cat.query(&Query { sort: "name".into(), ..Default::default() }).unwrap().rows;
        cat.set_rating(&[rows[0].id], 5).unwrap();
        cat.set_rating(&[rows[1].id], 2).unwrap();
        cat.set_flag(&[rows[2].id], 1).unwrap();
        let rule = |f: &str, o: &str, v: &str| Rule { field: f.into(), op: o.into(), value: v.into(), ..Default::default() };
        let count = |r: SmartRules| cat.smart_count(&r).unwrap();
        // rating at least 4: one photo; turned round: the other two
        assert_eq!(count(SmartRules { mode: "all".into(), rules: vec![rule("rating", ">=", "4")] }), 1);
        assert_eq!(count(SmartRules { mode: "all".into(), rules: vec![Rule { negate: true, ..rule("rating", ">=", "4") }] }), 2);
        // a photo with no ISO is not "ISO at least 100", so the turned-round rule keeps it
        assert_eq!(count(SmartRules { mode: "all".into(), rules: vec![Rule { negate: true, ..rule("iso", ">=", "100") }] }), 3);
        // (rating 5 or picked) and not rated 2: the first and the third
        let g = Rule { field: "group".into(), op: "group".into(), group: Some(Box::new(SmartRules { mode: "any".into(), rules: vec![rule("rating", "=", "5"), rule("flag", "is", "pick")] })), ..Default::default() };
        assert_eq!(count(SmartRules { mode: "all".into(), rules: vec![g.clone(), Rule { negate: true, ..rule("rating", "=", "2") }] }), 2);
        assert_eq!(count(SmartRules { mode: "all".into(), rules: vec![Rule { negate: true, ..g }] }), 1);
    }
    #[test]
    fn all_fifteen_details_are_kept_written_to_the_sidecar_and_read_back_and_an_older_catalog_gets_the_new_columns() {
        let (src, c, mut cat) = setup();
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let rows = cat.query(&Query::default()).unwrap().rows;
        let (a, b) = (rows[0].id, rows[1].id);
        let patch = MetaPatch {
            credit: Some("Credit".into()),
            source: Some("Card".into()),
            sublocation: Some("Main street".into()),
            city: Some("Paarl".into()),
            state: Some("WC".into()),
            country: Some("South Africa".into()),
            headline: Some("Dawn".into()),
            job_title: Some("Photographer".into()),
            instructions: Some("No crop".into()),
            job_id: Some("J-1".into()),
            usage_terms: Some("Editorial".into()),
            ..Default::default()
        };
        cat.metadata_set(&[a], &patch).unwrap();
        let view = cat.metadata_get(&[a]).unwrap();
        assert_eq!((view.headline[0].as_str(), view.job_title[0].as_str(), view.job_id[0].as_str(), view.usage_terms[0].as_str(), view.instructions[0].as_str()), ("Dawn", "Photographer", "J-1", "Editorial", "No crop"));
        // written to a sidecar and read into another photo: all the details arrive
        let text = crate::xmp::write(&cat.sidecar_data(a).unwrap());
        assert!(text.contains("<photoshop:City>Paarl</photoshop:City>") && text.contains("<photoshop:TransmissionReference>J-1</photoshop:TransmissionReference>"), "{text}");
        let sc = crate::xmp::parse(&text).unwrap();
        let changed = cat.apply_sidecar(b, &sc).unwrap();
        assert!(["credit", "source", "sublocation", "city", "state", "country", "headline", "job_title", "instructions", "job_id", "usage_terms"].iter().all(|n| changed.contains(n)), "{changed:?}");
        let other = cat.metadata_get(&[b]).unwrap();
        assert_eq!((other.city[0].as_str(), other.country[0].as_str(), other.usage_terms[0].as_str()), ("Paarl", "South Africa", "Editorial"));
        // a catalog made before the five new columns existed gets them when it is opened
        drop(cat);
        {
            let conn = Connection::open(c.path().join("catalog.db")).unwrap();
            conn.execute_batch("alter table iptc drop column headline; alter table iptc drop column job_title; alter table iptc drop column instructions; alter table iptc drop column job_id; alter table iptc drop column usage_terms;").unwrap();
        }
        let cat = Catalog::open(c.path()).unwrap();
        assert_eq!(cat.metadata_get(&[a]).unwrap().headline, vec![String::new()], "the column is back, empty");
    }

    #[test]
    fn keyword_synonyms_are_kept_tidy_and_a_private_keyword_stays_out_of_the_sidecar() {
        let (src, _c, mut cat) = setup();
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let id = cat.query(&Query::default()).unwrap().rows[0].id;
        let beach = cat.keyword_add(&[id], &["Places".into(), "Beach".into()]).unwrap();
        let secret = cat.keyword_add(&[id], &["Client list".into()]).unwrap();
        cat.keyword_set_options(beach, "  seaside ,Shore,  SEASIDE, , sand  coast", true, false).unwrap();
        let row = cat.keywords().unwrap().into_iter().find(|k| k.id == beach).unwrap();
        assert_eq!(row.synonyms, "seaside, Shore, sand coast", "tidied, and the repeat (in any case) dropped");
        assert!(row.include_on_export && !row.is_private);
        assert!(cat.keyword_set_options(beach, &"x".repeat(101), true, false).is_err());
        assert!(cat.keyword_set_options(beach, &(0..21).map(|i| format!("w{i}")).collect::<Vec<_>>().join(","), true, false).is_err());
        assert!(cat.keyword_set_options(9999, "", true, false).is_err());
        // a private keyword is in the catalog and the sidecar leaves it out; so does a keyword switched off for export
        assert!(cat.sidecar_data(id).unwrap().keywords.iter().any(|p| p == &vec!["Client list".to_string()]));
        cat.keyword_set_options(secret, "", true, true).unwrap();
        let kws = cat.sidecar_data(id).unwrap().keywords;
        assert!(!kws.iter().any(|p| p == &vec!["Client list".to_string()]) && kws.iter().any(|p| p.last().map(|s| s.as_str()) == Some("Beach")));
        assert!(cat.keywords().unwrap().iter().any(|k| k.id == secret), "still in the catalog");
        cat.keyword_set_options(beach, "", false, false).unwrap();
        assert!(cat.sidecar_data(id).unwrap().keywords.is_empty());
        assert_eq!(cat.keywords().unwrap().into_iter().find(|k| k.id == beach).unwrap().synonyms, "");
    }

    #[test]
    fn collection_sets_hold_collections_and_sets_and_deleting_a_set_keeps_what_was_in_it() {
        let (_src, _c, cat) = setup();
        let weddings = cat.collection_set_create("Weddings", None).unwrap();
        let y2026 = cat.collection_set_create("2026", Some(weddings)).unwrap();
        let ana = cat.collection_create("Ana and Tom").unwrap();
        cat.collection_move(ana, Some(y2026)).unwrap();
        let rows = cat.collections().unwrap();
        let by = |id: i64| rows.iter().find(|c| c.id == id).unwrap().clone();
        assert_eq!((by(y2026).kind.as_str(), by(y2026).parent_id), ("set", Some(weddings)));
        assert_eq!(by(ana).parent_id, Some(y2026));
        // a set cannot go inside itself or something in it; a collection cannot hold a collection
        assert!(cat.collection_move(weddings, Some(y2026)).unwrap_err().contains("inside itself"));
        assert!(cat.collection_move(weddings, Some(weddings)).is_err());
        assert!(cat.collection_move(ana, Some(ana)).unwrap_err().contains("only be put inside a collection set"));
        assert!(cat.collection_set_create("x", Some(ana)).is_err());
        // renaming a set works; the quick collection cannot be moved
        cat.collection_rename(y2026, "Summer 2026").unwrap();
        let quick = cat.collections().unwrap().into_iter().find(|c| c.kind == "quick").unwrap().id;
        assert!(cat.collection_move(quick, Some(weddings)).is_err());
        // deleting the middle set moves what was in it up one level
        cat.collection_delete(y2026).unwrap();
        let after = cat.collections().unwrap();
        assert_eq!(after.iter().find(|c| c.id == ana).unwrap().parent_id, Some(weddings));
        assert!(after.iter().all(|c| c.id != y2026));
        // taking a collection out of its set
        cat.collection_move(ana, None).unwrap();
        assert_eq!(cat.collections().unwrap().iter().find(|c| c.id == ana).unwrap().parent_id, None);
    }

    #[test]
    fn a_virtual_copy_can_be_named_and_starts_with_the_originals_history_and_the_filter_can_hide_copies() {
        let (_src, _c, mut cat, rows) = imported();
        let a = rows[0].id;
        cat.conn.execute("insert into history_step(photo_id, seq, label, patch_json) values (?1, 1, 'Exposure', '{}')", [a]).unwrap();
        cat.conn.execute("insert into snapshot(photo_id, name, settings_json) values (?1, 'Start', '{}')", [a]).unwrap();
        let made = cat.virtual_copies(&[a, a]).unwrap();
        let (c1, c2) = (made[0].1, made[1].1);
        let count = |table: &str, id: i64| -> i64 { cat.conn.query_row(&format!("select count(*) from {table} where photo_id = ?1"), [id], |r| r.get(0)).unwrap() };
        assert_eq!((count("history_step", c1), count("snapshot", c1)), (1, 1), "the copy has the History and snapshots too");
        cat.rename_copy(c1, "  Black   and white ").unwrap();
        let name = |id: i64| cat.query(&Query::default()).unwrap().rows.into_iter().find(|p| p.id == id).unwrap().copy_name;
        assert_eq!(name(c1).as_deref(), Some("Black and white"));
        assert!(cat.rename_copy(c2, "black and WHITE").unwrap_err().contains("already"));
        assert!(cat.rename_copy(c2, "").is_err() && cat.rename_copy(c2, &"x".repeat(41)).is_err());
        assert!(cat.rename_copy(a, "x").unwrap_err().contains("virtual copy"), "an original is not named");
        let total = cat.query(&Query::default()).unwrap().total;
        assert_eq!(cat.query(&Query { copies: Some("no".into()), ..Default::default() }).unwrap().total, total - 2);
        assert_eq!(cat.query(&Query { copies: Some("only".into()), ..Default::default() }).unwrap().total, 2);
    }

    #[test]
    fn one_photo_can_be_reconnected_to_a_file_chosen_by_hand() {
        let (src, _c, cat, rows) = imported();
        let a = rows.iter().find(|p| p.name.starts_with('a')).unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        fs::copy(src.path().join("a.jpg"), elsewhere.path().join("renamed.jpg")).unwrap();
        fs::remove_file(src.path().join("a.jpg")).unwrap();
        cat.scan_missing(|_, _| {}).unwrap();
        assert!(cat.relink_photo(a.id, &elsewhere.path().join("nothing.jpg")).is_err());
        fs::write(elsewhere.path().join("notes.txt"), "x").unwrap();
        assert!(cat.relink_photo(a.id, &elsewhere.path().join("notes.txt")).unwrap_err().contains("not a photo file"));
        cat.relink_photo(a.id, &elsewhere.path().join("renamed.jpg")).unwrap();
        let path = cat.photo_path(a.id).unwrap();
        assert!(path.is_file() && path.ends_with("renamed.jpg"), "{path:?}");
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 0);
        // a file that already belongs to another photo is refused
        let b = rows.iter().find(|p| p.name.starts_with('b')).unwrap();
        assert!(cat.relink_photo(b.id, &elsewhere.path().join("renamed.jpg")).is_err());
    }

    #[test]
    fn a_renamed_file_is_found_by_what_is_inside_it() {
        let (src, _c, cat, rows) = imported();
        let shelf = tempfile::tempdir().unwrap();
        fs::create_dir_all(shelf.path().join("moved")).unwrap();
        // a is renamed and moved; b is gone for good, and a different file of the same size is not b
        let a = rows.iter().find(|p| p.name.starts_with('a')).unwrap();
        fs::rename(src.path().join("a.jpg"), shelf.path().join("moved/holiday-001.jpg")).unwrap();
        let b_len = fs::metadata(src.path().join("b.jpg")).unwrap().len() as usize;
        fs::remove_file(src.path().join("b.jpg")).unwrap();
        fs::write(shelf.path().join("moved/other.jpg"), vec![7u8; b_len]).unwrap();
        cat.scan_missing(|_, _| {}).unwrap();
        let out = cat.relink_by_search(shelf.path(), |_| {}).unwrap();
        assert_eq!((out.relinked, out.by_content, out.conflicts), (1, 1, 0), "{out:?}");
        let path = cat.photo_path(a.id).unwrap();
        assert!(path.is_file() && path.to_string_lossy().contains("holiday-001"), "{path:?}");
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 1, "b is still missing: the same-size file has other contents");
    }

    #[test]
    fn folders_can_be_renamed_and_moved_with_what_is_inside_them() {
        let (src, _c, mut cat) = setup();
        fs::create_dir_all(src.path().join("sub").join("deep")).unwrap();
        make_jpeg(&src.path().join("sub").join("deep"), "d.jpg", 50, 40, 40);
        fs::create_dir_all(src.path().join("other")).unwrap();
        make_jpeg(&src.path().join("other"), "e.jpg", 60, 40, 40);
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let id_of = |cat: &Catalog, rel: &str| cat.folders().unwrap().into_iter().find(|f| f.rel_path == rel).map(|f| f.id);
        let sub = id_of(&cat, "sub").unwrap();
        // rename: the folder on the disk and every row inside it follow
        cat.rename_folder(sub, "inner").unwrap();
        assert!(src.path().join("inner").join("deep").join("d.jpg").is_file() && !src.path().join("sub").exists());
        let rels: Vec<String> = cat.folders().unwrap().into_iter().map(|f| f.rel_path).collect();
        assert!(rels.contains(&"inner".to_string()) && rels.contains(&"inner/deep".to_string()) && !rels.contains(&"sub".to_string()));
        let photo = cat.query(&Query::default()).unwrap().rows.into_iter().find(|p| p.name.starts_with("d")).unwrap();
        assert!(cat.photo_path(photo.id).unwrap().is_file(), "photos are still found after the rename");
        // refused: a bad name, a name already taken
        assert!(cat.rename_folder(sub, "a/b").is_err());
        assert!(cat.rename_folder(sub, "other").unwrap_err().contains("already"));
        // move into another folder, and back to the top
        let other = id_of(&cat, "other").unwrap();
        cat.move_folder(sub, Some(other)).unwrap();
        assert!(src.path().join("other").join("inner").join("deep").join("d.jpg").is_file());
        assert!(id_of(&cat, "other/inner/deep").is_some());
        assert!(cat.move_folder(other, Some(sub)).unwrap_err().contains("itself"));
        cat.move_folder(sub, None).unwrap();
        assert!(src.path().join("inner").join("deep").is_dir() && id_of(&cat, "inner").is_some());
        // the top of the imported place is renamed where it is, and the catalog follows
        let top = id_of(&cat, "").unwrap();
        assert!(cat.move_folder(top, None).is_err());
        let new_name = format!("Renamed place {}", uuid::Uuid::new_v4());
        cat.rename_folder(top, &new_name).unwrap();
        let moved = src.path().parent().unwrap().join(&new_name);
        assert!(moved.join("inner").join("deep").join("d.jpg").is_file());
        let any = cat.query(&Query::default()).unwrap().rows.first().unwrap().id;
        assert!(cat.photo_path(any).unwrap().is_file());
        // the temporary folder is gone from its old name, so put it back for the test folder to clean up, and remove the renamed one
        let _ = fs::remove_dir_all(&moved);
    }

    #[test]
    fn imports_in_place_and_skips_duplicates() {
        let (src, _c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        assert_eq!(files.len(), 3, "txt file must be ignored");
        let r = cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        assert_eq!(r.added.len(), 3);
        assert_eq!(cat.count().unwrap(), 3);
        let again = cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        assert_eq!(again.added.len(), 0);
        assert_eq!(again.duplicates, 3);
        // originals untouched
        assert!(src.path().join("a.jpg").exists());
    }

    #[test]
    fn a_folder_can_be_listed_with_or_without_the_folders_inside_it() {
        let src = tempfile::tempdir().unwrap();
        fs::create_dir(src.path().join("Day 2")).unwrap();
        fs::write(src.path().join("a.jpg"), b"x").unwrap();
        fs::write(src.path().join("Day 2").join("b.jpg"), b"x").unwrap();
        assert_eq!(Catalog::list_files_in(src.path(), true).len(), 2);
        let top = Catalog::list_files_in(src.path(), false);
        assert_eq!(top.len(), 1);
        assert!(top[0].ends_with("a.jpg"));
        assert_eq!(Catalog::list_files(src.path()).len(), 2, "the usual listing still goes into sub-folders");
    }

    #[test]
    fn copy_mode_leaves_source_and_files_into_dated_folder() {
        let (src, _c, mut cat) = setup();
        let dest = tempfile::tempdir().unwrap();
        let files = Catalog::list_files(src.path());
        let r = cat.import_files(&files, src.path(), "copy", Some(dest.path()), |_, _| {}).unwrap();
        assert_eq!(r.added.len(), 3);
        for (_, p) in &r.added {
            assert!(Path::new(p).starts_with(path_str(dest.path())) || p.starts_with(&path_str(dest.path())), "{p}");
            assert!(Path::new(p).exists());
        }
        assert!(Catalog::list_files(src.path()).len() == 3);
        assert!(cat.import_files(&files, src.path(), "copy", None, |_, _| {}).is_err());
    }

    #[test]
    fn query_filters_sorts_and_pages() {
        let (src, _c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        let all = cat.query(&Query { sort: "name".into(), ..Default::default() }).unwrap();
        assert_eq!(all.total, 3);
        assert_eq!(all.rows[0].name, "a.jpg");
        let ids: Vec<i64> = all.rows.iter().map(|r| r.id).collect();
        cat.set_rating(&ids[..2], 4).unwrap();
        cat.set_flag(&ids[..1], 1).unwrap();
        cat.set_label(&ids[1..2], Some("green")).unwrap();
        assert_eq!(cat.query(&Query { min_rating: Some(4), ..Default::default() }).unwrap().total, 2);
        assert_eq!(cat.query(&Query { flag: Some("pick".into()), ..Default::default() }).unwrap().total, 1);
        assert_eq!(cat.query(&Query { label: Some("green".into()), ..Default::default() }).unwrap().total, 1);
        assert_eq!(cat.query(&Query { text: Some("b.".into()), ..Default::default() }).unwrap().total, 0);
        assert_eq!(cat.query(&Query { text: Some("b".into()), ..Default::default() }).unwrap().total, 1);
        let page = cat.query(&Query { sort: "name".into(), offset: 1, limit: 1, ..Default::default() }).unwrap();
        assert_eq!((page.total, page.rows.len(), page.rows[0].name.as_str()), (3, 1, "b.jpg"));
        // reverse
        let d = cat.query(&Query { sort: "name".into(), desc: true, ..Default::default() }).unwrap();
        assert_eq!(d.rows[0].name, "c.jpg");
    }

    #[test]
    fn rejects_bad_values_and_sql_metacharacters_are_data() {
        let (src, _c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        assert!(cat.set_rating(&[1], 6).is_err());
        assert!(cat.set_flag(&[1], 2).is_err());
        assert!(cat.set_label(&[1], Some("pink")).is_err());
        let evil = cat.query(&Query { text: Some("'; drop table photo; --".into()), ..Default::default() }).unwrap();
        assert_eq!(evil.total, 0);
        assert_eq!(cat.count().unwrap(), 3);
        let weird = cat.query(&Query { sort: "name; drop table photo".into(), ..Default::default() }).unwrap();
        assert_eq!(weird.total, 3);
    }

    #[test]
    fn previews_and_export_respect_size_and_never_touch_originals() {
        let (src, _c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        let r = cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        let (id, p) = &r.added[0];
        media::build_previews(Path::new(p), &cat.previews_dir(), *id).unwrap();
        let th = image::open(media::preview_path(&cat.previews_dir(), *id, "thumb")).unwrap();
        assert!(th.width().max(th.height()) <= media::THUMB_EDGE);
        let before = fs::read(p).unwrap();
        let out = tempfile::tempdir().unwrap();
        let o1 = media::export_jpeg(Path::new(p), out.path(), 200, 85, None, crate::colour::Space::Srgb).unwrap();
        let o2 = media::export_jpeg(Path::new(p), out.path(), 0, 85, None, crate::colour::Space::Srgb).unwrap();
        assert_ne!(o1, o2, "second export must not overwrite the first");
        assert_eq!(image::open(&o1).unwrap().width(), 200);
        assert_eq!(image::open(&o2).unwrap().width(), 800);
        assert_eq!(fs::read(p).unwrap(), before);
    }

    fn setup_imported() -> (tempfile::TempDir, tempfile::TempDir, Catalog, Vec<i64>) {
        let (src, c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        let r = cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        let ids = r.added.iter().map(|(id, _)| *id).collect();
        (src, c, cat, ids)
    }

    // ---- choosing which photos to import ----

    fn names(files: &[PathBuf]) -> Vec<String> {
        files.iter().map(|f| f.file_name().unwrap().to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn only_the_chosen_photos_are_picked_in_folder_order_and_each_once() {
        let (src, _c, _cat) = setup();
        let all = Catalog::list_files(src.path());
        assert_eq!(names(&all), ["a.jpg", "b.jpg", "c.jpg"]);
        let path = |n: &str| all.iter().find(|f| f.file_name().unwrap() == n).unwrap().to_string_lossy().into_owned();
        // asked out of order and with a repeat: still in listing order, once each
        let picked = Catalog::pick_files(src.path(), &[path("c.jpg"), path("a.jpg"), path("c.jpg")]);
        assert_eq!(names(&picked), ["a.jpg", "c.jpg"]);
        assert!(Catalog::pick_files(src.path(), &[]).is_empty(), "nothing chosen is nothing picked");
    }

    #[test]
    fn files_outside_the_folder_unsupported_files_and_missing_ones_are_ignored() {
        let (src, _c, _cat) = setup();
        let other = tempfile::tempdir().unwrap();
        make_jpeg(other.path(), "elsewhere.jpg", 50, 40, 40);
        let inside = Catalog::list_files(src.path())[0].to_string_lossy().into_owned();
        let requested = vec![
            inside.clone(),
            other.path().join("elsewhere.jpg").to_string_lossy().into_owned(),
            src.path().join("notes.txt").to_string_lossy().into_owned(),
            src.path().join("gone.jpg").to_string_lossy().into_owned(),
            // an attempt to climb out of the folder by a relative path
            src.path().join("..").join(other.path().file_name().unwrap()).join("elsewhere.jpg").to_string_lossy().into_owned(),
        ];
        let picked = Catalog::pick_files(src.path(), &requested);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].to_string_lossy(), inside);
    }

    #[test]
    fn importing_the_picked_photos_adds_only_those() {
        let (src, _c, mut cat) = setup();
        let all = Catalog::list_files(src.path());
        let chosen = vec![all[1].to_string_lossy().into_owned()];
        let files = Catalog::pick_files(src.path(), &chosen);
        let r = cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        assert_eq!(r.added.len(), 1);
        assert_eq!(cat.count().unwrap(), 1, "the others are not in the catalog");
        // importing the rest later adds the rest, and the one already there is a duplicate
        let rest = cat.import_files(&all, src.path(), "add", None, |_, _| {}).unwrap();
        assert_eq!((rest.added.len(), rest.duplicates), (2, 1));
    }

    #[test]
    fn a_source_thumbnail_is_a_small_jpeg_in_proportion_for_wide_and_tall_photos_and_refuses_other_files() {
        let (src, _c, _cat) = setup();
        let wide = media::source_thumb(&src.path().join("a.jpg"), 160).unwrap(); // 800 x 400
        let img = image::load_from_memory(&wide).unwrap();
        assert_eq!((img.width(), img.height()), (160, 80));
        let tall = image::load_from_memory(&media::source_thumb(&src.path().join("b.jpg"), 160).unwrap()).unwrap(); // 300 x 600
        assert_eq!((tall.width(), tall.height()), (80, 160));
        let small = image::load_from_memory(&media::source_thumb(&src.path().join("sub").join("c.jpg"), 160).unwrap()).unwrap(); // 64 x 64 is not enlarged
        assert_eq!((small.width(), small.height()), (64, 64));
        assert!(media::source_thumb(&src.path().join("notes.txt"), 160).is_err());
        assert!(media::source_thumb(&src.path().join("missing.jpg"), 160).is_err());
    }

    // ---- filtering by camera, lens and settings ----

    /// Three photos with different gear: a Canon at ISO 100, a Sony at ISO 3200, a bare "Nikon" with nothing else known.
    fn with_gear() -> (tempfile::TempDir, tempfile::TempDir, Catalog, Vec<i64>) {
        let (s, c, cat, ids) = setup_imported();
        let rows: [(Option<&str>, Option<&str>, Option<&str>, Option<i64>, Option<f64>, Option<f64>, Option<&str>); 3] = [
            (Some("Canon"), Some("Canon EOS R6"), Some("RF50mm F1.8 STM"), Some(100), Some(1.8), Some(50.0), Some("2026-05-10T10:00:00")),
            (Some("SONY"), Some("ILCE-7M3"), Some("FE 24-70mm F2.8 GM"), Some(3200), Some(2.8), Some(70.0), Some("2026-05-12T09:00:00")),
            (Some("Nikon"), None, None, None, None, None, None),
        ];
        for (id, (make, model, lens, iso, aperture, focal, taken)) in ids.iter().zip(rows) {
            cat.conn.execute("insert or replace into exif(photo_id, make, model, lens, iso, aperture, focal_mm) values (?1,?2,?3,?4,?5,?6,?7)", params![id, make, model, lens, iso, aperture, focal]).unwrap();
            cat.conn.execute("update photo set captured_local = ?1, file_mtime = '2026-07-04T08:00:00Z' where id = ?2", params![taken, id]).unwrap();
        }
        (s, c, cat, ids)
    }
    fn found(cat: &Catalog, q: Query) -> Vec<i64> {
        let page = cat.query(&Query { sort: "name".into(), ..q }).unwrap();
        page.rows.iter().map(|r| r.id).collect()
    }

    #[test]
    fn culling_gets_the_file_names_and_capture_times_and_skips_photos_that_are_gone() {
        let (_s, _c, cat, ids) = with_gear();
        let info = cat.cull_info(&[ids[0], ids[2], 99_999]).unwrap();
        assert_eq!(info.len(), 2, "a photo that is not in the catalog is left out");
        assert_eq!(info[&ids[0]].1.as_deref(), Some("2026-05-10T10:00:00"));
        assert!(info[&ids[0]].0.contains('.'), "{:?}", info[&ids[0]]);
        assert_eq!(info[&ids[2]].1, None, "no capture time is None");
    }

    #[test]
    fn the_camera_and_the_lens_are_matched_exactly_by_the_names_the_grid_shows() {
        let (_s, _c, cat, ids) = with_gear();
        assert_eq!(found(&cat, Query { camera: Some("Canon EOS R6".into()), ..Default::default() }), [ids[0]], "the make is not repeated when the model starts with it");
        assert_eq!(found(&cat, Query { camera: Some("SONY ILCE-7M3".into()), ..Default::default() }), [ids[1]], "the make goes in front otherwise");
        assert_eq!(found(&cat, Query { camera: Some("Nikon".into()), ..Default::default() }), [ids[2]], "a make with no model");
        assert!(found(&cat, Query { camera: Some("Canon".into()), ..Default::default() }).is_empty(), "a part of a name is not the name");
        assert!(found(&cat, Query { camera: Some("canon eos r6".into()), ..Default::default() }).len() <= 1);
        assert_eq!(found(&cat, Query { lens: Some("FE 24-70mm F2.8 GM".into()), ..Default::default() }), [ids[1]]);
        assert_eq!(found(&cat, Query { camera: Some(String::new()), lens: Some(String::new()), ..Default::default() }).len(), 3, "an empty choice is no choice");
        // the page shows the same name the filter takes
        let page = cat.query(&Query { camera: Some("SONY ILCE-7M3".into()), ..Default::default() }).unwrap();
        assert_eq!(page.rows[0].camera.as_deref(), Some("SONY ILCE-7M3"));
    }

    #[test]
    fn a_range_includes_both_ends_and_leaves_out_photos_that_do_not_know_the_value() {
        let (_s, _c, cat, ids) = with_gear();
        let iso = |lo, hi| found(&cat, Query { min_iso: lo, max_iso: hi, ..Default::default() });
        assert_eq!(iso(Some(100), None), [ids[0], ids[1]], "the bare Nikon has no ISO, so it is not 'at least 100'");
        assert_eq!(iso(Some(101), None), [ids[1]]);
        assert_eq!(iso(None, Some(100)), [ids[0]]);
        assert_eq!(iso(Some(100), Some(3200)), [ids[0], ids[1]]);
        assert_eq!(iso(Some(3201), None), Vec::<i64>::new());
        assert_eq!(iso(None, None).len(), 3, "no range is no filter, the Nikon included");
        let focal = |lo, hi| found(&cat, Query { min_focal: lo, max_focal: hi, ..Default::default() });
        assert_eq!(focal(Some(50.0), Some(50.0)), [ids[0]]);
        assert_eq!(focal(Some(51.0), Some(100.0)), [ids[1]]);
        let aperture = |lo, hi| found(&cat, Query { min_aperture: lo, max_aperture: hi, ..Default::default() });
        assert_eq!(aperture(Some(1.8), Some(1.8)), [ids[0]], "f/1.8 is f/1.8");
        assert_eq!(aperture(Some(2.0), None), [ids[1]]);
        assert_eq!(aperture(None, Some(2.0)), [ids[0]]);
    }

    #[test]
    fn the_date_range_is_the_day_taken_or_the_file_date_when_there_is_no_capture_time() {
        let (_s, _c, cat, ids) = with_gear();
        let days = |from: Option<&str>, to: Option<&str>| found(&cat, Query { date_from: from.map(String::from), date_to: to.map(String::from), ..Default::default() });
        assert_eq!(days(Some("2026-05-11"), None), [ids[1], ids[2]], "the Nikon has no capture time, so its file date (4 July) counts");
        assert_eq!(days(None, Some("2026-05-11")), [ids[0]]);
        assert_eq!(days(Some("2026-05-10"), Some("2026-05-10")), [ids[0]], "one whole day, both ends in");
        assert_eq!(days(Some("2026-05-12"), Some("2026-05-12")), [ids[1]], "a photo taken at 09:00 is on that day, not before it");
        assert_eq!(days(Some("2026-07-04"), Some("2026-07-04")), [ids[2]]);
        // a date that is not a date is ignored rather than breaking the search or emptying it
        assert_eq!(days(Some("yesterday"), Some("2026-13-45")).len(), 3);
        assert_eq!(days(Some("2026-5-1"), None).len(), 3);
    }

    #[test]
    fn filters_combine_with_each_other_and_with_the_others_and_nothing_can_be_injected() {
        let (_s, _c, mut cat, ids) = with_gear();
        assert_eq!(found(&cat, Query { camera: Some("SONY ILCE-7M3".into()), min_iso: Some(3000), ..Default::default() }), [ids[1]]);
        assert!(found(&cat, Query { camera: Some("Canon EOS R6".into()), min_iso: Some(3000), ..Default::default() }).is_empty());
        cat.set_rating(&[ids[0]], 4).unwrap();
        assert_eq!(found(&cat, Query { min_rating: Some(3), max_iso: Some(200), ..Default::default() }), [ids[0]]);
        assert!(found(&cat, Query { camera: Some("x' or '1'='1".into()), ..Default::default() }).is_empty());
        assert!(found(&cat, Query { lens: Some("%".into()), ..Default::default() }).is_empty(), "a percent sign is a character here, not a wild card");
        // the number of photos and the ids agree with the page, which is what the grid and Select all rely on
        let q = Query { min_iso: Some(100), ..Default::default() };
        assert_eq!(cat.query(&q).unwrap().total, 2);
        assert_eq!(cat.photo_ids(&q).unwrap().len(), 2);
    }

    #[test]
    fn the_catalog_can_list_what_it_holds_for_the_filter_to_offer() {
        let (_s, _c, cat, _ids) = with_gear();
        let v = cat.metadata_values().unwrap();
        assert_eq!(v.cameras, [Counted { name: "Canon EOS R6".into(), count: 1 }, Counted { name: "Nikon".into(), count: 1 }, Counted { name: "SONY ILCE-7M3".into(), count: 1 }], "in alphabetical order, ignoring case");
        assert_eq!(v.lenses, [Counted { name: "FE 24-70mm F2.8 GM".into(), count: 1 }, Counted { name: "RF50mm F1.8 STM".into(), count: 1 }]);
        assert_eq!(v.iso, Some((100, 3200)));
        assert_eq!(v.focal, Some((50.0, 70.0)));
        assert_eq!(v.aperture, Some((1.8, 2.8)));
        assert_eq!(v.days, Some(("2026-05-10".into(), "2026-07-04".into())));
        // two photos from the same camera are counted together
        cat.conn.execute("update exif set make = 'Canon', model = 'Canon EOS R6' where photo_id = ?1", [_ids[1]]).unwrap();
        assert_eq!(cat.metadata_values().unwrap().cameras.iter().find(|c| c.name == "Canon EOS R6").unwrap().count, 2);
    }

    #[test]
    fn an_empty_catalog_has_nothing_to_offer_and_the_page_can_send_the_filters_by_name() {
        let (_s, _c, cat) = setup();
        assert_eq!(cat.metadata_values().unwrap(), MetadataValues::default());
        let q: Query = serde_json::from_str(r#"{"camera":"Canon EOS R6","minIso":100,"maxFocal":85.5,"dateFrom":"2026-05-11","sort":"name"}"#).unwrap();
        assert_eq!((q.camera.as_deref(), q.min_iso, q.max_focal, q.date_from.as_deref()), (Some("Canon EOS R6"), Some(100), Some(85.5), Some("2026-05-11")));
        assert!(q.lens.is_none() && q.max_iso.is_none() && q.date_to.is_none());
        let none: Query = serde_json::from_str("{}").unwrap();
        assert!(none.camera.is_none() && none.min_aperture.is_none());
    }

    #[test]
    fn quick_collection_exists_once_and_toggles() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let cols = cat.collections().unwrap();
        assert_eq!(cols.iter().filter(|c| c.kind == "quick").count(), 1);
        assert_eq!(cols[0].kind, "quick", "Quick Collection is listed first");
        assert!(cat.quick_toggle(&ids[..2]).unwrap(), "first press adds");
        assert_eq!(cat.collections().unwrap()[0].count, 2);
        assert!(cat.quick_toggle(&ids[..3]).unwrap(), "not all were in, so it adds all");
        assert_eq!(cat.collections().unwrap()[0].count, 3);
        assert!(!cat.quick_toggle(&ids[..3]).unwrap(), "all were in, so it removes");
        assert_eq!(cat.collections().unwrap()[0].count, 0);
        // reopening must not create a second Quick Collection
        let root = cat.root.clone();
        drop(cat);
        let again = Catalog::open(&root).unwrap();
        assert_eq!(again.collections().unwrap().iter().filter(|c| c.kind == "quick").count(), 1);
    }

    #[test]
    fn collections_crud_target_and_filter() {
        let (_s, _c, mut cat, ids) = setup_imported();
        assert!(cat.collection_create("   ").is_err());
        assert!(cat.collection_create(&"x".repeat(101)).is_err());
        let a = cat.collection_create("  Best   of  ").unwrap();
        let b = cat.collection_create("Second").unwrap();
        assert_eq!(cat.collections().unwrap().iter().find(|c| c.id == a).unwrap().name, "Best of");
        cat.collection_add(a, &ids[..2]).unwrap();
        cat.collection_add(a, &ids[..2]).unwrap(); // adding twice must not duplicate
        assert_eq!(cat.query(&Query { collection_id: Some(a), ..Default::default() }).unwrap().total, 2);
        cat.collection_remove(a, &ids[..1]).unwrap();
        assert_eq!(cat.query(&Query { collection_id: Some(a), ..Default::default() }).unwrap().total, 1);
        // only one target at a time
        cat.collection_set_target(Some(a)).unwrap();
        cat.collection_set_target(Some(b)).unwrap();
        let targets: Vec<i64> = cat.collections().unwrap().into_iter().filter(|c| c.is_target).map(|c| c.id).collect();
        assert_eq!(targets, vec![b]);
        cat.collection_set_target(None).unwrap();
        assert!(cat.collections().unwrap().iter().all(|c| !c.is_target));
        // the Quick Collection cannot be renamed or deleted
        let quick = cat.collections().unwrap()[0].id;
        assert!(cat.collection_rename(quick, "Nope").is_err());
        assert!(cat.collection_delete(quick).is_err());
        // deleting a collection keeps the photos
        cat.collection_delete(a).unwrap();
        assert_eq!(cat.count().unwrap(), 3);
        assert!(cat.collection_add(a, &ids).is_err(), "adding to a deleted collection is an error");
    }

    #[test]
    fn keywords_hierarchy_counts_and_filter_include_children() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let leaf = cat.keyword_add(&ids[..2], &["Places".into(), "Beach".into()]).unwrap();
        let same = cat.keyword_add(&ids[1..2], &["places".into(), "BEACH".into()]).unwrap();
        assert_eq!(leaf, same, "keywords match without regard to case");
        assert!(cat.keyword_add(&ids, &[]).is_err());
        assert!(cat.keyword_add(&ids, &["a".into(), "b".into(), "c".into(), "d".into()]).is_err());
        assert!(cat.keyword_add(&ids, &["   ".into()]).is_err());
        cat.keyword_add(&ids[2..], &["Places".into()]).unwrap();
        let kws = cat.keywords().unwrap();
        let places = kws.iter().find(|k| k.name == "Places").unwrap();
        let beach = kws.iter().find(|k| k.name == "Beach").unwrap();
        assert_eq!(beach.parent_id, Some(places.id));
        assert_eq!(beach.count, 2);
        assert_eq!(places.count, 3, "a parent counts photos below it, once each");
        // filtering by the parent includes the children
        assert_eq!(cat.query(&Query { keyword_id: Some(places.id), ..Default::default() }).unwrap().total, 3);
        assert_eq!(cat.query(&Query { keyword_id: Some(beach.id), ..Default::default() }).unwrap().total, 2);
        let uses = cat.keywords_for(&ids).unwrap();
        assert_eq!(uses.iter().find(|u| u.keyword_id == beach.id).unwrap().count, 2);
        cat.keyword_remove(&ids[..1], beach.id).unwrap();
        assert_eq!(cat.keywords().unwrap().iter().find(|k| k.name == "Beach").unwrap().count, 1);
    }

    #[test]
    fn metadata_get_reports_mixed_and_set_applies_to_all() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let v = cat.metadata_get(&ids).unwrap();
        assert_eq!(v.title, vec![String::new()], "empty and the same everywhere");
        cat.metadata_set(&ids[..1], &MetaPatch { title: Some("One".into()), ..Default::default() }).unwrap();
        assert_eq!(cat.metadata_get(&ids).unwrap().title.len(), 2, "two different values means mixed");
        assert_eq!(cat.metadata_get(&ids[..1]).unwrap().title, vec!["One".to_string()]);
        cat.metadata_set(&ids, &MetaPatch { creator: Some("Sam".into()), ..Default::default() }).unwrap();
        let v = cat.metadata_get(&ids).unwrap();
        assert_eq!(v.creator, vec!["Sam".to_string()]);
        assert_eq!(v.title.len(), 2, "setting creator leaves title alone");
        assert!(cat.metadata_set(&ids, &MetaPatch { caption: Some("x".repeat(2001)), ..Default::default() }).is_err());
        assert!(cat.metadata_set(&[9999], &MetaPatch { title: Some("t".into()), ..Default::default() }).is_err());
        let dirty: i64 = cat.conn.query_row("select count(*) from photo where metadata_dirty = 1", [], |r| r.get(0)).unwrap();
        assert_eq!(dirty, 3);
        assert!(cat.metadata_get(&[]).unwrap().title.is_empty());
    }

    #[test]
    fn select_all_returns_every_match_not_one_page() {
        let src = tempfile::tempdir().unwrap();
        let cat_dir = tempfile::tempdir().unwrap();
        for i in 0..12u8 {
            make_jpeg(src.path(), &format!("p{i}.jpg"), i * 10, 40 + i as u32, 30);
        }
        let mut cat = Catalog::open(cat_dir.path()).unwrap();
        cat.import_files(&Catalog::list_files(src.path()), src.path(), "add", None, |_, _| {}).unwrap();
        let page = cat.query(&Query { limit: 5, ..Default::default() }).unwrap();
        assert_eq!((page.total, page.rows.len()), (12, 5));
        assert_eq!(cat.photo_ids(&Query::default()).unwrap().len(), 12);
        let ids = cat.photo_ids(&Query::default()).unwrap();
        cat.set_rating(&ids[..4], 5).unwrap();
        assert_eq!(cat.photo_ids(&Query { min_rating: Some(5), ..Default::default() }).unwrap().len(), 4);
    }

    #[test]
    fn remove_deletes_rows_and_links_but_never_the_files() {
        let (src, _c, mut cat, ids) = setup_imported();
        cat.quick_toggle(&ids).unwrap();
        cat.keyword_add(&ids, &["Gone".into()]).unwrap();
        let (id, p) = {
            let r = cat.query(&Query::default()).unwrap();
            (r.rows[0].id, r.rows[0].path.clone())
        };
        media::build_previews(Path::new(&p), &cat.previews_dir(), id).unwrap();
        assert!(media::preview_path(&cat.previews_dir(), id, "thumb").exists());
        assert_eq!(cat.photo_remove(&[id]).unwrap(), 1);
        assert_eq!(cat.count().unwrap(), 2);
        assert!(Path::new(&p).exists(), "the original file must stay");
        assert!(!media::preview_path(&cat.previews_dir(), id, "thumb").exists(), "our preview copy is cleaned up");
        assert_eq!(cat.collections().unwrap()[0].count, 2, "removed from the Quick Collection too");
        assert_eq!(cat.keywords().unwrap()[0].count, 2);
        assert_eq!(cat.photo_remove(&[id]).unwrap(), 0, "removing twice is harmless");
        assert!(src.path().join("a.jpg").exists());
    }

    #[test]
    fn prune_removes_only_previews_with_no_photo() {
        let (_src, _c, mut cat, ids) = setup_imported();
        let rows = cat.query(&Query::default()).unwrap().rows;
        for r in &rows {
            media::build_previews(Path::new(&r.path), &cat.previews_dir(), r.id).unwrap();
        }
        let gone = ids[0];
        cat.photo_remove(&[gone]).unwrap();
        // a worker that finishes after the removal writes the files back
        let gone_row = rows.iter().find(|r| r.id == gone).unwrap();
        media::build_previews(Path::new(&gone_row.path), &cat.previews_dir(), gone).unwrap();
        fs::write(cat.previews_dir().join("notes.txt"), "keep").unwrap();
        assert_eq!(cat.prune_orphan_previews().unwrap(), 2);
        assert!(!media::preview_path(&cat.previews_dir(), gone, "thumb").exists());
        for r in rows.iter().filter(|r| r.id != gone) {
            assert!(media::preview_path(&cat.previews_dir(), r.id, "thumb").exists(), "live previews stay");
        }
        assert!(cat.previews_dir().join("notes.txt").exists(), "unrelated files stay");
        assert_eq!(cat.prune_orphan_previews().unwrap(), 0);
    }

    /// Needs real camera files, so it looks for them (or `PENUMBRA_RAW_SAMPLES`, a folder) and skips if absent.
    #[test]
    fn raw_files_get_previews_and_export_from_real_samples() {
        let dir = std::env::var("PENUMBRA_RAW_SAMPLES").unwrap_or_else(|_| "C:/Users/BBOTNICS/Desktop/Other".into());
        let raws: Vec<_> = Catalog::list_files(Path::new(&dir))
            .into_iter()
            .filter(|p| media::kind_of(p) == Some(Kind::Raw))
            .take(2)
            .collect();
        if raws.is_empty() {
            eprintln!("skipped: no RAW samples in {dir}");
            return;
        }
        let out = tempfile::tempdir().unwrap();
        for (n, raw) in raws.iter().enumerate() {
            let id = n as i64 + 1;
            media::build_previews(raw, out.path(), id).unwrap();
            let th = image::open(media::preview_path(out.path(), id, "thumb")).unwrap();
            let st = image::open(media::preview_path(out.path(), id, "standard")).unwrap();
            assert_eq!(th.width().max(th.height()), media::THUMB_EDGE, "{raw:?}");
            assert!(st.width().max(st.height()) >= 1600, "standard preview is large enough: {raw:?}");
            let exported = media::export_jpeg(raw, out.path(), 1000, 85, None, crate::colour::Space::Srgb).unwrap();
            let ex = image::open(&exported).unwrap();
            assert_eq!(ex.width().max(ex.height()), 1000, "{raw:?}");
            assert!(raw.exists(), "the original stays");
        }
    }

    #[test]
    fn develop_saves_recipe_and_history_and_goes_with_the_photo() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let id = ids[0];
        assert_eq!(cat.develop_get(id).unwrap().recipe, Recipe::default(), "unedited photos have the default recipe");
        assert!(cat.develop_recipe(id).unwrap().is_none());
        let step = |l: &str| StepIn { label: l.into(), delta_text: Some("+1".into()), value_text: Some("1.00".into()) };
        let mut r = Recipe { exposure: 1.0, ..Default::default() };
        cat.develop_save(id, &r, Some(&step("Exposure"))).unwrap();
        r.contrast = 20.0;
        cat.develop_save(id, &r, Some(&step("Contrast"))).unwrap();
        let st = cat.develop_get(id).unwrap();
        assert_eq!(st.recipe.contrast, 20.0);
        assert_eq!(st.history.iter().map(|h| h.label.as_str()).collect::<Vec<_>>(), ["Contrast", "Exposure"], "newest first");
        assert_eq!(st.history[1].recipe.contrast, 0.0, "each step keeps the recipe as it was then");
        // saving without a step (a live change) does not add history
        r.exposure = 2.0;
        cat.develop_save(id, &r, None).unwrap();
        assert_eq!(cat.develop_get(id).unwrap().history.len(), 2);
        // out-of-range values are clamped on the way in
        cat.develop_save(id, &Recipe { exposure: 99.0, ..Default::default() }, None).unwrap();
        assert_eq!(cat.develop_get(id).unwrap().recipe.exposure, 5.0);
        // removing the photo takes its edits along
        cat.photo_remove(&[id]).unwrap();
        let left: i64 = cat.conn.query_row("select count(*) from develop_settings", [], |r| r.get(0)).unwrap();
        let hist: i64 = cat.conn.query_row("select count(*) from history_step", [], |r| r.get(0)).unwrap();
        assert_eq!((left, hist), (0, 0));
        assert!(cat.develop_get(id).is_err());
    }

    #[test]
    fn the_edited_filter_finds_the_photos_with_edits_or_without_and_combines_with_the_others() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let n = ids.len();
        assert!(n >= 3, "the test catalog has a few photos");
        let found = |cat: &Catalog, q: Query| cat.query(&q).unwrap().rows.iter().map(|r| r.id).collect::<Vec<_>>();
        assert_eq!(found(&cat, Query { edited: Some("yes".into()), ..Default::default() }).len(), 0);
        assert_eq!(found(&cat, Query { edited: Some("no".into()), ..Default::default() }).len(), n);
        let r = Recipe { exposure: 1.0, ..Recipe::default() };
        cat.develop_save(ids[1], &r, None).unwrap();
        cat.develop_save(ids[2], &r, None).unwrap();
        assert_eq!(found(&cat, Query { edited: Some("yes".into()), ..Default::default() }).len(), 2);
        assert_eq!(found(&cat, Query { edited: Some("no".into()), ..Default::default() }).len(), n - 2);
        assert_eq!(found(&cat, Query { edited: Some("other".into()), ..Default::default() }).len(), n, "anything else is no filter");
        cat.set_rating(&[ids[1]], 4).unwrap();
        assert_eq!(found(&cat, Query { edited: Some("yes".into()), min_rating: Some(4), ..Default::default() }), vec![ids[1]]);
        // back to untouched: no longer in the edited set
        cat.develop_save(ids[2], &Recipe::default(), None).unwrap();
        assert_eq!(found(&cat, Query { edited: Some("yes".into()), ..Default::default() }), vec![ids[1]]);
    }

    #[test]
    fn folders_are_made_from_the_day_in_the_chosen_pattern() {
        assert_eq!(folder_for("YYYY-MM-DD", "2026-10-19"), "2026-10-19");
        assert_eq!(folder_for("YYYY/MM/DD", "2026-10-19"), "2026/10/19");
        assert_eq!(folder_for("YYYY/YYYY-MM-DD", "2026-10-19"), "2026/2026-10-19");
        assert_eq!(folder_for("YYYY-MM", "2026-10-19"), "2026-10");
        assert_eq!(folder_for("YYYY", "2026-10-19"), "2026");
        assert_eq!(folder_for("flat", "2026-10-19"), "");
        assert_eq!(folder_for("nonsense", "2026-10-19"), "2026-10-19");
        assert_eq!(folder_for("YYYY/MM/DD", "undated"), "undated");
        assert_eq!(folder_for("flat", "undated"), "");
    }

    #[test]
    fn copying_names_and_files_by_the_pattern_and_moving_removes_the_originals_only_after_the_copy_is_checked() {
        let (src, c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        let n = files.len();
        let dest = tempfile::tempdir().unwrap();
        let opts = ImportOpts { name_template: "{date}_{seq}".into(), folder_format: "YYYY".into(), ..ImportOpts::default() };
        let r = cat.import_files_with(&files, src.path(), "copy", Some(dest.path()), &opts, |_, _| {}).unwrap();
        assert_eq!(r.added.len(), n);
        for (_, p) in &r.added {
            let p = Path::new(p);
            assert!(p.starts_with(dest.path()) && p.exists());
            let name = p.file_stem().unwrap().to_string_lossy().into_owned();
            assert!(name.contains('_') && name.ends_with(|ch: char| ch.is_ascii_digit()), "{name}");
            assert_eq!(p.parent().unwrap().file_name().unwrap().to_string_lossy().len(), 4, "a folder per year");
        }
        assert!(files.iter().all(|f| f.exists()), "a copy leaves the originals alone");
        // moving: a second catalog takes the photos from a second source and the originals go
        drop((c, cat));
        let (src2, c2, mut cat2) = setup();
        let files2 = Catalog::list_files(src2.path());
        let dest2 = tempfile::tempdir().unwrap();
        let r2 = cat2.import_files_with(&files2, src2.path(), "move", Some(dest2.path()), &ImportOpts::default(), |_, _| {}).unwrap();
        assert_eq!(r2.added.len(), files2.len());
        assert!(r2.left_behind.is_empty() && r2.failed.is_empty());
        assert!(files2.iter().all(|f| !f.exists()), "the originals are gone after the copies were checked");
        assert!(r2.added.iter().all(|(_, p)| Path::new(p).exists()));
        drop(c2);
        // a destination inside the source is refused, and so is moving with nowhere to go
        let (src3, _c3, mut cat3) = setup();
        let files3 = Catalog::list_files(src3.path());
        assert!(cat3.import_files_with(&files3, src3.path(), "move", None, &ImportOpts::default(), |_, _| {}).unwrap_err().contains("destination"));
        let inside = src3.path().join("inside");
        assert!(cat3.import_files_with(&files3, src3.path(), "copy", Some(&inside), &ImportOpts::default(), |_, _| {}).unwrap_err().contains("cannot be the folder"));
        assert!(files3.iter().all(|f| f.exists()), "nothing was touched");
    }

    #[test]
    fn the_other_details_are_stored_per_photo_and_mixed_values_are_told_apart() {
        let (_s, _c, mut cat, ids) = setup_imported();
        cat.metadata_set(&ids, &MetaPatch { city: Some("Cape Town".into()), country: Some("South Africa".into()), credit: Some("Studio".into()), ..Default::default() }).unwrap();
        cat.metadata_set(&ids[..1], &MetaPatch { city: Some("Paarl".into()), sublocation: Some("Main street".into()), source: Some("Card 1".into()), state: Some("Western Cape".into()), ..Default::default() }).unwrap();
        let all = cat.metadata_get(&ids).unwrap();
        assert_eq!(all.country, vec!["South Africa".to_string()]);
        assert_eq!(all.credit, vec!["Studio".to_string()]);
        assert_eq!(all.city.len(), 2, "two cities are a mixed value");
        let one = cat.metadata_get(&ids[..1]).unwrap();
        assert_eq!((one.city[0].as_str(), one.sublocation[0].as_str(), one.source[0].as_str(), one.state[0].as_str()), ("Paarl", "Main street", "Card 1", "Western Cape"));
        // a field left out of the patch is left alone, and clearing is an empty string
        cat.metadata_set(&ids[..1], &MetaPatch { city: Some(String::new()), ..Default::default() }).unwrap();
        let after = cat.metadata_get(&ids[..1]).unwrap();
        assert_eq!((after.city, after.sublocation), (vec![String::new()], vec!["Main street".to_string()]));
    }

    #[test]
    fn optimizing_gives_back_the_room_of_deleted_rows_and_changes_nothing_else() {
        let (_s, _c, mut cat, ids) = setup_imported();
        for i in 0..400 {
            cat.metadata_set(&ids[..1], &MetaPatch { caption: Some("x".repeat(1500 + i)), ..Default::default() }).unwrap();
        }
        let photos = cat.count().unwrap();
        let r = cat.optimize().unwrap();
        assert!(r.after <= r.before, "{r:?}");
        assert_eq!(cat.count().unwrap(), photos);
        assert!(cat.integrity().unwrap().ok);
        assert!(cat.optimize().is_ok(), "again is fine");
    }

    #[test]
    fn edited_flag_follows_the_stored_recipe() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let id = ids[0];
        let edited = |cat: &Catalog| cat.query(&Query::default()).unwrap().rows.iter().filter(|r| r.edited).map(|r| r.id).collect::<Vec<_>>();
        assert!(edited(&cat).is_empty());
        cat.develop_save(id, &Recipe { exposure: 0.5, ..Default::default() }, None).unwrap();
        assert_eq!(edited(&cat), vec![id]);
        // back to untouched: not edited any more, and the history stays
        let step = StepIn { label: "Reset all".into(), delta_text: None, value_text: None };
        cat.develop_save(id, &Recipe::default(), Some(&step)).unwrap();
        assert!(edited(&cat).is_empty());
        assert!(cat.develop_recipe(id).unwrap().is_none());
        assert_eq!(cat.develop_get(id).unwrap().history.len(), 1);
    }

    #[test]
    fn edited_previews_show_the_edit_without_touching_the_base_and_are_cleaned_up() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let id = ids[0];
        let dir = cat.previews_dir();
        let p = cat.photo_path(id).unwrap();
        media::build_previews(&p, &dir, id).unwrap();
        let base_before = fs::read(media::preview_path(&dir, id, "standard")).unwrap();
        let recipe = Recipe { exposure: 1.2, crop: develop::Crop { aspect: "1:1".into(), angle: 0.0, rect: None }, ..Default::default() };
        let (std_img, thumb) = media::render_edited_previews(&dir, id, &recipe).unwrap();
        media::write_edited_previews(&dir, id, &std_img, &thumb).unwrap();
        assert_eq!(fs::read(media::preview_path(&dir, id, "standard")).unwrap(), base_before, "the base preview is untouched");
        let (base_t, edit_t) = (image::open(media::preview_path(&dir, id, "thumb")).unwrap(), image::open(media::preview_path(&dir, id, "ethumb")).unwrap());
        assert_eq!(edit_t.width(), edit_t.height(), "the crop shows in the thumbnail");
        assert_ne!((base_t.width(), base_t.height()), (edit_t.width(), edit_t.height()));
        assert!(edit_t.width().max(edit_t.height()) <= media::THUMB_EDGE);
        // an orphan edited preview is pruned like any other
        cat.photo_remove(&[id]).unwrap();
        for level in media::PREVIEW_LEVELS {
            assert!(!media::preview_path(&dir, id, level).exists(), "{level} is gone with the photo");
        }
        media::write_edited_previews(&dir, id, &std_img, &thumb).unwrap();
        assert_eq!(cat.prune_orphan_previews().unwrap(), 2);
        // clearing removes only the edited ones
        media::build_previews(&p, &dir, ids[1]).unwrap();
        media::write_edited_previews(&dir, ids[1], &std_img, &thumb).unwrap();
        media::clear_edited_previews(&dir, ids[1]);
        assert!(media::preview_path(&dir, ids[1], "thumb").exists() && !media::preview_path(&dir, ids[1], "ethumb").exists());
    }

    #[test]
    fn presets_are_created_listed_renamed_and_deleted() {
        let (_s, _c, mut cat, _ids) = setup_imported();
        assert!(cat.preset_list().unwrap().is_empty());
        let recipe = Recipe { exposure: 0.7, saturation: 25.0, ..Default::default() };
        let id = cat.preset_create("  Warm   look ", None, &["tone".into(), "presence".into(), "bogus".into()], &recipe).unwrap();
        let list = cat.preset_list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!((list[0].name.as_str(), list[0].group.as_str()), ("Warm look", USER_PRESET_GROUP));
        assert_eq!(list[0].groups, ["tone", "presence"], "unknown groups are dropped");
        assert_eq!(list[0].recipe.exposure, 0.7);
        // same name in the same group, any case, is refused; in another group it is fine
        assert!(cat.preset_create("WARM LOOK", None, &["tone".into()], &recipe).unwrap_err().contains("already exists"));
        cat.preset_create("Warm look", Some("Portraits"), &["tone".into()], &recipe).unwrap();
        // rejects empty names, no groups, and absurd names
        assert!(cat.preset_create("   ", None, &["tone".into()], &recipe).is_err());
        assert!(cat.preset_create("x", None, &[], &recipe).unwrap_err().contains("at least one"));
        assert!(cat.preset_create(&"y".repeat(101), None, &["tone".into()], &recipe).is_err());
        assert!(cat.preset_create("sql ' ; drop table preset; --", None, &["tone".into()], &recipe).is_ok(), "names are data");
        cat.preset_rename(id, "Warmer").unwrap();
        assert!(cat.preset_list().unwrap().iter().any(|p| p.name == "Warmer"));
        let cool = cat.preset_create("Cool", None, &["tone".into()], &recipe).unwrap();
        assert!(cat.preset_rename(cool, "warmer").unwrap_err().contains("already exists"), "renaming onto an existing name is refused");
        assert!(cat.preset_rename(9999, "x").is_err());
        let before = cat.preset_list().unwrap().len();
        cat.preset_delete(id).unwrap();
        assert_eq!(cat.preset_list().unwrap().len(), before - 1);
        cat.preset_delete(id).unwrap(); // deleting twice is harmless
    }

    #[test]
    fn snapshots_belong_to_their_photo_and_are_capped() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let (a, b) = (ids[0], ids[1]);
        let r1 = Recipe { exposure: 1.0, ..Default::default() };
        let r2 = Recipe { contrast: 30.0, ..Default::default() };
        let s1 = cat.snapshot_create(a, "  First ", &r1).unwrap();
        cat.snapshot_create(a, "Second", &r2).unwrap();
        cat.snapshot_create(b, "Other photo", &r1).unwrap();
        let list = cat.snapshot_list(a).unwrap();
        assert_eq!(list.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["Second", "First"], "newest first");
        assert_eq!(list[1].recipe.exposure, 1.0);
        assert_eq!(cat.snapshot_list(b).unwrap().len(), 1);
        assert!(cat.snapshot_create(a, "  ", &r1).is_err());
        assert!(cat.snapshot_create(9999, "x", &r1).is_err());
        cat.snapshot_delete(s1).unwrap();
        assert_eq!(cat.snapshot_list(a).unwrap().len(), 1);
        for i in 0..(SNAPSHOT_LIMIT + 5) {
            cat.snapshot_create(b, &format!("s{i}"), &r1).unwrap();
        }
        assert_eq!(cat.snapshot_list(b).unwrap().len() as i64, SNAPSHOT_LIMIT);
        // removing the photo takes its snapshots along
        cat.photo_remove(&[a]).unwrap();
        let left: i64 = cat.conn.query_row("select count(*) from snapshot where photo_id = ?1", [a], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn the_stored_recipe_remembers_whether_it_has_masks() {
        use crate::masks::{LocalAdjust, Mask, Shape};
        let (_s, _c, mut cat, ids) = setup_imported();
        let id = ids[0];
        let with = Recipe {
            masks: vec![Mask { id: "m".into(), name: "A".into(), visible: true, invert: false, parts: Vec::new(), shape: Shape::Linear { x1: 0.0, y1: 0.0, x2: 1.0, y2: 1.0, feather: 0.5 }, adjust: LocalAdjust { exposure: 1.0, ..Default::default() } }],
            ..Default::default()
        };
        cat.develop_save(id, &with, None).unwrap();
        let flag = |cat: &Catalog| cat.conn.query_row("select has_masks from develop_settings where photo_id = ?1", [id], |r| r.get::<_, i64>(0)).unwrap();
        assert_eq!(flag(&cat), 1);
        assert_eq!(cat.develop_get(id).unwrap().recipe.masks.len(), 1, "the mask comes back");
        cat.develop_save(id, &Recipe { exposure: 0.3, ..Default::default() }, None).unwrap();
        assert_eq!(flag(&cat), 0);
    }

    #[test]
    fn export_applies_spots_at_full_size_and_the_original_stays_untouched() {
        use crate::spots::{Spot, SpotMode};
        let (src, _c, mut cat, ids) = setup_imported();
        let id = ids[0];
        let p = cat.photo_path(id).unwrap();
        let before = fs::read(&p).unwrap();
        let out = tempfile::tempdir().unwrap();
        let plain = media::export_jpeg(&p, out.path(), 0, 92, None, crate::colour::Space::Srgb).unwrap();
        let recipe = Recipe { spots: vec![Spot { id: "s".into(), visible: true, mode: SpotMode::Clone, x: 0.25, y: 0.5, sx: 0.75, sy: 0.5, size: 0.3, feather: 0.0, opacity: 1.0 }], ..Default::default() };
        cat.develop_save(id, &recipe, None).unwrap();
        let saved = cat.develop_recipe(id).unwrap().unwrap();
        assert_eq!(saved.spots.len(), 1, "the spot is stored with the recipe");
        let edited = media::export_jpeg(&p, out.path(), 0, 92, Some(&saved), crate::colour::Space::Srgb).unwrap();
        let (a, b) = (image::open(&plain).unwrap().to_rgb8(), image::open(&edited).unwrap().to_rgb8());
        assert_eq!((a.width(), a.height()), (b.width(), b.height()), "same size: a spot does not crop");
        let centre = (a.width() / 4, a.height() / 2);
        let diff: i32 = (0..3).map(|k| (a.get_pixel(centre.0, centre.1)[k] as i32 - b.get_pixel(centre.0, centre.1)[k] as i32).abs()).sum();
        assert!(diff > 6, "the patch changed the picture where the spot is");
        assert_eq!(fs::read(&p).unwrap(), before, "original bytes unchanged");
        assert!(src.path().join("a.jpg").exists());
    }

    #[test]
    fn export_applies_lens_and_transform_and_the_recipe_carries_them() {
        use crate::geometry::Geometry;
        let (_src, _c, mut cat, ids) = setup_imported();
        let id = ids[0];
        let p = cat.photo_path(id).unwrap();
        let out = tempfile::tempdir().unwrap();
        let plain = media::export_jpeg(&p, out.path(), 0, 92, None, crate::colour::Space::Srgb).unwrap();
        let recipe = Recipe { geometry: Geometry { rotate: 8.0, vertical: 40.0, ..Default::default() }, ..Default::default() };
        cat.develop_save(id, &recipe, None).unwrap();
        let saved = cat.develop_recipe(id).unwrap().unwrap();
        assert_eq!(saved.geometry.rotate, 8.0, "stored with the recipe");
        let edited = media::export_jpeg(&p, out.path(), 0, 92, Some(&saved), crate::colour::Space::Srgb).unwrap();
        let (a, b) = (image::open(&plain).unwrap().to_rgb8(), image::open(&edited).unwrap().to_rgb8());
        assert_eq!((a.width(), a.height()), (b.width(), b.height()), "a transform keeps the picture's size");
        let changed = a.pixels().zip(b.pixels()).filter(|(x, y)| (0..3).map(|k| (x[k] as i32 - y[k] as i32).abs()).sum::<i32>() > 30).count();
        assert!(changed > (a.width() * a.height()) as usize / 10, "the picture really changed: {changed} pixels");
    }

    #[test]
    fn history_is_capped() {
        let (_s, _c, mut cat, ids) = setup_imported();
        let step = StepIn { label: "x".into(), delta_text: None, value_text: None };
        for _ in 0..(HISTORY_LIMIT + 20) {
            cat.develop_save(ids[0], &Recipe::default(), Some(&step)).unwrap();
        }
        let n: i64 = cat.conn.query_row("select count(*) from history_step", [], |r| r.get(0)).unwrap();
        assert_eq!(n, HISTORY_LIMIT);
    }

    #[test]
    fn export_applies_the_saved_recipe_and_never_touches_the_original() {
        let (src, _c, mut cat, ids) = setup_imported();
        let id = ids[0];
        let p = cat.photo_path(id).unwrap();
        let before = fs::read(&p).unwrap();
        let out = tempfile::tempdir().unwrap();
        let plain = media::export_jpeg(&p, out.path(), 0, 90, None, crate::colour::Space::Srgb).unwrap();
        let recipe = Recipe { exposure: 1.5, crop: develop::Crop { aspect: "1:1".into(), angle: 0.0, rect: None }, ..Default::default() };
        cat.develop_save(id, &recipe, None).unwrap();
        let saved = cat.develop_recipe(id).unwrap();
        let edited = media::export_jpeg(&p, out.path(), 0, 90, saved.as_ref(), crate::colour::Space::Srgb).unwrap();
        let (a, b) = (image::open(&plain).unwrap().to_rgb8(), image::open(&edited).unwrap().to_rgb8());
        assert_eq!(b.width(), b.height(), "cropped to a square");
        assert!(b.width() < a.width() || b.height() < a.height());
        let mean = |i: &image::RgbImage| i.pixels().map(|p| p[0] as u64 + p[1] as u64 + p[2] as u64).sum::<u64>() as f64 / (i.width() * i.height()) as f64;
        assert!(mean(&b) > mean(&a), "brighter after +1.5 EV");
        assert_eq!(fs::read(&p).unwrap(), before, "original bytes unchanged");
        assert!(src.path().join("a.jpg").exists());
    }

    fn imported() -> (tempfile::TempDir, tempfile::TempDir, Catalog, Vec<PhotoRow>) {
        let (src, c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        let rows = cat.query(&Query::default()).unwrap().rows;
        (src, c, cat, rows)
    }

    #[test]
    fn the_scan_marks_missing_files_groups_them_by_folder_and_clears_the_mark_when_they_come_back() {
        let (src, _c, cat, rows) = imported();
        let r = cat.scan_missing(|_, _| {}).unwrap();
        assert_eq!((r.checked, r.missing, r.groups.len()), (3, 0, 0));
        let a = src.path().join("a.jpg");
        let bytes = fs::read(&a).unwrap();
        fs::remove_file(&a).unwrap();
        let r = cat.scan_missing(|_, _| {}).unwrap();
        assert_eq!((r.missing, r.groups.len()), (1, 1));
        assert!(r.groups[0].folder_there && r.groups[0].missing == 1 && r.groups[0].total == 3, "{:?}", r.groups);
        let flags: Vec<(String, bool)> = cat.query(&Query::default()).unwrap().rows.into_iter().map(|p| (p.name, p.missing)).collect();
        assert!(flags.iter().any(|(n, m)| n.starts_with("a") && *m) && flags.iter().filter(|(_, m)| *m).count() == 1, "{flags:?}");
        fs::write(&a, bytes).unwrap();
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 0);
        assert!(cat.query(&Query::default()).unwrap().rows.iter().all(|p| !p.missing));
        // a folder that is gone altogether says so
        fs::remove_dir_all(src.path()).unwrap();
        let r = cat.scan_missing(|_, _| {}).unwrap();
        assert_eq!((r.missing, r.groups.len()), (3, 1));
        assert!(!r.groups[0].folder_there);
        let _ = rows;
    }

    #[test]
    fn a_folder_that_moved_is_found_again_by_pointing_the_catalog_at_it() {
        let (src, _c, cat, rows) = imported();
        let new = tempfile::tempdir().unwrap();
        // the same folders and files in a new place, the old place gone
        fs::create_dir_all(new.path().join("sub")).unwrap();
        for (from, to) in [("a.jpg", "a.jpg"), ("b.jpg", "b.jpg"), ("sub/c.jpg", "sub/c.jpg")] {
            fs::copy(src.path().join(from), new.path().join(to)).unwrap();
        }
        fs::remove_dir_all(src.path()).unwrap();
        let r = cat.scan_missing(|_, _| {}).unwrap();
        let root = r.groups[0].root_id;
        assert_eq!(cat.relocation_preview(root, new.path()).unwrap(), Relocation { found: 3, total: 3 });
        // a folder with none of them, and one that is not there, change nothing
        let empty = tempfile::tempdir().unwrap();
        assert!(cat.relocate_root(root, empty.path()).unwrap_err().contains("None of this folder's photos"));
        assert!(cat.relocate_root(root, &new.path().join("nope")).is_err());
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 3);
        cat.relocate_root(root, new.path()).unwrap();
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 0);
        assert!(cat.photo_path(rows[0].id).unwrap().starts_with(new.path()), "the photos are read from the new place now");
    }

    #[test]
    fn a_catalog_folder_cannot_be_pointed_at_another_catalog_folder() {
        let (src, _c, mut cat, _) = imported();
        let other = tempfile::tempdir().unwrap();
        make_jpeg(other.path(), "z.jpg", 5, 40, 40);
        let files = Catalog::list_files(other.path());
        cat.import_files(&files, other.path(), "add", None, |_, _| {}).unwrap();
        let root = cat.scan_missing(|_, _| {}).unwrap();
        assert_eq!(root.missing, 0);
        let first: i64 = cat.conn.query_row("select id from root_folder where absolute_path = ?1", [path_str(src.path())], |r| r.get(0)).unwrap();
        let err = cat.relocate_root(first, other.path()).unwrap_err();
        assert!(err.contains("already in the catalog"), "{err}");
    }

    #[test]
    #[cfg_attr(not(windows), ignore = "the file B.JPG is found as b.jpg only on a file system that ignores capital letters")]
    fn missing_photos_are_found_by_name_and_size_in_a_folder_and_a_doubtful_match_is_left_alone() {
        let (src, _c, cat, rows) = imported();
        let shelf = tempfile::tempdir().unwrap();
        fs::create_dir_all(shelf.path().join("deep/er")).unwrap();
        // b moved into a deeper folder; a is gone; c has two identical copies
        fs::rename(src.path().join("b.jpg"), shelf.path().join("deep/er/B.JPG")).unwrap();
        fs::remove_file(src.path().join("a.jpg")).unwrap();
        fs::create_dir_all(shelf.path().join("one")).unwrap();
        fs::create_dir_all(shelf.path().join("two")).unwrap();
        fs::copy(src.path().join("sub/c.jpg"), shelf.path().join("one/c.jpg")).unwrap();
        fs::copy(src.path().join("sub/c.jpg"), shelf.path().join("two/c.jpg")).unwrap();
        fs::remove_file(src.path().join("sub/c.jpg")).unwrap();
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 3);
        let out = cat.relink_by_search(shelf.path(), |_| {}).unwrap();
        assert_eq!((out.relinked, out.still_missing, out.ambiguous, out.conflicts), (1, 2, 1, 0), "{out:?}");
        let b = rows.iter().find(|p| p.name.starts_with('b')).unwrap();
        let path = cat.photo_path(b.id).unwrap();
        assert!(path.is_file() && path.starts_with(shelf.path()) && path.to_string_lossy().replace('\\', "/").contains("deep/er"), "{path:?}");
        let after = cat.scan_missing(|_, _| {}).unwrap();
        assert_eq!(after.missing, 2, "b is found, a and c are still missing");
        // nothing in the folder fits a: still missing, and nothing was changed on disk
        assert!(shelf.path().join("one/c.jpg").is_file() && shelf.path().join("two/c.jpg").is_file());
    }

    #[test]
    fn a_sound_catalog_passes_its_check_and_a_broken_link_is_found() {
        let (src, _c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        let r = cat.integrity().unwrap();
        assert!(r.ok && r.problems.is_empty(), "{r:?}");
        assert_eq!((r.photos, r.books), (3, 0));
        assert!(r.size_bytes > 0);
        // an edit that belongs to a photo that is not there
        cat.conn.pragma_update(None, "foreign_keys", "OFF").unwrap();
        cat.conn.execute("insert into develop_settings(photo_id, process_version, settings_json) values (9999, 1, '{}')", []).unwrap();
        let bad = cat.integrity().unwrap();
        assert!(!bad.ok);
        assert!(bad.problems.iter().any(|p| p.contains("develop_settings") && p.contains("not there")), "{:?}", bad.problems);
    }

    #[test]
    fn a_backup_is_a_catalog_folder_that_opens_with_the_same_photos_and_books_and_never_replaces_anything() {
        let (src, _c, mut cat) = setup();
        let files = Catalog::list_files(src.path());
        cat.import_files(&files, src.path(), "add", None, |_, _| {}).unwrap();
        let id = cat.book_create(&crate::book::Book { name: "Kept".into(), ..Default::default() }).unwrap();
        assert!(cat.last_backup().is_none());
        let out = tempfile::tempdir().unwrap();
        let folder = out.path().join("my backup");
        let bytes = cat.backup_to(&folder).unwrap();
        assert!(bytes > 0 && folder.join("catalog.db").is_file());
        assert!(cat.last_backup().unwrap().starts_with("20"), "the time is remembered");
        let copy = Catalog::open(&folder).unwrap();
        assert_eq!(copy.count().unwrap(), 3);
        assert_eq!(copy.book_get(id).unwrap().name, "Kept");
        assert!(copy.integrity().unwrap().ok);
        // the live catalog can go on changing without touching the copy
        cat.book_delete(id).unwrap();
        assert_eq!(copy.book_get(id).unwrap().name, "Kept");
        // a folder that already holds a catalog is left alone
        let before = fs::read(folder.join("catalog.db")).unwrap();
        assert!(cat.backup_to(&folder).unwrap_err().contains("nothing was replaced"));
        assert_eq!(fs::read(folder.join("catalog.db")).unwrap(), before);
        // a folder name with a quote in it is fine
        cat.backup_to(&out.path().join("it's here")).unwrap();
    }

    #[test]
    fn a_stack_shows_its_top_photo_when_closed_all_of_them_when_open_and_ends_when_it_is_down_to_one() {
        let (_src, _c, mut cat, rows) = imported();
        assert_eq!(rows.len(), 3);
        let ids: Vec<i64> = rows.iter().map(|p| p.id).collect();
        assert!(cat.stack_group(&ids[..1]).is_err(), "one photo is not a stack");
        let s = cat.stack_group(&[ids[1], ids[0]]).unwrap();
        // closed: the first of the two given (ids[1]) shows, the other is hidden; the third is not in the stack
        let shown: Vec<i64> = cat.query(&Query::default()).unwrap().rows.iter().map(|p| p.id).collect();
        assert_eq!(shown.len(), 2);
        assert!(shown.contains(&ids[1]) && shown.contains(&ids[2]) && !shown.contains(&ids[0]));
        let top = cat.query(&Query::default()).unwrap().rows.into_iter().find(|p| p.id == ids[1]).unwrap();
        assert_eq!((top.stack_id, top.stack_pos, top.stack_count, top.stack_collapsed), (Some(s), 0, 2, true));
        // open it: both show, and "all" shows them even when it is closed
        cat.stack_set_collapsed(s, false).unwrap();
        assert_eq!(cat.query(&Query::default()).unwrap().total, 3);
        cat.stack_set_all_collapsed(true).unwrap();
        assert_eq!(cat.query(&Query::default()).unwrap().total, 2);
        assert_eq!(cat.query(&Query { stacks: Some("all".into()), ..Default::default() }).unwrap().total, 3);
        // grouping a stacked photo with another brings its stack along
        let joined = cat.stack_group(&[ids[2], ids[0]]).unwrap();
        let all = cat.query(&Query { stacks: Some("all".into()), ..Default::default() }).unwrap().rows;
        assert!(all.iter().all(|p| p.stack_id == Some(joined) && p.stack_count == 3));
        assert_eq!(all.iter().find(|p| p.stack_pos == 0).unwrap().id, ids[2]);
        // another photo can be made the top
        cat.stack_make_top(ids[0]).unwrap();
        assert_eq!(cat.query(&Query::default()).unwrap().rows.iter().map(|p| p.id).collect::<Vec<_>>(), vec![ids[0]]);
        // taking one out leaves two; taking another out ends the stack
        assert_eq!(cat.stack_remove(&[ids[2]]).unwrap(), 1);
        assert_eq!(cat.query(&Query::default()).unwrap().total, 2);
        assert_eq!(cat.stack_remove(&[ids[1]]).unwrap(), 1);
        assert_eq!(cat.query(&Query::default()).unwrap().total, 3);
        assert!(cat.query(&Query::default()).unwrap().rows.iter().all(|p| p.stack_id.is_none()));
        // unstack, and removing a photo from the catalog tidies the stack it was in
        let again = cat.stack_group(&ids).unwrap();
        assert_eq!(cat.stack_ungroup(&[ids[1]]).unwrap(), 1);
        assert!(cat.query(&Query::default()).unwrap().rows.iter().all(|p| p.stack_id.is_none()), "{again}");
        cat.stack_group(&ids).unwrap();
        cat.photo_remove(&[ids[0]]).unwrap();
        cat.photo_remove(&[ids[1]]).unwrap();
        let left = cat.query(&Query::default()).unwrap().rows;
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].stack_id, None, "a stack of one photo ends");
    }

    #[test]
    fn photos_can_be_exported_as_a_catalog_and_imported_into_another_without_doubling_anything() {
        let (_src, _c, mut cat, rows) = imported();
        let a = rows.iter().find(|p| p.name.starts_with('a')).unwrap().id;
        let b = rows.iter().find(|p| p.name.starts_with('b')).unwrap().id;
        cat.set_rating(&[a], 4).unwrap();
        cat.set_label(&[a], Some("blue")).unwrap();
        cat.keyword_add(&[a], &["Places".to_string(), "Lake".to_string()]).unwrap();
        cat.metadata_set(&[a], &MetaPatch { title: Some("Sunrise".into()), ..Default::default() }).unwrap();
        let mut r = Recipe::default();
        r.exposure = 0.9;
        cat.develop_save(a, &r, None).unwrap();
        let copy = cat.virtual_copies(&[a]).unwrap()[0].1;
        fs::write(media::preview_path(&cat.previews_dir(), a, "thumb"), b"thumb").unwrap();

        // export a (with its copy) and not b, into a folder that is made
        let out = tempfile::tempdir().unwrap();
        let dest = out.path().join("Sunrise set");
        let done = crate::xfer::export(&cat, &[a, copy], &dest, true).unwrap();
        assert_eq!((done.photos, done.skipped, done.previews), (2, 0, 1));
        assert!(crate::xfer::export(&cat, &[a], &dest, true).unwrap_err().contains("catalog in that folder"));
        let other = Catalog::open(&dest).unwrap();
        let theirs = other.query(&Query::default()).unwrap().rows;
        assert_eq!(theirs.len(), 2);
        let ta = theirs.iter().find(|p| p.master_id.is_none()).unwrap();
        let tc = theirs.iter().find(|p| p.master_id.is_some()).unwrap();
        assert_eq!((ta.rating, ta.label.as_deref(), ta.name.as_str()), (4, Some("blue"), "a.jpg"));
        assert_eq!((tc.master_id, tc.copy_name.as_deref()), (Some(ta.id), Some("Copy 1")));
        assert!(ta.edited);
        assert_eq!(other.develop_recipe(ta.id).unwrap().unwrap().exposure, 0.9);
        let kw: i64 = other.conn.query_row("select count(*) from photo_keyword pk join keyword k on k.id = pk.keyword_id where k.name = 'Lake' and pk.photo_id = ?1", [ta.id], |r| r.get(0)).unwrap();
        assert_eq!(kw, 1);
        assert_eq!(fs::read(media::preview_path(&other.previews_dir(), ta.id, "thumb")).unwrap(), b"thumb");
        assert!(!theirs.iter().any(|p| p.name == "b.jpg"), "b was not exported ({b})");
        drop(other);

        // import it into a catalog that has nothing: the photos arrive with everything, and a second import adds nothing
        let (_s2, c2, mut cat2) = setup();
        let got = crate::xfer::import(&cat2, &dest, true).unwrap();
        assert_eq!((got.photos, got.skipped), (2, 0));
        let mine = cat2.query(&Query::default()).unwrap().rows;
        assert_eq!(mine.len(), 2);
        let ma = mine.iter().find(|p| p.master_id.is_none()).unwrap();
        assert_eq!((ma.rating, ma.edited), (4, true));
        assert_eq!(mine.iter().filter(|p| p.master_id == Some(ma.id)).count(), 1);
        let again = crate::xfer::import(&cat2, &dest, false).unwrap();
        assert_eq!((again.photos, again.skipped), (0, 2));
        assert_eq!(cat2.query(&Query::default()).unwrap().total, 2);
        // not a catalog, and itself
        assert!(crate::xfer::import(&cat2, out.path(), false).unwrap_err().contains("does not hold a catalog"));
        assert!(crate::xfer::import(&cat2, c2.path(), false).unwrap_err().contains("this catalog"));
        let _ = &mut cat2;
    }

    #[test]
    fn a_lightroom_sidecar_puts_its_understood_settings_on_the_photo_once_and_then_agrees() {
        let (_src, _c, mut cat, rows) = imported();
        let a = rows[0].id;
        let xml = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 7.0"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
 <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+0.60" crs:Contrast2012="+12" crs:Vibrance="+20" crs:HasCrop="False"/>
</rdf:RDF></x:xmpmeta>"#;
        let sc = crate::xmp::parse(xml).unwrap();
        assert_eq!(cat.sidecar_differences(a, &sc).unwrap(), vec!["lightroom"]);
        assert_eq!(cat.apply_sidecar(a, &sc).unwrap(), vec!["lightroom"]);
        let r = cat.develop_recipe(a).unwrap().unwrap();
        assert_eq!((r.exposure, r.contrast, r.vibrance), (0.6, 12.0, 20.0));
        assert_eq!(cat.sidecar_differences(a, &sc).unwrap(), Vec::<&str>::new(), "it agrees now");
        // what the person had set that Lightroom's file does not speak of is kept
        let mut mine = r.clone();
        mine.saturation = -15.0;
        cat.develop_save(a, &mine, None).unwrap();
        cat.apply_sidecar(a, &sc).unwrap();
        assert_eq!(cat.develop_recipe(a).unwrap().unwrap().saturation, -15.0);
        // and it shows in the history under its own name
        assert!(cat.develop_get(a).unwrap().history.iter().any(|h| h.label == "Read Lightroom settings"));
    }

    #[test]
    fn copy_as_dng_copies_pictures_as_they_are_and_reports_a_raw_file_that_cannot_be_converted() {
        let (src, _c, mut cat) = setup();
        fs::write(src.path().join("broken.cr2"), b"not really a raw file").unwrap();
        let dest = tempfile::tempdir().unwrap();
        let files = Catalog::list_files(src.path());
        let done = cat.import_files_with(&files, src.path(), "copy_dng", Some(dest.path()), &ImportOpts::default(), |_, _| {}).unwrap();
        // the three JPEGs are copied as JPEGs; the broken RAW file is reported and leaves nothing behind or in the catalog
        assert_eq!(done.added.len(), 3, "{:?}", done.failed);
        assert_eq!(done.failed.len(), 1);
        assert!(done.failed[0].contains("broken.cr2") && done.failed[0].contains("DNG"), "{:?}", done.failed);
        assert!(done.added.iter().all(|(_, p)| p.ends_with(".jpg")));
        let leftovers: Vec<_> = walkdir::WalkDir::new(dest.path()).into_iter().flatten().filter(|e| e.path().extension().map(|x| x == "dng" || x == "cr2").unwrap_or(false)).collect();
        assert!(leftovers.is_empty(), "{leftovers:?}");
        let session: String = cat.conn.query_row("select mode from import_session order by id desc limit 1", [], |r| r.get(0)).unwrap();
        assert_eq!(session, "copy_dng");
        // without a destination it is refused like a copy
        assert!(cat.import_files_with(&files, src.path(), "copy_dng", None, &ImportOpts::default(), |_, _| {}).unwrap_err().contains("destination"));
    }

    #[test]
    fn auto_stack_groups_photos_taken_close_together_and_leaves_the_rest() {
        let (_src, _c, mut cat, rows) = imported();
        let ids: Vec<i64> = rows.iter().map(|p| p.id).collect();
        for (id, when) in ids.iter().zip(["2026-10-03T10:00:00", "2026-10-03T10:00:03", "2026-10-03T10:30:00"]) {
            cat.conn.execute("update photo set captured_local = ?1 where id = ?2", params![when, id]).unwrap();
        }
        assert_eq!(cat.stack_auto(&ids, 5).unwrap(), (1, 2));
        let all = cat.query(&Query { stacks: Some("all".into()), ..Default::default() }).unwrap().rows;
        assert_eq!(all.iter().filter(|p| p.stack_id.is_some()).count(), 2);
        assert!(all.iter().find(|p| p.id == ids[2]).unwrap().stack_id.is_none());
        // a second run finds nothing new: the stacked photos are left alone
        assert_eq!(cat.stack_auto(&ids, 5).unwrap(), (0, 0));
        // a long enough gap would join the third as well, but only photos not yet stacked are considered
        assert_eq!(cat.stack_auto(&ids, 3600).unwrap(), (0, 0));
    }

    #[test]
    fn photos_that_look_alike_are_stacked_and_different_ones_are_not() {
        let (_src, _c, mut cat, rows) = imported();
        let ids: Vec<i64> = rows.iter().map(|p| p.id).collect();
        let dir = cat.previews_dir();
        let ramp = |lift: u8, flip: bool| image::RgbImage::from_fn(90, 60, |x, _| {
            let v = (if flip { 89 - x } else { x }) as u8 * 2 + lift;
            image::Rgb([v, v, v])
        });
        ramp(0, false).save(media::preview_path(&dir, ids[0], "thumb")).unwrap();
        ramp(12, false).save(media::preview_path(&dir, ids[1], "thumb")).unwrap(); // the same picture a little brighter
        ramp(0, true).save(media::preview_path(&dir, ids[2], "thumb")).unwrap(); // a different one
        assert_eq!(cat.stack_similar(&ids, 8).unwrap(), (1, 2));
        let all = cat.query(&Query { stacks: Some("all".into()), ..Default::default() }).unwrap().rows;
        let stacked: Vec<i64> = all.iter().filter(|p| p.stack_id.is_some()).map(|p| p.id).collect();
        assert!(stacked.contains(&ids[0]) && stacked.contains(&ids[1]) && !stacked.contains(&ids[2]));
        assert_eq!(cat.stack_similar(&ids, 8).unwrap(), (0, 0));
        // a photo with no preview is left alone, however loose the setting
        assert_eq!(cat.stack_similar(&[ids[2]], 24).unwrap(), (0, 0));
    }

    #[test]
    fn a_virtual_copy_is_a_photo_of_its_own_that_shares_the_file_and_starts_with_the_originals_settings() {
        let (src, _c, mut cat, rows) = imported();
        let a = rows.iter().find(|p| p.name.starts_with('a')).unwrap().id;
        cat.set_rating(&[a], 4).unwrap();
        cat.set_label(&[a], Some("blue")).unwrap();
        cat.keyword_add(&[a], &["Places".to_string(), "Lake".to_string()]).unwrap();
        cat.metadata_set(&[a], &MetaPatch { title: Some("Sunrise".into()), ..Default::default() }).unwrap();
        let mut r = Recipe::default();
        r.exposure = 0.9;
        cat.develop_save(a, &r, None).unwrap();
        // previews of the original, so there is something to copy
        let pdir = cat.previews_dir();
        for level in ["thumb", "standard", "ethumb", "estandard"] {
            fs::write(media::preview_path(&pdir, a, level), level.as_bytes()).unwrap();
        }
        let made = cat.virtual_copies(&[a]).unwrap();
        assert_eq!(made.len(), 1);
        let copy = made[0].1;
        assert_ne!(copy, a);
        // the same file, so no room is taken and the original is untouched
        assert_eq!(cat.photo_path(copy).unwrap(), cat.photo_path(a).unwrap());
        assert!(src.path().join("a.jpg").is_file());
        let page = cat.query(&Query::default()).unwrap();
        assert_eq!(page.total, 4);
        let row = page.rows.iter().find(|p| p.id == copy).unwrap();
        assert_eq!((row.copy_name.as_deref(), row.master_id, row.rating, row.label.as_deref(), row.edited), (Some("Copy 1"), Some(a), 4, Some("blue"), true));
        assert_eq!(page.rows.iter().find(|p| p.id == a).unwrap().copy_name, None);
        // its own copies of the settings
        assert_eq!(cat.develop_recipe(copy).unwrap().unwrap().exposure, 0.9);
        assert_eq!(cat.metadata_get(&[copy]).unwrap().title, vec!["Sunrise".to_string()]);
        assert_eq!(cat.keyword_paths(copy).unwrap(), vec![vec!["Places".to_string(), "Lake".to_string()]]);
        assert_eq!(fs::read(media::preview_path(&pdir, copy, "estandard")).unwrap(), b"estandard");
        // changing one does not change the other
        cat.set_rating(&[copy], 1).unwrap();
        let mut r2 = Recipe::default();
        r2.exposure = -1.0;
        cat.develop_save(copy, &r2, None).unwrap();
        let page = cat.query(&Query::default()).unwrap();
        assert_eq!(page.rows.iter().find(|p| p.id == a).unwrap().rating, 4);
        assert_eq!(cat.develop_recipe(a).unwrap().unwrap().exposure, 0.9);
        // a copy of a copy is another copy of the original, numbered on
        let again = cat.virtual_copies(&[copy]).unwrap();
        let second = cat.virtual_copies(&[a]).unwrap();
        let page = cat.query(&Query::default()).unwrap();
        let name = |id: i64| page.rows.iter().find(|p| p.id == id).unwrap().copy_name.clone();
        assert_eq!((name(again[0].1).as_deref(), name(second[0].1).as_deref()), (Some("Copy 2"), Some("Copy 3")));
        assert_eq!(page.rows.iter().find(|p| p.id == again[0].1).unwrap().master_id, Some(a));
        assert!(cat.virtual_copies(&[9999]).is_err());
        assert!(cat.virtual_copies(&vec![a; 201]).unwrap_err().contains("200"));
    }

    #[test]
    fn removing_a_photo_takes_its_copies_and_their_previews_with_it_and_removing_a_copy_leaves_the_photo() {
        let (src, _c, mut cat, rows) = imported();
        let b = rows.iter().find(|p| p.name.starts_with('b')).unwrap().id;
        let pdir = cat.previews_dir();
        let c1 = cat.virtual_copies(&[b]).unwrap()[0].1;
        let c2 = cat.virtual_copies(&[b]).unwrap()[0].1;
        for id in [b, c1, c2] {
            fs::write(media::preview_path(&pdir, id, "thumb"), b"x").unwrap();
        }
        // removing one copy leaves the photo and the other copy
        assert_eq!(cat.photo_remove(&[c1]).unwrap(), 1);
        assert!(!media::preview_path(&pdir, c1, "thumb").exists() && media::preview_path(&pdir, c2, "thumb").exists());
        assert_eq!(cat.query(&Query::default()).unwrap().total, 4);
        // removing the photo removes the remaining copy too, and its previews; the file stays
        assert_eq!(cat.photo_remove(&[b]).unwrap(), 2);
        assert!(!media::preview_path(&pdir, c2, "thumb").exists() && !media::preview_path(&pdir, b, "thumb").exists());
        assert_eq!(cat.query(&Query::default()).unwrap().total, 2);
        assert!(src.path().join("b.jpg").is_file());
    }

    #[test]
    fn copies_have_no_sidecar_wait_for_none_and_follow_their_photo_when_it_is_found_again() {
        let (src, _c, mut cat, rows) = imported();
        let a = rows.iter().find(|p| p.name.starts_with('a')).unwrap().id;
        let copy = cat.virtual_copies(&[a]).unwrap()[0].1;
        assert!(cat.is_virtual_copy(copy) && !cat.is_virtual_copy(a));
        assert!(cat.master_photo_ids().unwrap().iter().all(|id| *id != copy));
        // a change to the copy does not count as a sidecar waiting to be written
        cat.clear_changed(&[a, copy]).unwrap();
        cat.set_rating(&[copy], 3).unwrap();
        assert_eq!(cat.changed_photo_count(), 0);
        assert!(!cat.changed_photo_ids(10).unwrap().contains(&copy));
        // the photo's file moves into another folder: the search finds it once (not twice, for the copy), and the copy follows
        let shelf = tempfile::tempdir().unwrap();
        fs::create_dir_all(shelf.path().join("moved")).unwrap();
        fs::rename(src.path().join("a.jpg"), shelf.path().join("moved/a.jpg")).unwrap();
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 2, "the photo and its copy are both missing");
        let out = cat.relink_by_search(shelf.path(), |_| {}).unwrap();
        assert_eq!((out.relinked, out.ambiguous), (1, 0), "{out:?}");
        assert!(cat.photo_path(copy).unwrap().starts_with(shelf.path()));
        assert_eq!(cat.photo_path(copy).unwrap(), cat.photo_path(a).unwrap());
        assert_eq!(cat.scan_missing(|_, _| {}).unwrap().missing, 0);
    }

    fn smart(name: &str, mode: &str, rules: &[(&str, &str, &str)]) -> (String, crate::smart::SmartRules) {
        (name.into(), crate::smart::SmartRules { mode: mode.into(), rules: rules.iter().map(|(f, o, v)| crate::smart::Rule { field: (*f).into(), op: (*o).into(), value: (*v).into(), ..Default::default() }).collect() })
    }
    fn names_in(cat: &Catalog, id: i64) -> Vec<String> {
        let mut v: Vec<String> = cat.query(&Query { collection_id: Some(id), limit: 100, ..Default::default() }).unwrap().rows.into_iter().map(|p| p.name).collect();
        v.sort();
        v
    }

    #[test]
    fn a_smart_collection_holds_the_photos_that_meet_its_rules_now_and_changes_as_the_catalog_does() {
        let (_src, _c, mut cat, rows) = imported();
        let id_of = |n: &str| rows.iter().find(|p| p.name.starts_with(n)).unwrap().id;
        let (a, b, c) = (id_of("a"), id_of("b"), id_of("c"));
        cat.set_rating(&[a], 5).unwrap();
        cat.set_rating(&[b], 3).unwrap();
        cat.set_flag(&[a], 1).unwrap();
        cat.set_label(&[b], Some("red")).unwrap();
        cat.keyword_add(&[a], &["Places".to_string(), "Lake".to_string()]).unwrap();
        cat.keyword_add(&[b], &["Family".to_string()]).unwrap();
        cat.metadata_set(&[c], &MetaPatch { title: Some("Sunrise over the lake".into()), ..Default::default() }).unwrap();
        for (id, make, model, lens, iso, ap, focal, day) in [(a, "Canon", "Canon EOS R6", "RF 24-70mm", 400, 2.8, 35.0, "2026-10-17T10:00:00"), (b, "Nikon", "Z6", "Z 50mm", 3200, 1.8, 50.0, "2020-01-02T09:00:00"), (c, "Canon", "EOS 800D", "EF 50mm", 100, 8.0, 50.2, "2026-10-01T09:00:00")] {
            cat.conn.execute("insert into exif(photo_id, make, model, lens, iso, aperture, focal_mm) values (?1, ?2, ?3, ?4, ?5, ?6, ?7) on conflict(photo_id) do update set make = excluded.make, model = excluded.model, lens = excluded.lens, iso = excluded.iso, aperture = excluded.aperture, focal_mm = excluded.focal_mm", params![id, make, model, lens, iso, ap, focal]).unwrap();
            cat.conn.execute("update photo set captured_local = ?1 where id = ?2", params![day, id]).unwrap();
        }
        let mut r = Recipe::default();
        r.exposure = 0.5;
        cat.develop_save(b, &r, None).unwrap();
        let copy = cat.virtual_copies(&[c]).unwrap()[0].1;
        let col = cat.collection_create("Plain").unwrap();
        cat.collection_add(col, &[a, c]).unwrap();
        let count = |rules: &[(&str, &str, &str)], mode: &str| -> Vec<String> {
            let (_, r) = smart("t", mode, rules);
            let id = cat.smart_create("probe", &r).unwrap();
            let out = names_in(&cat, id);
            cat.collection_delete(id).unwrap();
            out
        };
        let named = |ids: &[i64]| -> Vec<String> {
            let mut v: Vec<String> = ids.iter().map(|i| rows.iter().find(|p| p.id == *i).map(|p| p.name.clone()).unwrap_or_else(|| "copy".into())).collect();
            v.sort();
            v
        };
        assert_eq!(count(&[("rating", ">=", "4")], "all"), named(&[a]));
        assert_eq!(count(&[("rating", "=", "3")], "all"), named(&[b]));
        assert_eq!(count(&[("rating", "<=", "0")], "all").len(), 2, "c and its copy are unrated");
        assert_eq!(count(&[("flag", "is", "pick")], "all"), named(&[a]));
        assert_eq!(count(&[("label", "is", "red")], "all"), named(&[b]));
        assert_eq!(count(&[("label", "is", "none")], "all").len(), 3, "a, c and the copy have no label");
        assert_eq!(count(&[("keyword", "is", "places")], "all"), named(&[a]), "the keyword and what is below it, in any letter case");
        assert_eq!(count(&[("keyword", "contains", "fam")], "all"), named(&[b]));
        assert_eq!(count(&[("camera", "contains", "canon")], "all").len(), 3, "a, c and the copy of c");
        assert_eq!(count(&[("camera", "contains", "EOS R6")], "all"), named(&[a]));
        assert_eq!(count(&[("lens", "contains", "50mm")], "all").len(), 3);
        assert_eq!(count(&[("iso", ">=", "1000")], "all"), named(&[b]));
        assert_eq!(count(&[("aperture", "<=", "2.8")], "all").len(), 2);
        assert_eq!(count(&[("focal", "=", "50")], "all").len(), 3, "50 and 50.2 are both about 50");
        assert_eq!(count(&[("date", "after", "2026-10-10")], "all"), named(&[a]));
        assert_eq!(count(&[("date", "before", "2021-01-01")], "all"), named(&[b]));
        assert_eq!(count(&[("date", "on", "2026-10-01")], "all").len(), 2);
        assert_eq!(count(&[("date", "last", "36500")], "all").len(), 4, "everything is within a hundred years");
        assert_eq!(count(&[("format", "is", "jpeg")], "all").len(), 4);
        assert_eq!(count(&[("format", "is", "raw")], "all").len(), 0);
        assert_eq!(count(&[("edited", "is", "yes")], "all"), named(&[b]));
        assert_eq!(count(&[("text", "contains", "SUNRISE")], "all").len(), 2, "a title: c and its copy");
        assert_eq!(count(&[("text", "contains", "b.")], "all"), named(&[b]), "a file name");
        assert_eq!(count(&[("copy", "is", "yes")], "all").len(), 1);
        assert_eq!(count(&[("copy", "is", "no")], "all").len(), 3);
        assert_eq!(count(&[("missing", "is", "no")], "all").len(), 4);
        assert_eq!(count(&[("collection", "is", &col.to_string())], "all").len(), 2);
        // all against any
        assert_eq!(count(&[("rating", ">=", "3"), ("camera", "contains", "canon")], "all"), named(&[a]));
        assert_eq!(count(&[("rating", ">=", "3"), ("camera", "contains", "canon")], "any").len(), 4);
        // it is a collection like the others: listed with a live count, refuses hand-made changes, can be renamed and deleted
        let (n, r) = smart("Keepers", "all", &[("rating", ">=", "4")]);
        let k = cat.smart_create(&n, &r).unwrap();
        let listed = cat.collections().unwrap();
        let row = listed.iter().find(|c| c.id == k).unwrap();
        assert_eq!((row.kind.as_str(), row.count, row.name.as_str()), ("smart", 1, "Keepers"));
        assert_eq!(cat.photo_ids(&Query { collection_id: Some(k), ..Default::default() }).unwrap(), vec![a]);
        assert!(cat.collection_add(k, &[b]).unwrap_err().contains("fills itself"));
        assert!(cat.collection_remove(k, &[a]).unwrap_err().contains("fills itself"));
        assert!(cat.collection_set_target(Some(k)).unwrap_err().contains("fills itself"));
        cat.set_rating(&[b], 5).unwrap();
        assert_eq!(cat.collections().unwrap().iter().find(|c| c.id == k).unwrap().count, 2, "it changes as the catalog does");
        // its rules can be changed, and are checked
        assert!(cat.smart_update(k, "Keepers", &smart("x", "all", &[("rating", ">=", "9")]).1).unwrap_err().contains("0 to 5"));
        cat.smart_update(k, "Best of Canon", &smart("x", "all", &[("rating", ">=", "4"), ("camera", "contains", "canon")]).1).unwrap();
        assert_eq!(names_in(&cat, k), named(&[a]));
        assert_eq!(cat.smart_rules_of(k).unwrap().rules.len(), 2);
        assert_eq!(cat.smart_count(&smart("x", "any", &[("flag", "is", "reject")]).1).unwrap(), 0);
        assert!(cat.smart_update(col, "x", &smart("x", "all", &[("rating", ">=", "1")]).1).unwrap_err().contains("not a smart"));
        assert!(cat.smart_create("  ", &smart("x", "all", &[("rating", ">=", "1")]).1).is_err());
        cat.collection_rename(k, "Renamed").unwrap();
        cat.collection_delete(k).unwrap();
        assert!(cat.smart_rules_of(k).is_none());
        // a smart collection whose saved rules were damaged shows nothing and breaks nothing
        let broken = cat.smart_create("Broken", &smart("x", "all", &[("rating", ">=", "1")]).1).unwrap();
        cat.conn.execute("update collection set rules_json = '{not json' where id = ?1", [broken]).unwrap();
        assert!(names_in(&cat, broken).is_empty());
        assert_eq!(cat.collections().unwrap().iter().find(|c| c.id == broken).unwrap().count, 0);
        let _ = copy;
    }
}
